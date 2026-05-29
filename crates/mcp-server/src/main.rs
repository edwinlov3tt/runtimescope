//! `mcp-server` — embeds collector-core in-process (ADR-0008) and exposes the
//! MCP tool surface over stdio JSON-RPC.
//!
//! M1/M2 slice + command channel: get_network_requests (store read) and
//! get_dom_snapshot (server→SDK command channel via CommandHub). The remaining
//! ~61 tools fan out in Milestone 3 onto this exact pattern (rmcp `#[tool]` +
//! schemars-derived args + the standard `{summary,data,issues,metadata}` envelope,
//! reading `self.store` / driving `self.hub`).

use collector_core::{
    open_store, port_from_env, serve, CommandHub, StoreHandle, DEFAULT_HTTP_PORT, DEFAULT_WS_PORT, VERSION,
};
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
    hub: CommandHub,
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

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DomArgs {
    project_id: Option<String>,
    max_size: Option<u64>,
}

#[tool_router]
impl Mcp {
    fn new(store: StoreHandle, hub: CommandHub) -> Self {
        Self { store, hub, tool_router: Self::tool_router() }
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

    #[tool(description = "Capture a live DOM snapshot from the connected SDK (server→SDK command channel).")]
    async fn get_dom_snapshot(
        &self,
        Parameters(args): Parameters<DomArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Pick a connected session (optionally project-scoped).
        let session = self
            .store
            .sessions()
            .await
            .into_iter()
            .find(|s| s.is_connected && args.project_id.as_ref().is_none_or(|p| &s.project == p));

        let Some(session) = session else {
            let env = json!({
                "summary": "No active SDK session connected. Ensure the SDK is running in the browser.",
                "data": null,
                "issues": ["No active session"],
                "metadata": { "eventCount": 0, "sessionId": null, "projectId": args.project_id },
            });
            return Ok(CallToolResult::success(vec![Content::text(env.to_string())]));
        };

        let params = json!({ "maxSize": args.max_size.unwrap_or(500_000) });
        match self.hub.send_command(&session.session_id, "capture_dom_snapshot", params).await {
            Ok(payload) => {
                let env = json!({
                    "summary": "DOM snapshot captured.",
                    "data": payload,
                    "issues": [],
                    "metadata": { "eventCount": 1, "sessionId": session.session_id, "projectId": args.project_id },
                });
                Ok(CallToolResult::success(vec![Content::text(env.to_string())]))
            }
            Err(e) => {
                let env = json!({
                    "summary": format!("Failed to capture DOM snapshot: {e}"),
                    "data": null,
                    "issues": [e],
                    "metadata": { "eventCount": 0, "sessionId": session.session_id, "projectId": args.project_id },
                });
                Ok(CallToolResult::success(vec![Content::text(env.to_string())]))
            }
        }
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
    eprintln!("[RuntimeScope] MCP server running on stdio (2 tools — M1/M2 slice + command channel)");

    let service = Mcp::new(store, hub).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
