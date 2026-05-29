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
    Timeline { project: Option<String>, types: Option<Vec<String>>, reply: oneshot::Sender<Vec<Value>> },
    EventCount { project: Option<String>, reply: oneshot::Sender<usize> },
    SaveSnapshot {
        session_id: String,
        project: String,
        label: Option<String>,
        created_at: i64,
        metrics: Value,
        reply: oneshot::Sender<i64>,
    },
    SessionHistory { project: String, limit: usize, reply: oneshot::Sender<Vec<SnapshotRow>> },
}

/// Cloneable async handle to the store. Cheap to clone (just the channel sender).
#[derive(Clone)]
pub struct StoreHandle {
    tx: mpsc::Sender<Cmd>,
}

impl StoreHandle {
    /// Open the store at `data_dir` (creating it), run WAL recovery, and return
    /// once recovery is complete (so `/readyz` is honest about being warm).
    pub async fn open(data_dir: PathBuf) -> Result<StoreHandle, String> {
        let (tx, mut rx) = mpsc::channel::<Cmd>(1024);
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();

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

            while let Some(cmd) = rx.blocking_recv() {
                match cmd {
                    Cmd::AddBatch { project, events, reply } => {
                        // Durability: WAL append + fsync BEFORE the SQLite write.
                        // Errors are propagated, not swallowed (audit #5).
                        let mut err: Option<String> = None;
                        if let Err(e) = wal.append(&project, &events).and_then(|()| wal.commit()) {
                            eprintln!("[RuntimeScope] durability: WAL write failed: {e}");
                            err.get_or_insert(format!("WAL: {e}"));
                        }
                        let mut stored = 0usize;
                        for ev in &events {
                            match insert_event(&conn, &project, ev) {
                                Ok(_) => stored += 1,
                                Err(e) => {
                                    eprintln!("[RuntimeScope] durability: SQLite insert failed: {e}");
                                    err.get_or_insert(format!("SQLite: {e}"));
                                }
                            }
                        }
                        // The batch is now durable in SQLite (its own WAL) — close the
                        // JSONL WAL window so it stays bounded (audit #3). Only when
                        // every write succeeded; otherwise keep it for recovery.
                        if err.is_none() {
                            if let Err(e) = wal.truncate() {
                                eprintln!("[RuntimeScope] WAL truncate failed: {e}");
                            }
                        }
                        let _ = reply.send(err.map_or(Ok(stored), Err));
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
                        let _ = insert_event(&conn, &scope, &session_event);
                    }
                    Cmd::MarkDisconnected { session_id } => {
                        if let Some(s) = sessions.iter_mut().find(|s| s.session_id == session_id) {
                            s.is_connected = false;
                        }
                        let _ = conn.execute(
                            "UPDATE sessions SET is_connected = 0 WHERE session_id = ?1",
                            rusqlite::params![session_id],
                        );
                    }
                    Cmd::Sessions { reply } => {
                        let _ = reply.send(sessions.clone());
                    }
                    Cmd::ConnectedCount { reply } => {
                        let _ = reply.send(sessions.iter().filter(|s| s.is_connected).count());
                    }
                    Cmd::EventsByType { event_type, project, reply } => {
                        let _ = reply.send(query_events(&conn, &event_type, project.as_deref()));
                    }
                    Cmd::Timeline { project, types, reply } => {
                        let _ = reply.send(query_timeline(&conn, project.as_deref(), types.as_deref()));
                    }
                    Cmd::EventCount { project, reply } => {
                        let _ = reply.send(count_events(&conn, project.as_deref()));
                    }
                    Cmd::SaveSnapshot { session_id, project, label, created_at, metrics, reply } => {
                        let id = conn
                            .execute(
                                "INSERT INTO snapshots (session_id, project, label, created_at, metrics)
                                 VALUES (?1, ?2, ?3, ?4, ?5)",
                                rusqlite::params![session_id, project, label, created_at, metrics.to_string()],
                            )
                            .map(|_| conn.last_insert_rowid())
                            .unwrap_or(0);
                        let _ = reply.send(id);
                    }
                    Cmd::SessionHistory { project, limit, reply } => {
                        let _ = reply.send(query_session_history(&conn, &project, limit));
                    }
                }
            }
        });

        ready_rx.await.map_err(|_| "store thread died during init".to_string())??;
        Ok(StoreHandle { tx })
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

    /// Persist a session snapshot and return its row id.
    pub async fn save_snapshot(
        &self,
        session_id: String,
        project: String,
        label: Option<String>,
        created_at: i64,
        metrics: Value,
    ) -> i64 {
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::SaveSnapshot { session_id, project, label, created_at, metrics, reply };
        if self.tx.send(cmd).await.is_err() {
            return 0;
        }
        rx.await.unwrap_or(0)
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
    pub async fn timeline(&self, project: Option<&str>, types: Option<Vec<String>>) -> Vec<Value> {
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::Timeline { project: project.map(String::from), types, reply };
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
        })
    });
    rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
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
    let n = conn.execute(
        "INSERT OR IGNORE INTO events (event_id, session_id, project, event_type, timestamp, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![event_id, session_id, project, event_type, timestamp, data],
    )?;
    Ok(n > 0)
}

/// Timeline: all events for a project in insertion order (id ASC), optionally
/// filtered to a set of event types (filtered in Rust to keep the SQL simple).
fn query_timeline(conn: &Connection, project: Option<&str>, types: Option<&[String]>) -> Vec<Value> {
    let mut stmt = match conn.prepare(
        "SELECT event_type, data FROM events WHERE (?1 IS NULL OR project = ?1) ORDER BY id ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(rusqlite::params![project], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    });
    let mut out = Vec::new();
    if let Ok(rows) = rows {
        for (event_type, data) in rows.flatten() {
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

/// COUNT(*) of stored events for a project scope (or all events when `None`).
fn count_events(conn: &Connection, project: Option<&str>) -> usize {
    conn.query_row(
        "SELECT COUNT(*) FROM events WHERE (?1 IS NULL OR project = ?1)",
        rusqlite::params![project],
        |r| r.get::<_, i64>(0),
    )
    .unwrap_or(0) as usize
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

/// Query events of a type, optionally project-scoped, newest-first.
fn query_events(conn: &Connection, event_type: &str, project: Option<&str>) -> Vec<Value> {
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
