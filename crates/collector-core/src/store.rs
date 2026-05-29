//! In-memory event + session store for the Milestone 1 slice.
//!
//! A simple ring buffer behind a `Mutex`. The dedicated-DB-owner-thread model
//! with WAL + rusqlite (research note 0001 / ADR-0008) replaces this as the
//! slice widens to persistence; the query surface defined here is what both the
//! HTTP routes and the MCP tools call, so it's the seam to keep stable.

use serde_json::Value;
use std::collections::VecDeque;

pub struct StoredEvent {
    pub project: String,
    pub event_type: String,
    pub value: Value,
}

#[derive(Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub app_name: String,
    pub project: String,
    pub is_connected: bool,
}

pub struct Store {
    events: VecDeque<StoredEvent>,
    sessions: Vec<SessionInfo>,
    cap: usize,
}

impl Store {
    pub fn new(cap: usize) -> Self {
        Store { events: VecDeque::new(), sessions: Vec::new(), cap }
    }

    pub fn add_event(&mut self, project: String, event_type: String, value: Value) {
        if self.events.len() >= self.cap {
            self.events.pop_front();
        }
        self.events.push_back(StoredEvent { project, event_type, value });
    }

    /// Register (or re-connect) a session. Idempotent on session_id.
    pub fn register_session(&mut self, session_id: String, app_name: String, project: String) {
        if let Some(s) = self.sessions.iter_mut().find(|s| s.session_id == session_id) {
            s.is_connected = true;
            s.app_name = app_name;
            s.project = project;
        } else {
            self.sessions.push(SessionInfo { session_id, app_name, project, is_connected: true });
        }
    }

    pub fn mark_disconnected(&mut self, session_id: &str) {
        if let Some(s) = self.sessions.iter_mut().find(|s| s.session_id == session_id) {
            s.is_connected = false;
        }
    }

    pub fn sessions(&self) -> Vec<SessionInfo> {
        self.sessions.clone()
    }

    pub fn connected_count(&self) -> usize {
        self.sessions.iter().filter(|s| s.is_connected).count()
    }

    /// Events of a given type, optionally scoped to a project, newest-first
    /// (matching the Node collector's query order).
    pub fn events_by_type(&self, event_type: &str, project_id: Option<&str>) -> Vec<Value> {
        self.events
            .iter()
            .rev()
            .filter(|e| e.event_type == event_type)
            .filter(|e| project_id.is_none_or(|p| e.project == p))
            .map(|e| e.value.clone())
            .collect()
    }
}
