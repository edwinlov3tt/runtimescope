//! RuntimeScope tray application.
//!
//! Architecture:
//! - One Tokio task polls the local collector via HTTP every 5s (with
//!   `MissedTickBehavior::Delay` so a sleep/wake cycle doesn't unleash a
//!   burst of catch-up ticks).
//! - The polling task is **paused** when the dropdown window is hidden — the
//!   user can't see it anyway and the laptop battery thanks us.
//! - Each successful tick caches a `HealthSnapshot` in `AppState` and emits
//!   a `health-snapshot` event to the webview. The React hook listens to
//!   the event AND can request a refresh on-demand via the `health_snapshot`
//!   command (after mounting, or after the user runs an action).
//! - Service lifecycle (restart/stop/update) shells out to the `runtimescope`
//!   CLI — per hard rule 4 in the Phase Tauri-Tray brief, the tray never
//!   reimplements `launchctl` calls.

mod collector_client;

use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use collector_client::{
    compare_versions, latest_published_version, CollectorClient, CollectorError, DEFAULT_PORT,
};
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};
use tokio::sync::{Mutex, Notify};
use tokio::time::{interval, MissedTickBehavior};

const HEALTH_EVENT: &str = "health-snapshot";
const POLL_INTERVAL_SECS: u64 = 5;
const VERSION_CHECK_TICKS: u64 = 12; // 12 * 5s = once per minute

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub app_name: String,
    pub is_connected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    pub state: &'static str,
    pub status_line: String,
    pub pid: Option<u32>,
    pub port: u16,
    pub uptime_seconds: Option<u64>,
    pub running_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub sessions: Vec<SessionSummary>,
    pub error_reason: Option<String>,
}

impl HealthSnapshot {
    fn starting() -> Self {
        Self {
            state: "gray",
            status_line: "Starting up…".to_string(),
            pid: None,
            port: DEFAULT_PORT,
            uptime_seconds: None,
            running_version: None,
            latest_version: None,
            update_available: false,
            sessions: Vec::new(),
            error_reason: None,
        }
    }
}

#[derive(Default)]
struct PollGate {
    notify: Notify,
    paused: Mutex<bool>,
}

impl PollGate {
    async fn wait_until_active(&self) {
        loop {
            {
                let guard = self.paused.lock().await;
                if !*guard {
                    return;
                }
            }
            self.notify.notified().await;
        }
    }

    async fn pause(&self) {
        *self.paused.lock().await = true;
    }

    async fn resume(&self) {
        *self.paused.lock().await = false;
        self.notify.notify_waiters();
    }
}

pub struct AppState {
    client: CollectorClient,
    last_snapshot: Mutex<HealthSnapshot>,
    cached_latest_version: Mutex<Option<String>>,
    gate: Arc<PollGate>,
    /// When the window was last auto-hidden by a focus-loss event. Used to
    /// debounce the tray-click-to-close race: on macOS, clicking the tray
    /// icon while the panel is open makes the window resign focus (hiding
    /// it) *before* the click handler runs — so without this guard, the
    /// click handler would see a hidden window and re-show it, making the
    /// icon unable to dismiss the panel. A std Mutex (not tokio) because the
    /// event handlers that touch it are synchronous closures.
    last_focus_hide: std::sync::Mutex<Option<Instant>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            client: CollectorClient::new(DEFAULT_PORT),
            last_snapshot: Mutex::new(HealthSnapshot::starting()),
            cached_latest_version: Mutex::new(None),
            gate: Arc::new(PollGate::default()),
            last_focus_hide: std::sync::Mutex::new(None),
        }
    }
}

/// Window is considered "just dismissed by clicking the tray icon" if a
/// focus-loss hide happened within this window. Tuned to cover the focus →
/// click event gap without blocking a deliberate quick re-open.
const FOCUS_HIDE_DEBOUNCE: Duration = Duration::from_millis(300);

fn format_uptime(seconds: u64) -> String {
    let h = seconds / 3600;
    let m = (seconds % 3600) / 60;
    let s = seconds % 60;
    if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

async fn build_snapshot(state: &AppState, refresh_latest: bool) -> HealthSnapshot {
    // /api/health is the primary truth source. If it fails, we go red and
    // skip the sessions fetch entirely — the dropdown is useless without it.
    let health = match state.client.health().await {
        Ok(h) => h,
        Err(e) => {
            let reason = match e {
                CollectorError::Unreachable(_) => "Collector not responding on :6768.".to_string(),
                CollectorError::Http { status, .. } => {
                    format!("Collector returned HTTP {status}.")
                }
                CollectorError::AuthRequired => {
                    "Collector requires authentication.".to_string()
                }
            };
            return HealthSnapshot {
                state: "red",
                status_line: "Collector unreachable".to_string(),
                pid: None,
                port: DEFAULT_PORT,
                uptime_seconds: None,
                running_version: None,
                latest_version: state.cached_latest_version.lock().await.clone(),
                update_available: false,
                sessions: Vec::new(),
                error_reason: Some(reason),
            };
        }
    };

    let (sessions, sessions_err) = match state.client.sessions().await {
        Ok(list) => (
            list.into_iter()
                .map(|s| SessionSummary {
                    session_id: s.session_id,
                    app_name: s.app_name,
                    is_connected: s.is_connected,
                })
                .collect(),
            None,
        ),
        Err(CollectorError::AuthRequired) => (
            Vec::new(),
            Some("Authenticated endpoints unreachable (set RUNTIMESCOPE_API_KEY).".to_string()),
        ),
        Err(_) => (Vec::new(), Some("Could not list sessions.".to_string())),
    };

    let latest_version = if refresh_latest {
        match latest_published_version().await {
            Ok(v) => {
                *state.cached_latest_version.lock().await = Some(v.clone());
                Some(v)
            }
            Err(_) => state.cached_latest_version.lock().await.clone(),
        }
    } else {
        state.cached_latest_version.lock().await.clone()
    };

    let update_available = match (&latest_version, &health.version) {
        (Some(latest), running) => {
            matches!(
                compare_versions(running, latest),
                std::cmp::Ordering::Less
            )
        }
        _ => false,
    };

    let status_line = format!(
        "port {}, uptime {}, v{}",
        DEFAULT_PORT,
        format_uptime(health.uptime),
        health.version,
    );

    let state_color = if sessions_err.is_some() { "yellow" } else { "green" };

    HealthSnapshot {
        state: state_color,
        status_line,
        pid: None, // The HTTP API doesn't expose the PID directly. (CLI's `service status` does, via launchctl — but the brief says HTTP-only.)
        port: DEFAULT_PORT,
        uptime_seconds: Some(health.uptime),
        running_version: Some(health.version),
        latest_version,
        update_available,
        sessions,
        error_reason: sessions_err,
    }
}

async fn poll_loop(app: AppHandle, state: Arc<AppState>) {
    let mut tick = interval(Duration::from_secs(POLL_INTERVAL_SECS));
    // Sleep/wake protection — see Phase brief §A polling rules.
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut counter: u64 = 0;

    loop {
        // Block until the gate is open (dropdown visible). Saves battery
        // when the user dismissed the window.
        state.gate.wait_until_active().await;
        tick.tick().await;

        let refresh_latest = counter % VERSION_CHECK_TICKS == 0;
        counter = counter.wrapping_add(1);

        let snapshot = build_snapshot(&state, refresh_latest).await;
        *state.last_snapshot.lock().await = snapshot.clone();
        let _ = app.emit(HEALTH_EVENT, &snapshot);
    }
}

// --- Tauri commands invoked from the webview ---

#[tauri::command]
async fn health_snapshot(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<HealthSnapshot, String> {
    // Trigger an immediate refresh AND return the cached snapshot — the
    // webview gets a non-empty render right away, the fresh result arrives
    // via the next emit.
    let cached = state.last_snapshot.lock().await.clone();
    let state_clone = Arc::clone(&state);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let fresh = build_snapshot(&state_clone, false).await;
        *state_clone.last_snapshot.lock().await = fresh.clone();
        let _ = app_clone.emit(HEALTH_EVENT, &fresh);
    });
    Ok(cached)
}

#[tauri::command]
fn service_action(action: String) -> Result<(), String> {
    let sub = match action.as_str() {
        "restart" => "restart",
        "update" => "update",
        "stop" => "stop",
        other => return Err(format!("unknown service action: {other}")),
    };
    let status = Command::new("runtimescope")
        .args(["service", sub])
        .status()
        .map_err(|e| format!("failed to spawn runtimescope: {e}"))?;
    if !status.success() {
        return Err(format!(
            "runtimescope service {sub} exited with status {}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

#[tauri::command]
fn open_dashboard() -> Result<(), String> {
    open_path("http://127.0.0.1:6768/dashboard")
}

#[tauri::command]
fn open_logs() -> Result<(), String> {
    // ~/.runtimescope/logs/collector.err.log — let the OS open it in the
    // default `.log` viewer (Console.app on macOS).
    let home = std::env::var("HOME").map_err(|_| "$HOME not set".to_string())?;
    let path = format!("{home}/.runtimescope/logs/collector.err.log");
    open_path(&path)
}

#[tauri::command]
async fn quit_tray(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

fn open_path(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";
    #[cfg(target_os = "windows")]
    let cmd = "explorer";

    Command::new(cmd)
        .arg(target)
        .spawn()
        .map_err(|e| format!("failed to open {target}: {e}"))?;
    Ok(())
}

// --- Tray + window plumbing ---

fn toggle_dropdown(app: &AppHandle, state: &Arc<AppState>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        let _ = window.hide();
        let s = Arc::clone(state);
        // `tauri::async_runtime::spawn` — NOT `tokio::spawn`. Tauri's event
        // loop callbacks (tray click, window events) run on a thread that
        // does NOT have a tokio runtime context, so a raw `tokio::spawn`
        // here panics with "no reactor running" the moment the user clicks
        // the tray icon for the first time.
        tauri::async_runtime::spawn(async move { s.gate.pause().await });
    } else {
        // Debounce the focus-loss-then-click race: if the window was just
        // hidden because clicking the tray icon stole its focus, this click
        // is the same gesture the user meant as "close" — don't reopen.
        let just_hidden = state
            .last_focus_hide
            .lock()
            .ok()
            .and_then(|g| *g)
            .map(|t| t.elapsed() < FOCUS_HIDE_DEBOUNCE)
            .unwrap_or(false);
        if just_hidden {
            return;
        }
        // Anchor near the top-right of the menu bar. The tauri-plugin-positioner
        // v2.3.1 `TrayCenter` variant requires the `tracker` feature which we
        // don't enable yet — TopRight is a close approximation that works on
        // every multi-display layout. Refinement for v1.1: pass the tray-icon
        // rect from `TrayIconEvent::Click` and position relative to it.
        let _ = window.as_ref().window().move_window(Position::TopRight);
        let _ = window.show();
        let _ = window.set_focus();
        let s = Arc::clone(state);
        tauri::async_runtime::spawn(async move { s.gate.resume().await });
    }
}

/// Install a panic hook that writes the panic payload + location to
/// `~/.runtimescope/logs/tray-panic.log`. Default Rust panic output goes to
/// stderr which is silenced when LaunchServices spawns the app from Finder
/// — without this hook, a panic in the Cocoa runloop bubbles up as a bare
/// SIGABRT with no diagnostic context.
fn install_panic_hook() {
    use std::io::Write;
    let prior = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Ok(home) = std::env::var("HOME") {
            let log_dir = format!("{home}/.runtimescope/logs");
            let _ = std::fs::create_dir_all(&log_dir);
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(format!("{log_dir}/tray-panic.log"))
            {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let location = info
                    .location()
                    .map(|l| format!("{}:{}", l.file(), l.line()))
                    .unwrap_or_else(|| "<unknown>".to_string());
                let payload = info
                    .payload()
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| info.payload().downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "<non-string panic payload>".to_string());
                let _ = writeln!(
                    file,
                    "[{ts}] runtimescope-tray PANIC at {location}: {payload}"
                );
                let _ = writeln!(file, "  backtrace:");
                let _ = writeln!(file, "{}", std::backtrace::Backtrace::force_capture());
                let _ = writeln!(file, "---");
            }
        }
        // Defer to whatever the previous (default) hook would have printed,
        // so terminal-launches still see the message on stderr.
        prior(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();

    let state = Arc::new(AppState::new());

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_positioner::init());

    // The auto-updater is gated on P1 (Tauri signing key present in
    // GitHub Actions). If the build was produced without TAURI_SIGNING_PUBKEY
    // baked into env, we skip plugin registration — the binary still works,
    // there's just no in-app update path for the v0.1.0 release.
    if option_env!("TAURI_SIGNING_PUBKEY").is_some() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(Arc::clone(&state))
        .invoke_handler(tauri::generate_handler![
            health_snapshot,
            service_action,
            open_dashboard,
            open_logs,
            quit_tray
        ])
        .setup({
            let state = Arc::clone(&state);
            move |app| {
                // macOS: don't show in the Dock.
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);

                // Tray menu — right-click reveals a minimal menu. Left-click
                // toggles the dropdown (handled in on_tray_icon_event below).
                let quit_item = MenuItem::with_id(app, "quit", "Quit RuntimeScope (Tray)", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&quit_item])?;

                // `include_image!` decodes the PNG at compile time and embeds
                // it as raw RGBA pixels — no runtime decoder needed.
                let tray_icon = tauri::include_image!("./icons/tray-icon.png");

                let _tray = TrayIconBuilder::with_id("main")
                    .icon(tray_icon)
                    .icon_as_template(true)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event: MenuEvent| {
                        if event.id().as_ref() == "quit" {
                            app.exit(0);
                        }
                    })
                    .on_tray_icon_event({
                        let state = Arc::clone(&state);
                        move |tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                toggle_dropdown(tray.app_handle(), &state);
                            }
                        }
                    })
                    .build(app)?;

                // Spawn the polling task. Paused until first show.
                {
                    let app_handle = app.handle().clone();
                    let state = Arc::clone(&state);
                    tauri::async_runtime::spawn(async move {
                        // Start paused — nothing to render against until the
                        // user clicks the tray. wait_until_active() will
                        // block until the gate resumes.
                        state.gate.pause().await;
                        poll_loop(app_handle, state).await;
                    });
                }

                // Hide the main window when it loses focus (click-outside-
                // to-dismiss behavior the user expects from a menu-bar app).
                if let Some(window) = app.get_webview_window("main") {
                    let state = Arc::clone(&state);
                    let window_clone = window.clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::Focused(false) = event {
                            // Stamp the hide so the tray-click handler can tell
                            // this dismissal apart from a deliberate re-open.
                            if let Ok(mut g) = state.last_focus_hide.lock() {
                                *g = Some(Instant::now());
                            }
                            let _ = window_clone.hide();
                            let s = Arc::clone(&state);
                            tauri::async_runtime::spawn(async move { s.gate.pause().await });
                        }
                    });
                }

                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(|_app, event| {
            // Keep the process alive when all windows close — the tray icon
            // is the real entry point.
            if let RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
