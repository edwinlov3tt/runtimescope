//! The WS + HTTP server, shared by both the standalone `collector-server` bin
//! and the `mcp-server` bin (which embeds it in-process per ADR-0008).
//!
//! Two axum apps on two ports (matching the Node collector): SDK WebSocket on
//! `ws_port` (default 6767), HTTP API on `http_port` (default 6768). All store
//! access is async (the store is the dedicated-thread `StoreHandle`).

use crate::auth::AuthManager;
use crate::command::CommandHub;
use crate::event::{
    event_type_of, is_valid_event_type, kind_to_event_type, project_of, EventBatch,
    HandshakePayload, WsMessage,
};
use crate::pm_discovery;
use crate::pm_store::PmStore;
use crate::store::StoreHandle;
use axum::{
    extract::{
        ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::sync::mpsc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Monotonic suffix so backfilled HTTP eventIds are unique even within one ms.
static HTTP_EVENT_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct AppState {
    store: StoreHandle,
    hub: CommandHub,
    pm: PmStore,
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
    hub: CommandHub,
    pm: PmStore,
    ws_port: u16,
    http_port: u16,
    version: String,
) -> std::io::Result<()> {
    let state = AppState {
        store,
        hub,
        pm,
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
        .route("/api/events", post(post_events))
        .route("/api/events/{kind}", get(events_by_kind))
        // pm/ project-manager surface (M5)
        .route("/api/pm/discover", post(pm_discover))
        .route("/api/pm/projects", get(pm_projects))
        .route("/api/pm/projects/{id}", get(pm_project_by_id))
        .route("/api/pm/sessions", get(pm_sessions))
        .route("/api/pm/sessions/{id}", get(pm_session_by_id))
        .route("/api/pm/workspaces", get(pm_workspaces))
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
                "projectId": si.project_id,
                "connectedAt": si.connected_at,
                "eventCount": 0,
                "isConnected": si.is_connected,
            })
        })
        .collect();
    let count = list.len();
    Json(json!({ "data": list, "count": count })).into_response()
}

/// Event read API: `/api/events/<kind>`, scoped by `?project_id=` + query
/// filters. `timeline` is a cross-type merge; other kinds map to one event type
/// (`renders`→`render`); an unknown kind → 404 (Node has explicit routes).
async fn events_by_kind(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project = q.get("project_id").map(String::as_str);

    if kind == "timeline" {
        let types = q.get("event_types").map(|s| {
            s.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect::<Vec<_>>()
        });
        let data = s.store.timeline(project, types).await;
        let count = data.len();
        return Json(json!({ "data": data, "count": count })).into_response();
    }

    let Some(event_type) = kind_to_event_type(&kind) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Not found", "path": format!("/api/events/{kind}") })),
        )
            .into_response();
    };

    let mut data = s.store.events_by_type(event_type, project).await;
    apply_filters(&mut data, &q);
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

/// Apply the read-API query filters Node supports, reading fields off the raw
/// event value. `status` is intentionally NOT a filter — Node's network route
/// doesn't forward it (locked by conformance).
fn apply_filters(data: &mut Vec<Value>, q: &HashMap<String, String>) {
    if let Some(since) = q.get("since_seconds").and_then(|v| v.parse::<i64>().ok()) {
        let cutoff = now_ms() - since * 1000;
        data.retain(|e| e.get("timestamp").and_then(Value::as_i64).is_none_or(|t| t >= cutoff));
    }
    if let Some(method) = q.get("method") {
        let want = method.to_ascii_uppercase();
        data.retain(|e| {
            e.get("method").and_then(Value::as_str).is_some_and(|m| m.to_ascii_uppercase() == want)
        });
    }
    if let Some(pat) = q.get("url_pattern") {
        data.retain(|e| e.get("url").and_then(Value::as_str).is_some_and(|u| u.contains(pat.as_str())));
    }
    if let Some(level) = q.get("level") {
        data.retain(|e| e.get("level").and_then(Value::as_str) == Some(level.as_str()));
    }
    if let Some(search) = q.get("search") {
        let needle = search.to_lowercase();
        data.retain(|e| {
            e.get("message").and_then(Value::as_str).is_some_and(|m| m.to_lowercase().contains(&needle))
        });
    }
    if let Some(sid) = q.get("session_id") {
        data.retain(|e| e.get("sessionId").and_then(Value::as_str) == Some(sid.as_str()));
    }
}

/// `POST /api/events` — HTTP ingest (the Workers SDK + Python SDK path).
/// Body: `{ sessionId, appName, projectId, events: [...] }`. Returns the ingest
/// receipt `{ accepted, dropped, rejected, sessionId }`; 200 if anything was
/// accepted, 429 if all were rejected, 400 on an empty/invalid payload.
async fn post_events(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Ok(payload) = serde_json::from_str::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body is not valid JSON" }))).into_response();
    };
    let events = payload.get("events").and_then(Value::as_array);
    let Some(events) = events.filter(|e| !e.is_empty()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Missing or empty events array" }))).into_response();
    };

    let session_id = payload.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
    let app_name = payload.get("appName").and_then(Value::as_str).unwrap_or("unknown").to_string();
    let project_id = payload.get("projectId").and_then(Value::as_str).map(String::from);
    // Event-scoping key (events.project, used by ?project_id= read filtering):
    // the projectId when present, else the appName.
    let project = project_id.clone().unwrap_or_else(|| app_name.clone());

    if !session_id.is_empty() {
        s.store.register_session(session_id.clone(), app_name, project_id).await;
    }

    let mut accepted_events: Vec<Value> = Vec::new();
    let mut rejected = 0usize;
    for ev in events {
        if !is_valid_event_type(&event_type_of(ev)) {
            rejected += 1;
            continue;
        }
        // Backfill the fields an HTTP client (Workers/Python SDK) may omit, so
        // events without an eventId aren't silently swallowed by INSERT OR IGNORE
        // (Node http-server.ts parity: generate eventId, default sessionId/timestamp).
        let mut ev = ev.clone();
        if let Some(obj) = ev.as_object_mut() {
            let blank = |o: &serde_json::Map<String, Value>, k: &str| {
                o.get(k).is_none_or(|v| v.is_null() || v.as_str() == Some(""))
            };
            if blank(obj, "eventId") {
                let seq = HTTP_EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
                obj.insert("eventId".into(), json!(format!("http-{}-{}", now_ms(), seq)));
            }
            if blank(obj, "sessionId") && !session_id.is_empty() {
                obj.insert("sessionId".into(), json!(session_id));
            }
            // Node treats a 0/absent timestamp as missing.
            if obj.get("timestamp").and_then(Value::as_i64).unwrap_or(0) == 0 {
                obj.insert("timestamp".into(), json!(now_ms()));
            }
        }
        accepted_events.push(ev);
    }
    let accepted = accepted_events.len();
    if accepted > 0 {
        if let Err(e) = s.store.add_batch(project, accepted_events).await {
            eprintln!("[RuntimeScope] POST /api/events: durability error: {e}");
        }
    }
    let status = if accepted > 0 { StatusCode::OK } else { StatusCode::TOO_MANY_REQUESTS };
    (status, Json(json!({ "accepted": accepted, "dropped": 0, "rejected": rejected, "sessionId": session_id }))).into_response()
}

/// Sessions grouped by app name (the dashboard's project list).
async fn projects(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    use std::collections::BTreeMap;
    // (sessions, anyConnected, projectId)
    let mut by_app: BTreeMap<String, (Vec<String>, bool, Option<String>)> = BTreeMap::new();
    for si in s.store.sessions().await {
        let entry = by_app.entry(si.app_name.clone()).or_default();
        entry.0.push(si.session_id);
        entry.1 |= si.is_connected;
        if entry.2.is_none() {
            entry.2 = si.project_id;
        }
    }
    let data: Vec<Value> = by_app
        .into_iter()
        .map(|(app, (sessions, connected, project_id))| {
            json!({ "appName": app, "sessions": sessions, "isConnected": connected, "projectId": project_id })
        })
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

// ---- pm/ project-manager routes (M5) ----

/// Trigger Claude project discovery (the over-discovery-filtered scan) + session
/// indexing. Runs on a blocking thread (fs + SQLite). Returns the DiscoveryResult.
async fn pm_discover(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let pm = s.pm.clone();
    let claude_base = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude");
    let result = tokio::task::spawn_blocking(move || pm_discovery::discover_claude_projects(&claude_base, &pm))
        .await
        .unwrap_or_default();
    Json(result).into_response()
}

async fn pm_projects(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let mut projects = s.pm.list_projects();
    if let Some(ws) = q.get("workspace_id") {
        projects.retain(|p| p.workspace_id.as_deref() == Some(ws.as_str()));
    }
    let count = projects.len();
    Json(json!({ "data": projects, "count": count })).into_response()
}

async fn pm_project_by_id(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    match s.pm.get_project(&id) {
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Project not found" }))).into_response(),
        Some(project) => {
            let stats = s.pm.session_stats(Some(&project.id));
            let mut obj = serde_json::to_value(&project).unwrap_or_else(|_| json!({}));
            if let Some(m) = obj.as_object_mut() {
                m.insert("stats".into(), serde_json::to_value(&stats).unwrap_or_else(|_| json!({})));
            }
            Json(obj).into_response()
        }
    }
}

async fn pm_sessions(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project_id = q.get("project_id").map(String::as_str);
    let limit: i64 = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(100);
    let offset: i64 = q.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);
    let sessions = s.pm.list_sessions(project_id, limit, offset);
    let total = s.pm.session_stats(project_id).total_sessions;
    let count = sessions.len();
    Json(json!({ "data": sessions, "count": count, "total": total })).into_response()
}

async fn pm_session_by_id(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    match s.pm.get_session(&id) {
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response(),
        Some(session) => Json(session).into_response(),
    }
}

async fn pm_workspaces(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    // No auth-key→workspace context here → return all (admin-equivalent), matching
    // Node's no-caller path. Per-workspace filtering arrives with the API-key auth path.
    Json(json!({ "data": s.pm.list_workspaces() })).into_response()
}

// ---- WebSocket ----

async fn ws_upgrade(ws: WebSocketUpgrade, State(s): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, s))
}

async fn handle_socket(socket: WebSocket, s: AppState) {
    // Split so the embedded collector can PUSH command frames to this SDK
    // (the command channel) while the read loop handles incoming frames.
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut session_id: Option<String> = None;
    let mut project: Option<String> = None;

    // Auth gate: when enabled, the first frame must be a valid authenticated
    // handshake within 5s. Two distinct rejections, each with an `error` frame
    // BEFORE the 4001 close (wire-protocol §3, audit #6) — the server SDK keys
    // off the code: AUTH_FAILED (bad/missing token) = permanent, don't retry;
    // AUTH_TIMEOUT (no handshake in time) = transient.
    if s.auth.enabled() {
        enum Gate { Ok(HandshakePayload), Failed, Timeout, Closed }
        let outcome = match tokio::time::timeout(Duration::from_secs(5), ws_stream.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => match parse_authed_handshake(&s, text.as_str()) {
                Some(h) => Gate::Ok(h),
                None => Gate::Failed, // a frame arrived but didn't authenticate
            },
            Ok(Some(Ok(_))) => Gate::Failed, // a non-text frame arrived first
            Ok(Some(Err(_))) | Ok(None) => Gate::Closed, // socket closed/errored
            Err(_) => Gate::Timeout, // 5s elapsed with no frame
        };
        match outcome {
            Gate::Ok(h) => {
                let proj = project_of(&h);
                session_id = Some(h.session_id.clone());
                project = Some(proj);
                s.store.register_session(h.session_id.clone(), h.app_name, h.project_id).await;
                s.hub.register(h.session_id, out_tx.clone());
            }
            Gate::Closed => {
                drop(out_tx);
                let _ = writer.await;
                return;
            }
            rejected => {
                let (code, message, reason) = match rejected {
                    Gate::Timeout => ("AUTH_TIMEOUT", "Handshake timeout", "Authentication timeout"),
                    _ => ("AUTH_FAILED", "Invalid or missing API key", "Authentication failed"),
                };
                let frame = json!({ "type": "error", "payload": { "code": code, "message": message }, "timestamp": 0 });
                let _ = out_tx.send(Message::Text(Utf8Bytes::from(frame.to_string())));
                let _ = out_tx.send(Message::Close(Some(CloseFrame { code: 4001, reason: reason.into() })));
                drop(out_tx);
                let _ = writer.await;
                return;
            }
        }
    }

    while let Some(Ok(msg)) = ws_stream.next().await {
        let Message::Text(text) = msg else { continue };
        // Parse as a raw value: command_response carries `requestId` as a
        // sibling of `payload`, not inside it.
        let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
        match v.get("type").and_then(Value::as_str).unwrap_or("") {
            "handshake" => {
                if let Ok(h) = serde_json::from_value::<HandshakePayload>(
                    v.get("payload").cloned().unwrap_or(Value::Null),
                ) {
                    let proj = project_of(&h);
                    session_id = Some(h.session_id.clone());
                    project = Some(proj);
                    s.store.register_session(h.session_id.clone(), h.app_name, h.project_id).await;
                    s.hub.register(h.session_id, out_tx.clone());
                }
            }
            "event" => {
                if let (Ok(batch), Some(proj)) = (
                    serde_json::from_value::<EventBatch>(v.get("payload").cloned().unwrap_or(Value::Null)),
                    project.clone(),
                ) {
                    if let Err(e) = s.store.add_batch(proj, batch.events).await {
                        eprintln!("[RuntimeScope] WS ingest: durability error: {e}");
                    }
                }
            }
            "command_response" => {
                if let Some(req_id) = v.get("requestId").and_then(Value::as_str) {
                    s.hub.handle_response(req_id, v.get("payload").cloned().unwrap_or(Value::Null));
                }
            }
            _ => {}
        }
    }

    if let Some(sid) = session_id {
        s.store.mark_disconnected(sid.clone()).await;
        s.hub.unregister(&sid);
    }
    drop(out_tx);
    let _ = writer.await;
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
