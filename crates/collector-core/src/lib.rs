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

pub mod auth;
pub mod command;
pub mod event;
pub mod pm_discovery;
pub mod pm_session_parser;
pub mod pm_store;
pub mod server;
pub mod store;
pub mod wal;

pub use command::CommandHub;
pub use pm_store::PmStore;
pub use server::serve;
pub use store::StoreHandle;

use std::path::PathBuf;

/// The collector version string reported by `/api/health`.
pub const VERSION: &str = "0.11.0-dev";

/// Default ports (overridable via RUNTIMESCOPE_PORT / RUNTIMESCOPE_HTTP_PORT).
pub const DEFAULT_WS_PORT: u16 = 6767;
pub const DEFAULT_HTTP_PORT: u16 = 6768;

/// Read a `u16` port from `env`, falling back to `default`.
pub fn port_from_env(var: &str, default: u16) -> u16 {
    std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
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
