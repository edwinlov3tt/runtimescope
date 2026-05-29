//! The WS + HTTP server, shared by both the standalone `collector-server` bin
//! and the `mcp-server` bin (which embeds it in-process per ADR-0008).
//!
//! Two axum apps on two ports (matching the Node collector): SDK WebSocket on
//! `ws_port` (default 6767), HTTP API on `http_port` (default 6768). All store
//! access is async (the store is the dedicated-thread `StoreHandle`).

use crate::event::{project_of, EventBatch, HandshakePayload, WsMessage};
use crate::store::StoreHandle;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{StatusCode, Uri},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct AppState {
    store: StoreHandle,
    started: Instant,
    version: String,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Bind both ports and serve forever. Returns only on bind error.
pub async fn serve(
    store: StoreHandle,
    ws_port: u16,
    http_port: u16,
    version: String,
) -> std::io::Result<()> {
    let state = AppState { store, started: Instant::now(), version };

    let http = Router::new()
        .route("/readyz", get(readyz))
        .route("/api/health", get(health))
        .route("/api/sessions", get(sessions))
        .route("/api/events/network", get(events_network))
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
        "authEnabled": false,
    }))
}

async fn sessions(State(s): State<AppState>) -> impl IntoResponse {
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
    Json(json!({ "data": list, "count": count }))
}

async fn events_network(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let project = q.get("project_id").map(String::as_str);
    let data = s.store.events_by_type("network", project).await;
    let count = data.len();
    Json(json!({ "data": data, "count": count }))
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
