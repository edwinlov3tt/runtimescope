//! `mcp-server` — embeds collector-core in-process (ADR-0008) and exposes the
//! MCP tool surface over stdio JSON-RPC.
//!
//! `Mcp` holds the shared store + command hub. Tool families live under
//! `tools/` (one module + named router each); `Mcp::new` combines the routers.
//! The Milestone 3 fan-out adds family modules and one `+ Self::<family>_router()`
//! line each — see `tools/mod.rs` for the pattern.

mod sidecar;
mod tools;

use collector_core::{
    data_dir, open_store, port_from_env, serve, AuthMode, CommandHub, PmStore, StoreHandle,
    DEFAULT_HTTP_PORT, DEFAULT_WS_PORT, VERSION,
};
use rmcp::{
    handler::server::{tool::ToolRouter, ServerHandler},
    tool_handler,
    transport::stdio,
    ServiceExt,
};

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

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let ws_port = port_from_env("RUNTIMESCOPE_PORT", DEFAULT_WS_PORT);
    let http_port = port_from_env("RUNTIMESCOPE_HTTP_PORT", DEFAULT_HTTP_PORT);
    // First-run cutover guard: back up legacy Node-era data before opening the
    // stores (or leave it with RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1) — M6 Slice D.
    // Abort if the backup failed rather than run on a half-migrated store.
    collector_core::migration::first_run_guard(&data_dir()).map_err(std::io::Error::other)?;
    let store = open_store().await?;
    let hub = CommandHub::new();
    // pm/ store (M5): separate pm.db alongside the event store's collector.db.
    let pm = PmStore::open(&data_dir().join("pm.db"))?;

    // Embed the collector in-process (ADR-0008): WS + HTTP run alongside MCP so
    // the command channel's send is an in-process call, and the tools read the
    // same store the SDK feeds.
    //
    // BUT if a standalone collector is already serving this port (the common
    // setup: a launchd/systemd `collector-server` the SDKs report to), DON'T start
    // a second one — it would just fail to bind ("Address already in use") and,
    // worse, run a duplicate retention sweep against the shared collector.db. We
    // open the same data dir, so the read tools see the SDK's events either way;
    // attach as a pure reader and let the standalone own ingestion/WS/retention.
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
            // parity, mcp-server/src/index.ts).
            // process_monitor = true: mcp-server serves live /api/processes + /api/ports
            // (Node `new ProcessMonitor(store)`); the standalone collector-server passes false.
            if let Err(e) = serve(serve_store, serve_hub, serve_pm, ws_port, http_port, VERSION.to_string(), AuthMode::Mcp, true).await {
                eprintln!("[RuntimeScope] embedded collector failed: {e}");
            }
        });
    }

    // The conformance mcp-driver waits for this exact marker before sending
    // JSON-RPC (and only then attaches — see the harness note). Print it before
    // serve(stdio()) so initialize lands after the transport reader is up.
    eprintln!("[RuntimeScope] MCP server running on stdio");

    // pm/ project discovery (M5): scan ~/.claude/projects for REAL projects (the
    // over-discovery fix) + index their sessions into pm.db. Backgrounded so it
    // never delays the MCP transport; a no-op when ~/.claude/projects is absent
    // (e.g. the conformance harness's temp HOME). Incremental on re-run.
    {
        let pm_bg = pm.clone();
        let claude_base =
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude");
        let rs_base = data_dir();
        tokio::task::spawn_blocking(move || {
            // Claude projects (~/.claude/projects, filtered) + RuntimeScope projects
            // (~/.runtimescope/projects). Both no-op when absent.
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

    let service = Mcp::new(store, hub, pm).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
