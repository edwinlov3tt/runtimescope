//! Wire types — the SDK↔collector envelope and handshake.
//!
//! Locked by `docs/specs/wire-protocol.md`. For the Milestone 1 vertical slice
//! we keep individual events as raw `serde_json::Value` (the store is shape-
//! agnostic); the strongly-typed per-EventType structs land as the slice widens.

use serde::Deserialize;
use serde_json::Value;

/// Every WS frame: `{ type, payload, timestamp, sessionId }` (wire-protocol §2).
#[derive(Debug, Clone, Deserialize)]
pub struct WsMessage {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
}

/// Handshake payload — first frame (wire-protocol §3).
#[derive(Debug, Clone, Deserialize)]
pub struct HandshakePayload {
    #[serde(rename = "appName")]
    pub app_name: String,
    #[serde(rename = "sdkVersion", default)]
    pub sdk_version: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "projectId", default)]
    pub project_id: Option<String>,
    #[serde(rename = "authToken", default)]
    pub auth_token: Option<String>,
}

/// Event-batch payload — `{ events: [...] }` (wire-protocol §4).
#[derive(Debug, Clone, Deserialize)]
pub struct EventBatch {
    #[serde(default)]
    pub events: Vec<Value>,
}

/// The project name a handshake binds to: explicit `projectId`, else `appName`.
pub fn project_of(h: &HandshakePayload) -> String {
    h.project_id.clone().unwrap_or_else(|| h.app_name.clone())
}

/// Pull the `eventType` discriminant out of a raw event value (SDK sends
/// `eventType`; some paths use `type`). Defaults to "unknown".
pub fn event_type_of(v: &Value) -> String {
    v.get("eventType")
        .or_else(|| v.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}
