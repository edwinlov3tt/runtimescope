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

pub mod core_tools;
pub mod status_tools;

use rmcp::model::{CallToolResult, Content};
use serde_json::Value;

/// Wrap a JSON envelope as the single text-content result every tool returns.
pub fn envelope(v: Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(v.to_string())])
}
