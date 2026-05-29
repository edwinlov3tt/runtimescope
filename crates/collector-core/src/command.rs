//! Server→SDK command channel (`docs/specs/wire-protocol.md` §5, ADR-0008).
//!
//! An MCP tool (in-process with the embedded collector) calls
//! [`CommandHub::send_command`], which pushes a `{type:"command", payload:{
//! command, requestId, params}}` frame to the target session's WS connection and
//! awaits the SDK's `command_response` correlated by `requestId`. Because
//! mcp-server embeds the collector in the same process, this is a plain
//! in-process call — no cross-process bridge.
//!
//! Each WS connection registers an outbound `mpsc` sender (the writer half of
//! the split socket) keyed by `sessionId`; responses resolve a pending
//! `oneshot`. `requestId`s come from a process-local counter (no RNG needed).

use axum::extract::ws::{Message, Utf8Bytes};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Default)]
pub struct CommandHub {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    outbound: Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    counter: AtomicU64,
}

impl CommandHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a session's outbound channel (called by the WS handler on connect).
    pub fn register(&self, session_id: String, tx: mpsc::UnboundedSender<Message>) {
        self.inner.outbound.lock().unwrap().insert(session_id, tx);
    }

    pub fn unregister(&self, session_id: &str) {
        self.inner.outbound.lock().unwrap().remove(session_id);
    }

    /// Resolve a pending command with the SDK's response payload (called by the
    /// WS handler when a `command_response` frame arrives).
    pub fn handle_response(&self, request_id: &str, payload: Value) {
        if let Some(tx) = self.inner.pending.lock().unwrap().remove(request_id) {
            let _ = tx.send(payload);
        }
    }

    /// Send a command to a session and await its response (10s timeout).
    pub async fn send_command(
        &self,
        session_id: &str,
        command: &str,
        params: Value,
    ) -> Result<Value, String> {
        let req_id = format!("req-{}", self.inner.counter.fetch_add(1, Ordering::Relaxed));
        let frame = json!({
            "type": "command",
            "payload": { "command": command, "requestId": req_id, "params": params },
            "timestamp": 0,
            "sessionId": session_id,
        })
        .to_string();

        let (rtx, rrx) = oneshot::channel();
        {
            let outbound = self.inner.outbound.lock().unwrap();
            let Some(tx) = outbound.get(session_id) else {
                return Err(format!("no active session: {session_id}"));
            };
            self.inner.pending.lock().unwrap().insert(req_id.clone(), rtx);
            if tx.send(Message::Text(Utf8Bytes::from(frame))).is_err() {
                self.inner.pending.lock().unwrap().remove(&req_id);
                return Err("session connection closed".into());
            }
        }

        match tokio::time::timeout(Duration::from_secs(10), rrx).await {
            Ok(Ok(v)) => Ok(v),
            _ => {
                self.inner.pending.lock().unwrap().remove(&req_id);
                Err("command timed out".into())
            }
        }
    }
}
