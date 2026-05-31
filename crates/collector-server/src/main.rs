//! `collector-server` — the standalone daemon (launchd / `runtimescope service`).
//! WS + HTTP, no MCP. This is the tray's backend.
//!
//! Milestone 1 slice: boots the in-memory collector and serves the wire surface.
//! Honors RUNTIMESCOPE_PORT / RUNTIMESCOPE_HTTP_PORT (the conformance harness
//! sets these and waits for /readyz).

use collector_core::{
    data_dir, open_store, port_from_env, serve, AuthMode, CommandHub, PmStore, DEFAULT_HTTP_PORT,
    DEFAULT_WS_PORT, VERSION,
};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let ws_port = port_from_env("RUNTIMESCOPE_PORT", DEFAULT_WS_PORT);
    let http_port = port_from_env("RUNTIMESCOPE_HTTP_PORT", DEFAULT_HTTP_PORT);

    let store = open_store()
        .await
        .map_err(|e| std::io::Error::other(format!("store init failed: {e}")))?;
    let pm = PmStore::open(&data_dir().join("pm.db"))
        .map_err(|e| std::io::Error::other(format!("pm store init failed: {e}")))?;

    eprintln!("[RuntimeScope] collector-server (rust {VERSION})");
    eprintln!("[RuntimeScope]   WebSocket: ws://127.0.0.1:{ws_port}");
    eprintln!("[RuntimeScope]   HTTP API:  http://127.0.0.1:{http_port}");

    // Standalone daemon has no MCP, so the command hub is unused here (sessions
    // still register; commands simply never get issued). Standalone auth mode:
    // honors RUNTIMESCOPE_AUTH_TOKEN (Node parity, standalone.ts).
    serve(store, CommandHub::new(), pm, ws_port, http_port, VERSION.to_string(), AuthMode::Standalone)
        .await
}
