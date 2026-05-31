//! pm/ project-manager store — workspaces + API keys (M5, ADR-0009).
//!
//! A SQLite DB (`pm.db`) separate from the event store's `collector.db`. Ports
//! `packages/collector/src/pm/pm-store.ts` (workspace + API-key layer first;
//! projects/tasks/sessions land as M5 widens).
//!
//! Unlike the event store (hot-path → dedicated owner thread), pm/ ops are
//! low-frequency (workspace CRUD + auth key lookup), so a shared
//! `Arc<Mutex<Connection>>` accessed inline is the right weight. IDs use SQLite's
//! `randomblob` CSPRNG (no extra RNG dep); API keys are stored as a SHA-256 hash
//! of the raw token (the raw `tk_…` is returned exactly once, like Node).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS pm_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pm_api_keys (
  key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  key_prefix TEXT,
  key_last4 TEXT,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS pm_projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  name TEXT NOT NULL,
  path TEXT,
  claude_project_key TEXT,
  runtimescope_project TEXT,
  phase TEXT NOT NULL DEFAULT 'preliminary',
  management_authorized INTEGER NOT NULL DEFAULT 0,
  probable_to_complete INTEGER NOT NULL DEFAULT 0,
  project_status TEXT NOT NULL DEFAULT 'active',
  category TEXT,
  sdk_installed INTEGER NOT NULL DEFAULT 0,
  runtime_apps TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS pm_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  jsonl_path TEXT NOT NULL,
  jsonl_size INTEGER,
  first_prompt TEXT,
  summary TEXT,
  slug TEXT,
  model TEXT,
  version TEXT,
  git_branch TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  user_message_count INTEGER NOT NULL DEFAULT 0,
  assistant_message_count INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_microdollars INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  active_minutes REAL NOT NULL DEFAULT 0,
  compaction_count INTEGER NOT NULL DEFAULT 0,
  pre_compaction_tokens INTEGER,
  permission_mode TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_sessions_project ON pm_sessions(project_id);
CREATE TABLE IF NOT EXISTS pm_capex_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'expensed',
  work_type TEXT,
  active_minutes REAL NOT NULL DEFAULT 0,
  cost_microdollars INTEGER NOT NULL DEFAULT 0,
  adjustment_factor REAL NOT NULL DEFAULT 1.0,
  adjusted_cost_microdollars INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  confirmed_at INTEGER,
  confirmed_by TEXT,
  notes TEXT,
  period TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_capex_project ON pm_capex_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_pm_capex_period ON pm_capex_entries(period);
CREATE INDEX IF NOT EXISTS idx_pm_capex_confirmed ON pm_capex_entries(confirmed);
CREATE TABLE IF NOT EXISTS pm_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pm_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  labels TEXT,
  source TEXT DEFAULT 'manual',
  source_ref TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  assigned_to TEXT,
  due_date TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS pm_deleted_projects (
  path TEXT PRIMARY KEY,
  name TEXT,
  deleted_at INTEGER NOT NULL
);
";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmWorkspace {
    pub id: String,
    pub name: String,
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_default: bool,
}

#[derive(Clone, Debug)]
pub struct PmApiKey {
    /// Raw secret — populated ONLY by `create_api_key`'s return; blank on reads.
    pub key: String,
    pub key_prefix: String,
    pub key_last4: String,
    pub workspace_id: String,
    pub label: String,
    pub created_at: i64,
    pub expires_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmProject {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_project_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtimescope_project: Option<String>,
    pub phase: String,
    pub project_status: String,
    pub sdk_installed: bool,
    /// JSON-encoded array of runtime app names (mirrors Node's `runtime_apps` TEXT column).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_apps: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A parsed/indexed Claude session row (the parser's metrics + file bookkeeping).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmSession {
    pub id: String,
    pub project_id: String,
    pub jsonl_path: String,
    pub jsonl_size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    pub message_count: i64,
    pub user_message_count: i64,
    pub assistant_message_count: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_creation_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub cost_microdollars: i64,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    pub active_minutes: f64,
    pub compaction_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_compaction_tokens: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A CapEx (capital-expenditure) ledger entry for a session (ports Node
/// `PmCapexEntry`). Stubs default to `expensed`/unconfirmed with a 1.0 factor.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmCapexEntry {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub classification: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_type: Option<String>,
    pub active_minutes: f64,
    pub cost_microdollars: i64,
    pub adjustment_factor: f64,
    pub adjusted_cost_microdollars: i64,
    pub confirmed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub period: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// SHA-256 hex of a raw API token (matches Node `hashApiKey`).
pub fn hash_api_key(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

/// Node's slug derivation: lowercase, runs of non-`[a-z0-9-]` → a single `-`,
/// collapse repeats, trim leading/trailing `-`.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

#[derive(Clone, Debug)]
pub struct PmStore {
    conn: Arc<Mutex<Connection>>,
}

impl PmStore {
    /// Open (creating) `pm.db` at `path`, run the schema, ensure the default
    /// "Personal" workspace exists.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        let store = PmStore { conn: Arc::new(Mutex::new(conn)) };
        store.ensure_default_workspace()?;
        Ok(store)
    }

    fn ensure_default_workspace(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<String> = conn
            .query_row("SELECT id FROM pm_workspaces WHERE is_default = 1", [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if existing.is_none() {
            let id = gen_id(&conn, "ws_", 8);
            let now = now_ms();
            conn.execute(
                "INSERT INTO pm_workspaces (id, name, slug, description, is_default, created_at, updated_at)
                 VALUES (?1, 'Personal', 'personal', 'Your personal workspace', 1, ?2, ?2)",
                params![id, now],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Workspaces, default-first then name-ASC (matches Node listWorkspaces).
    pub fn list_workspaces(&self) -> Vec<PmWorkspace> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, name, slug, description, is_default, created_at, updated_at
             FROM pm_workspaces ORDER BY is_default DESC, name ASC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], map_workspace);
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// Projects (empty until project-discovery is ported). Used for per-workspace
    /// project counts in list_workspaces.
    pub fn list_projects(&self) -> Vec<PmProject> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(&format!("SELECT {PROJECT_COLS} FROM pm_projects")) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], map_project);
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// Insert or merge a project. New projects without a workspace go to the
    /// default; existing keep theirs. `path`/`claude_project_key`/`runtimescope_project`
    /// COALESCE (new value wins only when non-null); `sdk_installed` is sticky-true.
    /// Ports Node `upsertProject`.
    pub fn upsert_project(&self, p: &PmProject) {
        let conn = self.conn.lock().unwrap();
        let workspace_id: Option<String> = p.workspace_id.clone().or_else(|| {
            conn.query_row("SELECT id FROM pm_workspaces WHERE is_default = 1 LIMIT 1", [], |r| r.get(0))
                .optional()
                .ok()
                .flatten()
        });
        let phase = if p.phase.is_empty() { "application_development" } else { &p.phase };
        let status = if p.project_status.is_empty() { "active" } else { &p.project_status };
        let _ = conn.execute(
            "INSERT INTO pm_projects (id, workspace_id, name, path, claude_project_key, runtimescope_project,
               phase, project_status, sdk_installed, runtime_apps, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
               workspace_id = COALESCE(pm_projects.workspace_id, excluded.workspace_id),
               name = excluded.name,
               path = COALESCE(excluded.path, pm_projects.path),
               claude_project_key = COALESCE(excluded.claude_project_key, pm_projects.claude_project_key),
               runtimescope_project = COALESCE(excluded.runtimescope_project, pm_projects.runtimescope_project),
               sdk_installed = CASE WHEN excluded.sdk_installed = 1 THEN 1 ELSE pm_projects.sdk_installed END,
               runtime_apps = COALESCE(excluded.runtime_apps, pm_projects.runtime_apps),
               updated_at = excluded.updated_at",
            params![
                p.id, workspace_id, p.name, p.path, p.claude_project_key, p.runtimescope_project,
                phase, status, p.sdk_installed as i64, p.runtime_apps, p.created_at, p.updated_at
            ],
        );
    }

    /// Insert or replace a session row (ports Node `upsertSession`).
    pub fn upsert_session(&self, s: &PmSession) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO pm_sessions (id, project_id, jsonl_path, jsonl_size, first_prompt, summary,
               slug, model, version, git_branch, permission_mode, message_count, user_message_count,
               assistant_message_count, total_input_tokens, total_output_tokens, total_cache_creation_tokens,
               total_cache_read_tokens, cost_microdollars, started_at, ended_at, active_minutes,
               compaction_count, pre_compaction_tokens, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)",
            params![
                s.id, s.project_id, s.jsonl_path, s.jsonl_size, s.first_prompt, s.summary,
                s.slug, s.model, s.version, s.git_branch, s.permission_mode, s.message_count,
                s.user_message_count, s.assistant_message_count, s.total_input_tokens, s.total_output_tokens,
                s.total_cache_creation_tokens, s.total_cache_read_tokens, s.cost_microdollars, s.started_at,
                s.ended_at, s.active_minutes, s.compaction_count, s.pre_compaction_tokens, s.created_at, s.updated_at
            ],
        );
    }

    /// The `jsonl_size` of a stored session (for the incremental "unchanged → skip"
    /// check), or `None` if not yet indexed.
    pub fn session_jsonl_size(&self, id: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT jsonl_size FROM pm_sessions WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    /// Has this path been explicitly deleted (the discovery blocklist)?
    pub fn is_deleted_path(&self, path: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT 1 FROM pm_deleted_projects WHERE path = ?1", params![path], |_| Ok(()))
            .optional()
            .map(|o| o.is_some())
            .unwrap_or(false)
    }

    /// Resolve a raw `tk_…` API token to its (non-revoked, non-expired) workspace
    /// — the WS-handshake auth path. Hashes the token (SHA-256) and looks it up;
    /// best-effort bumps `last_used_at`. Ports Node `getWorkspaceByApiKey`.
    pub fn get_workspace_by_api_key(&self, raw: &str) -> Option<PmWorkspace> {
        if raw.is_empty() {
            return None;
        }
        let hash = hash_api_key(raw);
        let now = now_ms();
        let conn = self.conn.lock().unwrap();
        let ws = conn
            .query_row(
                "SELECT w.id, w.name, w.slug, w.description, w.is_default, w.created_at, w.updated_at
                 FROM pm_api_keys k JOIN pm_workspaces w ON w.id = k.workspace_id
                 WHERE k.key = ?1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?2)",
                params![hash, now],
                map_workspace,
            )
            .optional()
            .ok()
            .flatten();
        if ws.is_some() {
            let _ = conn.execute("UPDATE pm_api_keys SET last_used_at = ?2 WHERE key = ?1", params![hash, now]);
        }
        ws
    }

    pub fn get_session(&self, id: &str) -> Option<PmSession> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {SESSION_COLS} FROM pm_sessions WHERE id = ?1"), params![id], map_session)
            .optional()
            .ok()
            .flatten()
    }

    /// Sessions, newest-first by `started_at`, optionally scoped to a project,
    /// with limit/offset (ports Node `listSessions`).
    pub fn list_sessions(&self, project_id: Option<&str>, limit: i64, offset: i64) -> Vec<PmSession> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(&format!(
            "SELECT {SESSION_COLS} FROM pm_sessions WHERE (?1 IS NULL OR project_id = ?1)
             ORDER BY started_at DESC LIMIT ?2 OFFSET ?3"
        )) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![project_id, limit, offset], map_session);
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// Aggregate session stats, optionally scoped to a project (ports the core of
    /// Node `getSessionStats`).
    pub fn session_stats(&self, project_id: Option<&str>) -> SessionStats {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(active_minutes),0), COALESCE(SUM(cost_microdollars),0),
                    COALESCE(SUM(total_input_tokens),0), COALESCE(SUM(total_output_tokens),0),
                    COALESCE(AVG(active_minutes),0)
             FROM pm_sessions WHERE (?1 IS NULL OR project_id = ?1)",
            params![project_id],
            |r| {
                Ok(SessionStats {
                    total_sessions: r.get(0)?,
                    total_active_minutes: r.get(1)?,
                    total_cost_microdollars: r.get(2)?,
                    total_input_tokens: r.get(3)?,
                    total_output_tokens: r.get(4)?,
                    avg_active_minutes: r.get(5)?,
                })
            },
        )
        .unwrap_or_default()
    }

    /// Active (non-revoked) API keys for a workspace. The secret is masked.
    pub fn list_api_keys(&self, workspace_id: &str) -> Vec<PmApiKey> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT workspace_id, label, created_at, expires_at, key_prefix, key_last4
             FROM pm_api_keys WHERE workspace_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![workspace_id], |r| {
            Ok(PmApiKey {
                key: String::new(),
                key_prefix: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                key_last4: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                workspace_id: r.get(0)?,
                label: r.get(1)?,
                created_at: r.get(2)?,
                expires_at: r.get(3)?,
            })
        });
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    pub fn create_workspace(
        &self,
        name: &str,
        slug: Option<&str>,
        description: Option<&str>,
    ) -> Result<PmWorkspace, String> {
        let slug = slugify(slug.unwrap_or(name));
        if slug.is_empty() {
            return Err("Workspace slug cannot be empty".to_string());
        }
        let conn = self.conn.lock().unwrap();
        let dup: Option<String> = conn
            .query_row("SELECT id FROM pm_workspaces WHERE slug = ?1", params![slug], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if dup.is_some() {
            return Err(format!("Workspace with slug \"{slug}\" already exists"));
        }
        let id = gen_id(&conn, "ws_", 8);
        let now = now_ms();
        conn.execute(
            "INSERT INTO pm_workspaces (id, name, slug, description, is_default, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
            params![id, name, slug, description, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(PmWorkspace {
            id,
            name: name.to_string(),
            slug,
            description: description.map(String::from),
            created_at: now,
            updated_at: now,
            is_default: false,
        })
    }

    /// Create a workspace-scoped API key. Returns the raw `tk_…` secret ONCE; the
    /// DB stores only its SHA-256 hash + prefix + last4.
    pub fn create_api_key(
        &self,
        workspace_id: &str,
        label: &str,
        expires_at: Option<i64>,
    ) -> Result<PmApiKey, String> {
        let conn = self.conn.lock().unwrap();
        let exists: Option<String> = conn
            .query_row("SELECT id FROM pm_workspaces WHERE id = ?1", params![workspace_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_none() {
            return Err(format!("Workspace {workspace_id} does not exist"));
        }
        // tk_ + 24 random bytes hex (48 chars), via SQLite's CSPRNG.
        let raw: String = conn
            .query_row("SELECT 'tk_' || lower(hex(randomblob(24)))", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let hash = hash_api_key(&raw);
        let prefix = raw[..11].to_string();
        let last4 = raw[raw.len() - 4..].to_string();
        let now = now_ms();
        conn.execute(
            "INSERT INTO pm_api_keys (key, workspace_id, label, created_at, expires_at, key_prefix, key_last4)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![hash, workspace_id, label, now, expires_at, prefix, last4],
        )
        .map_err(|e| e.to_string())?;
        Ok(PmApiKey {
            key: raw,
            key_prefix: prefix,
            key_last4: last4,
            workspace_id: workspace_id.to_string(),
            label: label.to_string(),
            created_at: now,
            expires_at,
        })
    }

    pub fn get_project(&self, id: &str) -> Option<PmProject> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {PROJECT_COLS} FROM pm_projects WHERE id = ?1"), params![id], map_project)
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_project_workspace(&self, project_id: &str, workspace_id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE pm_projects SET workspace_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![project_id, workspace_id, now_ms()],
        );
    }

    // ============================================================
    // CapEx
    // ============================================================

    /// Insert/merge a CapEx ledger entry (ports Node `upsertCapexEntry`). On
    /// conflict, refreshes everything except `project_id`/`session_id`/`period`/
    /// `created_at` (those are stable for a given session stub).
    pub fn upsert_capex_entry(&self, e: &PmCapexEntry) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO pm_capex_entries (id, project_id, session_id, classification, work_type,
               active_minutes, cost_microdollars, adjustment_factor, adjusted_cost_microdollars,
               confirmed, confirmed_at, confirmed_by, notes, period, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET
               classification = excluded.classification,
               work_type = excluded.work_type,
               active_minutes = excluded.active_minutes,
               cost_microdollars = excluded.cost_microdollars,
               adjustment_factor = excluded.adjustment_factor,
               adjusted_cost_microdollars = excluded.adjusted_cost_microdollars,
               confirmed = excluded.confirmed,
               confirmed_at = excluded.confirmed_at,
               confirmed_by = excluded.confirmed_by,
               notes = excluded.notes,
               updated_at = excluded.updated_at",
            params![
                e.id, e.project_id, e.session_id, e.classification, e.work_type,
                e.active_minutes, e.cost_microdollars, e.adjustment_factor, e.adjusted_cost_microdollars,
                e.confirmed as i64, e.confirmed_at, e.confirmed_by, e.notes, e.period, e.created_at, e.updated_at
            ],
        );
    }

    /// Create/refresh the CapEx stub for a freshly-indexed session — mirrors Node
    /// `upsertCapexStub`: id `capex-<sessionId>`, `expensed`, unconfirmed, 1.0
    /// factor (so `adjustedCost == cost`), period = `YYYY-MM-DD` from `startedAt`.
    pub fn upsert_capex_stub(&self, session: &PmSession) {
        let now = now_ms();
        let entry = PmCapexEntry {
            id: format!("capex-{}", session.id),
            project_id: session.project_id.clone(),
            session_id: session.id.clone(),
            classification: "expensed".to_string(),
            work_type: None,
            active_minutes: session.active_minutes,
            cost_microdollars: session.cost_microdollars,
            adjustment_factor: 1.0,
            adjusted_cost_microdollars: session.cost_microdollars,
            confirmed: false,
            confirmed_at: None,
            confirmed_by: None,
            notes: None,
            period: crate::pm_discovery::to_period(session.started_at),
            created_at: now,
            updated_at: now,
        };
        self.upsert_capex_entry(&entry);
    }

    /// CapEx entries for a project, period-DESC then created_at-DESC (ports the
    /// core of Node `listCapexEntries`). Used by the capex-stub test.
    pub fn list_capex_entries(&self, project_id: &str) -> Vec<PmCapexEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(&format!(
            "SELECT {CAPEX_COLS} FROM pm_capex_entries WHERE project_id = ?1
             ORDER BY period DESC, created_at DESC"
        )) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![project_id], map_capex);
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    // ============================================================
    // Workspace write-CRUD (ports Node updateWorkspace/deleteWorkspace)
    // ============================================================

    /// Patch a workspace's `name`/`slug`/`description` (only the provided fields).
    /// Bumps `updated_at`. No-op when nothing is supplied. Ports Node `updateWorkspace`.
    pub fn update_workspace(
        &self,
        id: &str,
        name: Option<&str>,
        slug: Option<&str>,
        description: Option<&str>,
    ) {
        let mut sets: Vec<&str> = Vec::new();
        let mut vals: Vec<&dyn rusqlite::ToSql> = Vec::new();
        if let Some(n) = name.as_ref() {
            sets.push("name = ?");
            vals.push(n);
        }
        if let Some(sl) = slug.as_ref() {
            sets.push("slug = ?");
            vals.push(sl);
        }
        if let Some(d) = description.as_ref() {
            sets.push("description = ?");
            vals.push(d);
        }
        if sets.is_empty() {
            return;
        }
        let now = now_ms();
        sets.push("updated_at = ?");
        vals.push(&now);
        vals.push(&id);
        let sql = format!("UPDATE pm_workspaces SET {} WHERE id = ?", sets.join(", "));
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(&sql, rusqlite::params_from_iter(vals));
    }

    /// Delete a workspace, reassigning its projects to the default and wiping its
    /// API keys. Rejects deleting the default. Ports Node `deleteWorkspace`.
    pub fn delete_workspace(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let is_default: Option<i64> = conn
            .query_row("SELECT is_default FROM pm_workspaces WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        // Node: getWorkspace(id) → if !ws return (silent no-op).
        let Some(is_default) = is_default else { return Ok(()) };
        if is_default == 1 {
            return Err("Cannot delete the default workspace".to_string());
        }
        let default_id: String = conn
            .query_row("SELECT id FROM pm_workspaces WHERE is_default = 1 LIMIT 1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE pm_projects SET workspace_id = ?1 WHERE workspace_id = ?2",
            params![default_id, id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM pm_api_keys WHERE workspace_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM pm_workspaces WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============================================================
    // API-key write-CRUD (ports Node revokeApiKey/findApiKeyByPrefix)
    // ============================================================

    /// Revoke an API key by its public prefix (`tk_########`). Ports Node `revokeApiKey`.
    pub fn revoke_api_key(&self, prefix: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE pm_api_keys SET revoked_at = ?2 WHERE key_prefix = ?1",
            params![prefix, now_ms()],
        );
    }

    /// Look up a non-revoked API key by its public prefix (for per-workspace authz
    /// on the revoke route). Ports Node `findApiKeyByPrefix`. The raw secret is
    /// never returned (it's the hash); `key` is blank.
    pub fn find_api_key_by_prefix(&self, prefix: &str) -> Option<PmApiKey> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT workspace_id, label, created_at, expires_at, key_prefix, key_last4
             FROM pm_api_keys WHERE key_prefix = ?1 AND revoked_at IS NULL LIMIT 1",
            params![prefix],
            |r| {
                Ok(PmApiKey {
                    key: String::new(),
                    key_prefix: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    key_last4: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    workspace_id: r.get(0)?,
                    label: r.get(1)?,
                    created_at: r.get(2)?,
                    expires_at: r.get(3)?,
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    }

    // ============================================================
    // Project write-CRUD (ports Node updateProject/deleteProject)
    // ============================================================

    /// Patch a project's mutable PM fields (only the provided ones), bumping
    /// `updated_at`. Mirrors the subset Node's `updateProject` sets that round-trip
    /// through our `PmProject` shape: name, phase, projectStatus, sdkInstalled,
    /// runtimeApps, runtimescopeProject. No-op when nothing is supplied.
    #[allow(clippy::too_many_arguments)]
    pub fn update_project(
        &self,
        id: &str,
        name: Option<&str>,
        phase: Option<&str>,
        project_status: Option<&str>,
        sdk_installed: Option<bool>,
        runtime_apps: Option<&str>,
        runtimescope_project: Option<&str>,
        management_authorized: Option<bool>,
        probable_to_complete: Option<bool>,
    ) {
        let mut sets: Vec<String> = Vec::new();
        let mut vals: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(v) = name {
            sets.push("name = ?".into());
            vals.push(Box::new(v.to_string()));
        }
        if let Some(v) = phase {
            sets.push("phase = ?".into());
            vals.push(Box::new(v.to_string()));
        }
        if let Some(v) = project_status {
            sets.push("project_status = ?".into());
            vals.push(Box::new(v.to_string()));
        }
        if let Some(v) = sdk_installed {
            sets.push("sdk_installed = ?".into());
            vals.push(Box::new(v as i64));
        }
        if let Some(v) = runtime_apps {
            sets.push("runtime_apps = ?".into());
            vals.push(Box::new(v.to_string()));
        }
        if let Some(v) = runtimescope_project {
            sets.push("runtimescope_project = ?".into());
            vals.push(Box::new(v.to_string()));
        }
        if let Some(v) = management_authorized {
            sets.push("management_authorized = ?".into());
            vals.push(Box::new(v as i64));
        }
        if let Some(v) = probable_to_complete {
            sets.push("probable_to_complete = ?".into());
            vals.push(Box::new(v as i64));
        }
        if sets.is_empty() {
            return;
        }
        sets.push("updated_at = ?".into());
        vals.push(Box::new(now_ms()));
        vals.push(Box::new(id.to_string()));
        let sql = format!("UPDATE pm_projects SET {} WHERE id = ?", sets.join(", "));
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(&sql, rusqlite::params_from_iter(vals.iter().map(|b| &**b)));
    }

    /// Delete a project + blocklist its path/claudeProjectKey so discovery won't
    /// re-import, then cascade-delete its capex/notes/tasks/sessions rows. No-op
    /// if the project doesn't exist. Ports Node `deleteProject`.
    pub fn delete_project(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        let row: Option<(Option<String>, Option<String>, String)> = conn
            .query_row(
                "SELECT path, claude_project_key, name FROM pm_projects WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .ok()
            .flatten();
        let Some((path, claude_key, name)) = row else { return };
        let now = now_ms();
        if let Some(p) = path.as_ref() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO pm_deleted_projects (path, name, deleted_at) VALUES (?1, ?2, ?3)",
                params![p, name, now],
            );
        }
        if let Some(k) = claude_key.as_ref() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO pm_deleted_projects (path, name, deleted_at) VALUES (?1, ?2, ?3)",
                params![k, name, now],
            );
        }
        let _ = conn.execute("DELETE FROM pm_capex_entries WHERE project_id = ?1", params![id]);
        let _ = conn.execute("DELETE FROM pm_notes WHERE project_id = ?1", params![id]);
        let _ = conn.execute("DELETE FROM pm_tasks WHERE project_id = ?1", params![id]);
        let _ = conn.execute("DELETE FROM pm_sessions WHERE project_id = ?1", params![id]);
        let _ = conn.execute("DELETE FROM pm_projects WHERE id = ?1", params![id]);
    }
}

/// Generate a `<prefix><n bytes hex>` id via SQLite's `randomblob` CSPRNG.
fn gen_id(conn: &Connection, prefix: &str, bytes: u32) -> String {
    conn.query_row(
        &format!("SELECT '{prefix}' || lower(hex(randomblob({bytes})))"),
        [],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| format!("{prefix}00000000"))
}

/// Aggregate session stats (core of Node `SessionStats`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub total_sessions: i64,
    pub total_active_minutes: f64,
    pub total_cost_microdollars: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub avg_active_minutes: f64,
}

const SESSION_COLS: &str = "id, project_id, jsonl_path, jsonl_size, first_prompt, summary, slug, model, \
    version, git_branch, permission_mode, message_count, user_message_count, assistant_message_count, \
    total_input_tokens, total_output_tokens, total_cache_creation_tokens, total_cache_read_tokens, \
    cost_microdollars, started_at, ended_at, active_minutes, compaction_count, pre_compaction_tokens, \
    created_at, updated_at";

fn map_session(r: &rusqlite::Row) -> rusqlite::Result<PmSession> {
    Ok(PmSession {
        id: r.get(0)?,
        project_id: r.get(1)?,
        jsonl_path: r.get(2)?,
        jsonl_size: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
        first_prompt: r.get(4)?,
        summary: r.get(5)?,
        slug: r.get(6)?,
        model: r.get(7)?,
        version: r.get(8)?,
        git_branch: r.get(9)?,
        permission_mode: r.get(10)?,
        message_count: r.get(11)?,
        user_message_count: r.get(12)?,
        assistant_message_count: r.get(13)?,
        total_input_tokens: r.get(14)?,
        total_output_tokens: r.get(15)?,
        total_cache_creation_tokens: r.get(16)?,
        total_cache_read_tokens: r.get(17)?,
        cost_microdollars: r.get(18)?,
        started_at: r.get(19)?,
        ended_at: r.get(20)?,
        active_minutes: r.get(21)?,
        compaction_count: r.get(22)?,
        pre_compaction_tokens: r.get(23)?,
        created_at: r.get(24)?,
        updated_at: r.get(25)?,
    })
}

/// Column list (and order) shared by `list_projects`/`get_project` ↔ `map_project`.
const PROJECT_COLS: &str = "id, workspace_id, name, path, claude_project_key, runtimescope_project, \
                            phase, project_status, sdk_installed, runtime_apps, created_at, updated_at";

fn map_project(r: &rusqlite::Row) -> rusqlite::Result<PmProject> {
    Ok(PmProject {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        name: r.get(2)?,
        path: r.get(3)?,
        claude_project_key: r.get(4)?,
        runtimescope_project: r.get(5)?,
        phase: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
        project_status: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
        sdk_installed: r.get::<_, i64>(8)? == 1,
        runtime_apps: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
    })
}

const CAPEX_COLS: &str = "id, project_id, session_id, classification, work_type, active_minutes, \
    cost_microdollars, adjustment_factor, adjusted_cost_microdollars, confirmed, confirmed_at, \
    confirmed_by, notes, period, created_at, updated_at";

fn map_capex(r: &rusqlite::Row) -> rusqlite::Result<PmCapexEntry> {
    Ok(PmCapexEntry {
        id: r.get(0)?,
        project_id: r.get(1)?,
        session_id: r.get(2)?,
        classification: r.get(3)?,
        work_type: r.get(4)?,
        active_minutes: r.get(5)?,
        cost_microdollars: r.get(6)?,
        adjustment_factor: r.get(7)?,
        adjusted_cost_microdollars: r.get(8)?,
        confirmed: r.get::<_, i64>(9)? == 1,
        confirmed_at: r.get(10)?,
        confirmed_by: r.get(11)?,
        notes: r.get(12)?,
        period: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

fn map_workspace(r: &rusqlite::Row) -> rusqlite::Result<PmWorkspace> {
    Ok(PmWorkspace {
        id: r.get(0)?,
        name: r.get(1)?,
        slug: r.get(2)?,
        description: r.get(3)?,
        is_default: r.get::<_, i64>(4)? == 1,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> PmStore {
        // Unique per call — ms resolution collides when tests run in parallel.
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pmstore-{}-{nanos}-{seq}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        PmStore::open(&dir.join("pm.db")).unwrap()
    }

    #[test]
    fn fresh_store_has_one_personal_workspace() {
        let s = tmp_store();
        let ws = s.list_workspaces();
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].name, "Personal");
        assert_eq!(ws[0].slug, "personal");
        assert!(ws[0].is_default);
        assert!(ws[0].id.starts_with("ws_"));
    }

    #[test]
    fn create_workspace_derives_slug_and_rejects_dup() {
        let s = tmp_store();
        let ws = s.create_workspace("Work Stuff", None, None).unwrap();
        assert_eq!(ws.slug, "work-stuff");
        assert!(!ws.is_default);
        // Duplicate slug (the default's "personal") is rejected.
        let err = s.create_workspace("Personal", None, None).unwrap_err();
        assert_eq!(err, "Workspace with slug \"personal\" already exists");
    }

    #[test]
    fn get_workspace_by_api_key_validates_token() {
        let s = tmp_store();
        let ws_id = s.list_workspaces()[0].id.clone();
        let k = s.create_api_key(&ws_id, "auth", None).unwrap();
        // valid raw token → its workspace
        let resolved = s.get_workspace_by_api_key(&k.key).expect("valid key resolves");
        assert_eq!(resolved.id, ws_id);
        // bogus / empty → None
        assert!(s.get_workspace_by_api_key("tk_not_a_real_key").is_none());
        assert!(s.get_workspace_by_api_key("").is_none());
        // expired key → None
        let expired = s.create_api_key(&ws_id, "old", Some(1)).unwrap(); // expires_at = 1ms epoch (past)
        assert!(s.get_workspace_by_api_key(&expired.key).is_none());
    }

    #[test]
    fn create_api_key_returns_secret_once_and_masks_on_list() {
        let s = tmp_store();
        let ws_id = s.list_workspaces()[0].id.clone();
        let k = s.create_api_key(&ws_id, "CI", None).unwrap();
        assert!(k.key.starts_with("tk_"));
        assert_eq!(k.key.len(), 51); // tk_ + 48 hex
        assert_eq!(k.key_prefix, k.key[..11]);
        assert_eq!(k.key_last4, k.key[k.key.len() - 4..]);
        // Listed keys are masked (no raw secret) but counted.
        let keys = s.list_api_keys(&ws_id);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].key, "");
        assert_eq!(keys[0].key_prefix, k.key_prefix);
        // Unknown workspace is rejected.
        assert!(s.create_api_key("ws_nope", "x", None).is_err());
    }

    fn sample_session(id: &str, project_id: &str) -> PmSession {
        PmSession {
            id: id.to_string(),
            project_id: project_id.to_string(),
            jsonl_path: "/tmp/x.jsonl".to_string(),
            started_at: 1_704_067_200_000, // 2024-01-01T00:00:00Z (period via LOCAL tz)
            active_minutes: 42.5,
            cost_microdollars: 1_234_567,
            ..Default::default()
        }
    }

    #[test]
    fn upsert_capex_stub_defaults_match_node() {
        let s = tmp_store();
        let sess = sample_session("sess-abc", "proj-1");
        s.upsert_capex_stub(&sess);

        let entries = s.list_capex_entries("proj-1");
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        // id is `capex-<sessionId>` (Node: `capex-${session.id}`)
        assert_eq!(e.id, "capex-sess-abc");
        assert_eq!(e.session_id, "sess-abc");
        assert_eq!(e.project_id, "proj-1");
        // Node stub defaults
        assert_eq!(e.classification, "expensed");
        assert!(!e.confirmed);
        assert!(e.confirmed_at.is_none());
        assert!(e.confirmed_by.is_none());
        assert!(e.work_type.is_none());
        assert!(e.notes.is_none());
        assert_eq!(e.adjustment_factor, 1.0);
        // factor 1.0 → adjusted == cost == session.costMicrodollars
        assert_eq!(e.cost_microdollars, 1_234_567);
        assert_eq!(e.adjusted_cost_microdollars, 1_234_567);
        assert_eq!(e.active_minutes, 42.5);
        // period is YYYY-MM-DD (to_period uses LOCAL tz, like Node toPeriod)
        let expected_period = crate::pm_discovery::to_period(sess.started_at);
        assert_eq!(e.period, expected_period);
        assert_eq!(expected_period.len(), 10); // YYYY-MM-DD

        // Idempotent re-stub with new metrics overwrites cost/adjusted but keeps id.
        let mut sess2 = sample_session("sess-abc", "proj-1");
        sess2.cost_microdollars = 9_000_000;
        sess2.active_minutes = 100.0;
        s.upsert_capex_stub(&sess2);
        let after = s.list_capex_entries("proj-1");
        assert_eq!(after.len(), 1, "same id → upsert, not insert");
        assert_eq!(after[0].cost_microdollars, 9_000_000);
        assert_eq!(after[0].adjusted_cost_microdollars, 9_000_000);
        assert_eq!(after[0].active_minutes, 100.0);
    }

    #[test]
    fn update_workspace_patches_provided_fields_only() {
        let s = tmp_store();
        let ws = s.create_workspace("Old Name", Some("old-slug"), Some("desc")).unwrap();
        // Patch only the name; slug + description unchanged.
        s.update_workspace(&ws.id, Some("New Name"), None, None);
        let got = s.list_workspaces().into_iter().find(|w| w.id == ws.id).unwrap();
        assert_eq!(got.name, "New Name");
        assert_eq!(got.slug, "old-slug");
        assert_eq!(got.description.as_deref(), Some("desc"));
    }

    #[test]
    fn delete_workspace_rejects_default_and_reassigns_projects() {
        let s = tmp_store();
        let default_id = s.list_workspaces()[0].id.clone();
        // Default rejected.
        assert_eq!(
            s.delete_workspace(&default_id).unwrap_err(),
            "Cannot delete the default workspace"
        );
        // Create a workspace + a project in it + a key.
        let ws = s.create_workspace("Temp", None, None).unwrap();
        let mut proj = PmProject {
            id: "p1".into(),
            name: "p1".into(),
            workspace_id: Some(ws.id.clone()),
            phase: "application_development".into(),
            project_status: "active".into(),
            ..Default::default()
        };
        proj.created_at = now_ms();
        proj.updated_at = now_ms();
        s.upsert_project(&proj);
        s.create_api_key(&ws.id, "k", None).unwrap();
        // Delete → project reassigned to default, keys gone, workspace gone.
        s.delete_workspace(&ws.id).unwrap();
        assert!(s.list_workspaces().iter().all(|w| w.id != ws.id));
        let p = s.get_project("p1").unwrap();
        assert_eq!(p.workspace_id.as_deref(), Some(default_id.as_str()));
        assert!(s.list_api_keys(&ws.id).is_empty());
        // Deleting an unknown workspace is a silent no-op (matches Node).
        assert!(s.delete_workspace("ws_nope").is_ok());
    }

    #[test]
    fn revoke_api_key_by_prefix_hides_from_list() {
        let s = tmp_store();
        let ws_id = s.list_workspaces()[0].id.clone();
        let k = s.create_api_key(&ws_id, "ci", None).unwrap();
        assert_eq!(s.list_api_keys(&ws_id).len(), 1);
        // findApiKeyByPrefix resolves the workspace for authz, raw secret masked.
        let found = s.find_api_key_by_prefix(&k.key_prefix).unwrap();
        assert_eq!(found.workspace_id, ws_id);
        assert_eq!(found.key, "");
        // Revoke → disappears from list + find returns None.
        s.revoke_api_key(&k.key_prefix);
        assert!(s.list_api_keys(&ws_id).is_empty());
        assert!(s.find_api_key_by_prefix(&k.key_prefix).is_none());
    }

    #[test]
    fn update_and_delete_project() {
        let s = tmp_store();
        let mut proj = PmProject {
            id: "p1".into(),
            name: "Original".into(),
            path: Some("/tmp/p1".into()),
            claude_project_key: Some("-tmp-p1".into()),
            phase: "application_development".into(),
            project_status: "active".into(),
            ..Default::default()
        };
        proj.created_at = now_ms();
        proj.updated_at = now_ms();
        s.upsert_project(&proj);
        // Seed a capex stub so cascade-delete is observable.
        s.upsert_capex_stub(&sample_session("s1", "p1"));
        assert_eq!(s.list_capex_entries("p1").len(), 1);

        // Patch phase + status only.
        s.update_project("p1", None, Some("maintenance"), Some("paused"), None, None, None, None, None);
        let g = s.get_project("p1").unwrap();
        assert_eq!(g.phase, "maintenance");
        assert_eq!(g.project_status, "paused");
        assert_eq!(g.name, "Original"); // untouched

        // Delete → gone, capex cascaded, path + key blocklisted.
        s.delete_project("p1");
        assert!(s.get_project("p1").is_none());
        assert!(s.list_capex_entries("p1").is_empty());
        assert!(s.is_deleted_path("/tmp/p1"));
        assert!(s.is_deleted_path("-tmp-p1"));
        // Deleting again is a no-op.
        s.delete_project("p1");
    }

    #[test]
    fn slugify_matches_node() {
        assert_eq!(slugify("Acme  Corp"), "acme-corp");
        assert_eq!(slugify("a--b"), "a-b");
        assert_eq!(slugify("Work_Stuff!"), "work-stuff");
        assert_eq!(slugify("--trim--"), "trim");
    }
}
