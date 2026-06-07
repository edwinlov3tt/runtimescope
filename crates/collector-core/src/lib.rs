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

/// The data directory: `$HOME/.runtimescope` (the conformance harness sets HOME
/// to an isolated temp dir, so a restart-at-same-HOME finds the prior data).
pub fn data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".runtimescope")
}

/// Open the persistent store (runs WAL recovery before returning).
pub async fn open_store() -> Result<StoreHandle, String> {
    StoreHandle::open(data_dir()).await
}
