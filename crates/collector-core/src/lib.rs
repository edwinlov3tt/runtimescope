//! `collector-core` — the shared library for the Rust RuntimeScope collector.
//!
//! Linked by both the standalone `collector-server` bin and the `mcp-server`
//! bin (ADR-0008: mcp-server embeds the collector in-process). Holds the wire
//! types, the event/session store, and the WS+HTTP server.
//!
//! Milestone 1 scope: in-memory store, network events, the slice query surface.
//! WAL/SQLite persistence, the full 19 event types, auth, and the command
//! channel widen this in later milestones.

pub mod event;
pub mod server;
pub mod store;

pub use server::{serve, SharedStore};
pub use store::Store;

use std::sync::{Arc, Mutex};

/// The collector version string reported by `/api/health`.
pub const VERSION: &str = "0.11.0-dev";

/// Default ports (overridable via RUNTIMESCOPE_PORT / RUNTIMESCOPE_HTTP_PORT).
pub const DEFAULT_WS_PORT: u16 = 6767;
pub const DEFAULT_HTTP_PORT: u16 = 6768;

/// Read a `u16` port from `env`, falling back to `default`.
pub fn port_from_env(var: &str, default: u16) -> u16 {
    std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Build a fresh shared store with the default ring-buffer capacity.
pub fn new_store() -> SharedStore {
    let cap = std::env::var("RUNTIMESCOPE_BUFFER_SIZE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000);
    Arc::new(Mutex::new(Store::new(cap)))
}
