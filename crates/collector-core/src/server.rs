//! The WS + HTTP server, shared by both the standalone `collector-server` bin
//! and the `mcp-server` bin (which embeds it in-process per ADR-0008).
//!
//! Two axum apps on two ports (matching the Node collector): SDK WebSocket on
//! `ws_port` (default 6767), HTTP API on `http_port` (default 6768). All store
//! access is async (the store is the dedicated-thread `StoreHandle`).

use crate::auth::AuthManager;
use crate::event::{project_of, EventBatch, HandshakePayload, WsMessage};
use crate::store::StoreHandle;
use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct AppState {
    store: StoreHandle,
    auth: AuthManager,
    started: Instant,
    version: String,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Bind both ports and serve forever. Returns only on bind error. Auth is read
/// from `RUNTIMESCOPE_AUTH_TOKEN` (off when unset).
pub async fn serve(
    store: StoreHandle,
    ws_port: u16,
    http_port: u16,
    version: String,
) -> std::io::Result<()> {
    let state = AppState {
        store,
        auth: AuthManager::from_env(),
        started: Instant::now(),
        version,
    };

    let http = Router::new()
        // public (no auth even when enabled)
        .route("/readyz", get(readyz))
        .route("/api/health", get(health))
        .route("/metrics", get(metrics))
        // gated
        .route("/api/sessions", get(sessions))
        .route("/api/projects", get(projects))
        .route("/api/events/{kind}", get(events_by_kind))
        .fallback(not_found)
        .with_state(state.clone());

    let ws = Router::new().route("/", get(ws_upgrade)).with_state(state);

    let http_listener = tokio::net::TcpListener::bind(("127.0.0.1", http_port)).await?;
    let ws_listener = tokio::net::TcpListener::bind(("127.0.0.1", ws_port)).await?;

    tokio::try_join!(
        async { axum::serve(http_listener, http).await },
        async { axum::serve(ws_listener, ws).await },
    )?;
    Ok(())
}

/// Gate check for the non-public HTTP routes.
fn http_authorized(s: &AppState, headers: &HeaderMap) -> bool {
    if !s.auth.enabled() {
        return true;
    }
    let presented = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    s.auth.authorized(AuthManager::extract_bearer(presented))
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized" }))).into_response()
}

// ---- HTTP handlers ----

async fn readyz() -> impl IntoResponse {
    Json(json!({ "status": "ready", "timestamp": now_ms() }))
}

async fn health(State(s): State<AppState>) -> impl IntoResponse {
    let connected = s.store.connected_count().await;
    Json(json!({
        "status": "ok",
        "version": s.version,
        "timestamp": now_ms(),
        "uptime": s.started.elapsed().as_secs(),
        "sessions": connected,
        "authEnabled": s.auth.enabled(),
    }))
}

async fn metrics() -> impl IntoResponse {
    let body = "# RuntimeScope collector metrics\nruntimescope_up 1\n";
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
}

async fn sessions(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let list: Vec<Value> = s
        .store
        .sessions()
        .await
        .into_iter()
        .map(|si| {
            json!({
                "sessionId": si.session_id,
                "appName": si.app_name,
                "projectName": si.project,
                "isConnected": si.is_connected,
            })
        })
        .collect();
    let count = list.len();
    Json(json!({ "data": list, "count": count })).into_response()
}

/// Generic event read API: `/api/events/<kind>`, scoped by `?project_id=`.
/// The store is type-agnostic, so one handler serves every family. The only
/// route↔type quirk is `renders` → eventType `render` (matching the Node API).
async fn events_by_kind(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let event_type = match kind.as_str() {
        "renders" => "render",
        other => other,
    };
    let project = q.get("project_id").map(String::as_str);
    let data = s.store.events_by_type(event_type, project).await;
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

/// Sessions grouped by app name (the dashboard's project list).
async fn projects(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    use std::collections::BTreeMap;
    let mut by_app: BTreeMap<String, (Vec<String>, bool)> = BTreeMap::new();
    for si in s.store.sessions().await {
        let entry = by_app.entry(si.app_name.clone()).or_default();
        entry.0.push(si.session_id);
        entry.1 |= si.is_connected;
    }
    let data: Vec<Value> = by_app
        .into_iter()
        .map(|(app, (sessions, connected))| json!({ "appName": app, "sessions": sessions, "isConnected": connected }))
        .collect();
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

async fn not_found(uri: Uri) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "Not found", "path": uri.path() })),
    )
}

// ---- WebSocket ----

async fn ws_upgrade(ws: WebSocketUpgrade, State(s): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, s))
}

async fn handle_socket(mut socket: WebSocket, s: AppState) {
    let mut session_id: Option<String> = None;
    let mut project: Option<String> = None;

    // Auth gate: when enabled, the first frame must be a valid authenticated
    // handshake within 5s, else close with WS code 4001 (wire-protocol §3).
    if s.auth.enabled() {
        let authed = match tokio::time::timeout(Duration::from_secs(5), socket.recv()).await {
            Ok(Some(Ok(Message::Text(text)))) => parse_authed_handshake(&s, text.as_str()),
            _ => None,
        };
        match authed {
            Some(h) => {
                let proj = project_of(&h);
                session_id = Some(h.session_id.clone());
                project = Some(proj.clone());
                s.store.register_session(h.session_id, h.app_name, proj).await;
            }
            None => {
                let _ = socket
                    .send(Message::Close(Some(CloseFrame {
                        code: 4001,
                        reason: "Authentication timeout".into(),
                    })))
                    .await;
                return;
            }
        }
    }

    while let Some(Ok(msg)) = socket.recv().await {
        let Message::Text(text) = msg else { continue };
        let Ok(m) = serde_json::from_str::<WsMessage>(text.as_str()) else { continue };
        match m.kind.as_str() {
            "handshake" => {
                if let Ok(h) = serde_json::from_value::<HandshakePayload>(m.payload.clone()) {
                    let proj = project_of(&h);
                    session_id = Some(h.session_id.clone());
                    project = Some(proj.clone());
                    s.store.register_session(h.session_id, h.app_name, proj).await;
                }
            }
            "event" => {
                if let (Ok(batch), Some(proj)) =
                    (serde_json::from_value::<EventBatch>(m.payload.clone()), project.clone())
                {
                    s.store.add_batch(proj, batch.events).await;
                }
            }
            _ => {}
        }
    }

    if let Some(sid) = session_id {
        s.store.mark_disconnected(sid).await;
    }
}

/// Parse a text frame as a handshake and return it only if its `authToken` is
/// authorized. Used for the auth-on first-frame gate.
fn parse_authed_handshake(s: &AppState, text: &str) -> Option<HandshakePayload> {
    let m = serde_json::from_str::<WsMessage>(text).ok()?;
    if m.kind != "handshake" {
        return None;
    }
    let h = serde_json::from_value::<HandshakePayload>(m.payload).ok()?;
    if s.auth.authorized(h.auth_token.as_deref()) {
        Some(h)
    } else {
        None
    }
}
