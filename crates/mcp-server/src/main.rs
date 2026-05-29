//! `mcp-server` — embeds collector-core in-process (ADR-0008) and exposes the
//! MCP tool surface over stdio JSON-RPC.
//!
//! Milestone 1 slice: one tool (`get_network_requests`) reading the shared,
//! in-process store. The remaining 62 tools fan out in Milestone 3 onto this
//! exact pattern (rmcp `#[tool]` + schemars-derived args + the standard envelope).

use collector_core::{open_store, port_from_env, serve, StoreHandle, DEFAULT_HTTP_PORT, DEFAULT_WS_PORT, VERSION};
use rmcp::{
    handler::server::{tool::ToolRouter, wrapper::Parameters, ServerHandler},
    model::{CallToolResult, Content},
    tool, tool_handler, tool_router,
    transport::stdio,
    ErrorData, ServiceExt,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone)]
struct Mcp {
    store: StoreHandle,
    // Read by the #[tool_router]/#[tool_handler] macro-generated code, not by
    // hand — the dead-code lint can't see through the macro.
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct NetArgs {
    /// Scope results to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
}

#[tool_router]
impl Mcp {
    fn new(store: StoreHandle) -> Self {
        Self { store, tool_router: Self::tool_router() }
    }

    #[tool(description = "Get captured network (fetch) requests from the running app. Returns URL, method, status, and timing.")]
    async fn get_network_requests(
        &self,
        Parameters(args): Parameters<NetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = self.store.events_by_type("network", args.project_id.as_deref()).await;
        let data: Vec<Value> = events
            .iter()
            .map(|e| {
                json!({
                    "url": e.get("url"),
                    "method": e.get("method"),
                    "status": e.get("status"),
                    "duration": e.get("duration"),
                })
            })
            .collect();
        let count = data.len();
        let envelope = json!({
            "summary": format!("Found {count} network request(s)."),
            "data": data,
            "issues": [],
            "metadata": { "eventCount": count, "projectId": args.project_id },
        });
        Ok(CallToolResult::success(vec![Content::text(envelope.to_string())]))
    }
}

#[tool_handler]
impl ServerHandler for Mcp {
    // Default get_info() advertises the tools capability (validated in the M0 spike).
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let ws_port = port_from_env("RUNTIMESCOPE_PORT", DEFAULT_WS_PORT);
    let http_port = port_from_env("RUNTIMESCOPE_HTTP_PORT", DEFAULT_HTTP_PORT);
    let store = open_store().await?;

    // Embed the collector in-process (ADR-0008): WS + HTTP run alongside MCP so
    // the (future) command channel's send is an in-process call, and the tools
    // read the same store the SDK feeds.
    let serve_store = store.clone();
    tokio::spawn(async move {
        if let Err(e) = serve(serve_store, ws_port, http_port, VERSION.to_string()).await {
            eprintln!("[RuntimeScope] embedded collector failed: {e}");
        }
    });

    // The conformance mcp-driver waits for this exact marker before sending
    // JSON-RPC (and only then attaches — see the harness note). Print it before
    // serve(stdio()) so initialize lands after the transport reader is up.
    eprintln!("[RuntimeScope] MCP server running on stdio (1 tool — Milestone 1 slice)");

    let service = Mcp::new(store).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
