//! The WS + HTTP server, shared by both the standalone `collector-server` bin
//! and the `mcp-server` bin (which embeds it in-process per ADR-0008).
//!
//! Two axum apps on two ports (matching the Node collector): SDK WebSocket on
//! `ws_port` (default 6767), HTTP API on `http_port` (default 6768). All store
//! access is async (the store is the dedicated-thread `StoreHandle`).

use crate::analytics_store::AnalyticsStore;
use crate::auth::{AuthManager, AuthMode};
use crate::command::CommandHub;
use crate::dev_server::{
    build_auto_attach, detect_container_local, group_alive, poll_listening_ports, resolve_launch,
    signal_from_name, spawn_dev_process, stop_group, DevServerRequest, Spawned, StopOutcome,
    DETECT_INTERVAL, DETECT_TIMEOUT, MAX_LOG_LINES,
};
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
        ConnectInfo, Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use tokio::sync::mpsc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Monotonic suffix so backfilled HTTP eventIds are unique even within one ms.
static HTTP_EVENT_SEQ: AtomicU64 = AtomicU64::new(0);

/// The live mutable state of one managed dev server. The detect-monitor thread
/// mutates `status`/`exit_code`/`ports`; the log readers append to `logs`; the
/// `GET` handler reads them. Each field has its own lock so a slow log read
/// never blocks a status read.
struct ProcInner {
    status: Mutex<String>,
    exit_code: Mutex<Option<i32>>,
    logs: Mutex<Vec<String>>,
    ports: Mutex<Vec<u16>>,
}

/// A managed dev server in the in-memory map. Cheap to `clone()` (the mutable
/// state is behind `Arc<ProcInner>`). Re-attached procs (post-restart) share
/// this shape but have no live monitor — `GET` re-derives their truth from the
/// pgid liveness check + persisted ports.
#[derive(Clone)]
struct ManagedProc {
    pid: u32,
    pgid: i32,
    command: String,
    started_at: i64,
    container_local: bool,
    inner: Arc<ProcInner>,
}

/// Shared mutable runtime state, keyed by projectId (one dev server per project,
/// like Node's `managedProcesses` map) — but persisted to `pm.db` so a restart
/// re-attaches instead of orphaning.
type ProcMap = Arc<Mutex<HashMap<String, ManagedProc>>>;
/// Project ids whose dev-server is mid-spawn — an atomic reservation so two
/// concurrent POSTs can't both pass the "already running?" check and double-spawn.
type StartingSet = Arc<Mutex<std::collections::HashSet<String>>>;

/// Releases a dev-server start reservation on every exit path (success or any
/// early return), so a failed/panicking start never wedges the project as
/// permanently "starting".
struct StartGuard {
    set: StartingSet,
    id: String,
}
impl Drop for StartGuard {
    fn drop(&mut self) {
        if let Ok(mut s) = self.set.lock() {
            s.remove(&self.id);
        }
    }
}

/// Token-bucket ingest rate limiter, keyed per **remote** client (ADR-0010
/// hardening). Guards `POST /api/events` + the SDK WS handshake from a flooding
/// client. Loopback is never limited (local dev / a same-host proxy's own
/// address). Behind a reverse proxy/tunnel set `RUNTIMESCOPE_TRUST_PROXY=1` so
/// the real client IP (`CF-Connecting-IP` / `X-Forwarded-For`) keys the bucket
/// instead of the proxy's loopback address.
struct RateLimiter {
    enabled: bool,
    trust_proxy: bool,
    capacity: f64,      // burst size (tokens)
    refill_per_sec: f64, // sustained requests/sec per client
    buckets: Mutex<HashMap<IpAddr, (f64, Instant)>>,
}

impl RateLimiter {
    fn from_env() -> Self {
        // RUNTIMESCOPE_INGEST_RATE = sustained req/s per client (0 disables).
        // Default 120/s (an SDK batches ~10/s) with a 2× burst — generous for
        // legit use, a hard ceiling on a runaway/malicious client.
        let rate = std::env::var("RUNTIMESCOPE_INGEST_RATE")
            .ok()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|r| *r >= 0.0)
            .unwrap_or(120.0);
        let burst = std::env::var("RUNTIMESCOPE_INGEST_BURST")
            .ok()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|b| *b > 0.0)
            .unwrap_or(rate * 2.0);
        RateLimiter {
            enabled: rate > 0.0,
            trust_proxy: std::env::var("RUNTIMESCOPE_TRUST_PROXY").as_deref() == Ok("1"),
            capacity: burst.max(1.0),
            refill_per_sec: rate,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Consume one token for this client. Returns true if allowed. Loopback and
    /// unresolvable clients are always allowed; disabled ⇒ always allowed.
    fn allow(&self, peer: Option<SocketAddr>, headers: &HeaderMap) -> bool {
        if !self.enabled {
            return true;
        }
        let Some(ip) = self.client_ip(peer, headers) else {
            return true;
        };
        if ip.is_loopback() {
            return true;
        }
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap();
        // Opportunistic eviction so distinct attacker IPs can't leak memory:
        // when the map grows, drop buckets that have fully refilled (idle).
        if buckets.len() > 10_000 {
            buckets.retain(|_, (tokens, last)| {
                *tokens + now.duration_since(*last).as_secs_f64() * self.refill_per_sec
                    < self.capacity
            });
        }
        let (tokens, last) = buckets.entry(ip).or_insert((self.capacity, now));
        let elapsed = now.duration_since(*last).as_secs_f64();
        *tokens = (*tokens + elapsed * self.refill_per_sec).min(self.capacity);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }

    fn client_ip(&self, peer: Option<SocketAddr>, headers: &HeaderMap) -> Option<IpAddr> {
        if self.trust_proxy {
            // CF-Connecting-IP first (Cloudflare), then the first X-Forwarded-For hop.
            for h in ["cf-connecting-ip", "x-forwarded-for"] {
                if let Some(first) = headers
                    .get(h)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.split(',').next())
                {
                    if let Ok(ip) = first.trim().parse::<IpAddr>() {
                        return Some(ip);
                    }
                }
            }
        }
        peer.map(|p| p.ip())
    }
}

#[cfg(test)]
mod rate_limit_tests {
    use super::*;

    fn limiter(enabled: bool, trust_proxy: bool, capacity: f64, refill: f64) -> RateLimiter {
        RateLimiter {
            enabled,
            trust_proxy,
            capacity,
            refill_per_sec: refill,
            buckets: Mutex::new(HashMap::new()),
        }
    }
    fn sock(s: &str) -> Option<SocketAddr> {
        Some(s.parse().unwrap())
    }

    #[test]
    fn throttles_remote_after_burst_exempts_loopback_and_disabled() {
        let h = HeaderMap::new();
        let rl = limiter(true, false, 3.0, 0.0); // burst 3, no refill
        let remote = sock("203.0.113.5:4000");
        assert!(rl.allow(remote, &h));
        assert!(rl.allow(remote, &h));
        assert!(rl.allow(remote, &h));
        assert!(!rl.allow(remote, &h), "4th over the burst must be denied");

        // loopback is never limited, even past the burst
        let lo = sock("127.0.0.1:9");
        for _ in 0..10 {
            assert!(rl.allow(lo, &h), "loopback must be exempt");
        }

        // disabled ⇒ always allow
        let off = limiter(false, false, 1.0, 0.0);
        for _ in 0..10 {
            assert!(off.allow(remote, &h));
        }
    }

    #[test]
    fn trust_proxy_keys_on_forwarded_client_ip() {
        let rl = limiter(true, true, 1.0, 0.0); // burst 1
        let proxy = sock("127.0.0.1:1"); // the proxy's own (loopback) socket
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "198.51.100.7, 10.0.0.1".parse().unwrap());
        // Keyed on the forwarded client IP — NOT exempted as loopback, and the
        // 2nd request from the same client is throttled.
        assert!(rl.allow(proxy, &h));
        assert!(!rl.allow(proxy, &h), "same forwarded client must be throttled");
        // A different forwarded client gets its own bucket.
        let mut h2 = HeaderMap::new();
        h2.insert("cf-connecting-ip", "198.51.100.99".parse().unwrap());
        assert!(rl.allow(proxy, &h2));
    }
}

#[derive(Clone)]
struct AppState {
    store: StoreHandle,
    hub: CommandHub,
    pm: PmStore,
    /// Product-analytics store (analytics.db) — ADR-0012; end-user identity + ROI.
    analytics: AnalyticsStore,
    /// Optional Mosaic sidecar client (ADR-0013 slice 3b) — Some when
    /// RUNTIMESCOPE_MOSAIC_URL is set; gates forecast/trace/narrative.
    mosaic: Option<crate::analytics_mosaic::MosaicClient>,
    auth: AuthManager,
    /// Per-client ingest rate limiter (POST /api/events + SDK WS handshake).
    rate: Arc<RateLimiter>,
    started: Instant,
    version: String,
    dev_servers: ProcMap,
    dev_starting: StartingSet,
    /// Whether `/api/processes` + `/api/ports` serve live ps/lsof data. True for
    /// mcp-server (Node `new ProcessMonitor(store)`), false for the standalone
    /// collector-server (Node passes no monitor → those routes return empty).
    process_monitor: bool,
    /// Epoch-ms of the last admin snapshot — enforces Node's 60s cooldown so a
    /// runaway caller can't fill the disk with VACUUM copies.
    last_snapshot: Arc<Mutex<i64>>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Bind both ports and serve forever. Returns only on bind error. Auth is
/// constructed per `auth_mode` ([`AuthMode::Standalone`] for `collector-server`,
/// [`AuthMode::Mcp`] for `mcp-server`) so each binary matches its Node reference.
#[allow(clippy::too_many_arguments)] // top-level entrypoint; per-binary wiring (auth_mode, process_monitor) is clearer flat than in a config struct
pub async fn serve(
    store: StoreHandle,
    hub: CommandHub,
    pm: PmStore,
    host: std::net::IpAddr,
    ws_port: u16,
    http_port: u16,
    version: String,
    auth_mode: AuthMode,
    process_monitor_enabled: bool,
) -> std::io::Result<()> {
    // Re-attach managed dev servers persisted before this restart: keep the ones
    // whose process group is still alive, prune the dead rows so GET stays honest
    // (the fix for Node's in-memory map that lies "stopped" after a restart).
    let dev_servers: ProcMap = Arc::new(Mutex::new(HashMap::new()));
    let dev_starting: StartingSet = Arc::new(Mutex::new(std::collections::HashSet::new()));
    reattach_dev_servers(&pm, &dev_servers);

    // Product-analytics store (ADR-0012). Opened from the data dir like pm.db; a
    // failure here shouldn't down the collector, so fall back to an in-memory DB
    // (analytics is additive — event ingest/reads must still work).
    let analytics = AnalyticsStore::open(&crate::data_dir().join("analytics.db"))
        .or_else(|e| {
            // Prominent + repeated: an in-memory analytics store still returns 200
            // for identify/baselines/projections, so a single quiet line would let
            // a silent total-persistence failure of the PII/identity boundary slip
            // by. Make it unmissable.
            eprintln!("[RuntimeScope] ╔══════════════════════════════════════════════════════════════╗");
            eprintln!("[RuntimeScope] ║ ⚠  ANALYTICS STORE FELL BACK TO IN-MEMORY ({e})", );
            eprintln!("[RuntimeScope] ║    identify / baselines / roles / projections will NOT persist");
            eprintln!("[RuntimeScope] ║    and are LOST on restart. Fix analytics.db (perms/lock/disk).");
            eprintln!("[RuntimeScope] ╚══════════════════════════════════════════════════════════════╝");
            tracing::error!("analytics store open failed ({e}); using non-persistent in-memory DB");
            AnalyticsStore::open(std::path::Path::new(":memory:"))
        })
        .map_err(std::io::Error::other)?;

    // Mosaic sidecar (ADR-0013 3b): wired only when RUNTIMESCOPE_MOSAIC_URL is set.
    let mosaic = crate::analytics_mosaic::MosaicConfig::from_env().map(|c| {
        eprintln!("[RuntimeScope] Mosaic sidecar configured: {} (cube '{}')", c.url, c.cube);
        crate::analytics_mosaic::MosaicClient::new(c)
    });

    // Periodic fact sync — keep the cube fresh so forecast/trace don't each pay a
    // full re-push. RUNTIMESCOPE_MOSAIC_SYNC_SECS (default 60, min 5). A baseline
    // edit racing a sync (per-call locks, not a snapshot) only makes that one tick
    // momentarily stale — the next full re-push reconciles it.
    if let Some(mc) = mosaic.clone() {
        let bstore = store.clone();
        let banalytics = analytics.clone();
        let secs = std::env::var("RUNTIMESCOPE_MOSAIC_SYNC_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60)
            .max(5);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(secs));
            loop {
                tick.tick().await;
                if let Err(e) = sync_facts(&bstore, &banalytics, &mc, None).await {
                    eprintln!("[RuntimeScope] Mosaic periodic sync failed: {e}");
                }
            }
        });
    }

    // Uptime active-probe task (slice 5): probe every enabled app on an interval,
    // record checks, open/resolve incidents. RUNTIMESCOPE_UPTIME_PROBE_SECS
    // (default 60, min 5; 0 disables active probing — heartbeat-only).
    let probe_secs = std::env::var("RUNTIMESCOPE_UPTIME_PROBE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(60);
    if probe_secs > 0 {
        let panalytics = analytics.clone();
        let allow_private = uptime_allow_private();
        let slow_ms = uptime_slow_ms();
        let secs = probe_secs.max(5);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(secs));
            let prune_every = (3600 / secs).max(1); // ~hourly
            let mut ticks: u64 = 0;
            loop {
                tick.tick().await;
                probe_all(&panalytics, allow_private, slow_ms).await;
                ticks += 1;
                if ticks.is_multiple_of(prune_every) {
                    panalytics.prune_uptime_checks(now_ms() - 90 * 86_400_000);
                }
            }
        });
    }

    let state = AppState {
        store,
        hub,
        pm,
        analytics,
        mosaic,
        auth: AuthManager::for_mode(auth_mode),
        rate: Arc::new(RateLimiter::from_env()),
        started: Instant::now(),
        version,
        dev_servers,
        dev_starting,
        process_monitor: process_monitor_enabled,
        last_snapshot: Arc::new(Mutex::new(0)),
    };

    let http = Router::new()
        // public (no auth even when enabled)
        .route("/readyz", get(readyz))
        .route("/api/health", get(health))
        .route("/metrics", get(metrics))
        // embedded dashboard SPA (M6 Slice A) — public; /assets/* because Vite
        // emits absolute asset paths.
        .route("/dashboard", get(serve_dashboard))
        .route("/dashboard/{*rest}", get(serve_dashboard))
        .route("/assets/{*rest}", get(serve_dashboard))
        // dashboard live feed (the SPA's ws-client.ts) — events + session changes
        .route("/api/ws/events", get(dashboard_ws))
        // gated
        .route("/api/sessions", get(sessions))
        .route("/api/v1/admin/snapshot", post(admin_snapshot))
        .route("/api/projects", get(projects))
        .route("/api/events", post(post_events))
        .route("/api/events/{kind}", get(events_by_kind))
        // analytics subsystem (ADR-0012, slice 1-2): end-user identity + reads
        .route("/api/analytics/identify", post(analytics_identify))
        .route("/api/analytics/roles", get(analytics_roles).put(analytics_put_role))
        .route("/api/analytics/baselines", get(analytics_baselines).put(analytics_put_baseline))
        .route("/api/analytics/baselines/history", get(analytics_baseline_history))
        .route("/api/analytics/baselines/whatif", post(analytics_baseline_whatif))
        .route(
            "/api/analytics/baselines/submissions",
            get(analytics_submissions).post(analytics_post_submission),
        )
        .route("/api/analytics/baselines/submissions/{id}", delete(analytics_dismiss_submission))
        .route("/api/analytics/baselines/submissions/{id}/accept", post(analytics_accept_submission))
        .route("/api/analytics/projections", get(analytics_projections).post(analytics_post_projection))
        // Mosaic sidecar (ADR-0013 3b) — forecast/trace require RUNTIMESCOPE_MOSAIC_URL
        .route("/api/analytics/mosaic/status", get(analytics_mosaic_status))
        .route("/api/analytics/mosaic/sync", post(analytics_mosaic_sync))
        .route("/api/analytics/forecast", get(analytics_forecast))
        .route("/api/analytics/trace", get(analytics_trace))
        // Uptime / status (slice 5)
        .route("/api/analytics/status", get(analytics_status))
        .route("/api/analytics/status/check-all", post(analytics_check_all))
        .route("/api/analytics/incidents", get(analytics_incidents))
        .route("/api/analytics/monitored-apps", post(analytics_add_app))
        .route("/api/analytics/monitored-apps/{id}", delete(analytics_delete_app))
        .route("/api/analytics/heartbeat", post(analytics_heartbeat))
        // Surveys (slice 4) — admin (workspace-key) + end-user (projectId-scoped).
        // `/active` is a static segment so it wins over `/{id}`.
        .route("/api/analytics/surveys", get(analytics_list_surveys).post(analytics_create_survey))
        .route("/api/analytics/surveys/active", get(analytics_active_surveys))
        .route("/api/analytics/surveys/{id}", put(analytics_update_survey).delete(analytics_delete_survey))
        .route("/api/analytics/surveys/{id}/responses", get(analytics_list_responses).post(analytics_submit_response))
        .route("/api/analytics/surveys/{id}/dismiss", post(analytics_dismiss_survey))
        // Admin de-anon (slice 6) — X-Admin-Key gated (RUNTIMESCOPE_ADMIN_KEY), audited.
        .route("/api/analytics/admin/users", get(analytics_admin_users))
        .route("/api/analytics/admin/users/{anon_id}", get(analytics_admin_user_by_id))
        .route("/api/analytics/admin/audit", get(analytics_admin_audit))
        // Not-yet-built analytics backend surfaces (greppable; the dashboard stubs
        // reference the same tags). Specs: docs/specs/analytics-data-model.md.
        //   TODO(analytics-mcp):     MCP tools get_adoption_metrics / get_feature_usage / get_user_funnel / get_roi_report
        //   TODO(analytics-status-heartbeat): SDK auto-heartbeat client wiring + missed-heartbeat→down detection (endpoint exists).
        //     Also harden: heartbeat is unauthenticated + trusts a guessable appId slug (spoofable 'up'); add a per-app heartbeat
        //     token at monitored-app creation. And escalate an ONGOING incident's type/severity on a degraded→down transition
        //     (probe_all currently only opens when none is ongoing, so the type can go stale). Both phase-review Low/Medium.
        .route("/api/analytics/overview", get(analytics_overview))
        .route("/api/analytics/features", get(analytics_features))
        .route("/api/analytics/trends", get(analytics_trends))
        .route("/api/analytics/feature-trends", get(analytics_feature_trends))
        .route("/api/analytics/event-mix", get(analytics_event_mix))
        .route("/api/analytics/cohorts", get(analytics_cohorts))
        .route("/api/analytics/funnel", get(analytics_funnel))
        .route("/api/analytics/compare", get(analytics_compare))
        .route("/api/analytics/narrative", get(analytics_narrative))
        .route("/api/analytics/users", get(analytics_users))
        .route("/api/analytics/users/{anon_id}", get(analytics_user_by_id))
        // pm/ project-manager surface (M5)
        .route("/api/pm/discover", post(pm_discover))
        .route("/api/pm/projects", get(pm_projects))
        // static project sub-routes before the {id} capture (M5.5 Slice E)
        .route("/api/pm/projects/summaries", get(pm_projects_summaries))
        .route("/api/pm/projects/export-csv", get(pm_projects_export_csv))
        .route(
            "/api/pm/projects/{id}",
            get(pm_project_by_id).put(pm_update_project).delete(pm_delete_project),
        )
        .route("/api/pm/projects/{id}/workspace", put(pm_set_project_workspace))
        // git integration (M5.5 Slice F)
        .route("/api/pm/projects/{id}/git/status", get(pm_git_status))
        .route("/api/pm/projects/{id}/git/log", get(pm_git_log))
        .route("/api/pm/projects/{id}/git/diff", get(pm_git_diff))
        .route("/api/pm/projects/{id}/git/stage", post(pm_git_stage))
        .route("/api/pm/projects/{id}/git/unstage", post(pm_git_unstage))
        .route("/api/pm/projects/{id}/git/commit", post(pm_git_commit))
        // project scripts (M5.5 Slice G, step 1)
        .route("/api/pm/projects/{id}/scripts", get(pm_project_scripts))
        // dev-server lifecycle (M5.5 Slice G, steps 2-4)
        .route(
            "/api/pm/projects/{id}/dev-server",
            get(pm_dev_server_get).post(pm_dev_server_post).delete(pm_dev_server_delete),
        )
        // process monitor (M5.5 Core) — live on mcp-server, empty on collector-server
        .route("/api/processes", get(processes_get).delete(processes_delete))
        .route("/api/ports", get(ports_get))
        .route("/api/pm/sessions", get(pm_sessions))
        .route("/api/pm/sessions/stats", get(pm_sessions_stats)) // before {id}
        .route("/api/pm/sessions/{id}", get(pm_session_by_id))
        .route("/api/pm/sessions/{id}/refresh", post(pm_session_refresh))
        .route("/api/pm/workspaces", get(pm_workspaces).post(pm_create_workspace))
        .route(
            "/api/pm/workspaces/{id}",
            get(pm_workspace_by_id).put(pm_update_workspace).delete(pm_delete_workspace),
        )
        .route("/api/pm/workspaces/{id}/api-keys", get(pm_list_api_keys).post(pm_create_api_key))
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
        // tasks (M5.5 Slice B)
        .route("/api/pm/tasks", get(pm_tasks_list).post(pm_tasks_create))
        .route("/api/pm/tasks/{id}", put(pm_tasks_update).delete(pm_tasks_delete))
        .route("/api/pm/tasks/{id}/reorder", put(pm_tasks_reorder))
        // notes (M5.5 Slice C)
        .route("/api/pm/notes", get(pm_notes_list).post(pm_notes_create))
        .route("/api/pm/notes/{id}", put(pm_notes_update).delete(pm_notes_delete))
        // memory + rules (M5.5 Slice D)
        .route("/api/pm/memory/{projectId}", get(pm_memory_list))
        .route(
            "/api/pm/memory/{projectId}/{filename}",
            get(pm_memory_get).put(pm_memory_put).delete(pm_memory_delete),
        )
        .route("/api/pm/rules/{projectId}", get(pm_rules_all))
        .route("/api/pm/rules/{projectId}/{scope}", get(pm_rules_get).put(pm_rules_put))
        .fallback(not_found)
        .with_state(state.clone());

    // Retention sweep: the durable store keeps every event (no in-memory-ring
    // eviction like Node), so without this collector.db grows forever. Prune
    // events + session snapshots older than the configured window, and cap the
    // on-disk snapshot backups. Default 90 days; RUNTIMESCOPE_RETENTION_DAYS=0
    // keeps events forever (still bounds snapshot backups). Runs once ~60s after
    // boot, then daily — off the hot path, on the store's owner thread.
    let retention_store = state.store.clone();
    let retention_days = std::env::var("RUNTIMESCOPE_RETENTION_DAYS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(90);
    let max_snapshots = std::env::var("RUNTIMESCOPE_MAX_SNAPSHOTS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(10);
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        loop {
            let r = retention_store.prune(retention_days, max_snapshots).await;
            if r.events_deleted + r.snapshots_rows_deleted + r.snapshot_dirs_deleted > 0 {
                eprintln!(
                    "[RuntimeScope] retention: pruned {} events, {} snapshot rows, {} backups (older than {} days)",
                    r.events_deleted, r.snapshots_rows_deleted, r.snapshot_dirs_deleted, retention_days
                );
            }
            tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
        }
    });

    let ws = Router::new().route("/", get(ws_upgrade)).with_state(state);

    let http_listener = tokio::net::TcpListener::bind((host, http_port)).await?;
    let ws_listener = tokio::net::TcpListener::bind((host, ws_port)).await?;

    // into_make_service_with_connect_info so handlers can read the peer SocketAddr
    // (the rate limiter's client key when not behind a trusted proxy).
    tokio::try_join!(
        async { axum::serve(http_listener, http.into_make_service_with_connect_info::<SocketAddr>()).await },
        async { axum::serve(ws_listener, ws.into_make_service_with_connect_info::<SocketAddr>()).await },
    )?;
    Ok(())
}

/// Gate check for the non-public HTTP routes.
/// The resolved identity of an HTTP caller, mirroring Node's `_rsCaller`.
struct Caller {
    /// Authenticated with a global AuthManager token, OR auth is inactive
    /// (local-trust mode) — full access.
    is_admin: bool,
    /// Set when a workspace-scoped `tk_` token authenticated this request.
    workspace_id: Option<String>,
}

/// Resolve the caller exactly as Node's `handleRequest` gate does. Returns
/// `None` when auth is *active* and no valid token matched (⇒ 401). Auth is
/// active when a global token is configured OR any workspace API key exists
/// (the H5 fix — a minted workspace key must gate access even with no global
/// token). A valid token may be the global token (⇒ admin) or a workspace
/// `tk_` token (⇒ that workspace).
fn resolve_caller(s: &AppState, headers: &HeaderMap) -> Option<Caller> {
    let workspace_keys_exist = s.pm.has_active_api_keys();
    let auth_active = s.auth.enabled() || workspace_keys_exist;
    if !auth_active {
        return Some(Caller { is_admin: true, workspace_id: None });
    }
    let presented = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    let token = AuthManager::extract_bearer(presented);
    // `validate` (not `authorized`) so a workspace token isn't misread as the
    // global admin token when no global keys are set.
    let is_global = token.is_some_and(|t| s.auth.validate(t));
    let workspace = token.and_then(|t| s.pm.get_workspace_by_api_key(t));
    if !is_global && workspace.is_none() {
        return None;
    }
    Some(Caller { is_admin: is_global, workspace_id: workspace.map(|w| w.id) })
}

fn http_authorized(s: &AppState, headers: &HeaderMap) -> bool {
    resolve_caller(s, headers).is_some()
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized", "code": "AUTH_FAILED" }))).into_response()
}

fn too_many_requests() -> Response {
    (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "Too Many Requests", "code": "RATE_LIMITED" }))).into_response()
}

// ── Analytics subsystem (ADR-0012) ──────────────────────────────────────────
// Slice 1-2: end-user identity (identify) + base anonymized reads. Rollups
// (per-user/feature/role over the event stream) + ROI land in later slices.
// The read paths return ONLY anonymized records — PII (email/ip) is reachable
// solely via the admin-token de-anon path (slice 6), never these routes.

#[derive(serde::Deserialize)]
struct IdentifyBody {
    email: String,
    role: Option<String>,
    consent: Option<bool>,
    #[serde(rename = "externalId")]
    external_id: Option<String>,
}

/// POST /api/analytics/identify — the SDK's `identify()`. Records/refreshes an
/// end-user and returns the anon id the SDK then stamps on `track()` events.
/// Rate-limited + auth-gated exactly like event ingest.
async fn analytics_identify(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !s.rate.allow(Some(peer), &headers) {
        return too_many_requests();
    }
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Ok(b) = serde_json::from_str::<IdentifyBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {email, role?, consent?}" }))).into_response();
    };
    if b.email.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "email is required" }))).into_response();
    }
    // role/consent are preserved on omit (no silent revoke). IP is PII — only
    // captured with explicit consent.
    let role = b.role.filter(|r| !r.trim().is_empty());
    let ip = if b.consent == Some(true) { s.rate.client_ip(Some(peer), &headers).map(|i| i.to_string()) } else { None };
    match s.analytics.identify(b.email.trim(), role.as_deref(), b.consent, b.external_id.as_deref(), ip.as_deref()) {
        Ok(anon) => {
            // Echo the PERSISTED role/consent (post-COALESCE), not the request — a
            // re-identify that omits them must report the durable value, not null.
            let u = s.analytics.get_user(&anon);
            let role_out = u.as_ref().map(|u| u.role.clone());
            let consent_out = u.as_ref().map(|u| u.consent);
            (StatusCode::OK, Json(json!({ "data": { "anonId": anon, "role": role_out, "consent": consent_out } }))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

/// GET /api/analytics/roles — role → hourly rate (seeded defaults, editable).
async fn analytics_roles(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let roles = s.analytics.roles();
    let count = roles.len();
    Json(json!({ "data": roles, "count": count })).into_response()
}

/// Build the ROI join context (feature→baseline, anonId→role, role→rate) from
/// the analytics store. Slice 3a.
fn roi_ctx(s: &AppState) -> crate::analytics_roi::RoiCtx {
    use crate::analytics_roi::{BaselineCalc, RoiCtx};
    let baselines = s
        .analytics
        .list_baselines()
        .into_iter()
        .map(|b| (b.fn_name, BaselineCalc { manual: b.manual_min, tool: b.tool_min, per_item: b.per_item }))
        .collect();
    let anon_role = s.analytics.list_users().into_iter().map(|u| (u.anon_id, u.role)).collect();
    let role_rate = s.analytics.roles().into_iter().map(|r| (r.role, r.hourly_rate)).collect();
    RoiCtx { baselines, anon_role, role_rate }
}

/// Filter events to a window (the $-enriched reads compute ROI over the window).
/// Drops future-dated (clock-skewed) events too, so valueSaved/hoursSaved exclude
/// the same events the usage rollups (active/adoption) do — one consistent payload.
fn window_filter(events: Vec<Value>, now: i64, window: &str) -> Vec<Value> {
    let cutoff = crate::analytics_rollups::window_cutoff(now, window);
    events
        .into_iter()
        .filter(|e| {
            let t = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
            t <= now && cutoff.is_none_or(|c| t >= c)
        })
        .collect()
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[derive(serde::Deserialize)]
struct BaselineBody {
    #[serde(rename = "fn")]
    fn_name: String,
    #[serde(rename = "manualMin")]
    manual_min: f64,
    #[serde(rename = "toolMin")]
    tool_min: f64,
    #[serde(default, rename = "perItem")]
    per_item: bool,
    source: Option<String>,
}

/// GET /api/analytics/baselines — ROI baselines enriched with live `uses` (event
/// count) + `value` (ROI $) per feature.
async fn analytics_baselines(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project = q.get("project_id").map(String::as_str);
    let events = s.store.events_by_type_full("custom", project).await;
    let feat_roi = roi_ctx(&s).by_feature(&events);
    let mut uses: HashMap<String, u64> = HashMap::new();
    for e in &events {
        if let Some(n) = e.get("name").and_then(Value::as_str) {
            *uses.entry(n.to_string()).or_insert(0) += 1;
        }
    }
    let data: Vec<Value> = s
        .analytics
        .list_baselines()
        .into_iter()
        .map(|b| {
            let mut base = serde_json::to_value(&b).unwrap_or_else(|_| json!({}));
            let (value, _h) = feat_roi.get(&b.fn_name).copied().unwrap_or((0.0, 0.0));
            if let Some(o) = base.as_object_mut() {
                o.insert("uses".into(), json!(uses.get(&b.fn_name).copied().unwrap_or(0)));
                o.insert("value".into(), json!(round2(value)));
            }
            base
        })
        .collect();
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

/// PUT /api/analytics/baselines — upsert a baseline (admin edit; appends history).
async fn analytics_put_baseline(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Ok(b) = serde_json::from_str::<BaselineBody>(&body) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {fn, manualMin, toolMin, perItem?, source?}" })),
        )
            .into_response();
    };
    let source = b.source.as_deref().unwrap_or("admin");
    match s.analytics.upsert_baseline(&b.fn_name, b.manual_min, b.tool_min, b.per_item, source, None, Some("api edit")) {
        Ok(()) => Json(json!({ "data": { "fn": b.fn_name, "ok": true } })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct RoleBody {
    role: String,
    #[serde(rename = "hourlyRate")]
    hourly_rate: f64,
}

/// PUT /api/analytics/roles — set a role's hourly rate.
async fn analytics_put_role(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Ok(b) = serde_json::from_str::<RoleBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {role, hourlyRate}" }))).into_response();
    };
    match s.analytics.set_role_rate(&b.role, b.hourly_rate) {
        Ok(()) => Json(json!({ "data": { "role": b.role, "ok": true } })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

/// GET /api/analytics/baselines/history?fn= — audited change history.
async fn analytics_baseline_history(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(fn_name) = q.get("fn") else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "?fn= is required" }))).into_response();
    };
    let h = s.analytics.baseline_history(fn_name);
    let count = h.len();
    Json(json!({ "data": h, "count": count })).into_response()
}

/// GET /api/analytics/baselines/submissions — crowd estimates + current baseline +
/// a >20% divergence flag.
async fn analytics_submissions(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let current: HashMap<String, f64> =
        s.analytics.list_baselines().into_iter().map(|b| (b.fn_name, b.manual_min)).collect();
    let data: Vec<Value> = s
        .analytics
        .list_submissions()
        .into_iter()
        .map(|sub| {
            let mut base = serde_json::to_value(&sub).unwrap_or_else(|_| json!({}));
            let cur = current.get(&sub.fn_name).copied();
            if let Some(o) = base.as_object_mut() {
                o.insert("currentManualMin".into(), json!(cur));
                if let Some(c) = cur.filter(|c| *c > 0.0) {
                    let diff = ((sub.est_manual_min - c).abs() / c * 100.0).round();
                    o.insert("diffPct".into(), json!(diff));
                    o.insert("flagged".into(), json!(diff > 20.0));
                }
            }
            base
        })
        .collect();
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

#[derive(serde::Deserialize)]
struct SubmissionBody {
    #[serde(rename = "fn")]
    fn_name: String,
    #[serde(rename = "manualMin")]
    manual_min: f64,
    #[serde(rename = "anonId")]
    anon_id: Option<String>,
}

/// POST /api/analytics/baselines/submissions — a crowd estimate.
async fn analytics_post_submission(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Ok(b) = serde_json::from_str::<SubmissionBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {fn, manualMin, anonId?}" }))).into_response();
    };
    match s.analytics.add_submission(&b.fn_name, b.manual_min, b.anon_id.as_deref()) {
        Ok(id) => Json(json!({ "data": { "id": id, "ok": true } })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

/// POST /api/analytics/baselines/submissions/{id}/accept — promote to the baseline.
async fn analytics_accept_submission(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<i64>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    match s.analytics.accept_submission(id) {
        Ok(true) => Json(json!({ "data": { "accepted": true } })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Submission not found" }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

/// DELETE /api/analytics/baselines/submissions/{id} — dismiss.
async fn analytics_dismiss_submission(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<i64>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if s.analytics.delete_submission(id) {
        Json(json!({ "data": { "dismissed": true } })).into_response()
    } else {
        (StatusCode::NOT_FOUND, Json(json!({ "error": "Submission not found" }))).into_response()
    }
}

/// "Q1 2026" → [start, end) epoch-ms (UTC), for live projection actuals.
fn quarter_bounds(q: &str) -> Option<(i64, i64)> {
    use chrono::{TimeZone, Utc};
    let mut it = q.split_whitespace();
    let qn: u32 = it.next()?.trim_start_matches(['Q', 'q']).parse().ok()?;
    let year: i32 = it.next()?.parse().ok()?;
    if !(1..=4).contains(&qn) {
        return None;
    }
    let sm = (qn - 1) * 3 + 1;
    let start = Utc.with_ymd_and_hms(year, sm, 1, 0, 0, 0).single()?;
    let (ey, em) = if qn == 4 { (year + 1, 1) } else { (year, sm + 3) };
    let end = Utc.with_ymd_and_hms(ey, em, 1, 0, 0, 0).single()?;
    Some((start.timestamp_millis(), end.timestamp_millis()))
}

/// GET /api/analytics/projections — manager targets + LIVE-derived actuals (ROI
/// over each quarter's window). The `actual_*` columns are NOT used (derived).
async fn analytics_projections(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project = q.get("project_id").map(String::as_str);
    let events = s.store.events_by_type_full("custom", project).await;
    let ctx = roi_ctx(&s);
    let data: Vec<Value> = s
        .analytics
        .list_projections()
        .into_iter()
        .map(|p| {
            let mut base = serde_json::to_value(&p).unwrap_or_else(|_| json!({}));
            let (ah, av) = match quarter_bounds(&p.quarter) {
                Some((start, end)) => {
                    let win: Vec<Value> = events
                        .iter()
                        .filter(|e| {
                            let t = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
                            t >= start && t < end
                        })
                        .cloned()
                        .collect();
                    let tot = ctx.totals(&win);
                    (tot["hours"].as_f64().unwrap_or(0.0), tot["value"].as_f64().unwrap_or(0.0))
                }
                None => (0.0, 0.0),
            };
            if let Some(o) = base.as_object_mut() {
                o.insert("actualHours".into(), json!(round2(ah)));
                o.insert("actualValue".into(), json!(round2(av)));
            }
            base
        })
        .collect();
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

#[derive(serde::Deserialize)]
struct ProjectionBody {
    quarter: String,
    #[serde(rename = "projHours")]
    proj_hours: f64,
    #[serde(rename = "projValue")]
    proj_value: f64,
    notes: Option<String>,
    #[serde(rename = "setBy")]
    set_by: Option<String>,
}

/// POST /api/analytics/projections — set a manager target.
async fn analytics_post_projection(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Ok(b) = serde_json::from_str::<ProjectionBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {quarter, projHours, projValue, notes?, setBy?}" }))).into_response();
    };
    match s.analytics.upsert_projection(&b.quarter, b.proj_hours, b.proj_value, b.notes.as_deref(), b.set_by.as_deref()) {
        Ok(()) => Json(json!({ "data": { "quarter": b.quarter, "ok": true } })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

// ── Mosaic sidecar (ADR-0013 slice 3b) ──────────────────────────────────────

fn mosaic_not_configured() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "Mosaic sidecar not configured",
            "code": "MOSAIC_NOT_CONFIGURED",
            "hint": "set RUNTIMESCOPE_MOSAIC_URL (ADR-0013); ROI $ still works via the SQL path"
        })),
    )
        .into_response()
}

fn mosaic_error(e: String) -> Response {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": e, "code": "MOSAIC_ERROR" }))).into_response()
}

/// Build the ROI input cells (leaves) from the event stream + analytics store —
/// the inputs the cube's rules read. Free fn (handles, not AppState) so the
/// periodic sync + the baseline-whatif both reuse it.
async fn build_facts_for(
    store: &StoreHandle,
    analytics: &AnalyticsStore,
    project: Option<&str>,
) -> Vec<crate::analytics_mosaic::Cell> {
    let events = store.events_by_type_full("custom", project).await;
    let sessions = store.events_by_type_full("session", project).await;
    let mut session_app: HashMap<String, String> = HashMap::new();
    for se in &sessions {
        if let (Some(sid), Some(app)) =
            (se.get("sessionId").and_then(Value::as_str), se.get("appName").and_then(Value::as_str))
        {
            session_app.insert(sid.to_string(), app.to_string());
        }
    }
    let baselines: HashMap<String, (f64, f64, bool)> =
        analytics.list_baselines().into_iter().map(|b| (b.fn_name, (b.manual_min, b.tool_min, b.per_item))).collect();
    let anon_role: HashMap<String, String> = analytics.list_users().into_iter().map(|u| (u.anon_id, u.role)).collect();
    let role_rate: HashMap<String, f64> = analytics.roles().into_iter().map(|r| (r.role, r.hourly_rate)).collect();
    crate::analytics_mosaic::build_facts(&events, &baselines, &anon_role, &role_rate, &session_app)
}

/// Build + push the ROI facts to the cube. Returns the number of cells written.
async fn sync_facts(
    store: &StoreHandle,
    analytics: &AnalyticsStore,
    client: &crate::analytics_mosaic::MosaicClient,
    project: Option<&str>,
) -> Result<usize, String> {
    let cells = build_facts_for(store, analytics, project).await;
    client.write_cells(&cells).await
}

/// GET /api/analytics/mosaic/status — is the sidecar wired + reachable? Always
/// available (reports `configured:false` when the flag is unset).
async fn analytics_mosaic_status(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    match &s.mosaic {
        None => Json(json!({ "data": { "configured": false, "healthy": false } })).into_response(),
        Some(c) => {
            let healthy = c.health().await;
            Json(json!({ "data": { "configured": true, "healthy": healthy, "cube": c.cube() } })).into_response()
        }
    }
}

/// POST /api/analytics/mosaic/sync — push current ROI facts to the cube.
async fn analytics_mosaic_sync(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(c) = s.mosaic.clone() else { return mosaic_not_configured() };
    let project = q.get("project_id").map(String::as_str);
    match sync_facts(&s.store, &s.analytics, &c, project).await {
        Ok(n) => Json(json!({ "data": { "synced": n } })).into_response(),
        Err(e) => mosaic_error(e),
    }
}

/// GET /api/analytics/forecast — sync facts, then query the cube's computed cells
/// (the forecast/value series is the deployed cube's responsibility). Requires
/// the Mosaic sidecar (else 503 — the SQL path has no forecast).
async fn analytics_forecast(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(c) = s.mosaic.clone() else { return mosaic_not_configured() };
    let project = q.get("project_id").map(String::as_str);
    if let Err(e) = sync_facts(&s.store, &s.analytics, &c, project).await {
        return mosaic_error(e);
    }
    let where_ = q.get("where").and_then(|w| serde_json::from_str::<Value>(w).ok()).unwrap_or_else(|| json!({}));
    match c.query(where_, &["value", "hours"]).await {
        Ok(v) => Json(json!({ "data": v })).into_response(),
        Err(e) => mosaic_error(e),
    }
}

/// GET /api/analytics/trace?coord=a,b,c — proxy the cube's dependency trace (the
/// "every dollar → a logged action" audit chain). Requires the Mosaic sidecar.
async fn analytics_trace(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(c) = s.mosaic.clone() else { return mosaic_not_configured() };
    let Some(coord_str) = q.get("coord") else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "?coord=a,b,c required" }))).into_response();
    };
    let coord: Vec<&str> = coord_str.split(',').collect();
    match c.trace(json!(coord)).await {
        Ok(v) => Json(json!({ "data": v })).into_response(),
        Err(e) => mosaic_error(e),
    }
}

#[derive(serde::Deserialize)]
struct BaselineWhatifBody {
    #[serde(rename = "fn")]
    fn_name: String,
    #[serde(rename = "manualMin")]
    manual_min: f64,
    #[serde(rename = "toolMin")]
    tool_min: f64,
}

/// POST /api/analytics/baselines/whatif {fn, manualMin, toolMin} — preview a
/// baseline edit's ROI impact WITHOUT persisting. Because baseline/rate are
/// denormalized onto every leaf (research 0006 §3), this overrides `manual_min`/
/// `tool_min` on **every leaf of the feature** then reads recomputed value/hours.
/// Requires the Mosaic sidecar (else 503).
async fn analytics_baseline_whatif(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(c) = s.mosaic.clone() else { return mosaic_not_configured() };
    let Ok(b) = serde_json::from_str::<BaselineWhatifBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {fn, manualMin, toolMin}" }))).into_response();
    };
    // Cube must hold current facts for the override to land on real leaves.
    if let Err(e) = sync_facts(&s.store, &s.analytics, &c, None).await {
        return mosaic_error(e);
    }
    // One override pair per distinct leaf of the feature (events-cell marks a leaf).
    let cells = build_facts_for(&s.store, &s.analytics, None).await;
    let mut seen = std::collections::HashSet::new();
    let mut overrides = Vec::new();
    for cell in &cells {
        if cell.measure == "events" && cell.coord.get(1).is_some_and(|f| f == &b.fn_name) && seen.insert(cell.coord.clone()) {
            overrides.push(crate::analytics_mosaic::Cell { coord: cell.coord.clone(), measure: "manual_min".into(), value: b.manual_min });
            overrides.push(crate::analytics_mosaic::Cell { coord: cell.coord.clone(), measure: "tool_min".into(), value: b.tool_min });
        }
    }
    if overrides.is_empty() {
        return Json(json!({ "data": { "fn": b.fn_name, "value": 0.0, "hours": 0.0, "note": "no usage for this feature" } })).into_response();
    }
    match c.whatif(&overrides, &["value", "hours"]).await {
        Ok(v) => Json(json!({ "data": v })).into_response(),
        Err(e) => mosaic_error(e),
    }
}

// ── Uptime / status (slice 5) ───────────────────────────────────────────────

fn uptime_slow_ms() -> u64 {
    std::env::var("RUNTIMESCOPE_UPTIME_SLOW_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(400)
}
fn uptime_allow_private() -> bool {
    std::env::var("RUNTIMESCOPE_UPTIME_ALLOW_PRIVATE").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false)
}

fn probe_target(app: &crate::analytics_store::MonitoredApp) -> String {
    match &app.probe_path {
        Some(p) if !p.is_empty() => format!("{}/{}", app.url.trim_end_matches('/'), p.trim_start_matches('/')),
        _ => app.url.clone(),
    }
}

/// Probe one app: SSRF-guard, then GET via a client **pinned to the validated IP**
/// (so reqwest can't re-resolve the host to an attacker-flipped address — DNS
/// rebinding), with a short timeout and NO redirects. Blocked/invalid target or
/// transport error ⇒ down.
async fn probe_app(
    app: &crate::analytics_store::MonitoredApp,
    allow_private: bool,
    slow_ms: u64,
) -> (u8, Option<i64>) {
    use crate::analytics_uptime::{classify, guard_probe_url, DOWN};
    let (url, pin) = match guard_probe_url(&probe_target(app), allow_private).await {
        Ok(v) => v,
        Err(_) => return (DOWN, None),
    };
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    // Pin host → the IP we validated; reqwest then connects to it without a second
    // DNS lookup. (When allow_private, pin is None and normal resolution is used.)
    if let (Some(addr), Some(host)) = (pin, url.host_str()) {
        builder = builder.resolve(host, addr);
    }
    let client = match builder.build() {
        Ok(c) => c,
        Err(_) => return (DOWN, None),
    };
    let t0 = Instant::now();
    let resp = client.get(url).send().await;
    let ms = t0.elapsed().as_millis() as i64;
    match resp {
        Ok(r) if r.status().is_success() => (classify(true, ms as u64, slow_ms), Some(ms)),
        Ok(_) => (DOWN, Some(ms)),
        Err(_) => (DOWN, None),
    }
}

/// Probe all enabled apps, record checks, and open/resolve incidents on state
/// transitions. Returns the count probed. Shared by the background task + check-all.
async fn probe_all(analytics: &AnalyticsStore, allow_private: bool, slow_ms: u64) -> usize {
    use crate::analytics_uptime::{DOWN, UP};
    let apps = analytics.list_apps();
    let mut n = 0;
    for app in apps.iter().filter(|a| a.enabled) {
        let (state, ms) = probe_app(app, allow_private, slow_ms).await;
        let _ = analytics.record_check(&app.id, "probe", state, ms);
        let ongoing = analytics.ongoing_incident(&app.id).is_some();
        if state == UP {
            if ongoing {
                analytics.resolve_incidents(&app.id);
            }
        } else if !ongoing {
            let (kind, sev) = if state == DOWN {
                (ms.map(|m| format!("Down (no 2xx, {m}ms)")).unwrap_or_else(|| "Down (unreachable)".into()), "down")
            } else {
                (format!("Slow response ({}ms > {}ms)", ms.unwrap_or(0), slow_ms), "degraded")
            };
            let _ = analytics.open_incident(&app.id, &kind, sev);
        }
        n += 1;
    }
    n
}

/// GET /api/analytics/status — apps + per-app uptime/strip/last + fleet KPIs.
async fn analytics_status(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let now = now_ms();
    let day = 86_400_000i64;
    let apps = s.analytics.list_apps();
    let (mut healthy, mut degraded, mut down) = (0i64, 0i64, 0i64);
    let (mut resp_sum, mut resp_n) = (0f64, 0i64);
    let (mut up_sum, mut up_n) = (0f64, 0i64);
    let mut data = Vec::new();
    for app in &apps {
        let checks = s.analytics.recent_checks(&app.id, now - 90 * day);
        let st = crate::analytics_uptime::app_status(&checks, now);
        match st["lastState"].as_i64() {
            Some(0) => healthy += 1,
            Some(1) => degraded += 1,
            Some(2) => down += 1,
            _ => {}
        }
        if st["lastState"].as_i64() == Some(0) {
            if let Some(ms) = st["lastRespMs"].as_f64() {
                resp_sum += ms;
                resp_n += 1;
            }
        }
        if let Some(p) = st["uptimePct"].as_f64() {
            up_sum += p;
            up_n += 1;
        }
        let mut obj = serde_json::to_value(app).unwrap_or_else(|_| json!({}));
        if let (Some(o), Some(stobj)) = (obj.as_object_mut(), st.as_object()) {
            for (k, v) in stobj {
                o.insert(k.clone(), v.clone());
            }
        }
        data.push(obj);
    }
    let kpis = json!({
        "appsMonitored": apps.len(),
        "healthy": healthy,
        "degraded": degraded,
        "down": down,
        "activeIncidents": s.analytics.list_incidents("ongoing", None).len(),
        "incidents30d": s.analytics.list_incidents("all", Some(now - 30 * day)).len(),
        "avgRespMs": if resp_n > 0 { json!((resp_sum / resp_n as f64).round()) } else { Value::Null },
        "overallUptimePct": if up_n > 0 { json!((up_sum / up_n as f64 * 100.0).round() / 100.0) } else { Value::Null },
    });
    Json(json!({ "data": data, "count": apps.len(), "kpis": kpis })).into_response()
}

/// GET /api/analytics/incidents?status=ongoing|resolved|all&window=
async fn analytics_incidents(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let status = q.get("status").map(String::as_str).unwrap_or("ongoing");
    let since = q.get("window").and_then(|w| crate::analytics_rollups::window_cutoff(now_ms(), w));
    let inc = s.analytics.list_incidents(status, since);
    let count = inc.len();
    Json(json!({ "data": inc, "count": count })).into_response()
}

#[derive(serde::Deserialize)]
struct MonitoredAppBody {
    name: String,
    url: String,
    #[serde(rename = "probePath")]
    probe_path: Option<String>,
}

/// POST /api/analytics/monitored-apps — register a probe target (SSRF-guarded at
/// add time; the probe re-guards for DNS rebind).
async fn analytics_add_app(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Ok(b) = serde_json::from_str::<MonitoredAppBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {name, url, probePath?}" }))).into_response();
    };
    if let Err(e) = crate::analytics_uptime::guard_probe_url(&b.url, uptime_allow_private()).await {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "BLOCKED_TARGET", "error": e }))).into_response();
    }
    match s.analytics.add_app(&b.name, &b.url, b.probe_path.as_deref()) {
        Ok(app) => Json(json!({ "data": app })).into_response(),
        Err(e) => (StatusCode::CONFLICT, Json(json!({ "error": e }))).into_response(),
    }
}

/// DELETE /api/analytics/monitored-apps/{id}
async fn analytics_delete_app(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if s.analytics.delete_app(&id) {
        Json(json!({ "data": { "deleted": true } })).into_response()
    } else {
        (StatusCode::NOT_FOUND, Json(json!({ "error": "app not found" }))).into_response()
    }
}

#[derive(serde::Deserialize)]
struct HeartbeatBody {
    #[serde(rename = "appId")]
    app_id: String,
}

/// POST /api/analytics/heartbeat — SDK liveness ping. Ingest-side (rate-limited,
/// not dashboard-auth-gated, like /api/events): records an 'up' heartbeat check.
async fn analytics_heartbeat(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !s.rate.allow(Some(peer), &headers) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "rate limited" }))).into_response();
    }
    let Ok(b) = serde_json::from_str::<HeartbeatBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {appId}" }))).into_response();
    };
    match s.analytics.record_check(&b.app_id, "heartbeat", crate::analytics_uptime::UP, None) {
        Ok(()) => Json(json!({ "data": { "ok": true } })).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "unknown appId — register via monitored-apps first" }))).into_response(),
    }
}

/// POST /api/analytics/status/check-all — probe every enabled app now.
async fn analytics_check_all(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let n = probe_all(&s.analytics, uptime_allow_private(), uptime_slow_ms()).await;
    Json(json!({ "data": { "probed": n } })).into_response()
}

// ── Headless surveys (slice 4) ──────────────────────────────────────────────

/// The caller's workspace from the bearer API key (None ⇒ global-admin /
/// unauthenticated). Survey admin scopes by this.
fn caller_workspace(s: &AppState, headers: &HeaderMap) -> Option<String> {
    let token = AuthManager::extract_bearer(headers.get("authorization").and_then(|v| v.to_str().ok()))?;
    s.pm.get_workspace_by_api_key(token).map(|w| w.id)
}

/// A workspace-scoped caller may only touch its own surveys; a global-admin caller
/// (no workspace key) may touch any.
fn owns_survey(s: &AppState, headers: &HeaderMap, survey: &crate::analytics_store::Survey) -> bool {
    match caller_workspace(s, headers) {
        Some(ws) => survey.workspace_id.as_deref() == Some(ws.as_str()),
        None => true,
    }
}

#[derive(serde::Deserialize)]
struct SurveyBody {
    name: String,
    status: Option<String>,
    questions: Value,
    #[serde(default)]
    targeting: Value,
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
}

#[allow(clippy::result_large_err)] // Err is a one-shot Response returned immediately
fn valid_survey_body(b: &SurveyBody) -> Result<(String, Value), Response> {
    if !b.questions.is_array() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "questions must be an array" }))).into_response());
    }
    let status = b.status.clone().unwrap_or_else(|| "draft".to_string());
    if !["draft", "active", "inactive"].contains(&status.as_str()) {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "status must be draft|active|inactive" }))).into_response());
    }
    let targeting = if b.targeting.is_null() { json!({}) } else { b.targeting.clone() };
    Ok((status, targeting))
}

/// POST /api/analytics/surveys — create (admin; workspace from the API key or body).
async fn analytics_create_survey(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Ok(b) = serde_json::from_str::<SurveyBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {name, questions, status?, targeting?, workspaceId?}" }))).into_response();
    };
    let (status, targeting) = match valid_survey_body(&b) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    // A workspace-scoped caller may only create in ITS OWN workspace — never trust a
    // body `workspaceId` to target another tenant (IDOR). Only a global-admin caller
    // (no workspace key) may set an arbitrary workspaceId.
    let ws = match (caller_workspace(&s, &headers), b.workspace_id.clone()) {
        (Some(own), Some(req)) if own != req => {
            return (StatusCode::FORBIDDEN, Json(json!({ "error": "cannot create a survey for another workspace" }))).into_response();
        }
        (Some(own), _) => Some(own),
        (None, body_ws) => body_ws,
    };
    match s.analytics.create_survey(ws.as_deref(), &b.name, &status, &b.questions, &targeting) {
        Ok(sv) => Json(json!({ "data": sv })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

/// GET /api/analytics/surveys — the caller's workspace surveys + response counts.
async fn analytics_list_surveys(State(s): State<AppState>, headers: HeaderMap) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let ws = caller_workspace(&s, &headers);
    let data: Vec<Value> = s
        .analytics
        .list_surveys(ws.as_deref())
        .into_iter()
        .map(|sv| {
            let count = s.analytics.response_count(&sv.id);
            let mut o = serde_json::to_value(&sv).unwrap_or_else(|_| json!({}));
            if let Some(obj) = o.as_object_mut() {
                obj.insert("responseCount".into(), json!(count));
            }
            o
        })
        .collect();
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

/// PUT /api/analytics/surveys/{id} — update (admin, workspace-isolated).
async fn analytics_update_survey(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(sv) = s.analytics.get_survey(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "survey not found" }))).into_response();
    };
    if !owns_survey(&s, &headers, &sv) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "survey not found" }))).into_response();
    }
    let Ok(b) = serde_json::from_str::<SurveyBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {name, questions, status?, targeting?}" }))).into_response();
    };
    let (status, targeting) = match valid_survey_body(&b) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match s.analytics.update_survey(&id, &b.name, &status, &b.questions, &targeting) {
        Ok(_) => Json(json!({ "data": { "id": id, "ok": true } })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

/// DELETE /api/analytics/surveys/{id}
async fn analytics_delete_survey(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    match s.analytics.get_survey(&id) {
        Some(sv) if owns_survey(&s, &headers, &sv) => {
            s.analytics.delete_survey(&id);
            Json(json!({ "data": { "deleted": true } })).into_response()
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": "survey not found" }))).into_response(),
    }
}

/// GET /api/analytics/surveys/{id}/responses — admin (workspace-isolated).
async fn analytics_list_responses(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    match s.analytics.get_survey(&id) {
        Some(sv) if owns_survey(&s, &headers, &sv) => {
            let data = s.analytics.list_responses(&id);
            let count = data.len();
            Json(json!({ "data": data, "count": count })).into_response()
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": "survey not found" }))).into_response(),
    }
}

/// GET /api/analytics/surveys/active?anonId=&projectId= — end-user (projectId-
/// scoped, ingest-rate-limited): eligible active surveys for this user (targeting
/// evaluated server-side; answered/dismissed filtered out). No PII.
async fn analytics_active_surveys(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !s.rate.allow(Some(peer), &headers) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "rate limited" }))).into_response();
    }
    let Some(anon) = q.get("anonId").filter(|a| !a.is_empty()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "?anonId= required" }))).into_response();
    };
    let project = q.get("projectId").map(String::as_str);
    let ws = project.and_then(|p| s.pm.get_project(p)).and_then(|pr| pr.workspace_id);
    // Scoped to the project's workspace + global surveys — NEVER all tenants'
    // (a missing/unknown projectId yields global-only, not everyone's).
    let surveys = s.analytics.list_active_surveys_for(ws.as_deref());
    let role = s.analytics.get_user(anon).map(|u| u.role);

    // Fetch this user's custom events only if some active survey has a feature trigger.
    let needs_features = surveys.iter().any(|sv| crate::analytics_surveys::target_feature(&sv.targeting).is_some());
    let anon_custom: Vec<Value> = if needs_features {
        s.store
            .events_by_type_full("custom", project)
            .await
            .into_iter()
            .filter(|e| e.get("anonId").and_then(Value::as_str) == Some(anon.as_str()))
            .collect()
    } else {
        Vec::new()
    };

    let mut out = Vec::new();
    for sv in &surveys {
        if s.analytics.has_interacted(&sv.id, anon) {
            continue;
        }
        let feature_uses = match crate::analytics_surveys::target_feature(&sv.targeting) {
            Some(feat) => anon_custom.iter().filter(|e| e.get("name").and_then(Value::as_str) == Some(feat.as_str())).count() as u64,
            None => 0,
        };
        if crate::analytics_surveys::eligible(&sv.targeting, &sv.id, anon, role.as_deref(), feature_uses) {
            out.push(json!({ "id": sv.id, "name": sv.name, "questions": sv.questions }));
        }
    }
    let count = out.len();
    Json(json!({ "data": out, "count": count })).into_response()
}

#[derive(serde::Deserialize)]
struct SurveyResponseBody {
    #[serde(rename = "anonId")]
    anon_id: String,
    #[serde(rename = "externalId")]
    external_id: Option<String>,
    answers: Value,
}

/// POST /api/analytics/surveys/{id}/responses — end-user (rate-limited). Validates
/// answers against the survey's questions; ties to the user via anonId + externalId.
async fn analytics_submit_response(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    if !s.rate.allow(Some(peer), &headers) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "rate limited" }))).into_response();
    }
    let Ok(b) = serde_json::from_str::<SurveyResponseBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {anonId, answers, externalId?}" }))).into_response();
    };
    let Some(sv) = s.analytics.get_survey(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "survey not found" }))).into_response();
    };
    // Once-per-user (ADR-0014): reject a second answer/dismissal up front (the
    // UNIQUE(survey_id, anon_id) constraint is the race backstop).
    if s.analytics.has_interacted(&id, &b.anon_id) {
        return (StatusCode::CONFLICT, Json(json!({ "code": "ALREADY_RESPONDED", "error": "this user already answered or dismissed the survey" }))).into_response();
    }
    if let Err(e) = crate::analytics_surveys::validate_answers(&sv.questions, &b.answers) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_ANSWERS", "error": e }))).into_response();
    }
    match s.analytics.record_response(&id, &b.anon_id, b.external_id.as_deref(), &b.answers) {
        Ok(()) => Json(json!({ "data": { "ok": true } })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct SurveyDismissBody {
    #[serde(rename = "anonId")]
    anon_id: String,
}

/// POST /api/analytics/surveys/{id}/dismiss — end-user (rate-limited).
// NOTE (phase-review Low): like respond, this trusts the body anonId (a no-secret
// browser endpoint, design-accepted by ADR-0014). Since anonId = SHA-256(email)
// truncated, someone who knows a target's email could POST /dismiss to suppress
// their survey. Mitigation if this matters: a per-session survey token.
// TODO(analytics-survey-anonbind).
async fn analytics_dismiss_survey(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    if !s.rate.allow(Some(peer), &headers) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "rate limited" }))).into_response();
    }
    let Ok(b) = serde_json::from_str::<SurveyDismissBody>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "code": "INVALID_PAYLOAD", "error": "Body must be {anonId}" }))).into_response();
    };
    if s.analytics.get_survey(&id).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "survey not found" }))).into_response();
    }
    match s.analytics.dismiss_survey(&id, &b.anon_id) {
        Ok(()) => Json(json!({ "data": { "ok": true } })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

// ── Admin de-anon + audit (slice 6) ─────────────────────────────────────────

/// The PII de-anon gate. Requires `X-Admin-Key` to match `RUNTIMESCOPE_ADMIN_KEY`
/// (constant-time). If the env key is UNSET the gate is CLOSED — PII de-anon is
/// opt-in (an ops-set secret), never reachable by default, distinct from the
/// dashboard/workspace tokens.
/// Constant-time match of the presented admin key against the configured one.
/// An empty/absent expected key ⇒ closed (false) — PII de-anon is opt-in.
fn admin_key_ok(expected: Option<&str>, provided: Option<&str>) -> bool {
    use subtle::ConstantTimeEq;
    match (expected.filter(|k| !k.is_empty()), provided) {
        (Some(e), Some(p)) => bool::from(p.as_bytes().ct_eq(e.as_bytes())),
        _ => false,
    }
}

fn admin_authorized(headers: &HeaderMap) -> bool {
    admin_key_ok(
        std::env::var("RUNTIMESCOPE_ADMIN_KEY").ok().as_deref(),
        headers.get("x-admin-key").and_then(|v| v.to_str().ok()),
    )
}

fn admin_forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "admin de-anon disabled or X-Admin-Key invalid", "code": "ADMIN_FORBIDDEN" })),
    )
        .into_response()
}

/// GET /api/analytics/admin/users — de-anonymized user list (PII). Audited.
async fn analytics_admin_users(State(s): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    if !admin_authorized(&headers) {
        return admin_forbidden();
    }
    let ip = s.rate.client_ip(Some(peer), &headers).map(|i| i.to_string());
    if s.analytics.log_admin_access("list_users", None, ip.as_deref()).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "audit write failed — PII withheld" }))).into_response();
    }
    let data = s.analytics.list_users_deanon();
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

/// GET /api/analytics/admin/users/{anonId} — single de-anon. Audited (the attempt
/// is logged even when the anon id is unknown).
async fn analytics_admin_user_by_id(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(anon): Path<String>,
) -> Response {
    if !admin_authorized(&headers) {
        return admin_forbidden();
    }
    let ip = s.rate.client_ip(Some(peer), &headers).map(|i| i.to_string());
    if s.analytics.log_admin_access("deanon_user", Some(&anon), ip.as_deref()).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "audit write failed — PII withheld" }))).into_response();
    }
    match s.analytics.get_user_deanon(&anon) {
        Some(u) => Json(json!({ "data": u })).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "user not found" }))).into_response(),
    }
}

/// GET /api/analytics/admin/audit?limit= — the PII-access audit log.
async fn analytics_admin_audit(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    if !admin_authorized(&headers) {
        return admin_forbidden();
    }
    let limit = q.get("limit").and_then(|v| v.parse::<i64>().ok()).unwrap_or(200);
    let data = s.analytics.list_admin_audit(limit);
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

/// GET /api/analytics/overview?window=&project_id= — usage KPIs (active users,
/// adoption, events, DAU/WAU/MAU, stickiness). ROI/$ deferred to slice 3.
async fn analytics_overview(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project = q.get("project_id").map(String::as_str);
    let window = q.get("window").map(String::as_str).unwrap_or("30d");
    let events = s.store.events_by_type_full("custom", project).await;
    let invited = s.analytics.list_users().len();
    let mut ov = crate::analytics_rollups::overview(&events, now_ms(), window, invited);
    // ROI $ (slice 3a), over the same window.
    let ctx = roi_ctx(&s);
    let win = window_filter(events, now_ms(), window);
    let totals = ctx.totals(&win);
    if let Some(o) = ov.as_object_mut() {
        o.insert("valueSaved".into(), totals["value"].clone());
        o.insert("hoursSaved".into(), totals["hours"].clone());
        o.insert("valueByRole".into(), json!(ctx.by_role(&win)));
    }
    Json(json!({ "data": ov })).into_response()
}

/// GET /api/analytics/features?window=&project_id= — per-feature usage rollup
/// (users, events, adoption% over active users). ROI/$ deferred to slice 3.
async fn analytics_features(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project = q.get("project_id").map(String::as_str);
    let window = q.get("window").map(String::as_str).unwrap_or("30d");
    let events = s.store.events_by_type_full("custom", project).await;
    let cutoff = crate::analytics_rollups::window_cutoff(now_ms(), window);
    let windowed: Vec<Value> = events
        .into_iter()
        .filter(|e| cutoff.is_none_or(|c| e.get("timestamp").and_then(Value::as_i64).unwrap_or(0) >= c))
        .collect();
    let active = crate::analytics_rollups::active_users(&windowed, now_ms(), "all");
    let feat_roi = roi_ctx(&s).by_feature(&windowed);
    let mut feats = crate::analytics_rollups::feature_rollups(&windowed, active);
    for f in feats.iter_mut() {
        if let Some(name) = f.get("feature").and_then(Value::as_str).map(str::to_string) {
            let (v, h) = feat_roi.get(&name).copied().unwrap_or((0.0, 0.0));
            if let Some(o) = f.as_object_mut() {
                o.insert("value".into(), json!(round2(v)));
                o.insert("hours".into(), json!(round2(h)));
            }
        }
    }
    let count = feats.len();
    Json(json!({ "data": feats, "count": count })).into_response()
}

/// GET /api/analytics/trends?window=&buckets=&project_id= — bucketed user+event
/// time series for the Trends charts (value series is ROI → slice 3).
async fn analytics_trends(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project = q.get("project_id").map(String::as_str);
    let window = q.get("window").map(String::as_str).unwrap_or("12w");
    let buckets = q.get("buckets").and_then(|b| b.parse::<usize>().ok()).unwrap_or(12);
    let events = s.store.events_by_type_full("custom", project).await;
    let t = crate::analytics_rollups::trends(&events, now_ms(), window, buckets);
    Json(json!({ "data": t })).into_response()
}

/// GET /api/analytics/funnel?project_id= — activation funnel
/// (identified→activated→repeat→power). `identified` = total identified users.
async fn analytics_funnel(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project = q.get("project_id").map(String::as_str);
    let events = s.store.events_by_type_full("custom", project).await;
    let invited = s.analytics.list_users().len();
    let f = crate::analytics_rollups::funnel(&events, now_ms(), invited);
    Json(json!({ "data": f })).into_response()
}

/// GET /api/analytics/feature-trends?window=&buckets=&top=&project_id= — stacked
/// per-feature event series (top-N + other) for the Trends chart.
async fn analytics_feature_trends(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project = q.get("project_id").map(String::as_str);
    let window = q.get("window").map(String::as_str).unwrap_or("12w");
    let buckets = q.get("buckets").and_then(|b| b.parse().ok()).unwrap_or(12);
    let top = q.get("top").and_then(|t| t.parse().ok()).unwrap_or(4);
    let events = s.store.events_by_type_full("custom", project).await;
    let t = crate::analytics_rollups::feature_trends(&events, now_ms(), window, buckets, top);
    Json(json!({ "data": t })).into_response()
}

/// GET /api/analytics/event-mix?window=&project_id= — event counts by eventType
/// (the donut). Queries the user-facing types and counts within the window.
async fn analytics_event_mix(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    const MIX_TYPES: &[&str] =
        &["custom", "ui", "network", "console", "database", "render", "performance", "navigation", "state"];
    let project = q.get("project_id").map(String::as_str);
    let window = q.get("window").map(String::as_str).unwrap_or("30d");
    let cutoff = crate::analytics_rollups::window_cutoff(now_ms(), window);
    let mut out: Vec<Value> = Vec::new();
    for t in MIX_TYPES {
        let evs = s.store.events_by_type_full(t, project).await;
        let count = evs
            .iter()
            .filter(|e| cutoff.is_none_or(|c| e.get("timestamp").and_then(Value::as_i64).unwrap_or(0) >= c))
            .count();
        if count > 0 {
            out.push(json!({ "type": t, "count": count }));
        }
    }
    out.sort_by(|a, b| b["count"].as_u64().unwrap_or(0).cmp(&a["count"].as_u64().unwrap_or(0)));
    Json(json!({ "data": out })).into_response()
}

/// GET /api/analytics/cohorts?weeks=&project_id= — weekly signup-cohort retention.
async fn analytics_cohorts(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project = q.get("project_id").map(String::as_str);
    let weeks = q.get("weeks").and_then(|w| w.parse().ok()).unwrap_or(8);
    let events = s.store.events_by_type_full("custom", project).await;
    let rows = crate::analytics_rollups::cohort_retention(&events, now_ms(), weeks);
    let count = rows.len();
    Json(json!({ "data": rows, "count": count })).into_response()
}

/// Shared compare computation (used by /compare and /narrative): per-entity
/// users/events/prev + value$/prevValue$ over the current vs prior window.
/// Returns (rows, key_name `role`|`app`).
async fn compute_compare(s: &AppState, by: &str, project: Option<&str>, window: &str) -> (Vec<Value>, &'static str) {
    let events = s.store.events_by_type_full("custom", project).await;
    let now = now_ms();
    let ctx = roi_ctx(s);
    let cur_cut = crate::analytics_rollups::window_cutoff(now, window).unwrap_or(now - 30 * 86_400_000);
    let prev_cut = cur_cut - (now - cur_cut);
    let ts = |e: &Value| e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
    let cur_events: Vec<Value> = events.iter().filter(|e| ts(e) >= cur_cut && ts(e) <= now).cloned().collect();
    let prev_events: Vec<Value> = events.iter().filter(|e| ts(e) >= prev_cut && ts(e) < cur_cut).cloned().collect();

    let (mut rows, key_name, cur_val, prev_val) = if by == "app" {
        // custom events don't carry the app; derive sessionId → appName from the
        // persisted `session` events.
        let sessions = s.store.events_by_type_full("session", project).await;
        let mut session_app: HashMap<String, String> = HashMap::new();
        for se in &sessions {
            if let (Some(sid), Some(app)) =
                (se.get("sessionId").and_then(Value::as_str), se.get("appName").and_then(Value::as_str))
            {
                session_app.insert(sid.to_string(), app.to_string());
            }
        }
        let keyf = |e: &Value| {
            e.get("sessionId").and_then(Value::as_str).map(|s| session_app.get(s).cloned().unwrap_or_else(|| "unknown".to_string()))
        };
        let rows = crate::analytics_rollups::compare_by_app(&events, &session_app, now, window);
        (rows, "app", ctx.value_by(&cur_events, &keyf), ctx.value_by(&prev_events, &keyf))
    } else {
        let roles: HashMap<String, String> =
            s.analytics.list_users().into_iter().map(|u| (u.anon_id, u.role)).collect();
        let keyf = |e: &Value| {
            e.get("anonId").and_then(Value::as_str).map(|a| roles.get(a).cloned().unwrap_or_else(|| "unknown".to_string()))
        };
        let rows = crate::analytics_rollups::compare_by_role(&events, &roles, now, window);
        (rows, "role", ctx.value_by(&cur_events, &keyf), ctx.value_by(&prev_events, &keyf))
    };
    for r in rows.iter_mut() {
        if let Some(k) = r.get(key_name).and_then(Value::as_str).map(str::to_string) {
            if let Some(o) = r.as_object_mut() {
                o.insert("value".into(), json!(round2(cur_val.get(&k).copied().unwrap_or(0.0))));
                o.insert("prevValue".into(), json!(round2(prev_val.get(&k).copied().unwrap_or(0.0))));
            }
        }
    }
    (rows, key_name)
}

/// GET /api/analytics/compare?by=role|app&window=&project_id= — current-vs-prior
/// per entity (users/events/value + prev).
async fn analytics_compare(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let by = q.get("by").map(String::as_str).unwrap_or("role");
    let project = q.get("project_id").map(String::as_str);
    let window = q.get("window").map(String::as_str).unwrap_or("30d");
    let (rows, key_name) = compute_compare(&s, by, project, window).await;
    let count = rows.len();
    Json(json!({ "data": rows, "count": count, "by": key_name })).into_response()
}

/// GET /api/analytics/narrative?by=role|app&window= — the compare-page insight
/// line generated from the compare data (collector-side; works without Mosaic).
async fn analytics_narrative(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let by = q.get("by").map(String::as_str).unwrap_or("role");
    let project = q.get("project_id").map(String::as_str);
    let window = q.get("window").map(String::as_str).unwrap_or("30d");
    let (rows, key_name) = compute_compare(&s, by, project, window).await;
    let n = crate::analytics_rollups::compare_narrative(&rows, key_name);
    Json(json!({ "data": n })).into_response()
}

/// GET /api/analytics/users — anonymized end-users (NO PII), enriched with
/// per-user usage rollups (events / features / sessions) from the event stream.
async fn analytics_users(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let project = q.get("project_id").map(String::as_str);
    let events = s.store.events_by_type_full("custom", project).await;
    let rollups = crate::analytics_rollups::user_rollups(&events);
    let roi = roi_ctx(&s).by_user(&events); // lifetime value attributed per user
    let data: Vec<Value> = s
        .analytics
        .list_users()
        .into_iter()
        .map(|u| {
            let mut base = serde_json::to_value(&u).unwrap_or_else(|_| json!({}));
            let roll = rollups
                .get(&u.anon_id)
                .cloned()
                .unwrap_or_else(|| json!({ "events": 0, "features": 0, "sessions": 0 }));
            let (value, hours) = roi.get(&u.anon_id).copied().unwrap_or((0.0, 0.0));
            if let Some(b) = base.as_object_mut() {
                if let Some(r) = roll.as_object() {
                    for (k, v) in r {
                        b.insert(k.clone(), v.clone());
                    }
                }
                b.insert("value".into(), json!(round2(value)));
                b.insert("hours".into(), json!(round2(hours)));
            }
            base
        })
        .collect();
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

/// GET /api/analytics/users/{anon_id} — one anonymized end-user (NO PII).
async fn analytics_user_by_id(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(anon_id): Path<String>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    match s.analytics.get_user(&anon_id) {
        Some(u) => Json(json!({ "data": u })).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "User not found" }))).into_response(),
    }
}

fn forbidden(msg: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": format!("Forbidden: {msg}") }))).into_response()
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
        // `authEnabled` = a global token is configured (back-compat).
        // `authRequired` = the gate is ACTIVE — a global token OR any workspace
        // API key exists — i.e. the read API + dashboard WS will 401 without a
        // valid token. The dashboard polls this (public, unauthenticated) to know
        // whether to show its login screen. Mirrors resolve_caller's auth_active.
        "authEnabled": s.auth.enabled(),
        "authRequired": s.auth.enabled() || s.pm.has_active_api_keys(),
    }))
}

async fn metrics(State(s): State<AppState>) -> Response {
    // Opt-out parity with Node (sensitive hosted collectors scrape via a sidecar).
    if std::env::var("RUNTIMESCOPE_DISABLE_METRICS").as_deref() == Ok("1") {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain")],
            "Metrics disabled (RUNTIMESCOPE_DISABLE_METRICS=1).\n",
        )
            .into_response();
    }
    let snap = s.store.metrics_snapshot().await;
    let connected = s.store.connected_count().await;
    let uptime = s.started.elapsed().as_secs();

    let mut body = String::from("# RuntimeScope collector metrics\nruntimescope_up 1\n");
    body.push_str("# HELP runtimescope_events_total Total events accepted by the collector since start.\n");
    body.push_str("# TYPE runtimescope_events_total counter\n");
    for (ty, n) in &snap.events_by_type {
        // Escape the label value per the Prometheus exposition format.
        let ty = ty.replace('\\', "\\\\").replace('"', "\\\"");
        body.push_str(&format!("runtimescope_events_total{{type=\"{ty}\"}} {n}\n"));
    }
    body.push_str("# HELP runtimescope_buffer_size Events currently held in the hot-tier window.\n");
    body.push_str("# TYPE runtimescope_buffer_size gauge\n");
    body.push_str(&format!("runtimescope_buffer_size {}\n", snap.buffer_size));
    body.push_str("# HELP runtimescope_sessions_connected SDK sessions currently connected.\n");
    body.push_str("# TYPE runtimescope_sessions_connected gauge\n");
    body.push_str(&format!("runtimescope_sessions_connected {connected}\n"));
    body.push_str("# HELP runtimescope_collector_uptime_seconds Seconds since the collector started.\n");
    body.push_str("# TYPE runtimescope_collector_uptime_seconds gauge\n");
    body.push_str(&format!("runtimescope_collector_uptime_seconds {uptime}\n"));

    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
        .into_response()
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
                "eventCount": si.event_count,
                "isConnected": si.is_connected,
            })
        })
        .collect();
    let count = list.len();
    Json(json!({ "data": list, "count": count })).into_response()
}

/// POST /api/v1/admin/snapshot — atomic `VACUUM INTO` backup of the store.
/// **Admin only**: a workspace-scoped token is non-admin → 403 (the security
/// property the auth-fuzz gate checks). Rate-limited to one call per 60s → 429
/// with `Retry-After`. Mirrors Node's admin snapshot endpoint.
async fn admin_snapshot(State(s): State<AppState>, headers: HeaderMap) -> Response {
    let Some(caller) = resolve_caller(&s, &headers) else {
        return unauthorized();
    };
    if !caller.is_admin {
        return forbidden("snapshot requires admin");
    }
    // 60s cooldown (Node) — checked + claimed under one lock so concurrent calls
    // can't both pass.
    const COOLDOWN_MS: i64 = 60_000;
    {
        let mut last = s.last_snapshot.lock().unwrap();
        let now = now_ms();
        let since = now - *last;
        if *last != 0 && since < COOLDOWN_MS {
            let retry_after = ((COOLDOWN_MS - since) as f64 / 1000.0).ceil() as i64;
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, retry_after.to_string())],
                Json(json!({ "error": "Snapshot rate-limited", "retryAfterSeconds": retry_after })),
            )
                .into_response();
        }
        *last = now;
    }
    match s.store.snapshot().await {
        Ok(v) => (StatusCode::CREATED, Json(v)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
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
        // since_seconds → cutoff = now - since*1000 (Node: Date.now() - sinceSeconds*1000).
        let since_ms = q
            .get("since_seconds")
            .and_then(|v| v.parse::<i64>().ok())
            .map(|secs| now_ms() - secs * 1000);
        let session_id = q.get("session_id").filter(|v| !v.is_empty()).map(String::as_str);
        let data = s.store.timeline(project, types, since_ms, session_id).await;
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
async fn post_events(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: String,
) -> Response {
    // Rate-limit before auth so a flood is shed cheaply (and can't hammer the
    // constant-time token compare). Per remote client; loopback is exempt.
    if !s.rate.allow(Some(peer), &headers) {
        return too_many_requests();
    }
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
        // Surface a persistence failure as 500 instead of a false 200 (audit #5:
        // "an ack that returns success while the write failed is silent data
        // loss"). This is an intended improvement over Node, whose `addEvent` is
        // void and returns 200 even when the write fails. The happy path is
        // unchanged, so conformance stays green.
        if let Err(e) = s.store.add_batch(project, accepted_events).await {
            eprintln!("[RuntimeScope] POST /api/events: durability error: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Failed to persist events", "code": "DURABILITY_ERROR" })),
            )
                .into_response();
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

// ---- embedded dashboard SPA (M6 Slice A) ----
//
// The built dashboard (`packages/dashboard/dist`) is compiled into the binary, so
// the collector serves `/dashboard` with no `packages/dashboard` on disk. Ports
// Node `http-server.ts:897-955`: `/dashboard[/…]` + `/assets/*` (Vite emits
// absolute `/assets/...` paths) → embedded file; an extensionless `/dashboard`
// route falls back to `index.html` for client-side routing; index.html is
// no-cache, hashed assets cache-forever. Path traversal is inherently safe —
// only embedded keys resolve. Public (no auth), like health/metrics.

// Crate-internal vendored SPA (populated by build.rs from packages/dashboard/dist
// in the repo, or shipped inside the published crate). Keeps the binary self-
// contained and the published crate self-contained on crates.io.
#[derive(rust_embed::RustEmbed)]
#[folder = "dashboard/"]
struct DashboardAssets;

fn dashboard_content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

async fn serve_dashboard(uri: Uri) -> Response {
    let path = uri.path();
    let is_asset = path.starts_with("/assets/");
    let rel: String = if is_asset {
        path[1..].to_string() // "/assets/x" → "assets/x"
    } else if path == "/dashboard" || path == "/dashboard/" {
        "index.html".to_string()
    } else {
        path["/dashboard/".len()..].to_string() // "/dashboard/<route>" → "<route>"
    };
    let has_ext = rel.rsplit('/').next().map(|f| f.contains('.')).unwrap_or(false);

    // Exact embedded file, else SPA fallback to index.html for an extensionless
    // non-asset route, else 404.
    let (served, file) = match DashboardAssets::get(&rel) {
        Some(f) => (rel.clone(), Some(f)),
        None if !has_ext && !is_asset => ("index.html".to_string(), DashboardAssets::get("index.html")),
        None => (rel.clone(), None),
    };
    let Some(file) = file else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    let cache = if served.ends_with("index.html") {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, dashboard_content_type(&served)),
            (header::CACHE_CONTROL, cache),
        ],
        file.data.into_owned(),
    )
        .into_response()
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
        // Self-heal: remove pre-filter junk (raw-key names / null paths / home
        // roots) left by Node-era over-discovery, so the dashboard + CSV export
        // stay clean. New junk is already blocked by the discovery filter.
        let pruned = pm_discovery::prune_junk_projects(&pm);
        if pruned > 0 {
            eprintln!("[RuntimeScope] discovery: pruned {pruned} junk project(s) (raw-key/null-path/root)");
        }
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

/// GET /api/pm/workspaces/{id}/api-keys — list the workspace's live keys with
/// the raw secret masked (only `keyPrefix`/`keyLast4` for display). Workspace-
/// scoped: a workspace token may only list its OWN keys (else 403); the global
/// admin token may list any. 404 when the workspace is absent. Mirrors Node's
/// `GET` route + `requireWorkspaceAccess`.
async fn pm_list_api_keys(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let Some(caller) = resolve_caller(&s, &headers) else {
        return unauthorized();
    };
    if !caller.is_admin && caller.workspace_id.as_deref() != Some(id.as_str()) {
        return forbidden("caller not authorized for this workspace");
    }
    if s.pm.list_workspaces().iter().all(|w| w.id != id) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Workspace not found" }))).into_response();
    }
    let data: Vec<Value> = s
        .pm
        .list_api_keys(&id)
        .into_iter()
        .map(|k| {
            // Node's mapApiKeyRow shape — `key` is blank (the secret never leaves
            // create); prefix + last4 are for display.
            let mut o = json!({
                "key": "",
                "keyPrefix": k.key_prefix,
                "keyLast4": k.key_last4,
                "workspaceId": k.workspace_id,
                "label": k.label,
                "createdAt": k.created_at,
            });
            if let Some(e) = k.expires_at {
                o.as_object_mut().unwrap().insert("expiresAt".into(), json!(e));
            }
            o
        })
        .collect();
    Json(json!({ "data": data })).into_response()
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

// ---- pm/ tasks (M5.5 Slice B) ----

/// A JSON `labels` value → the stored JSON-array string (`[]` when absent/not an array).
fn labels_json(v: &Value) -> String {
    match v.get("labels") {
        Some(l) if l.is_array() => l.to_string(),
        _ => "[]".to_string(),
    }
}

/// GET /api/pm/tasks (?project_id=&status=).
async fn pm_tasks_list(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let tasks = s.pm.list_tasks(q.get("project_id").map(String::as_str), q.get("status").map(String::as_str));
    let count = tasks.len();
    Json(json!({ "data": tasks, "count": count })).into_response()
}

/// POST /api/pm/tasks — create; 201 with the task, 400 on missing body/title.
async fn pm_tasks_create(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if body.is_empty() {
        return bad_request("Body required");
    }
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    // Node relies on the NOT NULL title constraint to 400; we guard explicitly.
    let Some(title) = v.get("title").and_then(Value::as_str) else {
        return bad_request("title required");
    };
    match s.pm.create_task(
        v.get("projectId").and_then(Value::as_str),
        title,
        v.get("description").and_then(Value::as_str),
        v.get("status").and_then(Value::as_str).unwrap_or("todo"),
        v.get("priority").and_then(Value::as_str).unwrap_or("medium"),
        &labels_json(&v),
        v.get("source").and_then(Value::as_str).unwrap_or("manual"),
        v.get("sourceRef").and_then(Value::as_str),
        v.get("sortOrder").and_then(Value::as_f64),
        v.get("assignedTo").and_then(Value::as_str),
        v.get("dueDate").and_then(Value::as_str),
    ) {
        // A dangling projectId trips the FK → 400 (Node's createTask throws → 400).
        Ok(task) => (StatusCode::CREATED, Json(serde_json::to_value(&task).unwrap_or_else(|_| json!({})))).into_response(),
        Err(e) => bad_request(&e),
    }
}

/// PUT /api/pm/tasks/{id} — partial update; {ok:true}, 400 on missing body.
async fn pm_tasks_update(
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
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    // labels: present-and-array → re-serialize; absent → leave unchanged.
    let labels = v.get("labels").filter(|l| l.is_array()).map(|l| l.to_string());
    s.pm.update_task(
        &id,
        v.get("title").and_then(Value::as_str),
        v.get("description").and_then(Value::as_str),
        v.get("status").and_then(Value::as_str),
        v.get("priority").and_then(Value::as_str),
        labels.as_deref(),
        v.get("sortOrder").and_then(Value::as_f64),
        v.get("assignedTo").and_then(Value::as_str),
        v.get("dueDate").and_then(Value::as_str),
        v.get("completedAt").and_then(Value::as_i64),
    );
    Json(json!({ "ok": true })).into_response()
}

/// DELETE /api/pm/tasks/{id}.
async fn pm_tasks_delete(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    s.pm.delete_task(&id);
    Json(json!({ "ok": true })).into_response()
}

/// PUT /api/pm/tasks/{id}/reorder — body { status, sortOrder }; 400 on missing body.
async fn pm_tasks_reorder(
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
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    let status = v.get("status").and_then(Value::as_str).unwrap_or("todo");
    let sort_order = v.get("sortOrder").and_then(Value::as_f64).unwrap_or(0.0);
    s.pm.reorder_task(&id, status, sort_order);
    Json(json!({ "ok": true })).into_response()
}

// ---- pm/ notes (M5.5 Slice C) ----

/// A JSON `tags` value → the stored JSON-array string (`[]` when absent/not an array).
fn tags_json(v: &Value) -> String {
    match v.get("tags") {
        Some(t) if t.is_array() => t.to_string(),
        _ => "[]".to_string(),
    }
}

/// GET /api/pm/notes (?project_id=&pinned=1).
async fn pm_notes_list(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    // Node: ?pinned=1 → pinned-only; anything else → no filter.
    let pinned = if q.get("pinned").map(String::as_str) == Some("1") { Some(true) } else { None };
    let notes = s.pm.list_notes(q.get("project_id").map(String::as_str), pinned);
    let count = notes.len();
    Json(json!({ "data": notes, "count": count })).into_response()
}

/// POST /api/pm/notes — create; 201 with the note, 400 on missing body.
async fn pm_notes_create(State(s): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if body.is_empty() {
        return bad_request("Body required");
    }
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    match s.pm.create_note(
        v.get("projectId").and_then(Value::as_str),
        v.get("sessionId").and_then(Value::as_str),
        v.get("title").and_then(Value::as_str).unwrap_or("Untitled"),
        v.get("content").and_then(Value::as_str).unwrap_or(""),
        v.get("pinned").and_then(Value::as_bool).unwrap_or(false),
        &tags_json(&v),
    ) {
        Ok(note) => (StatusCode::CREATED, Json(serde_json::to_value(&note).unwrap_or_else(|_| json!({})))).into_response(),
        Err(e) => bad_request(&e),
    }
}

/// PUT /api/pm/notes/{id} — partial update; {ok:true}, 400 on missing body.
async fn pm_notes_update(
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
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return bad_request("Invalid JSON");
    };
    let tags = v.get("tags").filter(|t| t.is_array()).map(|t| t.to_string());
    s.pm.update_note(
        &id,
        v.get("title").and_then(Value::as_str),
        v.get("content").and_then(Value::as_str),
        v.get("pinned").and_then(Value::as_bool),
        tags.as_deref(),
    );
    Json(json!({ "ok": true })).into_response()
}

/// DELETE /api/pm/notes/{id}.
async fn pm_notes_delete(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    s.pm.delete_note(&id);
    Json(json!({ "ok": true })).into_response()
}

// ---- pm/ memory files + rules (M5.5 Slice D) ----

/// Strip path separators and `..` to block traversal — ports Node `sanitizeFilename`
/// (`name.replace(/[/\\]/g,'').replace(/\.\./g,'')`, applied in that order).
fn sanitize_filename(name: &str) -> String {
    name.replace(['/', '\\'], "").replace("..", "")
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// `<home>/.claude/projects/<claudeProjectKey>/memory`.
fn memory_dir(key: &str) -> std::path::PathBuf {
    std::path::Path::new(&home_dir()).join(".claude").join("projects").join(key).join("memory")
}

fn not_found_json(msg: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": msg }))).into_response()
}

/// GET /api/pm/memory/{projectId} — list `*.md` memory files. No project / no
/// claudeProjectKey / unreadable dir → `{ data: [], count: 0 }` (Node parity).
async fn pm_memory_list(State(s): State<AppState>, headers: HeaderMap, Path(project_id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let empty = || Json(json!({ "data": [], "count": 0 })).into_response();
    let Some(key) = s.pm.get_project(&project_id).and_then(|p| p.claude_project_key) else {
        return empty();
    };
    let dir = memory_dir(&key);
    let Ok(entries) = std::fs::read_dir(&dir) else { return empty() };
    let mut data: Vec<Value> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".md") {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(dir.join(&name)) {
            let size = content.len();
            data.push(json!({ "filename": name, "content": content, "sizeBytes": size }));
        }
    }
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

/// GET /api/pm/memory/{projectId}/{filename} — read one memory file.
async fn pm_memory_get(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((project_id, filename)): Path<(String, String)>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(key) = s.pm.get_project(&project_id).and_then(|p| p.claude_project_key) else {
        return not_found_json("Project not found");
    };
    let filename = sanitize_filename(&filename);
    match std::fs::read_to_string(memory_dir(&key).join(&filename)) {
        Ok(content) => {
            let size = content.len();
            Json(json!({ "filename": filename, "content": content, "sizeBytes": size })).into_response()
        }
        Err(_) => not_found_json("File not found"),
    }
}

/// PUT /api/pm/memory/{projectId}/{filename} — write a memory file.
async fn pm_memory_put(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((project_id, filename)): Path<(String, String)>,
    body: String,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    // Node checks project (404) before body (400).
    let Some(key) = s.pm.get_project(&project_id).and_then(|p| p.claude_project_key) else {
        return not_found_json("Project not found");
    };
    if body.is_empty() {
        return bad_request("Body required");
    }
    let content = match serde_json::from_str::<Value>(&body) {
        Ok(v) => v.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    };
    let filename = sanitize_filename(&filename);
    let dir = memory_dir(&key);
    if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join(&filename), content)) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response();
    }
    Json(json!({ "ok": true })).into_response()
}

/// DELETE /api/pm/memory/{projectId}/{filename}.
async fn pm_memory_delete(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((project_id, filename)): Path<(String, String)>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(key) = s.pm.get_project(&project_id).and_then(|p| p.claude_project_key) else {
        return not_found_json("Project not found");
    };
    let filename = sanitize_filename(&filename);
    match std::fs::remove_file(memory_dir(&key).join(&filename)) {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(_) => not_found_json("File not found"),
    }
}

/// The CLAUDE.md path at each scope — ports Node `getRulesPaths`.
fn rules_paths(claude_project_key: Option<&str>, project_path: Option<&str>) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let home = home_dir();
    let global = std::path::Path::new(&home).join(".claude").join("CLAUDE.md");
    let project = match claude_project_key {
        Some(k) => std::path::Path::new(&home).join(".claude").join("projects").join(k).join("CLAUDE.md"),
        None => std::path::Path::new(project_path.unwrap_or("")).join(".claude").join("CLAUDE.md"),
    };
    let local = match project_path {
        Some(p) => std::path::Path::new(p).join("CLAUDE.md"),
        None => std::path::Path::new(&home).join("CLAUDE.md"),
    };
    (global, project, local)
}

/// `{ path, content, exists }` for a rule file — ports Node `readRuleFile`.
fn read_rule_file(path: &std::path::Path) -> Value {
    match std::fs::read_to_string(path) {
        Ok(content) => json!({ "path": path.to_string_lossy(), "content": content, "exists": true }),
        Err(_) => json!({ "path": path.to_string_lossy(), "content": "", "exists": false }),
    }
}

const RULE_SCOPES: [&str; 3] = ["global", "project", "local"];

/// GET /api/pm/rules/{projectId} — all three scopes.
async fn pm_rules_all(State(s): State<AppState>, headers: HeaderMap, Path(project_id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(project) = s.pm.get_project(&project_id) else {
        return not_found_json("Project not found");
    };
    let (global, project_p, local) = rules_paths(project.claude_project_key.as_deref(), project.path.as_deref());
    Json(json!({
        "global": read_rule_file(&global),
        "project": read_rule_file(&project_p),
        "local": read_rule_file(&local),
    }))
    .into_response()
}

fn rule_path_for_scope(scope: &str, project: &crate::pm_store::PmProject) -> std::path::PathBuf {
    let (global, project_p, local) = rules_paths(project.claude_project_key.as_deref(), project.path.as_deref());
    match scope {
        "global" => global,
        "project" => project_p,
        _ => local,
    }
}

/// GET /api/pm/rules/{projectId}/{scope} — one scope. Invalid scope → 400 (before
/// the project lookup, matching Node).
async fn pm_rules_get(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((project_id, scope)): Path<(String, String)>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if !RULE_SCOPES.contains(&scope.as_str()) {
        return bad_request("Invalid scope. Must be: global, project, or local");
    }
    let Some(project) = s.pm.get_project(&project_id) else {
        return not_found_json("Project not found");
    };
    Json(read_rule_file(&rule_path_for_scope(&scope, &project))).into_response()
}

/// PUT /api/pm/rules/{projectId}/{scope} — write a scope's CLAUDE.md.
async fn pm_rules_put(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((project_id, scope)): Path<(String, String)>,
    body: String,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if !RULE_SCOPES.contains(&scope.as_str()) {
        return bad_request("Invalid scope");
    }
    let Some(project) = s.pm.get_project(&project_id) else {
        return not_found_json("Project not found");
    };
    if body.is_empty() {
        return bad_request("Body required");
    }
    let content = match serde_json::from_str::<Value>(&body) {
        Ok(v) => v.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    };
    let path = rule_path_for_scope(&scope, &project);
    let write = path
        .parent()
        .map(std::fs::create_dir_all)
        .unwrap_or(Ok(()))
        .and_then(|_| std::fs::write(&path, content));
    if let Err(e) = write {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response();
    }
    Json(json!({ "ok": true })).into_response()
}

// ---- pm/ project + session ops (M5.5 Slice E) ----

fn q_hide_empty(q: &HashMap<String, String>) -> bool {
    matches!(q.get("hide_empty").map(String::as_str), Some("1") | Some("true"))
}

/// GET /api/pm/projects/summaries (?start_date=&end_date=&hide_empty=).
async fn pm_projects_summaries(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let summaries = s.pm.get_project_summaries(
        q.get("start_date").map(String::as_str),
        q.get("end_date").map(String::as_str),
        q_hide_empty(&q),
    );
    let count = summaries.len();
    Json(json!({ "data": summaries, "count": count })).into_response()
}

/// GET /api/pm/sessions/stats (?project_id=&start_date=&end_date=&hide_empty=).
async fn pm_sessions_stats(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let stats = s.pm.session_stats_filtered(
        q.get("project_id").filter(|v| !v.is_empty()).map(String::as_str),
        q.get("start_date").map(String::as_str),
        q.get("end_date").map(String::as_str),
        q_hide_empty(&q),
    );
    Json(serde_json::to_value(&stats).unwrap_or_else(|_| json!({}))).into_response()
}

/// CSV field escape — ports Node's `csvEscape` (quote+double when it contains `,`/`"`/newline).
fn csv_escape(v: &str) -> String {
    if v.contains(',') || v.contains('"') || v.contains('\n') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

fn ymd(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|dt| dt.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// GET /api/pm/projects/export-csv — the two-section (PROJECTS / SESSIONS) CSV
/// export. Ports Node exactly (section markers, headers, csvEscape, rounding).
async fn pm_projects_export_csv(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let start = q.get("start_date").map(String::as_str);
    let end = q.get("end_date").map(String::as_str);
    let hide_empty = q_hide_empty(&q);
    let project_ids: Option<Vec<String>> = q
        .get("project_ids")
        .filter(|v| !v.is_empty())
        .map(|v| v.split(',').filter(|s| !s.is_empty()).map(String::from).collect());

    let mut summaries = s.pm.get_project_summaries(start, end, hide_empty);
    if let Some(ids) = &project_ids {
        summaries.retain(|p| ids.contains(&p.id));
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("=== PROJECTS ===".into());
    lines.push("Project,Category,Sessions,Messages,Cost ($),Active Time (min),Last Session".into());
    for p in &summaries {
        lines.push(
            [
                csv_escape(&p.name),
                csv_escape(p.category.as_deref().unwrap_or("")),
                p.session_count.to_string(),
                p.total_messages.to_string(),
                format!("{:.2}", p.total_cost as f64 / 1_000_000.0),
                (p.total_active_minutes.round() as i64).to_string(),
                p.last_session_at.map(ymd).unwrap_or_default(),
            ]
            .join(","),
        );
    }
    lines.push(String::new());
    lines.push("=== SESSIONS ===".into());
    lines.push("Project,Session ID,Slug,Model,Date,Messages,Tokens In,Tokens Out,Cost ($),Active Time (min),Branch".into());

    // Sessions for the (filtered) projects, newest-first across all of them.
    let mut sessions: Vec<crate::pm_store::PmSession> = Vec::new();
    for p in &summaries {
        sessions.extend(s.pm.list_sessions_filtered(Some(&p.id), start, end, hide_empty));
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.started_at));
    for sess in &sessions {
        let pname = summaries
            .iter()
            .find(|p| p.id == sess.project_id)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| sess.project_id.clone());
        lines.push(
            [
                csv_escape(&pname),
                csv_escape(&sess.id),
                csv_escape(sess.slug.as_deref().unwrap_or("")),
                csv_escape(sess.model.as_deref().unwrap_or("")),
                ymd(sess.started_at),
                sess.message_count.to_string(),
                sess.total_input_tokens.to_string(),
                sess.total_output_tokens.to_string(),
                format!("{:.2}", sess.cost_microdollars as f64 / 1_000_000.0),
                (sess.active_minutes.round() as i64).to_string(),
                csv_escape(sess.git_branch.as_deref().unwrap_or("")),
            ]
            .join(","),
        );
    }

    let today = chrono::Utc::now().format("%Y-%m-%d");
    csv_response(&format!("runtimescope-export-{today}.csv"), lines.join("\n"))
}

/// POST /api/pm/sessions/{id}/refresh — re-index the session's project, return the
/// updated session. 404 when the session is unknown.
async fn pm_session_refresh(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(session) = s.pm.get_session(&id) else {
        return not_found_json("Session not found");
    };
    let pm = s.pm.clone();
    let project_id = session.project_id.clone();
    let claude_base = std::path::Path::new(&home_dir()).join(".claude");
    let _ = tokio::task::spawn_blocking(move || {
        crate::pm_discovery::reindex_project_sessions(&pm, &project_id, &claude_base);
    })
    .await;
    match s.pm.get_session(&id) {
        Some(updated) => Json(serde_json::to_value(&updated).unwrap_or_else(|_| json!({}))).into_response(),
        None => not_found_json("Session not found"),
    }
}

// ---- pm/ project scripts (M5.5 Slice G, step 1 — the safe package.json read) ----

/// `{ scripts, recommended }` from `<path>/package.json` — ports Node's `/scripts`
/// handler: `scripts = pkg.scripts ?? {}`; `recommended` = the first of
/// `dev`/`start`/`serve` present, else null. Missing/unparsable file → empty.
fn read_project_scripts(path: &str) -> Value {
    let empty = json!({ "scripts": {}, "recommended": Value::Null });
    let Ok(content) = std::fs::read_to_string(std::path::Path::new(path).join("package.json")) else {
        return empty;
    };
    let Ok(pkg) = serde_json::from_str::<Value>(&content) else {
        return empty;
    };
    let scripts = pkg.get("scripts").filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}));
    let recommended = ["dev", "start", "serve"]
        .iter()
        .find(|s| scripts.get(**s).is_some())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);
    json!({ "scripts": scripts, "recommended": recommended })
}

/// GET /api/pm/projects/{id}/scripts — 404 no-project; `{scripts:{},recommended:null}`
/// when the project has no path; else the package.json scripts.
async fn pm_project_scripts(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(project) = s.pm.get_project(&id) else {
        return not_found_json("Project not found");
    };
    let Some(path) = project.path else {
        return Json(json!({ "data": { "scripts": {}, "recommended": Value::Null } })).into_response();
    };
    let data = tokio::task::spawn_blocking(move || read_project_scripts(&path))
        .await
        .unwrap_or_else(|_| json!({ "scripts": {}, "recommended": Value::Null }));
    Json(json!({ "data": data })).into_response()
}

// ---- pm/ dev-server lifecycle (M5.5 Slice G, steps 2-4 — the "no gaps" slice) ----
//
// Closes the Node bugs rather than porting them (see docs/research/0004): argv +
// no shell, own process group, group-kill on stop, real listening-socket
// detection over the child tree, persistence + re-attach, devcontainer
// detect-and-warn, and active auto-attach of the detected port to monitoring.
// The OS-facing primitives live in `crate::dev_server`; this is the orchestration.

/// On startup, restore the managed-proc map from `pm.db`: keep live groups,
/// prune dead rows. A re-attached proc has no `Child`/monitor (it predates us) —
/// `GET` re-derives its status from the pgid liveness check + persisted ports.
fn reattach_dev_servers(pm: &PmStore, map: &ProcMap) {
    let current_boot = crate::dev_server::boot_time_secs();
    for rec in pm.dev_server_list() {
        // Reboot/identity guard: only trust a persisted pgid if it was spawned in
        // the CURRENT boot. After a reboot the kernel recycles pgids, so a stored
        // pgid could name an unrelated process group — re-attaching it would report
        // a stranger's process "running" and DELETE would group-kill it. Prune any
        // record not from this boot (incl. legacy boot_time=0). (Both reviewers + R2.)
        if let Some(now_boot) = current_boot {
            if rec.boot_time != now_boot {
                pm.dev_server_delete(&rec.project_id);
                continue;
            }
        }
        let pgid = rec.pgid as i32;
        if group_alive(pgid) {
            let inner = Arc::new(ProcInner {
                status: Mutex::new(rec.status.clone()),
                exit_code: Mutex::new(None),
                // Logs don't survive a restart (audit bug #10, acceptable for v1).
                logs: Mutex::new(Vec::new()),
                ports: Mutex::new(rec.parsed_ports()),
            });
            let mp = ManagedProc {
                pid: rec.pid as u32,
                pgid,
                command: rec.command.clone(),
                started_at: rec.started_at,
                container_local: rec.container_local,
                inner,
            };
            map.lock().unwrap().insert(rec.project_id, mp);
        } else {
            pm.dev_server_delete(&rec.project_id);
        }
    }
}

/// Tail a child stream into the proc's capped log ring (≤ MAX_LOG_LINES).
fn spawn_log_reader<R: std::io::Read + Send + 'static>(stream: R, inner: Arc<ProcInner>) {
    use std::io::{BufRead, BufReader};
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let mut logs = inner.logs.lock().unwrap();
            logs.push(line);
            let len = logs.len();
            if len > MAX_LOG_LINES {
                logs.drain(0..len - MAX_LOG_LINES);
            }
        }
    });
}

/// The detect-monitor: owns the spawned `Child` (so it reaps on exit — no
/// zombie), captures logs, and flips `starting`→`running` once the child TREE
/// actually binds a port (real socket poll, not log-scrape). On exit it prunes
/// the map + db so `GET` reports the truth.
fn spawn_dev_monitor(spawned: Spawned, mp: ManagedProc, pm: PmStore, map: ProcMap, project_id: String) {
    let Spawned { pid: _, pgid, mut child } = spawned;
    if let Some(out) = child.stdout.take() {
        spawn_log_reader(out, mp.inner.clone());
    }
    if let Some(err) = child.stderr.take() {
        spawn_log_reader(err, mp.inner.clone());
    }
    std::thread::spawn(move || {
        let start = Instant::now();
        let mut detected = false;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    *mp.inner.exit_code.lock().unwrap() = code;
                    let st = if code == Some(0) { "stopped" } else { "crashed" };
                    *mp.inner.status.lock().unwrap() = st.to_string();
                    map.lock().unwrap().remove(&project_id);
                    pm.dev_server_delete(&project_id);
                    let _ = child.wait(); // ensure fully reaped
                    return;
                }
                Ok(None) => {}
                Err(_) => return,
            }
            if !detected && start.elapsed() < DETECT_TIMEOUT {
                let ports = poll_listening_ports(pgid);
                if !ports.is_empty() {
                    detected = true;
                    *mp.inner.ports.lock().unwrap() = ports.clone();
                    {
                        let mut s = mp.inner.status.lock().unwrap();
                        if *s == "starting" {
                            *s = "running".to_string();
                        }
                    }
                    // Tie the detected port back to monitoring: persist it so a
                    // restart re-attaches with the real ports and GET/dashboard
                    // can surface the auto-attach hint (the feature's reason to exist).
                    let ports_json = serde_json::to_string(&ports).ok();
                    pm.dev_server_update_status(&project_id, "running", ports_json.as_deref());
                }
            }
            std::thread::sleep(if detected { Duration::from_millis(500) } else { DETECT_INTERVAL });
        }
    });
}

/// Parse the POST body `{ script?, command? }` (Node `try { JSON.parse } catch {}`).
fn parse_dev_body(body: &str) -> DevServerRequest {
    if body.is_empty() {
        return DevServerRequest::default();
    }
    serde_json::from_str::<Value>(body)
        .ok()
        .map(|v| DevServerRequest {
            command: v.get("command").and_then(Value::as_str).map(String::from),
            script: v.get("script").and_then(Value::as_str).map(String::from),
        })
        .unwrap_or_default()
}

/// Parse the DELETE body `{ signal? }` → "SIGKILL" or default "SIGTERM".
fn parse_dev_signal(body: &str) -> &'static str {
    let is_kill = (!body.is_empty())
        .then(|| serde_json::from_str::<Value>(body).ok())
        .flatten()
        .and_then(|v| v.get("signal").and_then(Value::as_str).map(|s| s == "SIGKILL"))
        .unwrap_or(false);
    if is_kill {
        "SIGKILL"
    } else {
        "SIGTERM"
    }
}

/// GET /api/pm/projects/{id}/dev-server — no managed proc → `{data:{status:"stopped"}}`;
/// a managed proc whose group has died → pruned + `stopped`; else the live status,
/// pid, command, startedAt, exitCode, logs (last 100) + the additive `ports`,
/// `isContainerLocal`, `autoAttach` fields.
async fn pm_dev_server_get(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let stopped = || Json(json!({ "data": { "status": "stopped" } })).into_response();
    let Some(mp) = s.dev_servers.lock().unwrap().get(&id).cloned() else {
        return stopped();
    };
    // Liveness-check the group (Node checks the pid); a dead group → prune + stopped.
    if !group_alive(mp.pgid) {
        s.dev_servers.lock().unwrap().remove(&id);
        s.pm.dev_server_delete(&id);
        return stopped();
    }
    let status = mp.inner.status.lock().unwrap().clone();
    let exit_code = *mp.inner.exit_code.lock().unwrap();
    let ports = mp.inner.ports.lock().unwrap().clone();
    let logs: Vec<String> = {
        let l = mp.inner.logs.lock().unwrap();
        l[l.len().saturating_sub(100)..].to_vec()
    };
    let auto_attach = build_auto_attach(&ports, mp.container_local, &id);
    Json(json!({ "data": {
        // --- Node-matched shape (the dashboard reads these) ---
        "status": status,
        "pid": mp.pid,
        "command": mp.command,
        "startedAt": mp.started_at,
        "exitCode": exit_code,
        "logs": logs,
        // --- additive (allowed by the contract): the real tie-back ---
        "ports": ports,
        "isContainerLocal": mp.container_local,
        "autoAttach": auto_attach,
    }}))
    .into_response()
}

/// POST /api/pm/projects/{id}/dev-server — start a dev server (argv, no shell,
/// own process group). 404 unknown project; 400 no path / invalid input; 409
/// already running; else `200 {data:{pid, command, cwd, status:"starting"}}`.
async fn pm_dev_server_post(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(project) = s.pm.get_project(&id) else {
        return not_found_json("Project not found");
    };
    let Some(path) = project.path else {
        return bad_request("Project has no filesystem path");
    };

    // Atomically reserve the start so two concurrent POSTs for the same project
    // can't both pass the "already running?" check and double-spawn (TOCTOU). The
    // first to insert wins; the rest 409. The guard releases the reservation on
    // every exit path below.
    {
        let mut starting = s.dev_starting.lock().unwrap();
        if starting.contains(&id) {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "Dev server already starting", "data": { "status": "starting" } })),
            )
                .into_response();
        }
        starting.insert(id.clone());
    }
    let _start_guard = StartGuard { set: s.dev_starting.clone(), id: id.clone() };

    // Already running? (Node: process.kill(existing.pid, 0) → 409.) A stale dead
    // entry is pruned so a fresh start succeeds.
    if let Some(mp) = s.dev_servers.lock().unwrap().get(&id).cloned() {
        if group_alive(mp.pgid) {
            let status = mp.inner.status.lock().unwrap().clone();
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "Dev server already running", "data": { "pid": mp.pid, "status": status } })),
            )
                .into_response();
        }
        s.dev_servers.lock().unwrap().remove(&id);
        s.pm.dev_server_delete(&id);
    }

    let launch = match resolve_launch(&parse_dev_body(&body)) {
        Ok(l) => l,
        Err(e) => return bad_request(&e),
    };

    // Spawn + container-detect are blocking/fs work → spawn_blocking.
    let cwd = path.clone();
    let argv = launch.argv.clone();
    let spawn_result = tokio::task::spawn_blocking(move || {
        let container_local = detect_container_local(&cwd);
        (container_local, spawn_dev_process(&argv, &cwd))
    })
    .await;

    let (container_local, spawned) = match spawn_result {
        Ok(t) => t,
        Err(_) => return git_500("spawn task failed".into()),
    };
    let spawned = match spawned {
        Ok(sp) => sp,
        Err(e) => return git_500(e.to_string()),
    };

    let pid = spawned.pid;
    let now = now_ms();
    let inner = Arc::new(ProcInner {
        status: Mutex::new("starting".to_string()),
        exit_code: Mutex::new(None),
        logs: Mutex::new(Vec::new()),
        ports: Mutex::new(Vec::new()),
    });
    let mp = ManagedProc {
        pid,
        pgid: spawned.pgid,
        command: launch.display.clone(),
        started_at: now,
        container_local,
        inner,
    };
    s.dev_servers.lock().unwrap().insert(id.clone(), mp.clone());
    s.pm.dev_server_upsert(&crate::pm_store::DevServerRecord {
        project_id: id.clone(),
        pid: pid as i64,
        pgid: spawned.pgid as i64,
        command: launch.display.clone(),
        cwd: path.clone(),
        started_at: now,
        status: "starting".to_string(),
        ports: None,
        container_local,
        boot_time: crate::dev_server::boot_time_secs().unwrap_or(0),
    });
    spawn_dev_monitor(spawned, mp, s.pm.clone(), s.dev_servers.clone(), id.clone());

    Json(json!({ "data": { "pid": pid, "command": launch.display, "cwd": path, "status": "starting" } }))
        .into_response()
}

/// DELETE /api/pm/projects/{id}/dev-server — group-kill the whole tree. 404
/// unknown project; 404 nothing running; else `200 {data:{killed:true, pid, signal}}`
/// (+ `note:"Process already exited"` when the group was already gone).
///
/// Intended divergence from Node: we do NOT port the fragile `findPidsInDirectory`
/// fallback (audit bug #7 — shell-interpolated `lsof +D`, `/proc` prefix match,
/// kills an arbitrary pid). With persistence + re-attach the map is the source of
/// truth, so "no managed entry" → 404, and the kill is a `kill(-pgid)` group-kill.
async fn pm_dev_server_delete(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if s.pm.get_project(&id).is_none() {
        return not_found_json("Project not found");
    }
    let (sig, sig_name) = signal_from_name(parse_dev_signal(&body));

    let Some(mp) = s.dev_servers.lock().unwrap().get(&id).cloned() else {
        return not_found_json("No running dev server found for this project");
    };
    let pid = mp.pid;
    let pgid = mp.pgid;
    // Drop our tracking up front (Node deletes the map entry on stop).
    s.dev_servers.lock().unwrap().remove(&id);
    s.pm.dev_server_delete(&id);

    let outcome = tokio::task::spawn_blocking(move || stop_group(pgid, sig))
        .await
        .unwrap_or_else(|_| StopOutcome::Error("kill task failed".into()));

    match outcome {
        StopOutcome::Signalled => {
            Json(json!({ "data": { "killed": true, "pid": pid, "signal": sig_name } })).into_response()
        }
        StopOutcome::AlreadyExited => Json(
            json!({ "data": { "killed": true, "pid": pid, "signal": sig_name, "note": "Process already exited" } }),
        )
        .into_response(),
        StopOutcome::Error(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Failed to kill PID {pid}: {e}") })),
        )
            .into_response(),
    }
}

// ---- process monitor: /api/processes + /api/ports (M5.5 Core) ----
//
// Live ps/lsof on mcp-server (`s.process_monitor == true`); empty on the
// standalone collector-server — matching Node, where only the MCP server
// constructs a `ProcessMonitor`. Live data is non-deterministic → shape-only
// conformance; the standalone-empty + DELETE-500 paths gate green-vs-both.

/// GET /api/processes (?type=&project=) — live `DevProcess[]` or empty when disabled.
async fn processes_get(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if !s.process_monitor {
        return Json(json!({ "data": [], "count": 0 })).into_response();
    }
    let ptype = q.get("type").filter(|v| !v.is_empty()).cloned();
    let project = q.get("project").filter(|v| !v.is_empty()).cloned();
    let data = tokio::task::spawn_blocking(move || {
        let mut procs = crate::process_monitor::scan_dev_processes();
        if let Some(t) = &ptype {
            procs.retain(|p| p.get("type").and_then(Value::as_str) == Some(t.as_str()));
        }
        if let Some(pr) = &project {
            procs.retain(|p| p.get("project").and_then(Value::as_str) == Some(pr.as_str()));
        }
        procs
    })
    .await
    .unwrap_or_default();
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

/// GET /api/ports (?port=) — live `PortUsage[]` or empty when disabled.
async fn ports_get(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if !s.process_monitor {
        return Json(json!({ "data": [], "count": 0 })).into_response();
    }
    let port = q.get("port").and_then(|v| v.parse::<u16>().ok());
    let data = tokio::task::spawn_blocking(move || crate::process_monitor::port_usage(port))
        .await
        .unwrap_or_default();
    let count = data.len();
    Json(json!({ "data": data, "count": count })).into_response()
}

/// DELETE /api/processes (?pid=&signal= or body) — kill a pid. 500 when disabled
/// (Node "Process monitor not available"); 400 when no pid; else `{data:{success,…}}`.
async fn processes_delete(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    body: String,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    if !s.process_monitor {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Process monitor not available" }))).into_response();
    }
    let mut pid = q.get("pid").and_then(|v| v.parse::<i64>().ok());
    let mut signal = q.get("signal").filter(|v| !v.is_empty()).cloned();
    if pid.is_none() && !body.is_empty() {
        if let Ok(v) = serde_json::from_str::<Value>(&body) {
            pid = v.get("pid").and_then(Value::as_i64);
            if signal.is_none() {
                signal = v.get("signal").and_then(Value::as_str).map(String::from);
            }
        }
    }
    let Some(pid) = pid else {
        return bad_request("pid is required");
    };
    let sig = signal.unwrap_or_else(|| "SIGTERM".to_string());
    let result = tokio::task::spawn_blocking(move || crate::process_monitor::kill_process(pid, &sig))
        .await
        .unwrap_or_else(|_| json!({ "success": false, "error": "kill task failed" }));
    Json(json!({ "data": result })).into_response()
}

// ---- pm/ git integration (M5.5 Slice F) ----
//
// All git invocations go through `run_git` → `std::process::Command` with an
// explicit argv and NO shell (mirrors Node's `execFileSync('git', args)`), with a
// `--` separator before any user-supplied paths so a path can't be read as a flag.
// The blocking git work runs under `spawn_blocking`.

/// Run `git <args>` in `cwd` (no shell). Ok(stdout) on exit 0, else Err(stderr).
fn run_git(args: &[&str], cwd: &str) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn is_git_repo(cwd: &str) -> bool {
    std::process::Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(cwd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Parse `git status --porcelain` → (staged, unstaged, untracked) — ports Node
/// `parseGitStatus` (X=index col, Y=worktree col; `R old -> new` renames; `??`
/// untracked). `oldPath` is emitted only on a rename in the staged entry.
fn parse_git_status(porcelain: &str) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let (mut staged, mut unstaged, mut untracked) = (Vec::new(), Vec::new(), Vec::new());
    for line in porcelain.split('\n') {
        if line.len() < 4 {
            continue;
        }
        let mut chars = line.chars();
        let x = chars.next().unwrap();
        let y = chars.next().unwrap();
        let filepath = &line[3..]; // "XY " prefix is 3 ASCII bytes
        let (mut path, mut old_path) = (filepath.to_string(), None::<String>);
        if let Some(idx) = filepath.find(" -> ") {
            old_path = Some(filepath[..idx].to_string());
            path = filepath[idx + 4..].to_string();
        }
        if x == '?' && y == '?' {
            untracked.push(json!({ "path": path, "status": "?" }));
            continue;
        }
        if x != ' ' && x != '?' {
            let mut o = json!({ "path": path, "status": x.to_string() });
            if let Some(op) = &old_path {
                o["oldPath"] = json!(op);
            }
            staged.push(o);
        }
        if y != ' ' && y != '?' {
            unstaged.push(json!({ "path": path, "status": y.to_string() }));
        }
    }
    (staged, unstaged, untracked)
}

/// Extract the commit hash from `git commit` output — ports Node's
/// `/\[[\w/.-]+ ([a-f0-9]+)\]/` (the `[branch hash]` line).
fn extract_commit_hash(output: &str) -> String {
    for line in output.lines() {
        let Some(start) = line.find('[') else { continue };
        let Some(rel_end) = line[start..].find(']') else { continue };
        let inside = &line[start + 1..start + rel_end];
        if let Some((_, hash)) = inside.rsplit_once(' ') {
            if !hash.is_empty() && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return hash.to_string();
            }
        }
    }
    String::new()
}

/// Outcome of a mutating git op, so the handler can map to 200 / 400 / 500.
enum GitOutcome {
    Ok(Value),
    NotRepo,
    Err(String),
}

fn git_status_blocking(path: &str) -> Result<Value, String> {
    if !is_git_repo(path) {
        return Ok(json!({ "isGitRepo": false, "branch": "", "staged": [], "unstaged": [], "untracked": [] }));
    }
    let branch = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], path)?.trim().to_string();
    let porcelain = run_git(&["status", "--porcelain"], path)?;
    let (staged, unstaged, untracked) = parse_git_status(&porcelain);
    Ok(json!({ "isGitRepo": true, "branch": branch, "staged": staged, "unstaged": unstaged, "untracked": untracked }))
}

fn git_log_blocking(path: &str) -> Result<Value, String> {
    if !is_git_repo(path) {
        return Ok(json!([]));
    }
    let raw = run_git(&["log", "-30", "--format=%H%x00%h%x00%B%x00%an%x00%cr%x00%D%x01"], path)?;
    let mut commits = Vec::new();
    for entry in raw.trim().split('\u{1}').filter(|e| !e.is_empty()) {
        let parts: Vec<&str> = entry.trim().split('\0').collect();
        let get = |i: usize| parts.get(i).copied().unwrap_or("");
        let full = get(2).trim();
        let subject = full.split('\n').next().unwrap_or("");
        commits.push(json!({
            "hash": get(0), "shortHash": get(1), "subject": subject,
            "message": full, "author": get(3), "relativeDate": get(4), "refs": get(5).trim(),
        }));
    }
    Ok(json!(commits))
}

fn git_diff_blocking(path: &str, staged: bool, file: Option<String>) -> Result<Value, String> {
    if !is_git_repo(path) {
        return Ok(json!({ "diff": "" }));
    }
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--staged");
    }
    if let Some(f) = &file {
        args.push("--");
        args.push(f);
    }
    Ok(json!({ "diff": run_git(&args, path)? }))
}

fn git_stage_blocking(path: &str, files: Option<Vec<String>>, unstage: bool) -> GitOutcome {
    if !is_git_repo(path) {
        return GitOutcome::NotRepo;
    }
    let files = files.filter(|f| !f.is_empty());
    let res = match (&files, unstage) {
        (Some(files), false) => {
            let mut args = vec!["add", "--"];
            args.extend(files.iter().map(String::as_str));
            run_git(&args, path)
        }
        (None, false) => run_git(&["add", "-A"], path),
        (Some(files), true) => {
            let mut args = vec!["restore", "--staged", "--"];
            args.extend(files.iter().map(String::as_str));
            run_git(&args, path)
        }
        (None, true) => run_git(&["reset", "HEAD"], path),
    };
    match res {
        Ok(_) => GitOutcome::Ok(json!({ "ok": true })),
        Err(e) => GitOutcome::Err(e),
    }
}

fn git_commit_blocking(path: &str, message: &str) -> GitOutcome {
    if !is_git_repo(path) {
        return GitOutcome::NotRepo;
    }
    match run_git(&["commit", "-m", message], path) {
        Ok(out) => GitOutcome::Ok(json!({ "ok": true, "hash": extract_commit_hash(&out) })),
        Err(e) => GitOutcome::Err(e),
    }
}

fn git_500(e: String) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response()
}

/// Resolve the project + its on-disk path, or the early Response (404 / a graceful
/// non-path body via `no_path`).
async fn git_project_path(s: &AppState, id: &str, no_path: Value) -> Result<String, Response> {
    let Some(project) = s.pm.get_project(id) else {
        return Err(not_found_json("Project not found"));
    };
    match project.path {
        Some(p) => Ok(p),
        None => Err(Json(no_path).into_response()),
    }
}

async fn pm_git_status(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let no_repo = json!({ "data": { "isGitRepo": false, "branch": "", "staged": [], "unstaged": [], "untracked": [] } });
    let path = match git_project_path(&s, &id, no_repo).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    match tokio::task::spawn_blocking(move || git_status_blocking(&path)).await {
        Ok(Ok(data)) => Json(json!({ "data": data })).into_response(),
        Ok(Err(e)) => git_500(e),
        Err(_) => git_500("git task failed".into()),
    }
}

async fn pm_git_log(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let path = match git_project_path(&s, &id, json!({ "data": [] })).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    match tokio::task::spawn_blocking(move || git_log_blocking(&path)).await {
        Ok(Ok(data)) => Json(json!({ "data": data })).into_response(),
        Ok(Err(e)) => git_500(e),
        Err(_) => git_500("git task failed".into()),
    }
}

async fn pm_git_diff(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let path = match git_project_path(&s, &id, json!({ "data": { "diff": "" } })).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let staged = matches!(q.get("staged").map(String::as_str), Some("1") | Some("true"));
    let file = q.get("file").filter(|f| !f.is_empty()).cloned();
    match tokio::task::spawn_blocking(move || git_diff_blocking(&path, staged, file)).await {
        Ok(Ok(data)) => Json(json!({ "data": data })).into_response(),
        Ok(Err(e)) => git_500(e),
        Err(_) => git_500("git task failed".into()),
    }
}

/// 400 "Not a git repo" (shared by stage/unstage/commit's no-path + non-repo paths).
fn not_a_git_repo() -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "Not a git repo" }))).into_response()
}

fn git_mutate_response(outcome: Result<GitOutcome, tokio::task::JoinError>) -> Response {
    match outcome {
        Ok(GitOutcome::Ok(v)) => Json(v).into_response(),
        Ok(GitOutcome::NotRepo) => not_a_git_repo(),
        Ok(GitOutcome::Err(e)) => git_500(e),
        Err(_) => git_500("git task failed".into()),
    }
}

async fn pm_git_stage(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(project) = s.pm.get_project(&id) else {
        return not_found_json("Project not found");
    };
    let Some(path) = project.path else {
        return not_a_git_repo();
    };
    let files = parse_files(&body);
    git_mutate_response(tokio::task::spawn_blocking(move || git_stage_blocking(&path, files, false)).await)
}

async fn pm_git_unstage(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(project) = s.pm.get_project(&id) else {
        return not_found_json("Project not found");
    };
    let Some(path) = project.path else {
        return not_a_git_repo();
    };
    let files = parse_files(&body);
    git_mutate_response(tokio::task::spawn_blocking(move || git_stage_blocking(&path, files, true)).await)
}

/// `{ files: [...] }` from a body, or None (→ stage/unstage all), matching Node's
/// `try { files = JSON.parse(body).files } catch {}`.
fn parse_files(body: &str) -> Option<Vec<String>> {
    if body.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("files").and_then(|f| f.as_array()).map(|a| {
            a.iter().filter_map(|x| x.as_str().map(String::from)).collect()
        }))
}

async fn pm_git_commit(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: String) -> Response {
    if !http_authorized(&s, &headers) {
        return unauthorized();
    }
    let Some(project) = s.pm.get_project(&id) else {
        return not_found_json("Project not found");
    };
    let Some(path) = project.path else {
        return not_a_git_repo();
    };
    if body.is_empty() {
        return bad_request("Body required");
    }
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return git_500("invalid JSON".into());
    };
    let message = v.get("message").and_then(Value::as_str).unwrap_or("");
    if message.trim().is_empty() {
        return bad_request("Commit message required");
    }
    let message = message.to_string();
    git_mutate_response(tokio::task::spawn_blocking(move || git_commit_blocking(&path, &message)).await)
}

// ---- WebSocket ----

async fn ws_upgrade(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // Shed SDK connection floods before the upgrade (per remote client; loopback exempt).
    if !s.rate.allow(Some(peer), &headers) {
        return too_many_requests();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, s)).into_response()
}

/// `GET /api/ws/events` (HTTP port) — the dashboard's live feed. The SPA's
/// ws-client.ts opens this for `{type:"event"|"session_connected"|
/// "session_disconnected", …}` push messages. Without it the dashboard shows
/// "Connection lost" and falls back to polling. When auth is on, require a valid
/// token via `?token=` (browsers can't set headers on a WebSocket) — Node parity.
async fn dashboard_ws(
    ws: WebSocketUpgrade,
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    // Auth-active mirrors the HTTP gate (resolve_caller): a global token OR any
    // workspace API key. Accept a global OR workspace `tk_` token via `?token=`
    // (browsers can't set headers on a WebSocket).
    let auth_active = s.auth.enabled() || s.pm.has_active_api_keys();
    if auth_active {
        let tok = q.get("token").map(String::as_str);
        let ok = tok.is_some_and(|t| s.auth.validate(t) || s.pm.get_workspace_by_api_key(t).is_some());
        if !ok {
            return unauthorized();
        }
    }
    let mut rx = s.store.subscribe();
    ws.on_upgrade(move |socket| async move {
        let (mut sink, mut stream) = socket.split();
        loop {
            tokio::select! {
                // Push broadcast frames to the dashboard.
                msg = rx.recv() => match msg {
                    Ok(text) => {
                        if sink.send(Message::Text(Utf8Bytes::from(text))).await.is_err() {
                            break; // client gone
                        }
                    }
                    // Slow client fell behind — keep serving (drop the gap), don't kill it.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                // Drain client→server frames (pings/closes); the dashboard is read-only.
                incoming = stream.next() => match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
            }
        }
    })
    .into_response()
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

#[cfg(test)]
mod slice_d_tests {
    use super::{rules_paths, sanitize_filename};

    #[test]
    fn sanitize_filename_strips_separators_and_dotdot() {
        // Ports Node: replace([/\\]) then replace(..) — applied in that order.
        assert_eq!(sanitize_filename("notes.md"), "notes.md");
        assert_eq!(sanitize_filename("../../etc/passwd"), "etcpasswd"); // slashes + .. gone
        assert_eq!(sanitize_filename("a/b\\c"), "abc");
        assert_eq!(sanitize_filename(".."), "");
        assert_eq!(sanitize_filename("..."), "."); // one ".." removed, leaving "."
        assert_eq!(sanitize_filename("foo..bar"), "foobar");
        // No way to reconstruct a traversal segment: result has no '/' or '\' and no "..".
        let s = sanitize_filename("..\\..//x");
        assert!(!s.contains('/') && !s.contains('\\') && !s.contains(".."));
    }

    #[test]
    fn rules_paths_match_node_scopes() {
        std::env::set_var("HOME", "/tmp/rs-home");
        // With a claudeProjectKey + path.
        let (g, p, l) = rules_paths(Some("-Users-me-proj"), Some("/Users/me/proj"));
        assert!(g.ends_with(".claude/CLAUDE.md"));
        assert_eq!(p, std::path::Path::new("/tmp/rs-home/.claude/projects/-Users-me-proj/CLAUDE.md"));
        assert_eq!(l, std::path::Path::new("/Users/me/proj/CLAUDE.md"));
        // No key → project scope falls back to <path>/.claude/CLAUDE.md.
        let (_, p2, _) = rules_paths(None, Some("/Users/me/proj"));
        assert_eq!(p2, std::path::Path::new("/Users/me/proj/.claude/CLAUDE.md"));
        // No path → local scope falls back to <home>/CLAUDE.md.
        let (_, _, l2) = rules_paths(Some("k"), None);
        assert_eq!(l2, std::path::Path::new("/tmp/rs-home/CLAUDE.md"));
    }
}

#[cfg(test)]
mod slice_f_git_tests {
    use super::{extract_commit_hash, git_log_blocking, git_status_blocking, is_git_repo, parse_git_status, run_git};

    #[test]
    fn parse_git_status_buckets_index_worktree_untracked_and_renames() {
        // Build with join so the leading-space (worktree) columns survive — a
        // Rust string line-continuation (`\` + newline) would strip them.
        let porcelain = [
            "M  staged_mod.rs",
            " M worktree_mod.rs",
            "MM both.rs",
            "A  added.rs",
            "?? new_file.rs",
            "R  old.rs -> new.rs",
            "D  deleted.rs",
        ]
        .join("\n");
        let (staged, unstaged, untracked) = parse_git_status(&porcelain);
        // staged: staged_mod(M), both(M), added(A), rename(R, oldPath), deleted(D)
        assert_eq!(staged.len(), 5);
        assert_eq!(staged[0]["path"], "staged_mod.rs");
        assert_eq!(staged[0]["status"], "M");
        // 'MM both.rs' → staged M + unstaged M
        assert!(staged.iter().any(|s| s["path"] == "both.rs" && s["status"] == "M"));
        // rename carries oldPath on the staged entry, path = new.
        let rename = staged.iter().find(|s| s["status"] == "R").unwrap();
        assert_eq!(rename["path"], "new.rs");
        assert_eq!(rename["oldPath"], "old.rs");
        // unstaged: worktree_mod(M) + both(M)
        assert_eq!(unstaged.len(), 2);
        assert!(unstaged.iter().any(|u| u["path"] == "worktree_mod.rs"));
        assert!(unstaged.iter().all(|u| u.get("oldPath").is_none()), "unstaged entries omit oldPath");
        // untracked
        assert_eq!(untracked.len(), 1);
        assert_eq!(untracked[0], serde_json::json!({ "path": "new_file.rs", "status": "?" }));
    }

    #[test]
    fn extract_commit_hash_matches_node_regex() {
        assert_eq!(extract_commit_hash("[main 1a2b3c4] my message\n 1 file changed"), "1a2b3c4");
        assert_eq!(extract_commit_hash("[feature/x-y 0abc123] subject"), "0abc123");
        assert_eq!(extract_commit_hash("nothing here"), "");
    }

    // Live-git checks against this very repo (the crate dir is inside it). Skipped
    // gracefully if git isn't on PATH or this isn't a checkout.
    fn repo_dir() -> &'static str {
        env!("CARGO_MANIFEST_DIR")
    }

    #[test]
    fn live_git_status_and_log_against_this_repo() {
        let dir = repo_dir();
        if !is_git_repo(dir) {
            eprintln!("skip: not a git checkout");
            return;
        }
        // status: real repo → isGitRepo true + a branch.
        let status = git_status_blocking(dir).expect("status");
        assert_eq!(status["isGitRepo"], true);
        assert!(status["branch"].as_str().map(|b| !b.is_empty()).unwrap_or(false));

        // rev-parse round-trips a non-empty branch name.
        let branch = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], dir).expect("rev-parse");
        assert!(!branch.trim().is_empty());

        // log: repo has commits → non-empty array with hash/shortHash/subject.
        let log = git_log_blocking(dir).expect("log");
        let arr = log.as_array().expect("array");
        assert!(!arr.is_empty(), "repo should have commits");
        let c0 = &arr[0];
        assert!(c0["hash"].as_str().map(|h| h.len() == 40).unwrap_or(false), "full sha");
        assert!(c0["shortHash"].as_str().map(|h| !h.is_empty()).unwrap_or(false));
        assert!(c0["subject"].as_str().map(|s| !s.is_empty()).unwrap_or(false));
    }

    #[test]
    fn is_git_repo_false_for_non_repo() {
        assert!(!is_git_repo("/tmp"));
    }
}

// Persistence + re-attach proof (acceptance: a restart doesn't orphan and GET
// stays honest). `reattach_dev_servers` is the restart path both binaries run in
// `serve()` before binding — keep live groups, prune dead rows from pm.db.
#[cfg(all(test, unix))]
mod slice_g_dev_server_tests {
    use super::*;
    use crate::dev_server::spawn_dev_process;
    use crate::pm_store::{DevServerRecord, PmStore};
    use std::collections::HashMap;

    fn tmp_pm() -> PmStore {
        let dir = std::env::temp_dir().join(format!(
            "rs-pm-dev-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        PmStore::open(&dir.join("pm.db")).unwrap()
    }

    #[test]
    fn reattach_keeps_live_group_and_prunes_dead() {
        let pm = tmp_pm();
        // A real, live process in its OWN process group (mirrors a restart finding
        // a still-running dev server).
        let argv = vec!["node".to_string(), "-e".to_string(), "setInterval(()=>{},1e9)".to_string()];
        let Ok(mut spawned) = spawn_dev_process(&argv, "/tmp") else {
            eprintln!("skip: node unavailable");
            return;
        };
        let live_pgid = spawned.pgid;
        pm.dev_server_upsert(&DevServerRecord {
            project_id: "live".into(),
            pid: spawned.pid as i64,
            pgid: live_pgid as i64,
            command: "node".into(),
            cwd: "/tmp".into(),
            started_at: 1,
            status: "running".into(),
            ports: Some("[4321]".into()),
            container_local: false,
            // current boot so the record survives the reboot-prune and reaches liveness.
            boot_time: crate::dev_server::boot_time_secs().unwrap_or(0),
        });
        // A dead/bogus group — must be pruned so GET reports the truth after restart.
        pm.dev_server_upsert(&DevServerRecord {
            project_id: "dead".into(),
            pid: 999_998,
            pgid: 999_998,
            command: "gone".into(),
            cwd: "/tmp".into(),
            started_at: 1,
            status: "running".into(),
            ports: None,
            container_local: false,
            boot_time: crate::dev_server::boot_time_secs().unwrap_or(0),
        });

        let map: ProcMap = Arc::new(Mutex::new(HashMap::new()));
        reattach_dev_servers(&pm, &map);

        {
            let m = map.lock().unwrap();
            assert!(m.contains_key("live"), "live group re-attached (no orphan)");
            assert!(!m.contains_key("dead"), "dead group not re-attached");
            // persisted ports survive the restart (GET surfaces them again).
            assert_eq!(*m["live"].inner.ports.lock().unwrap(), vec![4321u16]);
        }
        // GET stays honest: the dead row is pruned from pm.db, the live one kept.
        assert!(pm.dev_server_get("dead").is_none(), "dead row pruned from pm.db");
        assert!(pm.dev_server_get("live").is_some(), "live row retained");

        // Cleanup the real process.
        let _ = stop_group(live_pgid, signal_from_name("SIGKILL").0);
        let _ = spawned.child.wait();
    }

    // Reboot guard: a record whose pgid is STILL ALIVE must still be pruned if it
    // was spawned in a prior boot — after a reboot the kernel recycles pgids, so a
    // live pgid from a stale boot names a stranger's group, not our dev server.
    // (Claude F3 / GPT #4 / round-2 cross-validated CRITICAL.)
    #[test]
    fn reattach_prunes_record_from_a_stale_boot_even_if_pgid_is_alive() {
        let Some(now_boot) = crate::dev_server::boot_time_secs() else {
            eprintln!("skip: boot time undetectable on this platform");
            return;
        };
        let pm = tmp_pm();
        let argv = vec!["node".to_string(), "-e".to_string(), "setInterval(()=>{},1e9)".to_string()];
        let Ok(mut spawned) = spawn_dev_process(&argv, "/tmp") else {
            eprintln!("skip: node unavailable");
            return;
        };
        let pgid = spawned.pgid;
        assert!(group_alive(pgid), "precondition: the group is alive");
        pm.dev_server_upsert(&DevServerRecord {
            project_id: "stale".into(),
            pid: spawned.pid as i64,
            pgid: pgid as i64,
            command: "node".into(),
            cwd: "/tmp".into(),
            started_at: 1,
            status: "running".into(),
            ports: None,
            container_local: false,
            // spawned in a *previous* boot — must be pruned despite being alive now.
            boot_time: now_boot - 1,
        });

        let map: ProcMap = Arc::new(Mutex::new(HashMap::new()));
        reattach_dev_servers(&pm, &map);

        assert!(!map.lock().unwrap().contains_key("stale"), "stale-boot pgid not re-attached");
        assert!(pm.dev_server_get("stale").is_none(), "stale-boot row pruned from pm.db (no group-kill of a stranger)");

        let _ = stop_group(pgid, signal_from_name("SIGKILL").0);
        let _ = spawned.child.wait();
    }

    // The success / 409 / no-path SHAPES the conformance harness can't reach (it
    // has no seeded project). Driven through the REAL handlers in-process via
    // `oneshot` against a seeded pm.db + a real `node` listener — this is the
    // audit-discipline fix: assert the success-path shapes, not just the 404s.
    use crate::auth::AuthMode;
    use crate::command::CommandHub;
    use crate::store::StoreHandle;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    fn node_available() -> bool {
        std::process::Command::new("node").arg("-v").output().map(|o| o.status.success()).unwrap_or(false)
    }

    async fn read_json(resp: Response) -> (u16, Value) {
        let status = resp.status().as_u16();
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, v)
    }

    async fn req(app: &Router, method: &str, uri: &str, body: Option<&str>) -> (u16, Value) {
        let mut b = Request::builder().method(method).uri(uri);
        let body = match body {
            Some(s) => {
                b = b.header("content-type", "application/json");
                Body::from(s.to_string())
            }
            None => Body::empty(),
        };
        let resp = app.clone().oneshot(b.body(body).unwrap()).await.unwrap();
        read_json(resp).await
    }

    #[tokio::test]
    async fn post_get_delete_success_shapes_through_real_handlers() {
        if !node_available() {
            eprintln!("skip: node unavailable");
            return;
        }
        let root = std::env::temp_dir().join(format!("rs-devhttp-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&root);
        // project working dir with a real listener script (argv `node listener.js`
        // — no shell, passes resolve_launch validation).
        let proj_dir = root.join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        std::fs::write(
            proj_dir.join("listener.js"),
            "const net=require('net');const s=net.createServer(()=>{});s.listen(0,'127.0.0.1');setInterval(()=>{},1e9);",
        )
        .unwrap();

        let store = StoreHandle::open(root.join("data")).await.expect("store");
        let pm = PmStore::open(&root.join("pm.db")).expect("pm");
        let analytics = AnalyticsStore::open(&root.join("analytics.db")).expect("analytics");
        pm.upsert_project(&crate::pm_store::PmProject {
            id: "p1".into(),
            name: "Proj".into(),
            path: Some(proj_dir.to_string_lossy().to_string()),
            ..Default::default()
        });
        // A project with NO path → the 400 branch.
        pm.upsert_project(&crate::pm_store::PmProject { id: "nopath".into(), name: "NoPath".into(), path: None, ..Default::default() });

        let state = AppState {
            store,
            hub: CommandHub::new(),
            pm,
            analytics,
            mosaic: None,
            auth: AuthManager::for_mode(AuthMode::Standalone),
            rate: Arc::new(RateLimiter::from_env()),
            started: Instant::now(),
            version: crate::VERSION.to_string(),
            dev_servers: Arc::new(Mutex::new(HashMap::new())),
            dev_starting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            process_monitor: false,
            last_snapshot: Arc::new(Mutex::new(0)),
        };
        let app = Router::new()
            .route(
                "/api/pm/projects/{id}/dev-server",
                get(pm_dev_server_get).post(pm_dev_server_post).delete(pm_dev_server_delete),
            )
            .with_state(state);

        // 404 unknown project (POST + DELETE resolve the project first).
        let (s, v) = req(&app, "POST", "/api/pm/projects/ghost/dev-server", None).await;
        assert_eq!((s, v), (404, json!({ "error": "Project not found" })));

        // 400 project has no filesystem path.
        let (s, v) = req(&app, "POST", "/api/pm/projects/nopath/dev-server", None).await;
        assert_eq!((s, v), (400, json!({ "error": "Project has no filesystem path" })));

        // 400 command injection is rejected (argv-no-shell, the audit's headline hole).
        let (s, _v) = req(&app, "POST", "/api/pm/projects/p1/dev-server", Some(r#"{"command":"node listener.js; rm -rf ~"}"#)).await;
        assert_eq!(s, 400);

        // POST success → 200 {data:{pid, command, cwd, status:"starting"}} (Node shape).
        let (s, v) = req(&app, "POST", "/api/pm/projects/p1/dev-server", Some(r#"{"command":"node listener.js"}"#)).await;
        assert_eq!(s, 200, "post success");
        let d = &v["data"];
        assert!(d["pid"].as_u64().unwrap() > 1);
        assert_eq!(d["command"], "node listener.js");
        assert_eq!(d["cwd"], proj_dir.to_string_lossy().to_string());
        assert_eq!(d["status"], "starting");
        let pid = d["pid"].as_u64().unwrap();

        // 409 already running → {error, data:{pid, status}} (Node shape).
        let (s, v) = req(&app, "POST", "/api/pm/projects/p1/dev-server", Some(r#"{"command":"node listener.js"}"#)).await;
        assert_eq!(s, 409, "second start conflicts");
        assert_eq!(v["error"], "Dev server already running");
        assert_eq!(v["data"]["pid"].as_u64().unwrap(), pid);
        assert!(v["data"]["status"].is_string());

        // GET → poll until the real port is detected (running). Assert the full
        // Node-matched shape + the additive tie-back fields.
        let mut got_running = false;
        let mut last = Value::Null;
        for _ in 0..50 {
            let (gs, gv) = req(&app, "GET", "/api/pm/projects/p1/dev-server", None).await;
            assert_eq!(gs, 200);
            last = gv.clone();
            if gv["data"]["status"] == "running" && gv["data"]["ports"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                got_running = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let d = &last["data"];
        // Node-matched keys (the dashboard reads these — a renamed field is the bug class we guard).
        assert_eq!(d["pid"].as_u64().unwrap(), pid);
        assert_eq!(d["command"], "node listener.js");
        assert!(d["startedAt"].as_i64().unwrap() > 0, "startedAt present (camelCase)");
        assert!(d.get("exitCode").is_some(), "exitCode key present");
        assert!(d["logs"].is_array(), "logs array present");
        // additive tie-back fields.
        assert!(d["ports"].is_array());
        assert_eq!(d["isContainerLocal"], false);
        assert!(got_running, "real port should be detected → running; last={last}");
        // auto-attach hint wired to the detected port (the feature's reason to exist).
        let ports = d["ports"].as_array().unwrap();
        assert!(!ports.is_empty());
        assert_eq!(d["autoAttach"]["port"], ports[0]);
        assert_eq!(d["autoAttach"]["hostReachable"], true);

        // DELETE → 200 {data:{killed:true, pid, signal:"SIGTERM"}} (Node shape) + group-kill.
        let (s, v) = req(&app, "DELETE", "/api/pm/projects/p1/dev-server", None).await;
        assert_eq!(s, 200, "delete success");
        assert_eq!(v["data"]["killed"], true);
        assert_eq!(v["data"]["pid"].as_u64().unwrap(), pid);
        assert_eq!(v["data"]["signal"], "SIGTERM");

        // GET after stop → bare stopped (group is gone).
        let (s, v) = req(&app, "GET", "/api/pm/projects/p1/dev-server", None).await;
        assert_eq!((s, v), (200, json!({ "data": { "status": "stopped" } })));

        let _ = std::fs::remove_dir_all(&root);
    }

    // Analytics HTTP (ADR-0012 slice 1-2): identify writes an anon user; the read
    // routes return it WITHOUT PII; roles are seeded; unknown id → 404.
    #[tokio::test]
    async fn analytics_identify_then_reads_expose_no_pii() {
        let dir = std::env::temp_dir().join(format!("an-http-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.join("data")).await.unwrap();
        let pm = PmStore::open(&dir.join("pm.db")).unwrap();
        let analytics = AnalyticsStore::open(&dir.join("analytics.db")).unwrap();
        let analytics_probe = analytics.clone(); // to assert the PII/consent boundary post-request
        let state = AppState {
            store,
            hub: CommandHub::new(),
            pm,
            analytics,
            mosaic: None,
            auth: AuthManager::for_mode(AuthMode::Mcp), // no token → auth inactive
            rate: Arc::new(RateLimiter::from_env()),
            started: Instant::now(),
            version: crate::VERSION.to_string(),
            dev_servers: Arc::new(Mutex::new(HashMap::new())),
            dev_starting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            process_monitor: false,
            last_snapshot: Arc::new(Mutex::new(0)),
        };
        let app = Router::new()
            .route("/api/analytics/identify", axum::routing::post(analytics_identify))
            .route("/api/analytics/roles", get(analytics_roles))
            .route("/api/analytics/users", get(analytics_users))
            .route("/api/analytics/users/{anon_id}", get(analytics_user_by_id))
            .with_state(state);

        // identify — oneshot needs a ConnectInfo extension (loopback ⇒ rate-exempt).
        let mut idreq = Request::builder()
            .method("POST")
            .uri("/api/analytics/identify")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"email":"Sara.Chen@Company.com","role":"Specialist","consent":true}"#.to_string()))
            .unwrap();
        idreq.extensions_mut().insert(axum::extract::ConnectInfo(
            "127.0.0.1:5000".parse::<std::net::SocketAddr>().unwrap(),
        ));
        let (s, v) = read_json(app.clone().oneshot(idreq).await.unwrap()).await;
        assert_eq!(s, 200, "identify ok");
        let anon = v["data"]["anonId"].as_str().unwrap().to_string();
        assert_eq!(anon.len(), 16);

        // roles seeded
        let (s, v) = req(&app, "GET", "/api/analytics/roles", None).await;
        assert_eq!(s, 200);
        assert_eq!(v["count"], 5);

        // users — the anon user is present, and the response carries NO PII
        let (s, v) = req(&app, "GET", "/api/analytics/users", None).await;
        assert_eq!(s, 200);
        assert_eq!(v["count"], 1);
        assert_eq!(v["data"][0]["anonId"], anon);
        assert_eq!(v["data"][0]["role"], "Specialist");
        let body = v.to_string().to_lowercase();
        assert!(!body.contains("sara") && !body.contains("email"), "read leaked PII: {body}");

        // user by id + 404
        let (s, _v) = req(&app, "GET", &format!("/api/analytics/users/{anon}"), None).await;
        assert_eq!(s, 200);
        let (s, _v) = req(&app, "GET", "/api/analytics/users/ZZZZZZZZ", None).await;
        assert_eq!(s, 404);

        // Fix #4 handler half: an identify WITHOUT consent must NOT capture the IP
        // (done last so it doesn't perturb the user-count assertion above).
        let mut noconsent = Request::builder()
            .method("POST")
            .uri("/api/analytics/identify")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"email":"no.consent@company.com","consent":false}"#.to_string()))
            .unwrap();
        noconsent.extensions_mut().insert(axum::extract::ConnectInfo(
            "203.0.113.9:5000".parse::<std::net::SocketAddr>().unwrap(),
        ));
        let (s, v) = read_json(app.clone().oneshot(noconsent).await.unwrap()).await;
        assert_eq!(s, 200);
        let nc_anon = v["data"]["anonId"].as_str().unwrap().to_string();
        assert!(
            analytics_probe.get_pii(&nc_anon).map(|p| p.ip).unwrap_or(None).is_none(),
            "IP must not be stored without consent"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Mosaic 3b: with no RUNTIMESCOPE_MOSAIC_URL, status reports unconfigured and
    // forecast/trace 503 with MOSAIC_NOT_CONFIGURED (the SQL ROI path is the default).
    #[tokio::test]
    async fn mosaic_endpoints_503_when_unconfigured() {
        let dir = std::env::temp_dir().join(format!("mosaic-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.join("data")).await.unwrap();
        let pm = PmStore::open(&dir.join("pm.db")).unwrap();
        let analytics = AnalyticsStore::open(&dir.join("analytics.db")).unwrap();
        let state = AppState {
            store,
            hub: CommandHub::new(),
            pm,
            analytics,
            mosaic: None,
            auth: AuthManager::for_mode(AuthMode::Mcp),
            rate: Arc::new(RateLimiter::from_env()),
            started: Instant::now(),
            version: crate::VERSION.to_string(),
            dev_servers: Arc::new(Mutex::new(HashMap::new())),
            dev_starting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            process_monitor: false,
            last_snapshot: Arc::new(Mutex::new(0)),
        };
        let app = Router::new()
            .route("/api/analytics/mosaic/status", get(analytics_mosaic_status))
            .route("/api/analytics/forecast", get(analytics_forecast))
            .route("/api/analytics/trace", get(analytics_trace))
            .with_state(state);

        let (s, v) = req(&app, "GET", "/api/analytics/mosaic/status", None).await;
        assert_eq!(s, 200);
        assert_eq!(v["data"]["configured"], false);

        let (s, v) = req(&app, "GET", "/api/analytics/forecast", None).await;
        assert_eq!(s, 503);
        assert_eq!(v["code"], "MOSAIC_NOT_CONFIGURED");

        let (s, _v) = req(&app, "GET", "/api/analytics/trace?coord=a,b", None).await;
        assert_eq!(s, 503);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // End-to-end over the real handlers (slice 3a): seed a baseline + an identified
    // user + anon-stamped custom events, then exercise overview/features/baselines/
    // submissions/projections — asserting the $ enrichment, the full-history read
    // path, and the submission flag/accept flow.
    #[tokio::test]
    async fn analytics_roi_endpoints_end_to_end() {
        use chrono::{Datelike, TimeZone, Utc};
        let dir = std::env::temp_dir().join(format!("an-e2e-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.join("data")).await.unwrap();
        let pm = PmStore::open(&dir.join("pm.db")).unwrap();
        let analytics = AnalyticsStore::open(&dir.join("analytics.db")).unwrap();
        analytics.upsert_baseline("geocode", 8.0, 2.4, true, "admin", None, Some("seed")).unwrap();
        let anon = analytics.identify("sara@co.com", Some("Specialist"), Some(true), None, None).unwrap(); // $50
        let now = now_ms();
        let ev = |id: &str, ts: i64| {
            json!({ "eventId": id, "sessionId": "s1", "timestamp": ts, "eventType": "custom", "name": "geocode", "anonId": anon, "properties": { "count": 10 } })
        };
        store.add_batch("proj".into(), vec![ev("e1", now), ev("e2", now - 1000)]).await.unwrap();

        let state = AppState {
            store,
            hub: CommandHub::new(),
            pm,
            analytics,
            mosaic: None,
            auth: AuthManager::for_mode(AuthMode::Mcp),
            rate: Arc::new(RateLimiter::from_env()),
            started: Instant::now(),
            version: crate::VERSION.to_string(),
            dev_servers: Arc::new(Mutex::new(HashMap::new())),
            dev_starting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            process_monitor: false,
            last_snapshot: Arc::new(Mutex::new(0)),
        };
        let app = Router::new()
            .route("/api/analytics/overview", get(analytics_overview))
            .route("/api/analytics/features", get(analytics_features))
            .route("/api/analytics/baselines", get(analytics_baselines).put(analytics_put_baseline))
            .route("/api/analytics/baselines/submissions", get(analytics_submissions).post(analytics_post_submission))
            .route("/api/analytics/baselines/submissions/{id}/accept", axum::routing::post(analytics_accept_submission))
            .route("/api/analytics/projections", get(analytics_projections).post(analytics_post_projection))
            .with_state(state);

        // overview $: 2 × (8-2.4)*10/60*50 = 2 × 46.67 = 93.33
        let (s, v) = req(&app, "GET", "/api/analytics/overview?window=30d", None).await;
        assert_eq!(s, 200);
        assert_eq!(v["data"]["activeUsers"], 1);
        assert!((v["data"]["valueSaved"].as_f64().unwrap() - 93.33).abs() < 0.05, "valueSaved={:?}", v["data"]["valueSaved"]);

        // features $: geocode has value + uses
        let (s, v) = req(&app, "GET", "/api/analytics/features?window=30d", None).await;
        assert_eq!(s, 200);
        assert_eq!(v["data"][0]["feature"], "geocode");
        assert!(v["data"][0]["value"].as_f64().unwrap() > 0.0);

        // baselines: live uses=2; PUT a new one
        let (s, v) = req(&app, "GET", "/api/analytics/baselines", None).await;
        assert_eq!(s, 200);
        assert_eq!(v["data"][0]["uses"], 2);
        let (s, _v) = req(&app, "PUT", "/api/analytics/baselines", Some(r#"{"fn":"export","manualMin":15,"toolMin":5,"perItem":false}"#)).await;
        assert_eq!(s, 200);

        // submission vs current manual 8, est 12 → 50% divergence → flagged; then accept.
        let (s, _v) = req(&app, "POST", "/api/analytics/baselines/submissions", Some(r#"{"fn":"geocode","manualMin":12}"#)).await;
        assert_eq!(s, 200);
        let (s, v) = req(&app, "GET", "/api/analytics/baselines/submissions", None).await;
        assert_eq!(s, 200);
        let sub = &v["data"][0];
        assert_eq!(sub["flagged"], true);
        assert_eq!(sub["currentManualMin"], 8.0);
        let sid = sub["id"].as_i64().unwrap();
        let (s, _v) = req(&app, "POST", &format!("/api/analytics/baselines/submissions/{sid}/accept"), None).await;
        assert_eq!(s, 200);

        // projections: POST the quarter containing `now`, GET → live-derived actuals > 0.
        let dt = Utc.timestamp_millis_opt(now).single().unwrap();
        let quarter = format!("Q{} {}", (dt.month() - 1) / 3 + 1, dt.year());
        let (s, _v) = req(&app, "POST", "/api/analytics/projections", Some(&format!(r#"{{"quarter":"{quarter}","projHours":100,"projValue":5000,"setBy":"Director"}}"#))).await;
        assert_eq!(s, 200);
        let (s, v) = req(&app, "GET", "/api/analytics/projections", None).await;
        assert_eq!(s, 200);
        assert_eq!(v["data"][0]["quarter"], quarter);
        assert!(v["data"][0]["actualValue"].as_f64().unwrap() > 0.0, "projection actuals derived from the quarter's events");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Slice 5: the uptime endpoints — SSRF block at add time, add/status/incidents/
    // delete/heartbeat. Uses IP-literal targets so the SSRF guard resolves offline.
    #[tokio::test]
    async fn uptime_status_endpoints_and_ssrf_guard() {
        let dir = std::env::temp_dir().join(format!("up-http-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.join("data")).await.unwrap();
        let pm = PmStore::open(&dir.join("pm.db")).unwrap();
        let analytics = AnalyticsStore::open(&dir.join("analytics.db")).unwrap();
        let probe = analytics.clone(); // seed checks/incidents directly
        let state = AppState {
            store,
            hub: CommandHub::new(),
            pm,
            analytics,
            mosaic: None,
            auth: AuthManager::for_mode(AuthMode::Mcp),
            rate: Arc::new(RateLimiter::from_env()),
            started: Instant::now(),
            version: crate::VERSION.to_string(),
            dev_servers: Arc::new(Mutex::new(HashMap::new())),
            dev_starting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            process_monitor: false,
            last_snapshot: Arc::new(Mutex::new(0)),
        };
        let app = Router::new()
            .route("/api/analytics/status", get(analytics_status))
            .route("/api/analytics/incidents", get(analytics_incidents))
            .route("/api/analytics/monitored-apps", axum::routing::post(analytics_add_app))
            .route("/api/analytics/monitored-apps/{id}", axum::routing::delete(analytics_delete_app))
            .route("/api/analytics/heartbeat", axum::routing::post(analytics_heartbeat))
            .with_state(state);

        // SSRF: a loopback target is rejected at add time.
        let (s, v) = req(&app, "POST", "/api/analytics/monitored-apps", Some(r#"{"name":"Internal","url":"http://127.0.0.1:9/x"}"#)).await;
        assert_eq!(s, 400);
        assert_eq!(v["code"], "BLOCKED_TARGET");
        // file:// scheme rejected too.
        let (s, _v) = req(&app, "POST", "/api/analytics/monitored-apps", Some(r#"{"name":"F","url":"file:///etc/passwd"}"#)).await;
        assert_eq!(s, 400);

        // A public target (IP literal → resolves offline) is accepted.
        let (s, v) = req(&app, "POST", "/api/analytics/monitored-apps", Some(r#"{"name":"My API","url":"https://93.184.216.34/health"}"#)).await;
        assert_eq!(s, 200);
        assert_eq!(v["data"]["id"], "my-api");

        // status: app present, no checks yet → null uptime/lastState.
        let (s, v) = req(&app, "GET", "/api/analytics/status", None).await;
        assert_eq!(s, 200);
        assert_eq!(v["count"], 1);
        assert_eq!(v["kpis"]["appsMonitored"], 1);
        assert!(v["data"][0]["uptimePct"].is_null());

        // seed a check + incident, re-read.
        probe.record_check("my-api", "probe", 0, Some(120)).unwrap();
        probe.open_incident("my-api", "Slow response (512ms > 400ms)", "degraded").unwrap();
        let (_s, v) = req(&app, "GET", "/api/analytics/status", None).await;
        assert_eq!(v["data"][0]["lastState"], 0);
        assert_eq!(v["kpis"]["healthy"], 1);
        let (_s, v) = req(&app, "GET", "/api/analytics/incidents?status=ongoing", None).await;
        assert_eq!(v["count"], 1);

        // heartbeat (needs ConnectInfo): known app ok, unknown app 404.
        let hb = |app_id: &str| {
            let mut r = Request::builder()
                .method("POST")
                .uri("/api/analytics/heartbeat")
                .header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"appId":"{app_id}"}}"#)))
                .unwrap();
            r.extensions_mut().insert(axum::extract::ConnectInfo("127.0.0.1:5000".parse::<std::net::SocketAddr>().unwrap()));
            r
        };
        let (s, _v) = read_json(app.clone().oneshot(hb("my-api")).await.unwrap()).await;
        assert_eq!(s, 200);
        let (s, _v) = read_json(app.clone().oneshot(hb("nope")).await.unwrap()).await;
        assert_eq!(s, 404, "heartbeat for an unregistered app is rejected");

        // delete → gone.
        let (s, _v) = req(&app, "DELETE", "/api/analytics/monitored-apps/my-api", None).await;
        assert_eq!(s, 200);
        let (_s, v) = req(&app, "GET", "/api/analytics/status", None).await;
        assert_eq!(v["count"], 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Slice 4: survey endpoints — admin create + end-user active/respond, role
    // targeting, answer validation, once-per-user suppression, externalId resolve.
    #[tokio::test]
    async fn surveys_admin_and_enduser_flow() {
        let dir = std::env::temp_dir().join(format!("sv-http-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.join("data")).await.unwrap();
        let pm = PmStore::open(&dir.join("pm.db")).unwrap();
        let analytics = AnalyticsStore::open(&dir.join("analytics.db")).unwrap();
        let an = analytics.clone();
        let anon = an.identify("u@co.com", Some("Specialist"), Some(true), Some("ext-7"), None).unwrap();
        let dir_anon = an.identify("boss@co.com", Some("Director"), Some(true), None, None).unwrap();
        let state = AppState {
            store,
            hub: CommandHub::new(),
            pm,
            analytics,
            mosaic: None,
            auth: AuthManager::for_mode(AuthMode::Mcp),
            rate: Arc::new(RateLimiter::from_env()),
            started: Instant::now(),
            version: crate::VERSION.to_string(),
            dev_servers: Arc::new(Mutex::new(HashMap::new())),
            dev_starting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            process_monitor: false,
            last_snapshot: Arc::new(Mutex::new(0)),
        };
        let app = Router::new()
            .route("/api/analytics/surveys", get(analytics_list_surveys).post(analytics_create_survey))
            .route("/api/analytics/surveys/active", get(analytics_active_surveys))
            .route("/api/analytics/surveys/{id}/responses", get(analytics_list_responses).post(analytics_submit_response))
            .with_state(state);

        // ConnectInfo-bearing request helper (the end-user routes are rate-gated).
        let conn = |method: &str, uri: &str, body: Option<&str>| {
            let mut r = Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(body.map(|b| Body::from(b.to_string())).unwrap_or(Body::empty()))
                .unwrap();
            r.extensions_mut().insert(axum::extract::ConnectInfo("127.0.0.1:5000".parse::<std::net::SocketAddr>().unwrap()));
            r
        };

        // admin create (no token ⇒ authorized in Mcp mode).
        let body = r#"{"name":"CSAT","status":"active","questions":[{"id":"q1","type":"rating","required":true}],"targeting":{"roles":["Specialist"],"samplePct":100}}"#;
        let (s, v) = req(&app, "POST", "/api/analytics/surveys", Some(body)).await;
        assert_eq!(s, 200);
        let sid = v["data"]["id"].as_str().unwrap().to_string();

        // active: Specialist sees it, Director doesn't (role filter).
        let (s, v) = read_json(app.clone().oneshot(conn("GET", &format!("/api/analytics/surveys/active?anonId={anon}"), None)).await.unwrap()).await;
        assert_eq!(s, 200);
        assert_eq!(v["count"], 1);
        assert_eq!(v["data"][0]["id"], sid);
        let (_s, v) = read_json(app.clone().oneshot(conn("GET", &format!("/api/analytics/surveys/active?anonId={dir_anon}"), None)).await.unwrap()).await;
        assert_eq!(v["count"], 0, "Director filtered out by role targeting");

        // respond: missing required q1 → 400; valid → 200.
        let bad = format!(r#"{{"anonId":"{anon}","answers":{{}}}}"#);
        let (s, _v) = read_json(app.clone().oneshot(conn("POST", &format!("/api/analytics/surveys/{sid}/responses"), Some(&bad))).await.unwrap()).await;
        assert_eq!(s, 400, "missing required answer rejected");
        let ok = format!(r#"{{"anonId":"{anon}","answers":{{"q1":5}}}}"#);
        let (s, _v) = read_json(app.clone().oneshot(conn("POST", &format!("/api/analytics/surveys/{sid}/responses"), Some(&ok))).await.unwrap()).await;
        assert_eq!(s, 200);
        // once-per-user on the WRITE path: a second response is rejected (409).
        let (s, _v) = read_json(app.clone().oneshot(conn("POST", &format!("/api/analytics/surveys/{sid}/responses"), Some(&ok))).await.unwrap()).await;
        assert_eq!(s, 409, "duplicate response rejected");

        // once-per-user: now suppressed for the Specialist.
        let (_s, v) = read_json(app.clone().oneshot(conn("GET", &format!("/api/analytics/surveys/active?anonId={anon}"), None)).await.unwrap()).await;
        assert_eq!(v["count"], 0, "answered ⇒ suppressed");

        // admin responses: externalId resolved from identify.
        let (_s, v) = req(&app, "GET", &format!("/api/analytics/surveys/{sid}/responses"), None).await;
        assert_eq!(v["data"][0]["externalId"], "ext-7");
        assert_eq!(v["data"][0]["answers"]["q1"], 5);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Slice 4 security: a workspace-scoped API key may not create a survey in
    // ANOTHER workspace via a body workspaceId (cross-tenant IDOR).
    #[tokio::test]
    async fn survey_create_blocks_cross_tenant_workspace() {
        let dir = std::env::temp_dir().join(format!("sv-tenant-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.join("data")).await.unwrap();
        let pm = PmStore::open(&dir.join("pm.db")).unwrap();
        let ws_a = pm.create_workspace("Team A", None, None).unwrap();
        let key_a = pm.create_api_key(&ws_a.id, "k", None).unwrap().key;
        let ws_b = pm.create_workspace("Team B", None, None).unwrap();
        let analytics = AnalyticsStore::open(&dir.join("analytics.db")).unwrap();
        let state = AppState {
            store,
            hub: CommandHub::new(),
            pm,
            analytics,
            mosaic: None,
            auth: AuthManager::for_mode(AuthMode::Mcp),
            rate: Arc::new(RateLimiter::from_env()),
            started: Instant::now(),
            version: crate::VERSION.to_string(),
            dev_servers: Arc::new(Mutex::new(HashMap::new())),
            dev_starting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            process_monitor: false,
            last_snapshot: Arc::new(Mutex::new(0)),
        };
        let app = Router::new()
            .route("/api/analytics/surveys", axum::routing::post(analytics_create_survey))
            .with_state(state);

        let mk = |key: &str, ws: Option<&str>| {
            let body = match ws {
                Some(w) => format!(r#"{{"name":"S","questions":[],"workspaceId":"{w}"}}"#),
                None => r#"{"name":"S","questions":[]}"#.to_string(),
            };
            Request::builder()
                .method("POST")
                .uri("/api/analytics/surveys")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {key}"))
                .body(Body::from(body))
                .unwrap()
        };

        // workspace-A key creating for workspace B → 403.
        let (s, _v) = read_json(app.clone().oneshot(mk(&key_a, Some(&ws_b.id))).await.unwrap()).await;
        assert_eq!(s, 403, "cross-tenant survey create blocked");
        // own workspace → 200, scoped to A.
        let (s, v) = read_json(app.clone().oneshot(mk(&key_a, Some(&ws_a.id))).await.unwrap()).await;
        assert_eq!(s, 200);
        assert_eq!(v["data"]["workspaceId"], ws_a.id);
        // body omitted → caller's own workspace (never another).
        let (s, v) = read_json(app.clone().oneshot(mk(&key_a, None)).await.unwrap()).await;
        assert_eq!(s, 200);
        assert_eq!(v["data"]["workspaceId"], ws_a.id);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Slice 4 security (phase-review High): /surveys/active must NOT leak another
    // tenant's surveys — a missing/unknown projectId returns GLOBAL surveys only.
    #[tokio::test]
    async fn survey_active_scoped_to_workspace_plus_global_not_all_tenants() {
        let dir = std::env::temp_dir().join(format!("sv-scope-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.join("data")).await.unwrap();
        let pm = PmStore::open(&dir.join("pm.db")).unwrap();
        let analytics = AnalyticsStore::open(&dir.join("analytics.db")).unwrap();
        // Seed a tenant-A survey (workspace_id set) + a global one (no workspace).
        let q = json!([{ "id": "q1", "type": "text" }]);
        analytics.create_survey(Some("ws-a"), "TenantA", "active", &q, &json!({})).unwrap();
        analytics.create_survey(None, "Global", "active", &q, &json!({})).unwrap();
        let state = AppState {
            store,
            hub: CommandHub::new(),
            pm,
            analytics,
            mosaic: None,
            auth: AuthManager::for_mode(AuthMode::Mcp),
            rate: Arc::new(RateLimiter::from_env()),
            started: Instant::now(),
            version: crate::VERSION.to_string(),
            dev_servers: Arc::new(Mutex::new(HashMap::new())),
            dev_starting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            process_monitor: false,
            last_snapshot: Arc::new(Mutex::new(0)),
        };
        let app = Router::new()
            .route("/api/analytics/surveys/active", get(analytics_active_surveys))
            .with_state(state);

        // active with NO projectId → GLOBAL only, never tenant A's.
        let mut r = Request::builder().method("GET").uri("/api/analytics/surveys/active?anonId=u").body(Body::empty()).unwrap();
        r.extensions_mut().insert(axum::extract::ConnectInfo("127.0.0.1:5000".parse::<std::net::SocketAddr>().unwrap()));
        let (s, v) = read_json(app.clone().oneshot(r).await.unwrap()).await;
        assert_eq!(s, 200);
        assert_eq!(v["count"], 1, "no projectId ⇒ global-only, not every tenant's; got {v}");
        assert_eq!(v["data"][0]["name"], "Global");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn admin_key_ok_is_closed_by_default() {
        assert!(!admin_key_ok(None, Some("x")), "no configured key ⇒ closed");
        assert!(!admin_key_ok(Some(""), Some("x")), "empty configured key ⇒ closed");
        assert!(!admin_key_ok(Some("k"), None), "missing header ⇒ closed");
        assert!(!admin_key_ok(Some("k"), Some("nope")));
        assert!(admin_key_ok(Some("secret"), Some("secret")));
    }

    // Slice 6: with no RUNTIMESCOPE_ADMIN_KEY set, the PII de-anon path is CLOSED
    // (403) even though a user with PII exists. (We don't set the env in tests to
    // avoid a process-global env race; the match logic is unit-tested above.)
    #[tokio::test]
    async fn admin_deanon_gate_closed_by_default() {
        let dir = std::env::temp_dir().join(format!("admin-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.join("data")).await.unwrap();
        let pm = PmStore::open(&dir.join("pm.db")).unwrap();
        let analytics = AnalyticsStore::open(&dir.join("analytics.db")).unwrap();
        analytics.identify("jo@co.com", Some("Director"), Some(true), None, Some("1.2.3.4")).unwrap();
        let state = AppState {
            store,
            hub: CommandHub::new(),
            pm,
            analytics,
            mosaic: None,
            auth: AuthManager::for_mode(AuthMode::Mcp),
            rate: Arc::new(RateLimiter::from_env()),
            started: Instant::now(),
            version: crate::VERSION.to_string(),
            dev_servers: Arc::new(Mutex::new(HashMap::new())),
            dev_starting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            process_monitor: false,
            last_snapshot: Arc::new(Mutex::new(0)),
        };
        let app = Router::new()
            .route("/api/analytics/admin/users", get(analytics_admin_users))
            .route("/api/analytics/admin/audit", get(analytics_admin_audit))
            .with_state(state);

        // admin/users extracts ConnectInfo → provide it; gate still 403 (no key).
        let mut r = Request::builder().method("GET").uri("/api/analytics/admin/users").body(Body::empty()).unwrap();
        r.extensions_mut().insert(axum::extract::ConnectInfo("127.0.0.1:5000".parse::<std::net::SocketAddr>().unwrap()));
        let (s, v) = read_json(app.clone().oneshot(r).await.unwrap()).await;
        assert_eq!(s, 403);
        assert_eq!(v["code"], "ADMIN_FORBIDDEN");
        // audit endpoint also closed.
        let (s, _v) = req(&app, "GET", "/api/analytics/admin/audit", None).await;
        assert_eq!(s, 403);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod slice_g_scripts_tests {
    use super::read_project_scripts;
    use std::io::Write;

    fn tmp_with_pkg(json: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rs-scripts-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = std::fs::File::create(dir.join("package.json")).unwrap();
        f.write_all(json.as_bytes()).unwrap();
        dir
    }

    #[test]
    fn reads_scripts_and_picks_recommended_dev_first() {
        let dir = tmp_with_pkg(r#"{"scripts":{"build":"x","start":"y","dev":"z"}}"#);
        let v = read_project_scripts(dir.to_str().unwrap());
        assert_eq!(v["scripts"]["dev"], "z");
        assert_eq!(v["recommended"], "dev", "dev wins over start (precedence order)");
    }

    #[test]
    fn recommended_falls_through_to_start_then_serve() {
        let dir = tmp_with_pkg(r#"{"scripts":{"build":"x","serve":"s","start":"y"}}"#);
        let v = read_project_scripts(dir.to_str().unwrap());
        assert_eq!(v["recommended"], "start", "start before serve");
    }

    #[test]
    fn no_recommended_when_none_present() {
        let dir = tmp_with_pkg(r#"{"scripts":{"build":"x","lint":"y"}}"#);
        let v = read_project_scripts(dir.to_str().unwrap());
        assert!(v["recommended"].is_null());
    }

    #[test]
    fn missing_or_malformed_package_json_is_empty() {
        assert_eq!(read_project_scripts("/nonexistent-xyz"), serde_json::json!({ "scripts": {}, "recommended": null }));
        let dir = tmp_with_pkg("not json{{");
        assert_eq!(read_project_scripts(dir.to_str().unwrap()), serde_json::json!({ "scripts": {}, "recommended": null }));
        // package.json with no scripts key → empty scripts, null recommended.
        let dir2 = tmp_with_pkg(r#"{"name":"x"}"#);
        let v = read_project_scripts(dir2.to_str().unwrap());
        assert_eq!(v, serde_json::json!({ "scripts": {}, "recommended": null }));
    }
}
