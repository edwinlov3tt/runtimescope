//! The WS + HTTP server, shared by both the standalone `collector-server` bin
//! and the `mcp-server` bin (which embeds it in-process per ADR-0008).
//!
//! Two axum apps on two ports (matching the Node collector): SDK WebSocket on
//! `ws_port` (default 6767), HTTP API on `http_port` (default 6768). All store
//! access is async (the store is the dedicated-thread `StoreHandle`).

use crate::auth::{AuthManager, AuthMode};
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
    routing::{get, post, put},
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

/// Bind both ports and serve forever. Returns only on bind error. Auth is
/// constructed per `auth_mode` ([`AuthMode::Standalone`] for `collector-server`,
/// [`AuthMode::Mcp`] for `mcp-server`) so each binary matches its Node reference.
pub async fn serve(
    store: StoreHandle,
    hub: CommandHub,
    pm: PmStore,
    ws_port: u16,
    http_port: u16,
    version: String,
    auth_mode: AuthMode,
) -> std::io::Result<()> {
    let state = AppState {
        store,
        hub,
        pm,
        auth: AuthManager::for_mode(auth_mode),
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
        .route(
            "/api/pm/projects/{id}",
            get(pm_project_by_id).put(pm_update_project).delete(pm_delete_project),
        )
        .route("/api/pm/projects/{id}/workspace", put(pm_set_project_workspace))
        .route("/api/pm/sessions", get(pm_sessions))
        .route("/api/pm/sessions/{id}", get(pm_session_by_id))
        .route("/api/pm/workspaces", get(pm_workspaces).post(pm_create_workspace))
        .route(
            "/api/pm/workspaces/{id}",
            get(pm_workspace_by_id).put(pm_update_workspace).delete(pm_delete_workspace),
        )
        .route("/api/pm/workspaces/{id}/api-keys", post(pm_create_api_key))
        .route("/api/pm/api-keys/{prefix}", axum::routing::delete(pm_revoke_api_key))
        // capex + categories (M5.5 Slice A)
        .route("/api/pm/categories", get(pm_categories))
        .route("/api/pm/capex-all", get(pm_capex_all))
        .route("/api/pm/capex-report-all", get(pm_capex_report_all))
        .route("/api/pm/capex-report/{projectId}", get(pm_capex_report))
        .route("/api/pm/capex/{projectId}", get(pm_capex_list))
        .route("/api/pm/capex/{projectId}/summary", get(pm_capex_summary))
        .route("/api/pm/capex/{projectId}/export", get(pm_capex_export))
        .route("/api/pm/capex/{projectId}/{entryId}", put(pm_capex_update))
        .route("/api/pm/capex/{projectId}/{entryId}/confirm", post(pm_capex_confirm))
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
    let rs_base = crate::data_dir();
    let result = tokio::task::spawn_blocking(move || {
        // Claude-project discovery (the over-discovery-filtered scan) + the
        // RuntimeScope-project discovery (~/.runtimescope/projects), summed.
        let mut r = pm_discovery::discover_claude_projects(&claude_base, &pm);
        let r2 = crate::discover_runtimescope_projects(&rs_base, &pm);
        r.projects_discovered += r2.projects_discovered;
        r.projects_updated += r2.projects_updated;
        r.sessions_discovered += r2.sessions_discovered;
        r.sessions_updated += r2.sessions_updated;
        r.errors.extend(r2.errors);
        r
    })
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

// ---- pm/ write routes (M5 fast-follow: capex-and-write-crud) ----
//
// All gated by `http_authorized`. In the embedded MCP path auth is disabled,
// which Node treats as the admin/local-trust caller (`isAdmin = !authEnabled`),
// so the admin-only routes (create/delete workspace) pass exactly as in Node.
// Per-workspace (`tk_`-scoped) authz refinement is a follow-up; here auth-on
// gates the whole surface like the existing read routes.

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

/// POST /api/pm/workspaces — create a workspace (Node: admin-only). 201 + the
/// workspace JSON; 400 on missing name / duplicate slug.
async fn pm_create_workspace(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if body.is_empty() {
        return bad_request("Missing body");
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    let name = parsed.get("name").and_then(Value::as_str);
    let Some(name) = name else {
        return bad_request("Missing name");
    };
    let slug = parsed.get("slug").and_then(Value::as_str);
    let description = parsed.get("description").and_then(Value::as_str);
    match s.pm.create_workspace(name, slug, description) {
        Ok(ws) => (StatusCode::CREATED, Json(serde_json::to_value(&ws).unwrap())).into_response(),
        Err(e) => bad_request(&e),
    }
}

/// GET /api/pm/workspaces/{id} — single workspace; 404 when absent.
async fn pm_workspace_by_id(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    match s.pm.list_workspaces().into_iter().find(|w| w.id == id) {
        Some(ws) => Json(serde_json::to_value(&ws).unwrap()).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Workspace not found" }))).into_response(),
    }
}

/// PUT /api/pm/workspaces/{id} — patch name/slug/description; returns the updated
/// workspace (Node returns `getWorkspace(id)`); 404 when absent, 400 on bad body.
async fn pm_update_workspace(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if s.pm.list_workspaces().iter().all(|w| w.id != id) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Workspace not found" }))).into_response();
    }
    if body.is_empty() {
        return bad_request("Missing body");
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    s.pm.update_workspace(
        &id,
        parsed.get("name").and_then(Value::as_str),
        parsed.get("slug").and_then(Value::as_str),
        parsed.get("description").and_then(Value::as_str),
    );
    match s.pm.list_workspaces().into_iter().find(|w| w.id == id) {
        Some(ws) => Json(serde_json::to_value(&ws).unwrap()).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Workspace not found" }))).into_response(),
    }
}

/// DELETE /api/pm/workspaces/{id} — reassign projects + wipe keys (Node:
/// admin-only). `{ ok: true }`; 400 when targeting the default.
async fn pm_delete_workspace(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    match s.pm.delete_workspace(&id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => bad_request(&e),
    }
}

/// POST /api/pm/workspaces/{id}/api-keys — mint a workspace-scoped `tk_` key.
/// 201 + the raw secret ONCE (Node returns `{ key, keyPrefix, keyLast4, ... }`);
/// 404 when the workspace is absent, 400 on missing label.
async fn pm_create_api_key(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if s.pm.list_workspaces().iter().all(|w| w.id != id) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Workspace not found" }))).into_response();
    }
    if body.is_empty() {
        return bad_request("Missing body");
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    let Some(label) = parsed.get("label").and_then(Value::as_str) else {
        return bad_request("Missing label");
    };
    let expires_at = parsed.get("expires_at").and_then(Value::as_i64);
    match s.pm.create_api_key(&id, label, expires_at) {
        Ok(k) => {
            // Mirror Node's create response shape exactly (raw `key` appears once).
            let mut body = json!({
                "key": k.key,
                "keyPrefix": k.key_prefix,
                "keyLast4": k.key_last4,
                "workspaceId": k.workspace_id,
                "label": k.label,
                "createdAt": k.created_at,
            });
            if let Some(e) = k.expires_at {
                body.as_object_mut().unwrap().insert("expiresAt".into(), json!(e));
            }
            (StatusCode::CREATED, Json(body)).into_response()
        }
        Err(e) => bad_request(&e),
    }
}

/// DELETE /api/pm/api-keys/{prefix} — revoke by public prefix. `{ ok: true }`;
/// 404 when no live key has that prefix.
async fn pm_revoke_api_key(State(s): State<AppState>, headers: HeaderMap, Path(prefix): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if s.pm.find_api_key_by_prefix(&prefix).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Key not found" }))).into_response();
    }
    s.pm.revoke_api_key(&prefix);
    Json(json!({ "ok": true })).into_response()
}

/// PUT /api/pm/projects/{id} — patch the project's mutable PM fields. `{ ok: true }`
/// (Node returns the same); 400 on bad JSON.
async fn pm_update_project(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if body.is_empty() {
        return bad_request("Body required");
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    // runtimeApps is a JSON array on the wire → store the JSON-encoded text (mirrors
    // Node's `runtime_apps` TEXT column; empty array → null is Node's rule but here
    // we only set when provided).
    let runtime_apps_json = parsed.get("runtimeApps").and_then(|v| v.as_array()).map(|_| {
        serde_json::to_string(parsed.get("runtimeApps").unwrap()).unwrap_or_default()
    });
    s.pm.update_project(
        &id,
        parsed.get("name").and_then(Value::as_str),
        parsed.get("phase").and_then(Value::as_str),
        parsed.get("projectStatus").and_then(Value::as_str),
        parsed.get("sdkInstalled").and_then(Value::as_bool),
        runtime_apps_json.as_deref(),
        parsed.get("runtimescopeProject").and_then(Value::as_str),
        parsed.get("managementAuthorized").and_then(Value::as_bool),
        parsed.get("probableToComplete").and_then(Value::as_bool),
    );
    Json(json!({ "ok": true })).into_response()
}

/// DELETE /api/pm/projects/{id} — blocklist + cascade-delete. 404 when absent;
/// `{ ok: true, deleted: <name> }` (matches Node).
async fn pm_delete_project(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(project) = s.pm.get_project(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Project not found" }))).into_response();
    };
    s.pm.delete_project(&id);
    Json(json!({ "ok": true, "deleted": project.name })).into_response()
}

/// PUT /api/pm/projects/{id}/workspace — move a project between workspaces.
/// `{ ok: true }`; 400 missing body/workspace_id, 404 unknown project.
async fn pm_set_project_workspace(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if body.is_empty() {
        return bad_request("Missing body");
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    let Some(workspace_id) = parsed.get("workspace_id").and_then(Value::as_str) else {
        return bad_request("Missing workspace_id");
    };
    if s.pm.get_project(&id).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Project not found" }))).into_response();
    }
    if s.pm.list_workspaces().iter().all(|w| w.id != workspace_id) {
        return bad_request(&format!("Workspace {workspace_id} does not exist"));
    }
    s.pm.set_project_workspace(&id, workspace_id);
    Json(json!({ "ok": true })).into_response()
}

// ---- pm/ capex + categories (M5.5 Slice A) ----

/// A `text/csv` download response with the given attachment filename.
fn csv_response(filename: &str, body: String) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/csv".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}\"")),
        ],
        body,
    )
        .into_response()
}

/// GET /api/pm/capex/{projectId} (?month=&confirmed=0|1) — ports Node's filtered list.
async fn pm_capex_list(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let month = q.get("month").map(String::as_str);
    // Node: '1' → true, '0' → false, anything else → undefined.
    let confirmed = match q.get("confirmed").map(String::as_str) {
        Some("1") => Some(true),
        Some("0") => Some(false),
        _ => None,
    };
    let entries = s.pm.list_capex_entries_filtered(&project_id, month, confirmed);
    let count = entries.len();
    Json(json!({ "data": entries, "count": count })).into_response()
}

/// GET /api/pm/capex/{projectId}/summary (?start_date=&end_date=).
async fn pm_capex_summary(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let summary = s.pm.get_capex_summary(
        &project_id,
        q.get("start_date").map(String::as_str),
        q.get("end_date").map(String::as_str),
    );
    Json(serde_json::to_value(&summary).unwrap_or_else(|_| json!({}))).into_response()
}

/// PUT /api/pm/capex/{projectId}/{entryId} — partial update; {ok:true}, 400 on no body.
async fn pm_capex_update(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((_project_id, entry_id)): Path<(String, String)>,
    body: String,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if body.is_empty() {
        return bad_request("Body required");
    }
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    s.pm.update_capex_entry(
        &entry_id,
        v.get("classification").and_then(Value::as_str),
        v.get("workType").and_then(Value::as_str),
        v.get("adjustmentFactor").and_then(Value::as_f64),
        v.get("costMicrodollars").and_then(Value::as_i64),
        v.get("notes").and_then(Value::as_str),
    );
    Json(json!({ "ok": true })).into_response()
}

/// POST /api/pm/capex/{projectId}/{entryId}/confirm.
async fn pm_capex_confirm(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((_project_id, entry_id)): Path<(String, String)>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    s.pm.confirm_capex_entry(&entry_id, None);
    Json(json!({ "ok": true })).into_response()
}

/// GET /api/pm/capex/{projectId}/export — CSV (Node passes start_date as the month).
async fn pm_capex_export(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let csv = s.pm.export_capex_csv(&project_id, q.get("start_date").map(String::as_str));
    csv_response(&format!("capex-{project_id}.csv"), csv)
}

/// GET /api/pm/capex-report/{projectId} — Node returns XLSX (exceljs); documented
/// divergence: we serve the CSV fallback (the path Node itself takes without exceljs).
async fn pm_capex_report(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let csv = s.pm.export_capex_csv(&project_id, q.get("start_date").map(String::as_str));
    csv_response(&format!("capex-{project_id}.csv"), csv)
}

/// GET /api/pm/capex-all (?category=) — cross-project JSON aggregation for the
/// home dashboard. Ports Node's `capex-all` summary/byProject/entries shape.
async fn pm_capex_all(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let category = q.get("category").map(String::as_str);
    let projects: Vec<_> = s
        .pm
        .list_projects()
        .into_iter()
        .filter(|p| category.is_none_or(|c| p.category.as_deref() == Some(c)))
        .collect();

    let round2 = |mins: f64| (mins / 60.0 * 100.0).round() / 100.0;
    let (mut total_cost, mut total_cap, mut total_exp, mut total_mins) = (0i64, 0i64, 0i64, 0f64);
    let (mut total_confirmed, mut total_unconfirmed) = (0i64, 0i64);
    let mut by_project: Vec<Value> = Vec::new();
    let mut all_entries: Vec<Value> = Vec::new();

    for project in &projects {
        let entries = s.pm.list_capex_entries_filtered(&project.id, None, None);
        let (mut p_cost, mut p_cap, mut p_exp, mut p_mins, mut p_confirmed) = (0i64, 0i64, 0i64, 0f64, 0i64);
        for e in &entries {
            let mut ev = serde_json::to_value(e).unwrap_or_else(|_| json!({}));
            if let Some(m) = ev.as_object_mut() {
                m.insert("projectName".into(), json!(project.name));
            }
            all_entries.push(ev);
            p_cost += e.adjusted_cost_microdollars;
            p_mins += e.active_minutes;
            if e.classification == "capitalizable" {
                p_cap += e.adjusted_cost_microdollars;
            } else {
                p_exp += e.adjusted_cost_microdollars;
            }
            if e.confirmed {
                p_confirmed += 1;
            }
        }
        if !entries.is_empty() {
            by_project.push(json!({
                "projectId": project.id,
                "projectName": project.name,
                "category": project.category,
                "totalCost": p_cost,
                "capitalizable": p_cap,
                "expensed": p_exp,
                "activeMinutes": p_mins,
                "activeHours": round2(p_mins),
                "confirmed": p_confirmed,
                "total": entries.len(),
            }));
        }
        total_cost += p_cost;
        total_cap += p_cap;
        total_exp += p_exp;
        total_mins += p_mins;
        total_confirmed += p_confirmed;
        total_unconfirmed += entries.len() as i64 - p_confirmed;
    }

    // Node sorts entries by createdAt DESC.
    all_entries.sort_by(|a, b| {
        let av = a.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
        let bv = b.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
        bv.cmp(&av)
    });

    Json(json!({
        "data": {
            "summary": {
                "totalCost": total_cost,
                "capitalizable": total_cap,
                "expensed": total_exp,
                "activeMinutes": total_mins,
                "activeHours": round2(total_mins),
                "confirmed": total_confirmed,
                "unconfirmed": total_unconfirmed,
                "projectCount": by_project.len(),
            },
            "byProject": by_project,
            "entries": all_entries,
        }
    }))
    .into_response()
}

/// GET /api/pm/capex-report-all — Node returns an all-projects XLSX; documented
/// divergence: we serve a CSV concatenation of every (optionally category-filtered)
/// project's ledger.
async fn pm_capex_report_all(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let category = q.get("category").map(String::as_str);
    let start = q.get("start_date").map(String::as_str);
    let mut csv = String::new();
    for project in s.pm.list_projects() {
        if category.is_some_and(|c| project.category.as_deref() != Some(c)) {
            continue;
        }
        let part = s.pm.export_capex_csv(&project.id, start);
        if !csv.is_empty() {
            csv.push('\n');
        }
        csv.push_str(&part);
    }
    csv_response("capex-all-projects.csv", csv)
}

/// GET /api/pm/categories — distinct project categories.
async fn pm_categories(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    Json(json!({ "data": s.pm.list_categories() })).into_response()
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
    // Accept EITHER the global token (RUNTIMESCOPE_AUTH_TOKEN / config) OR a valid
    // workspace-scoped API key (`tk_…` from the workspaces API) — matching Node's
    // two-layer auth. A valid workspace key bypasses the global check.
    let token = h.auth_token.as_deref();
    let ok = s.auth.authorized(token)
        || token.is_some_and(|t| s.pm.get_workspace_by_api_key(t).is_some());
    if ok {
        Some(h)
    } else {
        None
    }
}
