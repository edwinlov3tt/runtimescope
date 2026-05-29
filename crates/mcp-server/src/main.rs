//! `mcp-server` — embeds collector-core in-process (ADR-0008) and exposes the
//! MCP tool surface over stdio JSON-RPC.
//!
//! `Mcp` holds the shared store + command hub. Tool families live under
//! `tools/` (one module + named router each); `Mcp::new` combines the routers.
//! The Milestone 3 fan-out adds family modules and one `+ Self::<family>_router()`
//! line each — see `tools/mod.rs` for the pattern.

mod tools;

use collector_core::{
    open_store, port_from_env, serve, CommandHub, StoreHandle, DEFAULT_HTTP_PORT, DEFAULT_WS_PORT, VERSION,
};
use rmcp::{
    handler::server::{tool::ToolRouter, ServerHandler},
    tool_handler,
    transport::stdio,
    ServiceExt,
};

#[derive(Clone)]
pub struct Mcp {
    pub store: StoreHandle,
    pub hub: CommandHub,
    tool_router: ToolRouter<Self>,
}

impl Mcp {
    fn new(store: StoreHandle, hub: CommandHub) -> Self {
        // Combine every family's router. M3 fan-out appends `+ Self::x_router()`.
        let tool_router = Self::core_router() + Self::status_router();
        Self { store, hub, tool_router }
    }
}

// Point the handler at the combined `tool_router` field (the macro default is
// `Self::tool_router()`, which we don't have — we merge named routers in new()).
#[tool_handler(router = self.tool_router)]
impl ServerHandler for Mcp {
    // Default get_info() advertises the tools capability (validated in the M0 spike).
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let ws_port = port_from_env("RUNTIMESCOPE_PORT", DEFAULT_WS_PORT);
    let http_port = port_from_env("RUNTIMESCOPE_HTTP_PORT", DEFAULT_HTTP_PORT);
    let store = open_store().await?;
    let hub = CommandHub::new();

    // Embed the collector in-process (ADR-0008): WS + HTTP run alongside MCP so
    // the command channel's send is an in-process call, and the tools read the
    // same store the SDK feeds.
    let serve_store = store.clone();
    let serve_hub = hub.clone();
    tokio::spawn(async move {
        if let Err(e) = serve(serve_store, serve_hub, ws_port, http_port, VERSION.to_string()).await {
            eprintln!("[RuntimeScope] embedded collector failed: {e}");
        }
    });

    // The conformance mcp-driver waits for this exact marker before sending
    // JSON-RPC (and only then attaches — see the harness note). Print it before
    // serve(stdio()) so initialize lands after the transport reader is up.
    eprintln!("[RuntimeScope] MCP server running on stdio");

    let service = Mcp::new(store, hub).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
