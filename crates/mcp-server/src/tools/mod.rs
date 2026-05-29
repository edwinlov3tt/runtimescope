//! MCP tool families. Each family is its own module with a named rmcp router
//! (`#[tool_router(router = <name>_router, vis = "pub")]`); `main` combines them
//! into `Mcp`'s router. This is the seam the Milestone 3 fan-out fills — one
//! file per family, no shared-file contention.
//!
//! Pattern for a new family file (`tools/<family>.rs`):
//! ```ignore
//! use crate::Mcp;
//! use crate::tools::envelope;
//! use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
//! use serde::Deserialize;
//! use serde_json::json;
//!
//! #[derive(Debug, Deserialize, schemars::JsonSchema)]
//! pub struct FooArgs { project_id: Option<String> }
//!
//! #[tool_router(router = foo_router, vis = "pub")]
//! impl Mcp {
//!     #[tool(description = "...")]
//!     async fn get_foo(&self, Parameters(a): Parameters<FooArgs>) -> Result<CallToolResult, ErrorData> {
//!         let events = self.store.events_by_type("foo", a.project_id.as_deref()).await;
//!         Ok(envelope(json!({ "summary": "...", "data": events, "issues": [],
//!             "metadata": { "eventCount": events.len(), "projectId": a.project_id } })))
//!     }
//! }
//! ```
//! Then add `pub mod <family>;` here and `+ Self::foo_router()` in `Mcp::new`.

pub mod api_discovery;
pub mod core_tools;
pub mod database;
pub mod diagnostics;
pub mod event_reads;
pub mod process_infra;
pub mod recon;
pub mod sessions_history;
pub mod setup_workspaces;
pub mod status_tools;

use rmcp::model::{CallToolResult, Content};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

/// Wrap a JSON envelope as the single text-content result every tool returns.
pub fn envelope(v: Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(v.to_string())])
}

/// Current time in ms since epoch.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// ms epoch → ISO-8601 with millis + `Z`, matching JS `new Date(ms).toISOString()`.
/// The MCP tool layer reshapes stored numeric timestamps to ISO strings; use this
/// everywhere a tool surfaces a timestamp (audit #2).
pub fn iso_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
