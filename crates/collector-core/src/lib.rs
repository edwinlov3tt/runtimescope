//! `collector-core` — the shared library for the Rust RuntimeScope collector.
//!
//! Linked by both the standalone `collector-server` bin and the `mcp-server`
//! bin (ADR-0008: mcp-server embeds the collector in-process). Holds the wire
//! types, the persistent event/session store (dedicated DB-owner thread +
//! rusqlite WAL + JSONL WAL), and the WS+HTTP server.
//!
//! Milestone 1 scope: network events end-to-end with durable persistence +
//! crash recovery. The full 19 event types, auth, and the command channel
//! widen this in later milestones.

pub mod analytics_mosaic;
pub mod analytics_roi;
pub mod analytics_rollups;
pub mod analytics_store;
pub mod analytics_surveys;
pub mod analytics_uptime;
pub mod auth;
pub mod command;
pub mod dev_server;
pub mod event;
pub mod migration;
pub mod pm_discovery;
pub mod pm_project_manager;
pub mod pm_session_parser;
pub mod pm_store;
pub mod process_monitor;
pub mod server;
pub mod store;
pub mod wal;

pub use analytics_store::AnalyticsStore;
pub use auth::AuthMode;
pub use command::CommandHub;
pub use pm_project_manager::{discover_runtimescope_projects, ProjectManager};
pub use pm_store::PmStore;
pub use server::serve;
pub use store::StoreHandle;

use std::path::PathBuf;

/// The collector version string reported by `/api/health`. Tracks the crate
/// version so it never drifts from the release (was a hardcoded "0.11.0-dev").
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Default ports (overridable via RUNTIMESCOPE_PORT / RUNTIMESCOPE_HTTP_PORT).
pub const DEFAULT_WS_PORT: u16 = 6767;
pub const DEFAULT_HTTP_PORT: u16 = 6768;

/// Read a `u16` port from `env`, falling back to `default`.
pub fn port_from_env(var: &str, default: u16) -> u16 {
    std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// The bind address for the standalone collector, from `RUNTIMESCOPE_HOST`
/// (default `127.0.0.1`). Set `0.0.0.0` to expose the collector on all
/// interfaces — only do this behind a reverse proxy / tunnel that terminates
/// TLS and enforces access (ADR-0010). An unparseable value falls back to
/// loopback rather than failing open. The embedded MCP collector does NOT call
/// this — it always binds loopback.
pub fn host_from_env() -> std::net::IpAddr {
    parse_host(std::env::var("RUNTIMESCOPE_HOST").ok().as_deref())
}

/// Pure core of [`host_from_env`] (env split out so it's testable without
/// mutating process-global state). Unparseable/absent ⇒ loopback (fail closed).
fn parse_host(v: Option<&str>) -> std::net::IpAddr {
    use std::net::{IpAddr, Ipv4Addr};
    v.and_then(|s| s.trim().parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}

#[cfg(test)]
mod host_tests {
    use super::parse_host;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn host_defaults_to_loopback_and_fails_closed() {
        let loop4 = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert_eq!(parse_host(None), loop4, "absent ⇒ loopback");
        assert_eq!(parse_host(Some("")), loop4, "empty ⇒ loopback");
        assert_eq!(parse_host(Some("garbage")), loop4, "unparseable ⇒ loopback (fail closed)");
        assert_eq!(parse_host(Some("example.com")), loop4, "hostnames are not IPs ⇒ loopback");
        // Valid binds are honored, including whitespace-padded env values.
        assert_eq!(parse_host(Some("0.0.0.0")), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert_eq!(parse_host(Some("  127.0.0.1  ")), loop4);
        assert_eq!(parse_host(Some("::1")), IpAddr::V6(Ipv6Addr::LOCALHOST));
    }
}

#[cfg(test)]
mod exclude_tests {
    use super::project_excluded;
    use std::collections::HashSet;

    #[test]
    fn matches_id_name_or_projectid_case_insensitive() {
        // entries are stored lowercased (see excluded_projects)
        let ex: HashSet<String> = ["my-proj", "noisy app", "proj_abc"].iter().map(|s| s.to_string()).collect();
        assert!(project_excluded(&ex, "My-Proj", "X", None), "by id");
        assert!(project_excluded(&ex, "x", "Noisy App", None), "by name");
        assert!(project_excluded(&ex, "x", "y", Some("PROJ_ABC")), "by projectId");
        assert!(!project_excluded(&ex, "other", "other", Some("proj_zzz")), "no match");
        assert!(!project_excluded(&HashSet::new(), "my-proj", "x", None), "empty set never excludes");
    }
}

/// The data directory: `$HOME/.runtimescope` (the conformance harness sets HOME
/// to an isolated temp dir, so a restart-at-same-HOME finds the prior data).
pub fn data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".runtimescope")
}

/// Operator "always-exclude" project list from `~/.runtimescope/config.json`
/// (`"excludeProjects": ["…", …]`). Read fresh each call so edits take effect
/// without a restart. Entries are lowercased; a project matches if its id, name,
/// or runtimescope projectId is in the set (see `project_excluded`). Missing
/// file/key ⇒ empty set.
pub fn excluded_projects() -> std::collections::HashSet<String> {
    let path = data_dir().join("config.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return std::collections::HashSet::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return std::collections::HashSet::new();
    };
    v.get("excludeProjects")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.as_str())
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// True if `(id, name, project_id)` matches any entry in the exclude set
/// (case-insensitive). `project_id` is the runtimescope `proj_…` id, if known.
pub fn project_excluded(
    exclude: &std::collections::HashSet<String>,
    id: &str,
    name: &str,
    project_id: Option<&str>,
) -> bool {
    if exclude.is_empty() {
        return false;
    }
    exclude.contains(&id.to_lowercase())
        || exclude.contains(&name.trim().to_lowercase())
        || project_id.is_some_and(|p| exclude.contains(&p.to_lowercase()))
}

/// Open the persistent store (runs WAL recovery before returning).
pub async fn open_store() -> Result<StoreHandle, String> {
    StoreHandle::open(data_dir()).await
}
