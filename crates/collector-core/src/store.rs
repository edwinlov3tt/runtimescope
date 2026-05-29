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
use tokio::sync::{mpsc, oneshot};

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
";

#[derive(Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub app_name: String,
    pub project: String,
    pub is_connected: bool,
}

enum Cmd {
    AddBatch { project: String, events: Vec<Value>, reply: oneshot::Sender<()> },
    RegisterSession { session_id: String, app_name: String, project: String },
    MarkDisconnected { session_id: String },
    Sessions { reply: oneshot::Sender<Vec<SessionInfo>> },
    ConnectedCount { reply: oneshot::Sender<usize> },
    EventsByType { event_type: String, project: Option<String>, reply: oneshot::Sender<Vec<Value>> },
    Timeline { project: Option<String>, types: Option<Vec<String>>, reply: oneshot::Sender<Vec<Value>> },
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
                let wal = Wal::open(&data_dir.join("wal")).map_err(|e| e.to_string())?;
                // Recover: replay the JSONL WAL into SQLite (deduped by event_id).
                for (project, ev) in Wal::recover(&data_dir.join("wal")) {
                    insert_event(&conn, &project, &ev);
                }
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

            let mut sessions: Vec<SessionInfo> = Vec::new();

            while let Some(cmd) = rx.blocking_recv() {
                match cmd {
                    Cmd::AddBatch { project, events, reply } => {
                        // Durability: WAL append + fsync BEFORE the SQLite write.
                        let _ = wal.append(&project, &events);
                        let _ = wal.commit();
                        for ev in &events {
                            insert_event(&conn, &project, ev);
                        }
                        let _ = reply.send(());
                    }
                    Cmd::RegisterSession { session_id, app_name, project } => {
                        if let Some(s) = sessions.iter_mut().find(|s| s.session_id == session_id) {
                            s.is_connected = true;
                            s.app_name = app_name;
                            s.project = project;
                        } else {
                            sessions.push(SessionInfo { session_id, app_name, project, is_connected: true });
                        }
                    }
                    Cmd::MarkDisconnected { session_id } => {
                        if let Some(s) = sessions.iter_mut().find(|s| s.session_id == session_id) {
                            s.is_connected = false;
                        }
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
                }
            }
        });

        ready_rx.await.map_err(|_| "store thread died during init".to_string())??;
        Ok(StoreHandle { tx })
    }

    /// Persist a batch durably and await the ack (WAL fsync + SQLite commit).
    pub async fn add_batch(&self, project: String, events: Vec<Value>) {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::AddBatch { project, events, reply }).await.is_ok() {
            let _ = rx.await;
        }
    }

    pub async fn register_session(&self, session_id: String, app_name: String, project: String) {
        let _ = self.tx.send(Cmd::RegisterSession { session_id, app_name, project }).await;
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

/// INSERT OR IGNORE one raw event. Idempotent on `event_id` (so WAL replay is safe).
fn insert_event(conn: &Connection, project: &str, ev: &Value) {
    let event_id = ev.get("eventId").and_then(Value::as_str).unwrap_or("");
    if event_id.is_empty() {
        return;
    }
    let session_id = ev.get("sessionId").and_then(Value::as_str).unwrap_or("");
    let timestamp = ev.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
    let event_type = event_type_of(ev);
    let data = ev.to_string();
    let _ = conn.execute(
        "INSERT OR IGNORE INTO events (event_id, session_id, project, event_type, timestamp, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![event_id, session_id, project, event_type, timestamp, data],
    );
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
