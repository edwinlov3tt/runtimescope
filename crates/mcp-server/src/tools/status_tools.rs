//! Status/session tools — proves router merge across files works.

use crate::tools::envelope;
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SessionArgs {
    project_id: Option<String>,
}

#[tool_router(router = status_router, vis = "pub")]
impl Mcp {
    #[tool(description = "Show connected SDK sessions and their apps — verify the SDK is reporting.")]
    async fn get_session_info(
        &self,
        Parameters(args): Parameters<SessionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sessions = self.store.sessions().await;
        let data: Vec<Value> = sessions
            .iter()
            .filter(|s| args.project_id.as_ref().is_none_or(|p| &s.project == p))
            .map(|s| {
                json!({
                    "sessionId": s.session_id,
                    "appName": s.app_name,
                    "projectName": s.project,
                    "isConnected": s.is_connected,
                })
            })
            .collect();
        let connected = data.iter().filter(|s| s["isConnected"] == json!(true)).count();
        let total = data.len();
        Ok(envelope(json!({
            "summary": format!("{total} session(s), {connected} connected."),
            "data": data,
            "issues": [],
            "metadata": { "eventCount": total, "projectId": args.project_id },
        })))
    }
}
