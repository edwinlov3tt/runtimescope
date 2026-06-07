//! Persistent event + session store (ADR-0008 / research note 0001).
//!
//! A **dedicated thread owns** the rusqlite `Connection` (WAL mode) + the
//! [`Wal`]; async callers talk to it over an `mpsc` channel and get answers over
//! `oneshot`. This sidesteps `Connection: !Sync`, keeps a single writer (matching
//! the Node EventStore), and never blocks the tokio runtime on SQLite I/O.
//!
//! Durability: an event batch is `append`+`commit`(fsync)'d to the WAL, then
//! `INSERT OR IGNORE`'d into SQLite (itself WAL-mode), then the durability ack is
//! sent. On restart the JSONL WAL replays into SQLite (deduped by `event_id`),
//! recovering anything that was fsync'd but not yet committed before a crash.
//!
//! Sessions are kept in-memory on the owner thread (live-only; not part of the
//! durability contract for the slice). Slice scope: query straight from SQLite
//! (no separate hot ring) — the ring-buffer hot tier + cap is a later refinement.

use crate::event::event_type_of;
use crate::wal::Wal;
use rusqlite::Connection;
use serde_json::Value;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, oneshot};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  project TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);
CREATE INDEX IF NOT EXISTS idx_events_type_project ON events(event_type, project);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  project_id TEXT,
  connected_at INTEGER NOT NULL,
  is_connected INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  metrics TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project);
";

/// A persisted session snapshot (point-in-time metrics), mirroring Node's
/// SessionManager snapshots. `metrics` is the same JSON object the MCP tools
/// surface (totalEvents/errorCount/endpointCount/componentCount/webVitals/queryCount).
#[derive(Clone)]
pub struct SnapshotRow {
    pub id: i64,
    pub session_id: String,
    /// The app/project display name the snapshot was taken under.
    pub project: String,
    pub label: Option<String>,
    pub created_at: i64,
    pub metrics: Value,
}

#[derive(Clone)]
pub struct SessionInfo {
    pub session_id: String,
    /// The app/project display name (NOT the runtime projectId — audit #7).
    pub app_name: String,
    /// The runtime projectId (proj_xxx), separate from `app_name`.
    pub project_id: Option<String>,
    pub connected_at: i64,
    pub is_connected: bool,
    /// Stored events attributed to this session (filled at query time from
    /// SQLite — Node's `SessionInfo.eventCount`). 0 in the in-memory record.
    pub event_count: i64,
}

/// A point-in-time read of the collector's Prometheus-exposable counters/gauges.
/// `events_by_type` is the cumulative per-type accept counter (Node's
/// `runtimescope_events_total{type}`); `buffer_size` is the hot-tier gauge,
/// `min(total stored, ring cap)` (Node's `runtimescope_buffer_size`).
pub struct MetricsSnapshot {
    pub events_by_type: Vec<(String, u64)>,
    pub buffer_size: usize,
    pub total_events: usize,
}

/// Outcome of a retention sweep — what was reclaimed.
#[derive(Default)]
pub struct PruneResult {
    pub events_deleted: usize,
    pub snapshots_rows_deleted: usize,
    pub snapshot_dirs_deleted: usize,
}

impl SessionInfo {
    /// The effective project-scoping key (projectId when present, else appName) —
    /// for filtering/grouping. Display uses `app_name` + `project_id` distinctly.
    pub fn project_key(&self) -> &str {
        self.project_id.as_deref().unwrap_or(&self.app_name)
    }
}

enum Cmd {
    AddBatch { project: String, events: Vec<Value>, reply: oneshot::Sender<Result<usize, String>> },
    RegisterSession { session_id: String, app_name: String, project_id: Option<String> },
    MarkDisconnected { session_id: String },
    Sessions { reply: oneshot::Sender<Vec<SessionInfo>> },
    ConnectedCount { reply: oneshot::Sender<usize> },
    EventsByType { event_type: String, project: Option<String>, reply: oneshot::Sender<Vec<Value>> },
    /// Like EventsByType but filters by type FIRST over FULL durable history (no
    /// hot-tier all-types cap) — analytics aggregations need the whole `custom`
    /// stream, not the newest N events of all types.
    EventsByTypeFull { event_type: String, project: Option<String>, reply: oneshot::Sender<Vec<Value>> },
    Timeline {
        project: Option<String>,
        types: Option<Vec<String>>,
        since_ms: Option<i64>,
        session_id: Option<String>,
        reply: oneshot::Sender<Vec<Value>>,
    },
    EventCount { project: Option<String>, reply: oneshot::Sender<usize> },
    MetricsSnapshot { reply: oneshot::Sender<MetricsSnapshot> },
    Snapshot { reply: oneshot::Sender<Result<Value, String>> },
    Prune { retention_days: i64, max_snapshots: usize, reply: oneshot::Sender<PruneResult> },
    EventsForApp { app: String, reply: oneshot::Sender<Vec<Value>> },
    EventCountForApp { app: String, reply: oneshot::Sender<usize> },
    SaveSnapshot {
        session_id: String,
        project: String,
        label: Option<String>,
        created_at: i64,
        metrics: Value,
        reply: oneshot::Sender<Result<i64, String>>,
    },
    SessionHistory { project: String, limit: usize, reply: oneshot::Sender<Vec<SnapshotRow>> },
}

/// Cloneable async handle to the store. Cheap to clone (just the channel senders).
#[derive(Clone)]
pub struct StoreHandle {
    tx: mpsc::Sender<Cmd>,
    /// Live event/session feed for the dashboard's `/api/ws/events` socket. JSON
    /// strings: `{"type":"event","data":…}` / `{"type":"session_connected",…}` /
    /// `{"type":"session_disconnected",…}` (Node's dashboard broadcast).
    events_tx: tokio::sync::broadcast::Sender<String>,
}

impl StoreHandle {
    /// Subscribe to the live dashboard feed (one receiver per `/api/ws/events` client).
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.events_tx.subscribe()
    }

    /// Open the store at `data_dir` (creating it), run WAL recovery, and return
    /// once recovery is complete (so `/readyz` is honest about being warm).
    pub async fn open(data_dir: PathBuf) -> Result<StoreHandle, String> {
        let (tx, mut rx) = mpsc::channel::<Cmd>(1024);
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
        // Live feed for dashboard WS clients. Lagging/slow clients drop frames
        // (Lagged) rather than back-pressure the hot ingest path.
        let (events_tx, _) = tokio::sync::broadcast::channel::<String>(1024);
        let bcast = events_tx.clone();

        std::thread::spawn(move || {
            let init = (|| -> Result<(Connection, Wal), String> {
                std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
                let conn = Connection::open(data_dir.join("collector.db")).map_err(|e| e.to_string())?;
                conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
                conn.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
                conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
                let mut wal = Wal::open(&data_dir.join("wal")).map_err(|e| e.to_string())?;
                // Recover: replay the JSONL WAL into SQLite (deduped by event_id).
                for (project, ev) in Wal::recover(&data_dir.join("wal")) {
                    let _ = insert_event(&conn, &project, &ev);
                }
                // Recovered events are now durable in SQLite — clear the redundant
                // JSONL WAL so boot stays O(in-flight), not O(history) (audit #3).
                let _ = wal.truncate();
                Ok((conn, wal))
            })();

            let (conn, mut wal) = match init {
                Ok(v) => {
                    let _ = ready_tx.send(Ok(()));
                    v
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };

            // Rehydrate sessions from SQLite as DISCONNECTED — there are no live
            // WS connections after a restart; a reconnect flips is_connected back
            // (audit #7, matching Node's warmFromSqlite).
            let mut sessions: Vec<SessionInfo> = load_sessions(&conn);

            // Hot-tier cap (Node's ring-buffer size). We keep every event durably
            // in SQLite (the beyond-Node win), but the read API + buffer_size gauge
            // present only the newest `cap` rows so the observable hot-tier contract
            // matches Node. `RUNTIMESCOPE_BUFFER_SIZE` (default 10k) per the env spec.
            let cap: usize = std::env::var("RUNTIMESCOPE_BUFFER_SIZE")
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|n| *n > 0)
                .unwrap_or(10_000);
            // Cumulative per-type accept counter (Node's runtimescope_events_total).
            let mut counters: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

            // Group-commit: under load, AddBatch commands queue up. We drain the
            // consecutive ones and fsync the WAL ONCE for the whole group, instead
            // of one fsync per batch (the per-batch fsync dominated p99 tail
            // latency). Each batch still waits for a real fsync before its ack, so
            // durability is unchanged — the crash-recovery contract still holds.
            // `pending` lets us "unget" a non-AddBatch command pulled mid-drain so
            // command order is preserved.
            let mut pending: std::collections::VecDeque<Cmd> = std::collections::VecDeque::new();
            loop {
                let cmd = match pending.pop_front() {
                    Some(c) => c,
                    None => match rx.blocking_recv() {
                        Some(c) => c,
                        None => break,
                    },
                };
                match cmd {
                    Cmd::AddBatch { project, events, reply } => {
                        // Collect this batch + any already-queued AddBatch into a group.
                        type Pending = (String, Vec<Value>, oneshot::Sender<Result<usize, String>>);
                        let mut group: Vec<Pending> = vec![(project, events, reply)];
                        loop {
                            let next = pending.pop_front().or_else(|| rx.try_recv().ok());
                            match next {
                                Some(Cmd::AddBatch { project, events, reply }) => {
                                    group.push((project, events, reply));
                                }
                                Some(other) => {
                                    // preserve order: process it after the group commits.
                                    pending.push_front(other);
                                    break;
                                }
                                None => break,
                            }
                        }

                        let mut err: Option<String> = None;
                        // 1) WAL: append every batch, then ONE fsync for the group.
                        for (project, events, _) in &group {
                            if let Err(e) = wal.append(project, events) {
                                eprintln!("[RuntimeScope] durability: WAL append failed: {e}");
                                err.get_or_insert(format!("WAL: {e}"));
                            }
                        }
                        if err.is_none() {
                            if let Err(e) = wal.commit() {
                                eprintln!("[RuntimeScope] durability: WAL fsync failed: {e}");
                                err.get_or_insert(format!("WAL: {e}"));
                            }
                        }
                        // 2) Cumulative per-type accept counters (every event).
                        for (_, events, _) in &group {
                            for ev in events {
                                *counters.entry(crate::event::event_type_of(ev).to_string()).or_insert(0) += 1;
                            }
                        }
                        // 3) SQLite: the WHOLE group under ONE transaction (cached stmt).
                        let mut stored = vec![0usize; group.len()];
                        match conn.unchecked_transaction() {
                            Ok(tx) => {
                                for (i, (project, events, _)) in group.iter().enumerate() {
                                    for ev in events {
                                        match insert_event(&conn, project, ev) {
                                            Ok(true) => stored[i] += 1, // newly inserted
                                            Ok(false) => {}             // dedup / empty event_id
                                            Err(e) => {
                                                eprintln!("[RuntimeScope] durability: SQLite insert failed: {e}");
                                                err.get_or_insert(format!("SQLite: {e}"));
                                            }
                                        }
                                    }
                                }
                                if let Err(e) = tx.commit() {
                                    eprintln!("[RuntimeScope] durability: SQLite commit failed: {e}");
                                    err.get_or_insert(format!("SQLite commit: {e}"));
                                }
                            }
                            Err(e) => {
                                eprintln!("[RuntimeScope] durability: could not open SQLite transaction: {e}");
                                err.get_or_insert(format!("SQLite txn: {e}"));
                            }
                        }
                        // 4) Group is durable in SQLite — truncate the JSONL WAL once
                        //    (audit #3), only if every write succeeded.
                        if err.is_none() {
                            if let Err(e) = wal.truncate() {
                                eprintln!("[RuntimeScope] WAL truncate failed: {e}");
                            }
                        }
                        // 5) Live feed: push each event to dashboard WS clients
                        //    (Node's broadcastEvent). Skip the JSON cost when nobody
                        //    is subscribed; lagging clients drop frames, never block.
                        if bcast.receiver_count() > 0 {
                            for (project, events, _) in &group {
                                for ev in events {
                                    // Inject the batch's scoping key (projectId-or-appName,
                                    // see server.rs ingest) into `data.projectId`. Raw events
                                    // don't carry it, and the dashboard's WS filter
                                    // (ws-client.ts) keys its "reliable" project-match branch
                                    // off `data.projectId` — without this it always degrades to
                                    // the ~5s sessions-list fallback and drops live events from
                                    // freshly-connected sessions (the console-refresh bug).
                                    let data = match ev {
                                        Value::Object(_) => {
                                            let mut d = ev.clone();
                                            if let Value::Object(map) = &mut d {
                                                map.entry("projectId")
                                                    .or_insert_with(|| Value::String(project.clone()));
                                            }
                                            d
                                        }
                                        _ => ev.clone(),
                                    };
                                    let _ = bcast.send(serde_json::json!({ "type": "event", "data": data }).to_string());
                                }
                            }
                        }
                        // 6) Ack each batch: the shared err, or its own stored count.
                        for (i, (_, _, reply)) in group.into_iter().enumerate() {
                            let _ = reply.send(match &err {
                                Some(e) => Err(e.clone()),
                                None => Ok(stored[i]),
                            });
                        }
                    }
                    Cmd::RegisterSession { session_id, app_name, project_id } => {
                        let connected_at = if let Some(s) = sessions.iter_mut().find(|s| s.session_id == session_id) {
                            s.is_connected = true;
                            s.app_name = app_name.clone();
                            s.project_id = project_id.clone();
                            s.connected_at
                        } else {
                            let connected_at = now_ms();
                            sessions.push(SessionInfo {
                                session_id: session_id.clone(),
                                app_name: app_name.clone(),
                                project_id: project_id.clone(),
                                connected_at,
                                is_connected: true,
                                event_count: 0,
                            });
                            connected_at
                        };
                        // Persist (audit #7) so the session survives a restart.
                        let _ = conn.execute(
                            "INSERT INTO sessions (session_id, app_name, project_id, connected_at, is_connected)
                             VALUES (?1, ?2, ?3, ?4, 1)
                             ON CONFLICT(session_id) DO UPDATE SET app_name=?2, project_id=?3, is_connected=1",
                            rusqlite::params![session_id, app_name, project_id, connected_at],
                        );
                        // Record a queryable `session` connect event (Node parity:
                        // server.ts addEvent on handshake) so it counts in the
                        // history/QA metrics. Idempotent on eventId — reconnects of
                        // the same session don't double-count. Stored under the
                        // event-scoping key (projectId when present, else appName).
                        let scope = project_id.clone().unwrap_or_else(|| app_name.clone());
                        let session_event = serde_json::json!({
                            "eventId": format!("session-{session_id}"),
                            "sessionId": session_id,
                            "timestamp": connected_at,
                            "eventType": "session",
                            "appName": app_name,
                            "projectId": project_id,
                            "connectedAt": connected_at,
                        });
                        // Count the synthetic connect event once (idempotent on
                        // reconnect — only a newly-inserted row bumps the counter).
                        if let Ok(true) = insert_event(&conn, &scope, &session_event) {
                            *counters.entry("session".to_string()).or_insert(0) += 1;
                        }
                        // Tell dashboard WS clients to refresh the project list.
                        let _ = bcast.send(
                            serde_json::json!({ "type": "session_connected", "sessionId": session_id, "appName": app_name, "projectId": project_id })
                                .to_string(),
                        );
                    }
                    Cmd::MarkDisconnected { session_id } => {
                        if let Some(s) = sessions.iter_mut().find(|s| s.session_id == session_id) {
                            s.is_connected = false;
                        }
                        let _ = bcast.send(
                            serde_json::json!({ "type": "session_disconnected", "sessionId": session_id }).to_string(),
                        );
                        let _ = conn.execute(
                            "UPDATE sessions SET is_connected = 0 WHERE session_id = ?1",
                            rusqlite::params![session_id],
                        );
                    }
                    Cmd::Sessions { reply } => {
                        // Attach the live per-session event count (Node's
                        // SessionInfo.eventCount) from SQLite — one grouped query.
                        let counts = session_event_counts(&conn);
                        let mut list = sessions.clone();
                        for s in &mut list {
                            s.event_count = counts.get(&s.session_id).copied().unwrap_or(0);
                        }
                        let _ = reply.send(list);
                    }
                    Cmd::ConnectedCount { reply } => {
                        let _ = reply.send(sessions.iter().filter(|s| s.is_connected).count());
                    }
                    Cmd::EventsByType { event_type, project, reply } => {
                        let _ = reply.send(query_events(&conn, &event_type, project.as_deref(), cap));
                    }
                    Cmd::EventsByTypeFull { event_type, project, reply } => {
                        let _ = reply.send(query_events_typed(&conn, &event_type, project.as_deref()));
                    }
                    Cmd::Timeline { project, types, since_ms, session_id, reply } => {
                        let _ = reply.send(query_timeline(
                            &conn,
                            project.as_deref(),
                            types.as_deref(),
                            since_ms,
                            session_id.as_deref(),
                        ));
                    }
                    Cmd::EventCount { project, reply } => {
                        let _ = reply.send(count_events(&conn, project.as_deref()));
                    }
                    Cmd::MetricsSnapshot { reply } => {
                        let total = count_events(&conn, None);
                        let mut by_type: Vec<(String, u64)> =
                            counters.iter().map(|(k, v)| (k.clone(), *v)).collect();
                        by_type.sort_by(|a, b| a.0.cmp(&b.0));
                        let _ = reply.send(MetricsSnapshot {
                            events_by_type: by_type,
                            buffer_size: total.min(cap),
                            total_events: total,
                        });
                    }
                    Cmd::EventsForApp { app, reply } => {
                        // App-scoped (not projectId-scoped): events belonging to a
                        // session of this appName. Disambiguates the monorepo case
                        // where several apps share one projectId (Node's per-app
                        // SQLite store equivalent).
                        let sids: Vec<String> =
                            sessions.iter().filter(|s| s.app_name == app).map(|s| s.session_id.clone()).collect();
                        let _ = reply.send(query_events_for_sessions(&conn, &sids));
                    }
                    Cmd::EventCountForApp { app, reply } => {
                        let sids: Vec<String> =
                            sessions.iter().filter(|s| s.app_name == app).map(|s| s.session_id.clone()).collect();
                        let _ = reply.send(count_events_for_sessions(&conn, &sids));
                    }
                    Cmd::SaveSnapshot { session_id, project, label, created_at, metrics, reply } => {
                        // Surface the insert error instead of swallowing it to id=0 —
                        // the caller must not report "snapshot saved" on a failed write.
                        let result = conn
                            .execute(
                                "INSERT INTO snapshots (session_id, project, label, created_at, metrics)
                                 VALUES (?1, ?2, ?3, ?4, ?5)",
                                rusqlite::params![session_id, project, label, created_at, metrics.to_string()],
                            )
                            .map(|_| conn.last_insert_rowid())
                            .map_err(|e| e.to_string());
                        let _ = reply.send(result);
                    }
                    Cmd::SessionHistory { project, limit, reply } => {
                        let _ = reply.send(query_session_history(&conn, &project, limit));
                    }
                    Cmd::Snapshot { reply } => {
                        let _ = reply.send(make_snapshot(&conn, &data_dir));
                    }
                    Cmd::Prune { retention_days, max_snapshots, reply } => {
                        let _ = reply.send(prune_old(&conn, &data_dir, retention_days, max_snapshots));
                    }
                }
            }
        });

        ready_rx.await.map_err(|_| "store thread died during init".to_string())??;
        Ok(StoreHandle { tx, events_tx })
    }

    /// Persist a batch durably and await the ack: `Ok(stored)` once the WAL is
    /// fsync'd and SQLite committed, or `Err` if a write failed (so callers can
    /// surface it rather than report a false success — audit #5).
    pub async fn add_batch(&self, project: String, events: Vec<Value>) -> Result<usize, String> {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::AddBatch { project, events, reply }).await.is_err() {
            return Err("store channel closed".into());
        }
        rx.await.unwrap_or_else(|_| Err("store dropped the durability ack".into()))
    }

    pub async fn register_session(&self, session_id: String, app_name: String, project_id: Option<String>) {
        let _ = self.tx.send(Cmd::RegisterSession { session_id, app_name, project_id }).await;
    }

    pub async fn mark_disconnected(&self, session_id: String) {
        let _ = self.tx.send(Cmd::MarkDisconnected { session_id }).await;
    }

    pub async fn sessions(&self) -> Vec<SessionInfo> {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::Sessions { reply }).await.is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    /// Take an atomic `VACUUM INTO` backup of the store under
    /// `<data_dir>/snapshots/<ts>/`. Returns the Node-shaped result
    /// (`{ path, timestamp, projects, totalBytes }`) or an error string.
    pub async fn snapshot(&self) -> Result<Value, String> {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::Snapshot { reply }).await.is_err() {
            return Err("store channel closed".into());
        }
        rx.await.unwrap_or_else(|_| Err("store dropped the snapshot reply".into()))
    }

    /// Run a retention sweep: drop events/snapshots older than `retention_days`
    /// (<= 0 disables) + reclaim disk, and cap snapshot backups to `max_snapshots`.
    pub async fn prune(&self, retention_days: i64, max_snapshots: usize) -> PruneResult {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::Prune { retention_days, max_snapshots, reply }).await.is_err() {
            return PruneResult::default();
        }
        rx.await.unwrap_or_default()
    }

    /// A Prometheus-exposable snapshot of the live counters/gauges (`/metrics`).
    pub async fn metrics_snapshot(&self) -> MetricsSnapshot {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::MetricsSnapshot { reply }).await.is_err() {
            return MetricsSnapshot { events_by_type: Vec::new(), buffer_size: 0, total_events: 0 };
        }
        rx.await.unwrap_or(MetricsSnapshot { events_by_type: Vec::new(), buffer_size: 0, total_events: 0 })
    }

    pub async fn connected_count(&self) -> usize {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::ConnectedCount { reply }).await.is_err() {
            return 0;
        }
        rx.await.unwrap_or(0)
    }

    pub async fn events_by_type(&self, event_type: &str, project: Option<&str>) -> Vec<Value> {
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::EventsByType {
            event_type: event_type.to_string(),
            project: project.map(String::from),
            reply,
        };
        if self.tx.send(cmd).await.is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    /// Full type-filtered history (no hot-tier cap) — for analytics aggregations
    /// that must see the whole `custom`/`session` stream, not the newest N of all
    /// types. See [`Cmd::EventsByTypeFull`].
    pub async fn events_by_type_full(&self, event_type: &str, project: Option<&str>) -> Vec<Value> {
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::EventsByTypeFull {
            event_type: event_type.to_string(),
            project: project.map(String::from),
            reply,
        };
        if self.tx.send(cmd).await.is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    /// Count all stored events for a project scope (or every event when `None`).
    /// Matches Node's `sqliteStore.getEventCount({ project })`.
    pub async fn event_count(&self, project: Option<&str>) -> usize {
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::EventCount { project: project.map(String::from), reply };
        if self.tx.send(cmd).await.is_err() {
            return 0;
        }
        rx.await.unwrap_or(0)
    }

    /// All events belonging to sessions of `app` (appName), newest-first. This is
    /// the appName-addressed read (history tools) — distinct from projectId scope.
    pub async fn events_for_app(&self, app: &str) -> Vec<Value> {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::EventsForApp { app: app.to_string(), reply }).await.is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    /// Count of events belonging to sessions of `app` (appName).
    pub async fn event_count_for_app(&self, app: &str) -> usize {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::EventCountForApp { app: app.to_string(), reply }).await.is_err() {
            return 0;
        }
        rx.await.unwrap_or(0)
    }

    /// Persist a session snapshot and return its row id.
    pub async fn save_snapshot(
        &self,
        session_id: String,
        project: String,
        label: Option<String>,
        created_at: i64,
        metrics: Value,
    ) -> Result<i64, String> {
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::SaveSnapshot { session_id, project, label, created_at, metrics, reply };
        if self.tx.send(cmd).await.is_err() {
            return Err("store channel closed".to_string());
        }
        rx.await.unwrap_or_else(|_| Err("store reply dropped".to_string()))
    }

    /// The latest snapshot per session for a project, newest-first (`limit` rows).
    /// Matches Node's `sessionManager.getSessionHistory(project, limit)`.
    pub async fn session_history(&self, project: &str, limit: usize) -> Vec<SnapshotRow> {
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::SessionHistory { project: project.to_string(), limit, reply };
        if self.tx.send(cmd).await.is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    /// All events for a project in **insertion order** (oldest-first), optionally
    /// restricted to a set of event types — the cross-type timeline merge.
    /// Matches the Node `getEventTimeline` (buffer.toArray(), not timestamp-sorted).
    pub async fn timeline(
        &self,
        project: Option<&str>,
        types: Option<Vec<String>>,
        since_ms: Option<i64>,
        session_id: Option<&str>,
    ) -> Vec<Value> {
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::Timeline {
            project: project.map(String::from),
            types,
            since_ms,
            session_id: session_id.map(String::from),
            reply,
        };
        if self.tx.send(cmd).await.is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }
}

/// Load persisted sessions, forced to `is_connected = false` (no live WS exists
/// right after a restart; a reconnect flips it back). Audit #7.
fn load_sessions(conn: &Connection) -> Vec<SessionInfo> {
    let mut stmt = match conn.prepare(
        "SELECT session_id, app_name, project_id, connected_at FROM sessions",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        Ok(SessionInfo {
            session_id: r.get(0)?,
            app_name: r.get(1)?,
            project_id: r.get(2)?,
            connected_at: r.get(3)?,
            is_connected: false,
            event_count: 0,
        })
    });
    rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
}

/// Per-session stored-event counts (`session_id → COUNT(*)`), one grouped query.
/// Used to fill `SessionInfo.event_count` for `GET /api/sessions`.
fn session_event_counts(conn: &Connection) -> std::collections::HashMap<String, i64> {
    let mut m = std::collections::HashMap::new();
    let Ok(mut stmt) =
        conn.prepare("SELECT session_id, COUNT(*) FROM events WHERE session_id <> '' GROUP BY session_id")
    else {
        return m;
    };
    if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
        for (sid, c) in rows.flatten() {
            m.insert(sid, c);
        }
    }
    m
}

/// INSERT OR IGNORE one raw event. Idempotent on `event_id` (so WAL replay is
/// safe). Returns `Ok(true)` if a row was newly inserted, `Ok(false)` if it was
/// a dedup/empty-id no-op, `Err` on a real SQLite error (surfaced, not swallowed
/// — audit #5).
fn insert_event(conn: &Connection, project: &str, ev: &Value) -> rusqlite::Result<bool> {
    let event_id = ev.get("eventId").and_then(Value::as_str).unwrap_or("");
    if event_id.is_empty() {
        return Ok(false);
    }
    let session_id = ev.get("sessionId").and_then(Value::as_str).unwrap_or("");
    let timestamp = ev.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
    let event_type = event_type_of(ev);
    let data = ev.to_string();
    // prepare_cached: the INSERT is parsed once per connection, then reused for
    // every event in every batch (the hot ingest path runs this ~10k×/sec).
    let n = conn
        .prepare_cached(
            "INSERT OR IGNORE INTO events (event_id, session_id, project, event_type, timestamp, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?
        .execute(rusqlite::params![event_id, session_id, project, event_type, timestamp, data])?;
    Ok(n > 0)
}

/// Timeline: all events for a project in insertion order (id ASC = chronological,
/// matching Node's `buffer.toArray()`), then the same in-Rust filters Node's
/// `getEventTimeline` applies — `since_ms` (keep `timestamp >= since_ms`),
/// `session_id` (exact, or comma-list membership = Node's `matchesSessionFilter`),
/// and the `event_types` set.
fn query_timeline(
    conn: &Connection,
    project: Option<&str>,
    types: Option<&[String]>,
    since_ms: Option<i64>,
    session_id: Option<&str>,
) -> Vec<Value> {
    let mut stmt = match conn.prepare(
        "SELECT event_type, session_id, timestamp, data FROM events \
         WHERE (?1 IS NULL OR project = ?1) ORDER BY id ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(rusqlite::params![project], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
        ))
    });
    let mut out = Vec::new();
    if let Ok(rows) = rows {
        for (event_type, sid, ts, data) in rows.flatten() {
            if let Some(since) = since_ms {
                if ts < since {
                    continue;
                }
            }
            if let Some(filter) = session_id {
                let sid = sid.as_deref().unwrap_or("");
                let matches = if filter.contains(',') {
                    filter.split(',').any(|x| x == sid)
                } else {
                    sid == filter
                };
                if !matches {
                    continue;
                }
            }
            if let Some(filter) = types {
                if !filter.iter().any(|t| t == &event_type) {
                    continue;
                }
            }
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                out.push(v);
            }
        }
    }
    out
}

/// Atomic backup of the store: `VACUUM INTO` a fresh `collector.db` under
/// `<data_dir>/snapshots/<ts>/`. SQLite holds the full event history (the
/// beyond-Node durability win), so one DB copy is the whole snapshot. Returns
/// Node's response shape; surfaces a real error rather than a false success.
fn make_snapshot(conn: &Connection, data_dir: &std::path::Path) -> Result<Value, String> {
    let ts = now_ms();
    let root = data_dir.join("snapshots").join(ts.to_string());
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let db_path = root.join("collector.db");
    // VACUUM INTO requires the destination not already exist (ts-named dir is fresh).
    let dest = db_path.to_str().ok_or("snapshot path is not valid UTF-8")?;
    conn.execute("VACUUM INTO ?1", rusqlite::params![dest]).map_err(|e| e.to_string())?;
    let sqlite_bytes = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
    let event_count = count_events(conn, None) as i64;
    Ok(serde_json::json!({
        "path": root.to_string_lossy(),
        "timestamp": ts,
        "totalBytes": sqlite_bytes,
        "projects": [{
            "name": "collector",
            "sqliteBytes": sqlite_bytes,
            "walBytes": 0,
            "eventCount": event_count,
        }],
    }))
}

/// Retention sweep: the Rust collector stores every event durably (no in-memory
/// ring eviction like Node), so without this the DB grows forever. Deletes events
/// and session snapshots older than `retention_days`, caps the on-disk VACUUM-INTO
/// snapshot dirs to the newest `max_snapshots`, and reclaims freed pages with
/// `VACUUM`. A `retention_days` of 0 or less disables age-based pruning.
fn prune_old(
    conn: &Connection,
    data_dir: &std::path::Path,
    retention_days: i64,
    max_snapshots: usize,
) -> PruneResult {
    let mut r = PruneResult::default();

    if retention_days > 0 {
        let cutoff = now_ms() - retention_days * 86_400_000;
        r.events_deleted = conn
            .execute("DELETE FROM events WHERE timestamp < ?1", rusqlite::params![cutoff])
            .unwrap_or(0);
        r.snapshots_rows_deleted = conn
            .execute("DELETE FROM snapshots WHERE created_at < ?1", rusqlite::params![cutoff])
            .unwrap_or(0);
        // Reclaim disk only when we actually deleted rows (VACUUM rewrites the DB).
        if r.events_deleted > 0 || r.snapshots_rows_deleted > 0 {
            if let Err(e) = conn.execute_batch("VACUUM") {
                eprintln!("[RuntimeScope] retention: VACUUM failed: {e}");
            }
        }
    }

    // Cap the VACUUM-INTO snapshot backups (admin snapshot endpoint) — keep the
    // newest `max_snapshots` dirs (their names are epoch-ms, so lexical desc = newest).
    let snap_dir = data_dir.join("snapshots");
    if let Ok(entries) = std::fs::read_dir(&snap_dir) {
        let mut dirs: Vec<std::path::PathBuf> =
            entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        if dirs.len() > max_snapshots {
            for old in &dirs[..dirs.len() - max_snapshots] {
                if std::fs::remove_dir_all(old).is_ok() {
                    r.snapshot_dirs_deleted += 1;
                }
            }
        }
    }
    r
}

/// COUNT(*) of stored events for a project scope (or all events when `None`).
fn count_events(conn: &Connection, project: Option<&str>) -> usize {
    conn.query_row(
        "SELECT COUNT(*) FROM events WHERE (?1 IS NULL OR project = ?1)",
        rusqlite::params![project],
        |r| r.get::<_, i64>(0),
    )
    .unwrap_or(0) as usize
}

/// Events for a set of session ids, newest-first (id DESC). Empty set → no rows.
fn query_events_for_sessions(conn: &Connection, session_ids: &[String]) -> Vec<Value> {
    if session_ids.is_empty() {
        return Vec::new();
    }
    let placeholders = vec!["?"; session_ids.len()].join(",");
    let sql = format!("SELECT data FROM events WHERE session_id IN ({placeholders}) ORDER BY id DESC");
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let params: Vec<&dyn rusqlite::ToSql> = session_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |r| r.get::<_, String>(0));
    let mut out = Vec::new();
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&row) {
                out.push(v);
            }
        }
    }
    out
}

/// COUNT(*) of events for a set of session ids.
fn count_events_for_sessions(conn: &Connection, session_ids: &[String]) -> usize {
    if session_ids.is_empty() {
        return 0;
    }
    let placeholders = vec!["?"; session_ids.len()].join(",");
    let sql = format!("SELECT COUNT(*) FROM events WHERE session_id IN ({placeholders})");
    let params: Vec<&dyn rusqlite::ToSql> = session_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    conn.query_row(&sql, params.as_slice(), |r| r.get::<_, i64>(0)).unwrap_or(0) as usize
}

/// Latest snapshot per session for a project, newest-first, capped at `limit`.
fn query_session_history(conn: &Connection, project: &str, limit: usize) -> Vec<SnapshotRow> {
    // Latest row per session (MAX(id)), newest snapshot first.
    let mut stmt = match conn.prepare(
        "SELECT s.id, s.session_id, s.project, s.label, s.created_at, s.metrics
         FROM snapshots s
         JOIN (SELECT session_id, MAX(id) AS mid FROM snapshots WHERE project = ?1 GROUP BY session_id) latest
           ON s.id = latest.mid
         ORDER BY s.created_at DESC
         LIMIT ?2",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(rusqlite::params![project, limit as i64], |r| {
        let metrics_json: String = r.get(5)?;
        Ok(SnapshotRow {
            id: r.get(0)?,
            session_id: r.get(1)?,
            project: r.get(2)?,
            label: r.get(3)?,
            created_at: r.get(4)?,
            metrics: serde_json::from_str(&metrics_json).unwrap_or(Value::Null),
        })
    });
    rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
}

/// Query events of a type, optionally project-scoped, newest-first — but only
/// within the **hot tier**: the newest `cap` events across the whole store
/// (Node's ring-buffer window), then filtered by type/project. This bounds the
/// read API to the configured buffer size while SQLite keeps full history.
/// Filter by type FIRST over full durable history (no all-types hot-tier cap) —
/// for analytics aggregations that need the whole `custom`/`session` stream.
/// Newest-first. (`query_events` caps the newest N across ALL types then filters,
/// which is correct for the recent-activity dashboard pages but starves a
/// low-frequency type like `custom` in a busy app.)
fn query_events_typed(conn: &Connection, event_type: &str, project: Option<&str>) -> Vec<Value> {
    let mut stmt = match conn.prepare(
        "SELECT data FROM events WHERE event_type = ?1 AND (?2 IS NULL OR project = ?2) ORDER BY id DESC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(rusqlite::params![event_type, project], |r| r.get::<_, String>(0));
    let mut out = Vec::new();
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&row) {
                out.push(v);
            }
        }
    }
    out
}

fn query_events(conn: &Connection, event_type: &str, project: Option<&str>, cap: usize) -> Vec<Value> {
    let mut stmt = match conn.prepare(
        "SELECT data FROM (SELECT id, data, event_type, project FROM events ORDER BY id DESC LIMIT ?3) \
         WHERE event_type = ?1 AND (?2 IS NULL OR project = ?2) ORDER BY id DESC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(rusqlite::params![event_type, project, cap as i64], |r| r.get::<_, String>(0));
    let mut out = Vec::new();
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&row) {
                out.push(v);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Locks the INTENDED Rust behavior for the shared-projectId case (audit 0002
    // second review #3): appName-addressed reads are isolated per app. This is a
    // deliberate improvement over Node (whose per-app persistence is asymmetric),
    // so it cannot live in the Node-vs-Rust conformance suite — it's gated here.
    #[tokio::test]
    async fn events_for_app_isolates_apps_sharing_a_project_id() {
        let dir = std::env::temp_dir().join(format!("store-appiso-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.clone()).await.unwrap();

        // Two apps, ONE shared projectId.
        store.register_session("sidA".into(), "app-alpha".into(), Some("projShared".into())).await;
        store.register_session("sidB".into(), "app-beta".into(), Some("projShared".into())).await;

        let net = |sid: &str, url: &str| {
            serde_json::json!({
                "eventId": format!("evt-{sid}"), "sessionId": sid, "timestamp": 1,
                "eventType": "network", "url": url, "method": "GET", "status": 200
            })
        };
        store.add_batch("projShared".into(), vec![net("sidA", "https://x/a")]).await.unwrap();
        store.add_batch("projShared".into(), vec![net("sidB", "https://x/b")]).await.unwrap();

        // App-scoped reads are ISOLATED: app-alpha sees ONLY sidA's events (its
        // network + its synthetic session connect), never sidB's — and vice versa.
        let alpha = store.events_for_app("app-alpha").await;
        assert!(!alpha.is_empty());
        assert!(
            alpha.iter().all(|e| e.get("sessionId").and_then(Value::as_str) == Some("sidA")),
            "app-alpha leaked another app's events: {alpha:?}"
        );
        let beta = store.events_for_app("app-beta").await;
        assert!(beta.iter().all(|e| e.get("sessionId").and_then(Value::as_str) == Some("sidB")));

        // The projectId scope, by contrast, holds BOTH apps' events.
        assert!(store.event_count(Some("projShared")).await > store.event_count_for_app("app-alpha").await);
        assert_eq!(store.event_count_for_app("app-alpha").await, alpha.len());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Drift 0004 #1: the dashboard WS filter (ws-client.ts) keys its "reliable"
    // project-match branch off data.projectId; the per-event broadcast must
    // inject the batch's scoping key, or live filtering degrades to the stale
    // session-list fallback (the reported console-refresh bug). Also: an event
    // that already carries a projectId is left untouched.
    #[tokio::test]
    async fn broadcast_frames_carry_scoping_project_id() {
        let dir = std::env::temp_dir().join(format!("store-bcast-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.clone()).await.unwrap();

        // subscribe() makes receiver_count > 0, so the broadcast path fires.
        let mut rx = store.subscribe();
        async fn next_frame(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Value {
            let s = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
                .await
                .expect("no broadcast frame within 2s")
                .expect("broadcast channel closed");
            serde_json::from_str::<Value>(&s).unwrap()
        }

        // 1) An event with no projectId gets the batch's scoping key injected.
        let ev = serde_json::json!({
            "eventId": "evt-1", "sessionId": "sidA", "timestamp": 1,
            "eventType": "console", "level": "log", "message": "hi"
        });
        store.add_batch("proj_xyz".into(), vec![ev]).await.unwrap();
        let v = next_frame(&mut rx).await;
        assert_eq!(v.get("type").and_then(Value::as_str), Some("event"));
        assert_eq!(
            v.pointer("/data/projectId").and_then(Value::as_str),
            Some("proj_xyz"),
            "broadcast frame must carry the scoping projectId: {v}"
        );
        assert_eq!(v.pointer("/data/eventId").and_then(Value::as_str), Some("evt-1"));

        // 2) An event that already carries a projectId is NOT overwritten.
        let ev2 = serde_json::json!({
            "eventId": "evt-2", "sessionId": "sidB", "timestamp": 2,
            "eventType": "console", "level": "log", "message": "hi2",
            "projectId": "explicit"
        });
        store.add_batch("proj_xyz".into(), vec![ev2]).await.unwrap();
        let v2 = next_frame(&mut rx).await;
        assert_eq!(v2.pointer("/data/projectId").and_then(Value::as_str), Some("explicit"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Retention sweep: events past the window are deleted, recent ones survive,
    // and retention_days <= 0 disables age-based pruning (durability gap fix).
    #[tokio::test]
    async fn prune_drops_events_older_than_retention() {
        let dir = std::env::temp_dir().join(format!("store-prune-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreHandle::open(dir.clone()).await.unwrap();

        let now = now_ms();
        let old = now - 100 * 86_400_000; // 100 days ago
        let recent = now - 86_400_000; // 1 day ago
        let ev = |id: &str, ts: i64| {
            serde_json::json!({
                "eventId": id, "sessionId": "s", "timestamp": ts,
                "eventType": "network", "url": "https://x", "method": "GET", "status": 200
            })
        };
        store
            .add_batch("proj".into(), vec![ev("old1", old), ev("old2", old), ev("recent1", recent)])
            .await
            .unwrap();
        assert_eq!(store.event_count(Some("proj")).await, 3);

        let r = store.prune(90, 10).await;
        assert_eq!(r.events_deleted, 2, "the two 100-day-old events are pruned at 90d retention");
        assert_eq!(store.event_count(Some("proj")).await, 1, "the 1-day-old event survives");

        // retention_days = 0 disables age-based pruning.
        store.add_batch("proj".into(), vec![ev("old3", old)]).await.unwrap();
        let r0 = store.prune(0, 10).await;
        assert_eq!(r0.events_deleted, 0, "retention 0 keeps events forever");
        assert_eq!(store.event_count(Some("proj")).await, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
