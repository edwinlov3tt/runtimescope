//! Core tools: network reads + the DOM-snapshot command-channel tool.

use crate::tools::envelope;
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct NetArgs {
    /// Scope results to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DomArgs {
    project_id: Option<String>,
    max_size: Option<u64>,
}

#[tool_router(router = core_router, vis = "pub")]
impl Mcp {
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
        Ok(envelope(json!({
            "summary": format!("Found {count} network request(s)."),
            "data": data,
            "issues": [],
            "metadata": { "eventCount": count, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Capture a live DOM snapshot from the connected SDK (server→SDK command channel).")]
    async fn get_dom_snapshot(
        &self,
        Parameters(args): Parameters<DomArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let session = self
            .store
            .sessions()
            .await
            .into_iter()
            .find(|s| s.is_connected && args.project_id.as_ref().is_none_or(|p| &s.project == p));

        let Some(session) = session else {
            return Ok(envelope(json!({
                "summary": "No active SDK session connected. Ensure the SDK is running in the browser.",
                "data": null,
                "issues": ["No active session"],
                "metadata": { "eventCount": 0, "sessionId": null, "projectId": args.project_id },
            })));
        };

        let params = json!({ "maxSize": args.max_size.unwrap_or(500_000) });
        match self.hub.send_command(&session.session_id, "capture_dom_snapshot", params).await {
            Ok(payload) => Ok(envelope(json!({
                "summary": "DOM snapshot captured.",
                "data": payload,
                "issues": [],
                "metadata": { "eventCount": 1, "sessionId": session.session_id, "projectId": args.project_id },
            }))),
            Err(e) => Ok(envelope(json!({
                "summary": format!("Failed to capture DOM snapshot: {e}"),
                "data": null,
                "issues": [e],
                "metadata": { "eventCount": 0, "sessionId": session.session_id, "projectId": args.project_id },
            }))),
        }
    }
}
