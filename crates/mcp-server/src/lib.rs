//! `mcp-server` — embeds collector-core in-process (ADR-0008) and exposes the
//! MCP tool surface over stdio JSON-RPC.
//!
//! `Mcp` holds the shared store + command hub. Tool families live under
//! `tools/` (one module + named router each); `Mcp::new` combines the routers.
//! The Milestone 3 fan-out adds family modules and one `+ Self::<family>_router()`
//! line each — see `tools/mod.rs` for the pattern.

mod sidecar;
mod tools;

use collector_core::auth::AuthManager;
use collector_core::{
    data_dir, host_from_env, open_store, port_from_env, serve, AuthMode, CommandHub, PmStore,
    StoreHandle, DEFAULT_HTTP_PORT, DEFAULT_WS_PORT, VERSION,
};
use rmcp::{
    handler::server::{tool::ToolRouter, ServerHandler},
    tool_handler,
    transport::stdio,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ServiceExt,
};
use std::sync::Arc;

/// Default port for the remote MCP HTTP transport (ADR-0011) — distinct from the
/// collector's WS (6767) and HTTP/dashboard (6768). Override with
/// `RUNTIMESCOPE_MCP_HTTP_PORT`.
const DEFAULT_MCP_HTTP_PORT: u16 = 6770;

#[derive(Clone)]
pub struct Mcp {
    pub store: StoreHandle,
    pub hub: CommandHub,
    /// pm/ project-manager store (workspaces + API keys) — M5.
    pub pm: PmStore,
    tool_router: ToolRouter<Self>,
}

impl Mcp {
    fn new(store: StoreHandle, hub: CommandHub, pm: PmStore) -> Self {
        // Combine every family's router (M3 fan-out).
        let tool_router = Self::core_router()
            + Self::status_router()
            + Self::event_reads_router()
            + Self::diagnostics_router()
            + Self::api_discovery_router()
            + Self::database_router()
            + Self::process_infra_router()
            + Self::sessions_history_router()
            + Self::setup_workspaces_router()
            + Self::recon_router();
        Self { store, hub, pm, tool_router }
    }
}

// Point the handler at the combined `tool_router` field (the macro default is
// `Self::tool_router()`, which we don't have — we merge named routers in new()).
#[tool_handler(router = self.tool_router)]
impl ServerHandler for Mcp {
    // Default get_info() advertises the tools capability (validated in the M0 spike).
}

/// Run the MCP server (collector embedded in-process, ADR-0008) over stdio.
/// The binary wrapper provides the tokio runtime (`#[tokio::main]`); this is a
/// plain async entrypoint so the crate is a reusable library on crates.io.
/// Is a healthy collector already serving `/readyz` on `127.0.0.1:port`? Used to
/// decide whether this MCP server should start its own embedded collector or just
/// attach to the standalone one. Short-timeout, dependency-free raw HTTP probe.
async fn collector_already_running(port: u16) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::{timeout, Duration};
    let connect = timeout(Duration::from_millis(800), tokio::net::TcpStream::connect(("127.0.0.1", port))).await;
    let Ok(Ok(mut stream)) = connect else { return false };
    if stream.write_all(b"GET /readyz HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").await.is_err() {
        return false;
    }
    let mut buf = [0u8; 128];
    let Ok(Ok(n)) = timeout(Duration::from_millis(800), stream.read(&mut buf)).await else {
        return false;
    };
    // 2xx on /readyz ⇒ a healthy RuntimeScope collector owns the port.
    String::from_utf8_lossy(&buf[..n])
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .is_some_and(|code| (200..300).contains(&code))
}

/// Shared setup for both transports: cutover guard, open the store/pm, embed the
/// collector in-process (ADR-0008) OR attach to an already-running standalone one,
/// and kick off pm/ project discovery. Returns the handles the transport serves.
///
/// The embed/attach call: if a standalone collector already serves `:http_port`
/// (the common launchd/systemd setup the SDKs report to), DON'T start a second —
/// it would fail to bind and run a duplicate retention sweep against the shared
/// collector.db. We open the same data dir, so the tools read the SDK's events
/// either way; attach as a pure reader and let the standalone own ingestion.
async fn prepare() -> Result<(StoreHandle, CommandHub, PmStore), Box<dyn std::error::Error>> {
    let ws_port = port_from_env("RUNTIMESCOPE_PORT", DEFAULT_WS_PORT);
    let http_port = port_from_env("RUNTIMESCOPE_HTTP_PORT", DEFAULT_HTTP_PORT);
    // First-run cutover guard: back up legacy Node-era data before opening the
    // stores (or leave it with RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1) — M6 Slice D.
    collector_core::migration::first_run_guard(&data_dir()).map_err(std::io::Error::other)?;
    let store = open_store().await?;
    let hub = CommandHub::new();
    // pm/ store (M5): separate pm.db alongside the event store's collector.db.
    let pm = PmStore::open(&data_dir().join("pm.db"))?;

    if collector_already_running(http_port).await {
        eprintln!(
            "[RuntimeScope] attached to the collector already serving :{http_port} \
             (reading its store; not starting a second collector)"
        );
    } else {
        let serve_store = store.clone();
        let serve_hub = hub.clone();
        let serve_pm = pm.clone();
        tokio::spawn(async move {
            // MCP auth mode: config-file-only, ignores RUNTIMESCOPE_AUTH_TOKEN (Node
            // parity). process_monitor = true: serves live /api/processes + /api/ports.
            // The EMBEDDED collector always binds loopback — RUNTIMESCOPE_HOST governs
            // only the standalone collector-server (ADR-0010). Exposing the MCP itself
            // remotely is run_http() (ADR-0011), which gates with a bearer token.
            let host = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
            if let Err(e) = serve(serve_store, serve_hub, serve_pm, host, ws_port, http_port, VERSION.to_string(), AuthMode::Mcp, true).await {
                eprintln!("[RuntimeScope] embedded collector failed: {e}");
            }
        });
    }

    // pm/ project discovery (M5): scan ~/.claude/projects for REAL projects + index
    // their sessions into pm.db. Backgrounded so it never delays the transport; a
    // no-op when the dirs are absent. Incremental on re-run.
    {
        let pm_bg = pm.clone();
        let claude_base =
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude");
        let rs_base = data_dir();
        tokio::task::spawn_blocking(move || {
            let r = collector_core::pm_discovery::discover_claude_projects(&claude_base, &pm_bg);
            let r2 = collector_core::discover_runtimescope_projects(&rs_base, &pm_bg);
            let projects = r.projects_discovered + r.projects_updated + r2.projects_discovered + r2.projects_updated;
            if projects > 0 {
                eprintln!(
                    "[RuntimeScope] pm discovery: {} claude + {} rs new project(s), {} new session(s)",
                    r.projects_discovered, r2.projects_discovered, r.sessions_discovered
                );
            }
        });
    }

    Ok((store, hub, pm))
}

/// Run the MCP server over **stdio** (the local default; collector embedded or
/// attached per ADR-0008). The binary wrapper provides the tokio runtime.
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let (store, hub, pm) = prepare().await?;

    // The conformance mcp-driver waits for this exact marker before sending
    // JSON-RPC. Print it before serve(stdio()) so initialize lands after the
    // transport reader is up.
    eprintln!("[RuntimeScope] MCP server running on stdio");

    let service = Mcp::new(store, hub, pm).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

/// Per-request bearer gate for the remote HTTP transport.
struct McpHttpGate {
    auth: AuthManager,
    pm: PmStore,
}

/// Reject any request without a valid bearer (global token OR workspace `tk_`
/// key) — mirrors the collector's `resolve_caller`. The remote MCP is never
/// exposed unauthenticated (run_http refuses to start without a configured token).
async fn require_bearer(
    axum::extract::State(gate): axum::extract::State<Arc<McpHttpGate>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{header::AUTHORIZATION, StatusCode};
    use axum::response::IntoResponse;
    let presented = req.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok());
    let tok = AuthManager::extract_bearer(presented);
    let ok = tok.is_some_and(|t| gate.auth.validate(t) || gate.pm.get_workspace_by_api_key(t).is_some());
    if !ok {
        return (StatusCode::UNAUTHORIZED, "Unauthorized: a valid bearer token is required").into_response();
    }
    next.run(req).await
}

/// Run the MCP server over **Streamable HTTP** (ADR-0011) so a coding agent can
/// reach a DEPLOYED app's runtime remotely. Mounted at `/mcp`, **bearer-gated**:
/// requires `RUNTIMESCOPE_AUTH_TOKEN` (or a workspace API key) and refuses to
/// start otherwise — a remote MCP is never exposed unauthenticated. Binds
/// `RUNTIMESCOPE_HOST` + `RUNTIMESCOPE_MCP_HTTP_PORT` (default 6770), distinct
/// from the collector ports. OAuth 2.1 for interactive claude.ai custom
/// connectors is a follow-up; bearer covers Claude Code (`claude mcp add
/// --transport http`) and the MCP-connector API's `authorization_token`.
pub async fn run_http() -> Result<(), Box<dyn std::error::Error>> {
    // Standalone auth mode reads RUNTIMESCOPE_AUTH_TOKEN (+ config keys), matching
    // the standalone collector — the token an operator already sets for ingest.
    let gate_auth = AuthManager::for_mode(AuthMode::Standalone);
    let (store, hub, pm) = prepare().await?;
    if !gate_auth.enabled() && !pm.has_active_api_keys() {
        return Err("remote MCP over HTTP requires RUNTIMESCOPE_AUTH_TOKEN (or a workspace API key) \
                    — refusing to expose an unauthenticated MCP"
            .into());
    }

    let host = host_from_env();
    let port = port_from_env("RUNTIMESCOPE_MCP_HTTP_PORT", DEFAULT_MCP_HTTP_PORT);

    // One shared Mcp; the factory hands a clone to each session (Mcp: Clone).
    let mcp = Mcp::new(store, hub, pm.clone());
    let svc = StreamableHttpService::new(
        move || Ok::<_, std::io::Error>(mcp.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );

    let gate = Arc::new(McpHttpGate { auth: gate_auth, pm });
    let app = axum::Router::new()
        .nest_service("/mcp", svc)
        .layer(axum::middleware::from_fn_with_state(gate, require_bearer));

    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    eprintln!("[RuntimeScope] MCP server (Streamable HTTP) on http://{host}:{port}/mcp");
    if !host.is_loopback() {
        eprintln!(
            "[RuntimeScope]   ⚠ bound to {host} (non-loopback) — expose ONLY behind TLS + a \
             tunnel/proxy (ADR-0010/0011); requests require a bearer token"
        );
    }
    axum::serve(listener, app).await?;
    Ok(())
}
