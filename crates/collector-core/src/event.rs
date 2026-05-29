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

/// The wire event types the collector accepts (wire-protocol §4). `POST
/// /api/events` rejects events whose `eventType` isn't in this set.
pub const VALID_EVENT_TYPES: &[&str] = &[
    "network", "console", "session", "state", "render", "dom_snapshot",
    "performance", "database", "custom", "navigation", "ui",
    "recon_metadata", "recon_design_tokens", "recon_fonts", "recon_layout_tree",
    "recon_accessibility", "recon_computed_styles", "recon_element_snapshot",
    "recon_asset_inventory",
];

pub fn is_valid_event_type(t: &str) -> bool {
    VALID_EVENT_TYPES.contains(&t)
}

/// The HTTP `/api/events/<kind>` routes Node exposes, mapped to their event
/// type. `renders` → `render` is the one route↔type mismatch. `timeline` is
/// handled separately (a cross-type merge). Anything else → 404.
pub fn kind_to_event_type(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "network" => "network",
        "console" => "console",
        "state" => "state",
        "renders" => "render",
        "performance" => "performance",
        "database" => "database",
        "custom" => "custom",
        "ui" => "ui",
        "navigation" => "navigation",
        _ => return None,
    })
}
