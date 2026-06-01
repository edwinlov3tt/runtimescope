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
  last_used_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES pm_workspaces(id) ON DELETE CASCADE
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
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES pm_projects(id)
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
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES pm_projects(id),
  FOREIGN KEY (session_id) REFERENCES pm_sessions(id)
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
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES pm_projects(id),
  FOREIGN KEY (session_id) REFERENCES pm_sessions(id)
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
  completed_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES pm_projects(id)
);
CREATE TABLE IF NOT EXISTS pm_deleted_projects (
  path TEXT PRIMARY KEY,
  name TEXT,
  deleted_at INTEGER NOT NULL
);
-- Managed dev servers (M5.5 Slice G). Keyed by project_id (one dev server per
-- project, like Node's in-memory map) but PERSISTED so a collector restart can
-- re-attach (liveness-check the pgid) instead of orphaning the real server, and
-- so GET tells the truth after a restart. Deliberately NOT FK'd to pm_projects:
-- the row's lifetime is tied to a live OS process group, not to the project row,
-- and we don't want re-attach/discovery ordering to trip the (now-ON) FK pragma.
CREATE TABLE IF NOT EXISTS pm_dev_servers (
  project_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  pgid INTEGER NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'starting',
  ports TEXT,
  container_local INTEGER NOT NULL DEFAULT 0,
  boot_time INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
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

/// Emit a JSON-string column (e.g. `runtime_apps`, task `labels`) as a real JSON
/// array. A `None`/malformed/empty string degrades to `[]`. Mirrors Node, which
/// `JSON.parse`s these columns on read (and the dashboard consumes them as arrays).
fn serialize_json_string_array<S: serde::Serializer>(
    v: &Option<String>,
    s: S,
) -> Result<S::Ok, S::Error> {
    use serde::Serialize;
    let arr: Vec<String> = v
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    arr.serialize(s)
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
    /// Stored as a JSON-string in SQLite but emitted as a real array over HTTP —
    /// Node `JSON.parse`s it on read and the dashboard consumes `runtimeApps` as
    /// `string[]` (`.length`, `.map(...)`). Serializing the raw string would
    /// double-encode it and break those consumers.
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "serialize_json_string_array")]
    pub runtime_apps: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Optional project category (Node's `category` column, set via the UI). Drives
    /// the `capex-all` / `categories` dashboard filters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

/// A persisted managed dev server (M5.5 Slice G). The `ports` column is a
/// JSON-encoded `[u16]`; `parsed_ports()` decodes it.
#[derive(Clone, Debug)]
pub struct DevServerRecord {
    pub project_id: String,
    pub pid: i64,
    pub pgid: i64,
    pub command: String,
    pub cwd: String,
    pub started_at: i64,
    pub status: String,
    /// JSON array string of bound ports (e.g. `"[3000,5173]"`), or `None`.
    pub ports: Option<String>,
    pub container_local: bool,
    /// System boot time (epoch secs) when spawned — re-attach only trusts a pgid
    /// from the CURRENT boot (a reboot recycles pgids → a stored pgid could name
    /// an unrelated process group). 0 = unknown (legacy row) → not re-attached.
    pub boot_time: i64,
}

impl DevServerRecord {
    /// Decode the `ports` JSON column to a `Vec<u16>` (empty on null/malformed).
    pub fn parsed_ports(&self) -> Vec<u16> {
        self.ports
            .as_deref()
            .and_then(|j| serde_json::from_str::<Vec<u16>>(j).ok())
            .unwrap_or_default()
    }
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

/// A kanban task (ports Node `PmTask`). `labels` is a JSON-array column emitted
/// as a real array (always present, default `[]`); the other `Option` fields are
/// omitted when null (Node's `?? undefined`).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmTask {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    #[serde(serialize_with = "serialize_json_string_array")]
    pub labels: Option<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    pub sort_order: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assigned_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
}

/// A pinned/freeform note (ports Node `PmNote`). `tags` is a JSON-array column
/// emitted as a real array; `projectId`/`sessionId` are omitted when null.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmNote {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub title: String,
    pub content: String,
    pub pinned: bool,
    #[serde(serialize_with = "serialize_json_string_array")]
    pub tags: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// CapEx summary for a project (ports Node `CapexSummary` / `getCapexSummary`).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapexSummary {
    pub project_id: String,
    /// `{ start, end }` only when a start/end filter was supplied (else omitted,
    /// matching Node's `period: … ? {…} : undefined`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period: Option<CapexPeriod>,
    pub total_sessions: i64,
    pub total_active_minutes: f64,
    pub total_cost_microdollars: i64,
    pub capitalizable_cost_microdollars: i64,
    pub expensed_cost_microdollars: i64,
    pub confirmed_count: i64,
    pub unconfirmed_count: i64,
    pub by_month: Vec<CapexByMonth>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapexPeriod {
    pub start: String,
    pub end: String,
}

/// Per-day rollup row (Node names the field `activeMinutes`; `period` is YYYY-MM-DD).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapexByMonth {
    pub period: String,
    pub capitalizable: i64,
    pub expensed: i64,
    pub active_minutes: f64,
}

/// SHA-256 hex of a raw API token (matches Node `hashApiKey`).
pub fn hash_api_key(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

/// Format 32 random lowercase-hex chars as a RFC-4122 UUID **v4** (version nibble
/// forced to `4`, variant nibble to `{8,9,a,b}`) — matches `crypto.randomUUID()`'s
/// shape so consumers that validate the UUID form accept Rust-minted task ids.
fn uuid_v4_from_hex(hex: &str) -> String {
    let c: Vec<char> = hex.chars().collect();
    if c.len() < 32 {
        return hex.to_string();
    }
    let variant = {
        let v = c[16].to_digit(16).unwrap_or(0);
        std::char::from_digit((v & 0x3) | 0x8, 16).unwrap_or('8')
    };
    let s: String = (0..32).map(|i| c[i]).collect();
    format!(
        "{}-{}-4{}-{}{}-{}",
        &s[0..8],
        &s[8..12],
        &s[13..16], // version forced to '4' via the literal above
        variant,
        &s[17..20],
        &s[20..32],
    )
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
        // Enforce the declared FK constraints — parity with Node, where
        // better-sqlite3 defaults `foreign_keys = ON` (rusqlite defaults OFF).
        // Set before the schema runs and outside any transaction.
        conn.pragma_update(None, "foreign_keys", true).map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        // Migrate a pre-existing pm_dev_servers (created before boot_time was added)
        // — CREATE IF NOT EXISTS won't add the column. Ignore "duplicate column".
        let _ = conn.execute("ALTER TABLE pm_dev_servers ADD COLUMN boot_time INTEGER NOT NULL DEFAULT 0", []);
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

    /// `list_sessions` with the date-range + `hide_empty` filters Node's CSV export
    /// uses (newest-first, no pagination). Ports `listSessions(pid, {limit, …})`.
    pub fn list_sessions_filtered(
        &self,
        project_id: Option<&str>,
        start_date: Option<&str>,
        end_date: Option<&str>,
        hide_empty: bool,
    ) -> Vec<PmSession> {
        let conn = self.conn.lock().unwrap();
        let mut conds: Vec<String> = Vec::new();
        let mut vals: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(p) = project_id {
            conds.push("project_id = ?".into());
            vals.push(Box::new(p.to_string()));
        }
        if let Some(ms) = start_date.and_then(date_start_ms) {
            conds.push("started_at >= ?".into());
            vals.push(Box::new(ms));
        }
        if let Some(ms) = end_date.and_then(date_end_ms) {
            conds.push("started_at <= ?".into());
            vals.push(Box::new(ms));
        }
        if hide_empty {
            conds.push(nonempty_session_clause(""));
        }
        let where_sql = if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) };
        let sql = format!("SELECT {SESSION_COLS} FROM pm_sessions {where_sql} ORDER BY started_at DESC");
        let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
        let params_ref: Vec<&dyn rusqlite::ToSql> = vals.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(params_ref.iter().copied()), map_session);
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// Aggregate session stats, optionally scoped to a project (ports the core of
    /// Node `getSessionStats`).
    pub fn session_stats(&self, project_id: Option<&str>) -> SessionStats {
        self.session_stats_filtered(project_id, None, None, false)
    }

    /// Aggregate session stats with optional date-range + `hide_empty` filters,
    /// plus the per-model breakdown — ports Node `getSessionStats`.
    pub fn session_stats_filtered(
        &self,
        project_id: Option<&str>,
        start_date: Option<&str>,
        end_date: Option<&str>,
        hide_empty: bool,
    ) -> SessionStats {
        let conn = self.conn.lock().unwrap();
        let mut conds: Vec<String> = Vec::new();
        let mut vals: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(p) = project_id {
            conds.push("project_id = ?".into());
            vals.push(Box::new(p.to_string()));
        }
        if let Some(ms) = start_date.and_then(date_start_ms) {
            conds.push("started_at >= ?".into());
            vals.push(Box::new(ms));
        }
        if let Some(ms) = end_date.and_then(date_end_ms) {
            conds.push("started_at <= ?".into());
            vals.push(Box::new(ms));
        }
        if hide_empty {
            conds.push(nonempty_session_clause(""));
        }
        let where_sql = if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) };

        let totals_sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(active_minutes),0), COALESCE(SUM(cost_microdollars),0), \
             COALESCE(SUM(total_input_tokens),0), COALESCE(SUM(total_output_tokens),0), \
             COALESCE(AVG(active_minutes),0) FROM pm_sessions {where_sql}"
        );
        let params_ref: Vec<&dyn rusqlite::ToSql> = vals.iter().map(|b| b.as_ref()).collect();
        let mut stats = conn
            .query_row(&totals_sql, rusqlite::params_from_iter(params_ref.iter().copied()), |r| {
                Ok(SessionStats {
                    total_sessions: r.get(0)?,
                    total_active_minutes: r.get(1)?,
                    total_cost_microdollars: r.get(2)?,
                    total_input_tokens: r.get(3)?,
                    total_output_tokens: r.get(4)?,
                    avg_session_minutes: r.get(5)?,
                    model_breakdown: Vec::new(),
                })
            })
            .unwrap_or_default();

        // modelBreakdown: same filters + `model IS NOT NULL`, GROUP BY model, cost DESC.
        let mut model_conds = conds.clone();
        model_conds.push("model IS NOT NULL".into());
        let model_sql = format!(
            "SELECT model, COUNT(*) as sessions, COALESCE(SUM(cost_microdollars),0) as cost \
             FROM pm_sessions WHERE {} GROUP BY model ORDER BY cost DESC",
            model_conds.join(" AND ")
        );
        if let Ok(mut stmt) = conn.prepare(&model_sql) {
            let params_ref2: Vec<&dyn rusqlite::ToSql> = vals.iter().map(|b| b.as_ref()).collect();
            if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(params_ref2.iter().copied()), |r| {
                Ok(ModelBreakdown { model: r.get(0)?, sessions: r.get(1)?, cost: r.get(2)? })
            }) {
                stats.model_breakdown = rows.flatten().collect();
            }
        }
        stats
    }

    /// Per-project rollups for the dashboard home — ports Node `getProjectSummaries`.
    /// Returns **raw snake_case rows** (Node serves the SQL row verbatim, so
    /// `runtime_apps` stays a JSON string and `sdk_installed` an integer here).
    pub fn get_project_summaries(
        &self,
        start_date: Option<&str>,
        end_date: Option<&str>,
        hide_empty: bool,
    ) -> Vec<ProjectSummary> {
        let conn = self.conn.lock().unwrap();
        // Filters apply to the LEFT JOIN's ON clause (so projects with no matching
        // sessions still appear), matching Node.
        let mut join_conds: Vec<String> = Vec::new();
        let mut vals: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(ms) = start_date.and_then(date_start_ms) {
            join_conds.push("s.started_at >= ?".into());
            vals.push(Box::new(ms));
        }
        if let Some(ms) = end_date.and_then(date_end_ms) {
            join_conds.push("s.started_at <= ?".into());
            vals.push(Box::new(ms));
        }
        if hide_empty {
            join_conds.push(nonempty_session_clause("s."));
        }
        let on_extra = if join_conds.is_empty() { String::new() } else { format!("AND {}", join_conds.join(" AND ")) };
        let sql = format!(
            "SELECT p.id, p.name, p.path, p.category, p.sdk_installed, p.runtimescope_project, \
             p.runtime_apps, COUNT(s.id) as session_count, COALESCE(SUM(s.cost_microdollars),0) as total_cost, \
             COALESCE(SUM(s.active_minutes),0) as total_active_minutes, MAX(s.started_at) as last_session_at, \
             COALESCE(SUM(s.message_count),0) as total_messages \
             FROM pm_projects p LEFT JOIN pm_sessions s ON s.project_id = p.id {on_extra} \
             GROUP BY p.id ORDER BY last_session_at DESC"
        );
        let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
        let params_ref: Vec<&dyn rusqlite::ToSql> = vals.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(params_ref.iter().copied()), |r| {
            Ok(ProjectSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                path: r.get(2)?,
                category: r.get(3)?,
                sdk_installed: r.get(4)?,
                runtimescope_project: r.get(5)?,
                runtime_apps: r.get(6)?,
                session_count: r.get(7)?,
                total_cost: r.get(8)?,
                total_active_minutes: r.get(9)?,
                last_session_at: r.get(10)?,
                total_messages: r.get(11)?,
            })
        });
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
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
    // Dev servers (M5.5 Slice G) — persist + re-attach across restart.
    // ============================================================

    /// Upsert the managed dev-server row for a project (one per project).
    pub fn dev_server_upsert(&self, r: &DevServerRecord) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO pm_dev_servers
               (project_id, pid, pgid, command, cwd, started_at, status, ports, container_local, boot_time, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(project_id) DO UPDATE SET
               pid = excluded.pid, pgid = excluded.pgid, command = excluded.command,
               cwd = excluded.cwd, started_at = excluded.started_at, status = excluded.status,
               ports = excluded.ports, container_local = excluded.container_local,
               boot_time = excluded.boot_time, updated_at = excluded.updated_at",
            params![
                r.project_id, r.pid, r.pgid, r.command, r.cwd, r.started_at,
                r.status, r.ports, r.container_local as i64, r.boot_time, now_ms()
            ],
        );
    }

    /// Update just the live status + detected ports (called from the monitor).
    pub fn dev_server_update_status(&self, project_id: &str, status: &str, ports_json: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE pm_dev_servers SET status = ?2, ports = ?3, updated_at = ?4 WHERE project_id = ?1",
            params![project_id, status, ports_json, now_ms()],
        );
    }

    pub fn dev_server_get(&self, project_id: &str) -> Option<DevServerRecord> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT project_id, pid, pgid, command, cwd, started_at, status, ports, container_local, boot_time
             FROM pm_dev_servers WHERE project_id = ?1",
            params![project_id],
            map_dev_server,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn dev_server_delete(&self, project_id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM pm_dev_servers WHERE project_id = ?1", params![project_id]);
    }

    /// All persisted dev servers (for re-attach on startup).
    pub fn dev_server_list(&self) -> Vec<DevServerRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT project_id, pid, pgid, command, cwd, started_at, status, ports, container_local, boot_time
             FROM pm_dev_servers",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], map_dev_server);
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
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
               -- INTENTIONAL DIVERGENCE from Node (pm-store.ts upsertCapexEntry, which
               -- blindly overwrites these): once a user confirms an entry, re-indexing
               -- (which always re-stubs confirmed=false) must NOT revert it. Confirmation
               -- is financial audit state; preserve it once set. Gated by a Rust unit test.
               confirmed = CASE WHEN pm_capex_entries.confirmed = 1 THEN 1 ELSE excluded.confirmed END,
               confirmed_at = CASE WHEN pm_capex_entries.confirmed = 1 THEN pm_capex_entries.confirmed_at ELSE excluded.confirmed_at END,
               confirmed_by = CASE WHEN pm_capex_entries.confirmed = 1 THEN pm_capex_entries.confirmed_by ELSE excluded.confirmed_by END,
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

    /// Filtered capex list — ports Node `listCapexEntries(projectId, {month, confirmed})`.
    /// `month` is an exact `period` match (YYYY-MM-DD); `confirmed` filters on the flag.
    pub fn list_capex_entries_filtered(
        &self,
        project_id: &str,
        month: Option<&str>,
        confirmed: Option<bool>,
    ) -> Vec<PmCapexEntry> {
        let conn = self.conn.lock().unwrap();
        let confirmed_i = confirmed.map(i64::from);
        let mut sql = format!("SELECT {CAPEX_COLS} FROM pm_capex_entries WHERE project_id = ?");
        let mut vals: Vec<&dyn rusqlite::ToSql> = vec![&project_id];
        if let Some(m) = month.as_ref() {
            sql.push_str(" AND period = ?");
            vals.push(m);
        }
        if let Some(ci) = confirmed_i.as_ref() {
            sql.push_str(" AND confirmed = ?");
            vals.push(ci);
        }
        sql.push_str(" ORDER BY period DESC, created_at DESC");
        let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
        let rows = stmt.query_map(rusqlite::params_from_iter(vals), map_capex);
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// Partial-update a capex entry — ports Node `updateCapexEntry`. Only the
    /// supplied fields are written; `adjusted_cost` is recomputed only when BOTH
    /// `adjustment_factor` and `cost_microdollars` are provided (Node's quirk).
    /// No-op when nothing is supplied.
    pub fn update_capex_entry(
        &self,
        id: &str,
        classification: Option<&str>,
        work_type: Option<&str>,
        adjustment_factor: Option<f64>,
        cost_microdollars: Option<i64>,
        notes: Option<&str>,
    ) {
        let mut sets: Vec<&str> = Vec::new();
        let mut vals: Vec<&dyn rusqlite::ToSql> = Vec::new();
        if let Some(c) = classification.as_ref() {
            sets.push("classification = ?");
            vals.push(c);
        }
        if let Some(w) = work_type.as_ref() {
            sets.push("work_type = ?");
            vals.push(w);
        }
        // Reuse the parser's js_round (half-up + non-finite guard) so the recompute
        // rounds identically and can't produce a garbage cost from inf/NaN inputs.
        let adjusted = match (adjustment_factor, cost_microdollars) {
            (Some(f), Some(c)) => Some(crate::pm_session_parser::js_round((c as f64) * f)),
            _ => None,
        };
        if let Some(f) = adjustment_factor.as_ref() {
            sets.push("adjustment_factor = ?");
            vals.push(f);
            if let Some(a) = adjusted.as_ref() {
                sets.push("adjusted_cost_microdollars = ?");
                vals.push(a);
            }
        }
        if let Some(n) = notes.as_ref() {
            sets.push("notes = ?");
            vals.push(n);
        }
        if sets.is_empty() {
            return;
        }
        let now = now_ms();
        sets.push("updated_at = ?");
        vals.push(&now);
        vals.push(&id);
        let sql = format!("UPDATE pm_capex_entries SET {} WHERE id = ?", sets.join(", "));
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(&sql, rusqlite::params_from_iter(vals));
    }

    /// Mark a capex entry confirmed — ports Node `confirmCapexEntry`.
    pub fn confirm_capex_entry(&self, id: &str, confirmed_by: Option<&str>) {
        let now = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE pm_capex_entries SET confirmed = 1, confirmed_at = ?1, confirmed_by = ?2, updated_at = ?3 WHERE id = ?4",
            params![now, confirmed_by, now, id],
        );
    }

    /// Aggregate capex summary for a project — ports Node `getCapexSummary`.
    pub fn get_capex_summary(
        &self,
        project_id: &str,
        start_date: Option<&str>,
        end_date: Option<&str>,
    ) -> CapexSummary {
        let conn = self.conn.lock().unwrap();
        let mut where_sql = String::from("project_id = ?");
        let mut vals: Vec<&dyn rusqlite::ToSql> = vec![&project_id];
        if let Some(s) = start_date.as_ref() {
            where_sql.push_str(" AND period >= ?");
            vals.push(s);
        }
        if let Some(e) = end_date.as_ref() {
            where_sql.push_str(" AND period <= ?");
            vals.push(e);
        }

        let totals_sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(active_minutes),0), COALESCE(SUM(adjusted_cost_microdollars),0), \
             COALESCE(SUM(CASE WHEN classification='capitalizable' THEN adjusted_cost_microdollars ELSE 0 END),0), \
             COALESCE(SUM(CASE WHEN classification='expensed' THEN adjusted_cost_microdollars ELSE 0 END),0), \
             COALESCE(SUM(CASE WHEN confirmed=1 THEN 1 ELSE 0 END),0), \
             COALESCE(SUM(CASE WHEN confirmed=0 THEN 1 ELSE 0 END),0) \
             FROM pm_capex_entries WHERE {where_sql}"
        );
        let totals = conn.query_row(&totals_sql, rusqlite::params_from_iter(vals.iter().copied()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        });
        let (total_sessions, total_active_minutes, total_cost, cap_cost, exp_cost, confirmed_count, unconfirmed_count) =
            totals.unwrap_or((0, 0.0, 0, 0, 0, 0, 0));

        let by_month_sql = format!(
            "SELECT period, \
             SUM(CASE WHEN classification='capitalizable' THEN adjusted_cost_microdollars ELSE 0 END), \
             SUM(CASE WHEN classification='expensed' THEN adjusted_cost_microdollars ELSE 0 END), \
             SUM(active_minutes) \
             FROM pm_capex_entries WHERE {where_sql} GROUP BY period ORDER BY period ASC"
        );
        let by_month = conn
            .prepare(&by_month_sql)
            .and_then(|mut stmt| {
                let rows = stmt.query_map(rusqlite::params_from_iter(vals.iter().copied()), |r| {
                    Ok(CapexByMonth {
                        period: r.get(0)?,
                        capitalizable: r.get(1)?,
                        expensed: r.get(2)?,
                        active_minutes: r.get(3)?,
                    })
                })?;
                Ok(rows.flatten().collect::<Vec<_>>())
            })
            .unwrap_or_default();

        let period = if start_date.is_some() || end_date.is_some() {
            Some(CapexPeriod {
                start: start_date.unwrap_or("").to_string(),
                end: end_date.unwrap_or("").to_string(),
            })
        } else {
            None
        };

        CapexSummary {
            project_id: project_id.to_string(),
            period,
            total_sessions,
            total_active_minutes,
            total_cost_microdollars: total_cost,
            capitalizable_cost_microdollars: cap_cost,
            expensed_cost_microdollars: exp_cost,
            confirmed_count,
            unconfirmed_count,
            by_month,
        }
    }

    /// Render a project's capex ledger as CSV — ports Node `exportCapexCsv`.
    /// NB Node passes `startDate` as the exact `month` filter (not a range) — a
    /// quirk we replicate for parity.
    pub fn export_capex_csv(&self, project_id: &str, start_date: Option<&str>) -> String {
        let entries = self.list_capex_entries_filtered(project_id, start_date, None);
        // Node quotes only the DATA rows; the header row is the raw `headers.join(',')`.
        let headers = "Period,Session ID,Session Slug,Date,Model,\
Active Minutes,Active Hours,Cost (USD),Classification,Work Type,\
Adjustment Factor,Adjusted Cost (USD),Confirmed,Confirmed By,Notes";
        let mut out = String::from(headers);
        for e in &entries {
            let s = self.get_session(&e.session_id);
            let slug = s.as_ref().and_then(|s| s.slug.clone()).unwrap_or_default();
            let model = s.as_ref().and_then(|s| s.model.clone()).unwrap_or_default();
            let date = s
                .as_ref()
                .and_then(|s| chrono::DateTime::from_timestamp_millis(s.started_at))
                .map(|dt| dt.format("%Y-%m-%d").to_string())
                .unwrap_or_default();
            // RFC-4180 escape EVERY quoted string field (not just notes — Node's
            // bug): a `"`/`,`/newline in slug/model/work_type/etc would otherwise
            // break out of the quoted cell (CSV injection/corruption).
            let esc = |s: &str| s.replace('"', "\"\"");
            let row = format!(
                "\n\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{:.2}\",\"{:.2}\",\"{:.4}\",\"{}\",\"{}\",\"{:.2}\",\"{:.4}\",\"{}\",\"{}\",\"{}\"",
                esc(&e.period),
                esc(&e.session_id),
                esc(&slug),
                esc(&date),
                esc(&model),
                e.active_minutes,
                e.active_minutes / 60.0,
                e.cost_microdollars as f64 / 1_000_000.0,
                esc(&e.classification),
                esc(&e.work_type.clone().unwrap_or_default()),
                e.adjustment_factor,
                e.adjusted_cost_microdollars as f64 / 1_000_000.0,
                if e.confirmed { "Yes" } else { "No" },
                esc(&e.confirmed_by.clone().unwrap_or_default()),
                esc(&e.notes.clone().unwrap_or_default()),
            );
            out.push_str(&row);
        }
        out
    }

    /// Distinct non-null project categories, ascending — ports Node `listCategories`.
    pub fn list_categories(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(
            "SELECT DISTINCT category FROM pm_projects WHERE category IS NOT NULL ORDER BY category ASC",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| r.get::<_, String>(0));
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    // ============================================================
    // Tasks (ports Node createTask/updateTask/deleteTask/listTasks/reorderTask)
    // ============================================================

    /// A fresh UUID v4 string, sourced from SQLite `randomblob(16)` (no RNG dep,
    /// matching the `ws_`/`tk_` id pattern). Mirrors Node's `crypto.randomUUID()`.
    fn new_uuid_v4(&self) -> String {
        let conn = self.conn.lock().unwrap();
        let hex: String = conn
            .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))
            .unwrap_or_default();
        uuid_v4_from_hex(&hex)
    }

    /// Insert a task — ports Node `createTask`. `id`/`created_at`/`updated_at` are
    /// generated here; `sort_order` defaults to "now" when not supplied (Node's
    /// `data.sortOrder ?? now`). `labels_json` is a pre-serialized JSON array.
    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        &self,
        project_id: Option<&str>,
        title: &str,
        description: Option<&str>,
        status: &str,
        priority: &str,
        labels_json: &str,
        source: &str,
        source_ref: Option<&str>,
        sort_order: Option<f64>,
        assigned_to: Option<&str>,
        due_date: Option<&str>,
    ) -> Result<PmTask, String> {
        let id = self.new_uuid_v4();
        let now = now_ms();
        let sort_order = sort_order.unwrap_or(now as f64);
        let task = PmTask {
            id,
            project_id: project_id.map(String::from),
            title: title.to_string(),
            description: description.map(String::from),
            status: status.to_string(),
            priority: priority.to_string(),
            labels: Some(labels_json.to_string()),
            source: source.to_string(),
            source_ref: source_ref.map(String::from),
            sort_order,
            assigned_to: assigned_to.map(String::from),
            due_date: due_date.map(String::from),
            created_at: now,
            updated_at: now,
            completed_at: None,
        };
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO pm_tasks (id, project_id, title, description, status, priority, labels, \
             source, source_ref, sort_order, assigned_to, due_date, created_at, updated_at, completed_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                task.id, task.project_id, task.title, task.description, task.status, task.priority,
                task.labels, task.source, task.source_ref, task.sort_order, task.assigned_to,
                task.due_date, task.created_at, task.updated_at, task.completed_at
            ],
        )
        .map_err(|e| e.to_string())?; // e.g. a dangling project_id → FK violation
        Ok(task)
    }

    /// Partial-update a task — ports Node `updateTask`. Only provided fields are
    /// written; `labels` is a pre-serialized JSON array. No-op when nothing is set.
    #[allow(clippy::too_many_arguments)]
    pub fn update_task(
        &self,
        id: &str,
        title: Option<&str>,
        description: Option<&str>,
        status: Option<&str>,
        priority: Option<&str>,
        labels_json: Option<&str>,
        sort_order: Option<f64>,
        assigned_to: Option<&str>,
        due_date: Option<&str>,
        completed_at: Option<i64>,
    ) {
        let mut sets: Vec<&str> = Vec::new();
        let mut vals: Vec<&dyn rusqlite::ToSql> = Vec::new();
        if let Some(v) = title.as_ref() { sets.push("title = ?"); vals.push(v); }
        if let Some(v) = description.as_ref() { sets.push("description = ?"); vals.push(v); }
        if let Some(v) = status.as_ref() { sets.push("status = ?"); vals.push(v); }
        if let Some(v) = priority.as_ref() { sets.push("priority = ?"); vals.push(v); }
        if let Some(v) = labels_json.as_ref() { sets.push("labels = ?"); vals.push(v); }
        if let Some(v) = sort_order.as_ref() { sets.push("sort_order = ?"); vals.push(v); }
        if let Some(v) = assigned_to.as_ref() { sets.push("assigned_to = ?"); vals.push(v); }
        if let Some(v) = due_date.as_ref() { sets.push("due_date = ?"); vals.push(v); }
        if let Some(v) = completed_at.as_ref() { sets.push("completed_at = ?"); vals.push(v); }
        if sets.is_empty() {
            return;
        }
        let now = now_ms();
        sets.push("updated_at = ?");
        vals.push(&now);
        vals.push(&id);
        let sql = format!("UPDATE pm_tasks SET {} WHERE id = ?", sets.join(", "));
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(&sql, rusqlite::params_from_iter(vals));
    }

    /// Delete a task — ports Node `deleteTask`.
    pub fn delete_task(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM pm_tasks WHERE id = ?1", params![id]);
    }

    /// List tasks (optional project/status filter), `sort_order ASC` — ports Node `listTasks`.
    pub fn list_tasks(&self, project_id: Option<&str>, status: Option<&str>) -> Vec<PmTask> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from("SELECT id, project_id, title, description, status, priority, labels, \
            source, source_ref, sort_order, assigned_to, due_date, created_at, updated_at, completed_at \
            FROM pm_tasks");
        let mut vals: Vec<&dyn rusqlite::ToSql> = Vec::new();
        let mut conds: Vec<&str> = Vec::new();
        if let Some(p) = project_id.as_ref() { conds.push("project_id = ?"); vals.push(p); }
        if let Some(s) = status.as_ref() { conds.push("status = ?"); vals.push(s); }
        if !conds.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conds.join(" AND "));
        }
        sql.push_str(" ORDER BY sort_order ASC");
        let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
        let rows = stmt.query_map(rusqlite::params_from_iter(vals), map_task);
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// Move a task to a new status/order — ports Node `reorderTask`. Sets
    /// `completed_at` when moving to `done` (COALESCE: keeps an existing value otherwise).
    pub fn reorder_task(&self, id: &str, status: &str, sort_order: f64) {
        let now = now_ms();
        let completed_at: Option<i64> = if status == "done" { Some(now) } else { None };
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE pm_tasks SET status = ?1, sort_order = ?2, updated_at = ?3, \
             completed_at = COALESCE(?4, completed_at) WHERE id = ?5",
            params![status, sort_order, now, completed_at, id],
        );
    }

    // ============================================================
    // Notes (ports Node createNote/updateNote/deleteNote/listNotes)
    // ============================================================

    /// Insert a note — ports Node `createNote`. `id`/timestamps generated here;
    /// `tags_json` is a pre-serialized JSON array.
    #[allow(clippy::too_many_arguments)]
    pub fn create_note(
        &self,
        project_id: Option<&str>,
        session_id: Option<&str>,
        title: &str,
        content: &str,
        pinned: bool,
        tags_json: &str,
    ) -> Result<PmNote, String> {
        let id = self.new_uuid_v4();
        let now = now_ms();
        let note = PmNote {
            id,
            project_id: project_id.map(String::from),
            session_id: session_id.map(String::from),
            title: title.to_string(),
            content: content.to_string(),
            pinned,
            tags: Some(tags_json.to_string()),
            created_at: now,
            updated_at: now,
        };
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO pm_notes (id, project_id, session_id, title, content, pinned, tags, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                note.id, note.project_id, note.session_id, note.title, note.content,
                note.pinned as i64, note.tags, note.created_at, note.updated_at
            ],
        )
        .map_err(|e| e.to_string())?; // dangling project_id/session_id → FK violation
        Ok(note)
    }

    /// Partial-update a note — ports Node `updateNote` (title/content/pinned/tags).
    pub fn update_note(
        &self,
        id: &str,
        title: Option<&str>,
        content: Option<&str>,
        pinned: Option<bool>,
        tags_json: Option<&str>,
    ) {
        let mut sets: Vec<&str> = Vec::new();
        let mut vals: Vec<&dyn rusqlite::ToSql> = Vec::new();
        let pinned_i = pinned.map(i64::from);
        if let Some(v) = title.as_ref() { sets.push("title = ?"); vals.push(v); }
        if let Some(v) = content.as_ref() { sets.push("content = ?"); vals.push(v); }
        if let Some(v) = pinned_i.as_ref() { sets.push("pinned = ?"); vals.push(v); }
        if let Some(v) = tags_json.as_ref() { sets.push("tags = ?"); vals.push(v); }
        if sets.is_empty() {
            return;
        }
        let now = now_ms();
        sets.push("updated_at = ?");
        vals.push(&now);
        vals.push(&id);
        let sql = format!("UPDATE pm_notes SET {} WHERE id = ?", sets.join(", "));
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(&sql, rusqlite::params_from_iter(vals));
    }

    /// Delete a note — ports Node `deleteNote`.
    pub fn delete_note(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM pm_notes WHERE id = ?1", params![id]);
    }

    /// List notes (optional project filter; `pinned=Some(true)` → pinned-only),
    /// ordered `pinned DESC, updated_at DESC` — ports Node `listNotes`.
    pub fn list_notes(&self, project_id: Option<&str>, pinned: Option<bool>) -> Vec<PmNote> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from("SELECT id, project_id, session_id, title, content, pinned, tags, \
            created_at, updated_at FROM pm_notes");
        let mut vals: Vec<&dyn rusqlite::ToSql> = Vec::new();
        let pinned_i = pinned.map(i64::from);
        let mut conds: Vec<&str> = Vec::new();
        if let Some(p) = project_id.as_ref() { conds.push("project_id = ?"); vals.push(p); }
        if let Some(p) = pinned_i.as_ref() { conds.push("pinned = ?"); vals.push(p); }
        if !conds.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conds.join(" AND "));
        }
        sql.push_str(" ORDER BY pinned DESC, updated_at DESC");
        let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
        let rows = stmt.query_map(rusqlite::params_from_iter(vals), map_note);
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
    /// Node names this `avgSessionMinutes` (NOT `avgActiveMinutes`).
    pub avg_session_minutes: f64,
    pub model_breakdown: Vec<ModelBreakdown>,
}

/// Per-model rollup inside `SessionStats` (ports Node's `modelBreakdown` rows).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBreakdown {
    pub model: String,
    pub sessions: i64,
    pub cost: i64,
}

/// A raw project-summary row (Node `getProjectSummaries` serves the SQL row
/// verbatim — hence **snake_case** keys, a raw `runtime_apps` JSON string, and an
/// integer `sdk_installed`, unlike the camelCase `PmProject`). NULL columns are
/// emitted as `null` (not omitted), matching better-sqlite3's row JSON.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub category: Option<String>,
    pub sdk_installed: i64,
    pub runtimescope_project: Option<String>,
    pub runtime_apps: Option<String>,
    pub session_count: i64,
    pub total_cost: i64,
    pub total_active_minutes: f64,
    pub last_session_at: Option<i64>,
    pub total_messages: i64,
}

/// The "non-empty session" predicate (optionally column-aliased), shared by
/// `getSessionStats`/`getProjectSummaries`'s `hide_empty` filter.
fn nonempty_session_clause(prefix: &str) -> String {
    format!(
        "({p}message_count > 0 OR {p}total_input_tokens > 0 OR {p}total_output_tokens > 0 OR {p}cost_microdollars > 0 OR {p}active_minutes > 0)",
        p = prefix
    )
}

/// `new Date(d).getTime()` — UTC midnight of a YYYY-MM-DD.
fn date_start_ms(d: &str) -> Option<i64> {
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
        .ok()
        .and_then(|nd| nd.and_hms_opt(0, 0, 0))
        .map(|ndt| ndt.and_utc().timestamp_millis())
}

/// `new Date(d + 'T23:59:59.999Z').getTime()` — end-of-day UTC.
fn date_end_ms(d: &str) -> Option<i64> {
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
        .ok()
        .and_then(|nd| nd.and_hms_milli_opt(23, 59, 59, 999))
        .map(|ndt| ndt.and_utc().timestamp_millis())
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
                            phase, project_status, sdk_installed, runtime_apps, created_at, updated_at, category";

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
        category: r.get(12)?,
    })
}

fn map_dev_server(r: &rusqlite::Row) -> rusqlite::Result<DevServerRecord> {
    Ok(DevServerRecord {
        project_id: r.get(0)?,
        pid: r.get(1)?,
        pgid: r.get(2)?,
        command: r.get(3)?,
        cwd: r.get(4)?,
        started_at: r.get(5)?,
        status: r.get::<_, Option<String>>(6)?.unwrap_or_else(|| "starting".into()),
        ports: r.get(7)?,
        container_local: r.get::<_, i64>(8)? == 1,
        boot_time: r.get::<_, i64>(9)?,
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

/// Column order matches `create_task`/`list_tasks` SELECT.
fn map_task(r: &rusqlite::Row) -> rusqlite::Result<PmTask> {
    Ok(PmTask {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        description: r.get(3)?,
        status: r.get(4)?,
        priority: r.get(5)?,
        labels: r.get(6)?,
        // Node defaults a null `source` to 'manual' on read.
        source: r.get::<_, Option<String>>(7)?.unwrap_or_else(|| "manual".to_string()),
        source_ref: r.get(8)?,
        sort_order: r.get(9)?,
        assigned_to: r.get(10)?,
        due_date: r.get(11)?,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
        completed_at: r.get(14)?,
    })
}

/// Column order matches `create_note`/`list_notes` SELECT.
fn map_note(r: &rusqlite::Row) -> rusqlite::Result<PmNote> {
    Ok(PmNote {
        id: r.get(0)?,
        project_id: r.get(1)?,
        session_id: r.get(2)?,
        title: r.get(3)?,
        content: r.get(4)?,
        pinned: r.get::<_, i64>(5)? == 1,
        tags: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
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

    /// Seed a minimal parent project so FK-constrained child inserts (sessions,
    /// capex, tasks, notes) are valid (pm.db enforces foreign_keys).
    fn seed_project(s: &PmStore, id: &str) {
        s.upsert_project(&PmProject { id: id.into(), name: id.into(), ..Default::default() });
    }

    #[test]
    fn upsert_capex_stub_defaults_match_node() {
        let s = tmp_store();
        let sess = sample_session("sess-abc", "proj-1");
        seed_project(&s, "proj-1");
        s.upsert_session(&sess);
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
    fn reindex_does_not_clobber_user_confirmed_capex() {
        // INTENTIONAL DIVERGENCE from Node: re-stubbing a session (confirmed=false)
        // must never revert a user's manual confirmation. Once confirmed, the
        // confirmation flag + metadata are immutable through the stub path, while
        // the recomputed metrics (cost/minutes/etc.) still update.
        let s = tmp_store();
        let sess = sample_session("sess-c", "proj-c");
        seed_project(&s, "proj-c");
        s.upsert_session(&sess);
        s.upsert_capex_stub(&sess);

        // User confirms the entry (the write path sets confirmed=true + metadata).
        let mut confirmed = s.list_capex_entries("proj-c")[0].clone();
        confirmed.confirmed = true;
        confirmed.confirmed_at = Some(1_704_070_000_000);
        confirmed.confirmed_by = Some("edwin".to_string());
        confirmed.classification = "capitalized".to_string();
        s.upsert_capex_entry(&confirmed);

        // Re-index with fresh metrics (always confirmed=false via the stub).
        let mut sess2 = sample_session("sess-c", "proj-c");
        sess2.cost_microdollars = 7_777_777;
        s.upsert_capex_stub(&sess2);

        let after = &s.list_capex_entries("proj-c")[0];
        // Confirmation preserved...
        assert!(after.confirmed, "re-index must not revert confirmed");
        assert_eq!(after.confirmed_at, Some(1_704_070_000_000));
        assert_eq!(after.confirmed_by.as_deref(), Some("edwin"));
        // ...but recomputed metrics still flow through.
        assert_eq!(after.cost_microdollars, 7_777_777);
    }

    #[test]
    fn capex_filter_update_confirm_summary_roundtrip() {
        let s = tmp_store();
        seed_project(&s, "proj-q");
        // Two entries in the same project; different sessions/periods.
        let mut a = sample_session("sa", "proj-q");
        a.cost_microdollars = 1_000_000;
        s.upsert_session(&a);
        s.upsert_capex_stub(&a);
        let mut b = sample_session("sb", "proj-q");
        b.cost_microdollars = 2_000_000;
        b.started_at = a.started_at + 86_400_000; // next day → distinct period
        s.upsert_session(&b);
        s.upsert_capex_stub(&b);

        // confirmed filter: none confirmed yet.
        assert_eq!(s.list_capex_entries_filtered("proj-q", None, Some(true)).len(), 0);
        assert_eq!(s.list_capex_entries_filtered("proj-q", None, Some(false)).len(), 2);

        // Update entry a: capitalizable, factor 0.5 + cost → adjusted recompute (Math.round half-up).
        s.update_capex_entry("capex-sa", Some("capitalizable"), Some("feature"), Some(0.5), Some(1_000_001), Some("note"));
        let ea = s.list_capex_entries_filtered("proj-q", None, None).into_iter().find(|e| e.id == "capex-sa").unwrap();
        assert_eq!(ea.classification, "capitalizable");
        assert_eq!(ea.work_type.as_deref(), Some("feature"));
        assert_eq!(ea.adjustment_factor, 0.5);
        assert_eq!(ea.adjusted_cost_microdollars, 500_001, "round(1000001*0.5)=500001 (half-up)");
        assert_eq!(ea.notes.as_deref(), Some("note"));

        // month filter = exact period match.
        let period_a = crate::pm_discovery::to_period(a.started_at);
        assert_eq!(s.list_capex_entries_filtered("proj-q", Some(&period_a), None).len(), 1);

        // confirm a.
        s.confirm_capex_entry("capex-sa", Some("edwin"));
        assert_eq!(s.list_capex_entries_filtered("proj-q", None, Some(true)).len(), 1);

        // summary aggregates across both: 2 sessions, 1 confirmed, capitalizable=500001.
        let sum = s.get_capex_summary("proj-q", None, None);
        assert_eq!(sum.total_sessions, 2);
        assert_eq!(sum.confirmed_count, 1);
        assert_eq!(sum.unconfirmed_count, 1);
        assert_eq!(sum.capitalizable_cost_microdollars, 500_001);
        // b is still an unconfirmed expensed stub at full cost.
        assert_eq!(sum.expensed_cost_microdollars, 2_000_000);
        assert!(sum.period.is_none(), "no date filter → period omitted");
        assert_eq!(sum.by_month.len(), 2, "two distinct days");

        // date-filtered summary stamps the period.
        let sum2 = s.get_capex_summary("proj-q", Some("2020-01-01"), None);
        assert_eq!(sum2.period.as_ref().map(|p| p.start.as_str()), Some("2020-01-01"));

        // CSV export: header + 1 data row when month-filtered to a's period.
        let csv = s.export_capex_csv("proj-q", Some(&period_a));
        assert!(csv.starts_with("Period,Session ID,Session Slug,"), "unquoted header (Node parity)");
        assert!(csv.lines().nth(1).unwrap().starts_with('"'), "data rows are quoted");
        assert_eq!(csv.lines().count(), 2, "header + 1 row");
    }

    #[test]
    fn uuid_v4_from_hex_forces_version_and_variant() {
        // version nibble → '4'; variant nibble (idx 16, here 'f'=15) → (15&3)|8 = 'b'.
        let id = uuid_v4_from_hex("0123456789abcdeffedcba9876543210");
        assert_eq!(id, "01234567-89ab-4def-bedc-ba9876543210");
        // shape matches a UUID v4 regex.
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        assert!(parts[2].starts_with('4'));
        assert!(matches!(parts[3].chars().next().unwrap(), '8' | '9' | 'a' | 'b'));
    }

    #[test]
    fn task_create_list_update_reorder_delete() {
        let s = tmp_store();
        seed_project(&s, "proj-t");
        // create with defaults + labels.
        let t = s.create_task(
            Some("proj-t"), "Write tests", Some("desc"), "todo", "high",
            r#"["a","b"]"#, "manual", None, Some(5.0), None, None,
        ).unwrap();
        assert_eq!(t.title, "Write tests");
        assert_eq!(t.status, "todo");
        assert_eq!(t.priority, "high");
        assert!(t.completed_at.is_none());

        // listed back; labels serialize as a real array; filters work.
        let listed = s.list_tasks(Some("proj-t"), None);
        assert_eq!(listed.len(), 1);
        let v = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(v["labels"], serde_json::json!(["a", "b"]));
        assert_eq!(v["sortOrder"], serde_json::json!(5.0));
        assert!(v["id"].as_str().unwrap().len() == 36, "uuid id");
        assert_eq!(s.list_tasks(Some("proj-t"), Some("done")).len(), 0, "status filter");
        assert_eq!(s.list_tasks(Some("other"), None).len(), 0, "project filter");

        // partial update: title + status only.
        s.update_task(&t.id, Some("Renamed"), None, Some("in_progress"), None, None, None, None, None, None);
        let after = &s.list_tasks(None, None)[0];
        assert_eq!(after.title, "Renamed");
        assert_eq!(after.status, "in_progress");
        assert_eq!(after.priority, "high", "unset field unchanged");

        // reorder to done stamps completed_at.
        s.reorder_task(&t.id, "done", 1.0);
        let done = &s.list_tasks(None, None)[0];
        assert_eq!(done.status, "done");
        assert_eq!(done.sort_order, 1.0);
        assert!(done.completed_at.is_some(), "done → completed_at set");

        // delete.
        s.delete_task(&t.id);
        assert!(s.list_tasks(None, None).is_empty());
    }

    #[test]
    fn note_create_list_update_delete_with_pinned_ordering() {
        let s = tmp_store();
        seed_project(&s, "proj-n");
        s.upsert_session(&sample_session("sess-1", "proj-n")); // n2 references it (FK)
        // two notes; second pinned → must sort first (pinned DESC, updated_at DESC).
        let n1 = s.create_note(Some("proj-n"), None, "First", "body one", false, r#"["x"]"#).unwrap();
        let n2 = s.create_note(Some("proj-n"), Some("sess-1"), "Second", "body two", true, "[]").unwrap();

        let all = s.list_notes(Some("proj-n"), None);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, n2.id, "pinned note sorts first");
        let v = serde_json::to_value(&all[1]).unwrap();
        assert_eq!(v["tags"], serde_json::json!(["x"]), "tags emitted as array");
        assert_eq!(v["title"], "First");
        assert!(v.get("sessionId").is_none(), "null sessionId omitted");

        // pinned filter returns only the pinned one.
        let pinned = s.list_notes(Some("proj-n"), Some(true));
        assert_eq!(pinned.len(), 1);
        assert_eq!(pinned[0].id, n2.id);

        // project filter isolates.
        assert!(s.list_notes(Some("other"), None).is_empty());

        // partial update: content + pinned only.
        s.update_note(&n1.id, None, Some("edited body"), Some(true), None);
        let updated = s.list_notes(Some("proj-n"), Some(true));
        assert_eq!(updated.len(), 2, "both pinned now");
        let e = updated.iter().find(|n| n.id == n1.id).unwrap();
        assert_eq!(e.content, "edited body");
        assert!(e.pinned);
        assert_eq!(e.title, "First", "unset title unchanged");

        s.delete_note(&n2.id);
        assert_eq!(s.list_notes(Some("proj-n"), None).len(), 1);
    }

    #[test]
    fn session_stats_filtered_and_project_summaries() {
        let s = tmp_store();
        s.upsert_project(&PmProject {
            id: "proj-s".into(),
            name: "Proj S".into(),
            ..Default::default()
        });
        let mut a = sample_session("sa", "proj-s");
        a.model = Some("opus".into());
        a.cost_microdollars = 1_000_000;
        a.active_minutes = 10.0;
        a.message_count = 5;
        a.total_input_tokens = 100;
        a.total_output_tokens = 50;
        s.upsert_session(&a);
        let mut b = sample_session("sb", "proj-s");
        b.model = Some("opus".into());
        b.cost_microdollars = 3_000_000;
        b.active_minutes = 30.0;
        s.upsert_session(&b);
        let mut c = sample_session("sc", "proj-s");
        c.model = Some("sonnet".into());
        c.cost_microdollars = 500_000;
        c.active_minutes = 20.0;
        s.upsert_session(&c);

        let stats = s.session_stats_filtered(Some("proj-s"), None, None, false);
        assert_eq!(stats.total_sessions, 3);
        assert_eq!(stats.total_cost_microdollars, 4_500_000);
        assert_eq!(stats.avg_session_minutes, 20.0); // (10+30+20)/3
        // modelBreakdown: grouped, ordered by cost DESC → opus (4M) before sonnet (0.5M).
        assert_eq!(stats.model_breakdown.len(), 2);
        assert_eq!(stats.model_breakdown[0].model, "opus");
        assert_eq!(stats.model_breakdown[0].sessions, 2);
        assert_eq!(stats.model_breakdown[0].cost, 4_000_000);
        assert_eq!(stats.model_breakdown[1].model, "sonnet");

        // hide_empty drops the all-zero stub sessions (none here are empty).
        assert_eq!(s.session_stats_filtered(None, None, None, true).total_sessions, 3);

        // project summaries: one project, 3 sessions, raw snake_case row.
        let sums = s.get_project_summaries(None, None, false);
        assert_eq!(sums.len(), 1);
        assert_eq!(sums[0].id, "proj-s");
        assert_eq!(sums[0].session_count, 3);
        assert_eq!(sums[0].total_cost, 4_500_000);
        assert_eq!(sums[0].total_messages, 5);
        let v = serde_json::to_value(&sums[0]).unwrap();
        assert!(v.get("session_count").is_some(), "summaries are snake_case");
        assert!(v.get("sessionCount").is_none());
    }

    #[test]
    fn foreign_keys_enforced_parity_with_node() {
        let s = tmp_store();
        // Discovery's insert order is FK-safe: project → session → capex all succeed.
        seed_project(&s, "fk-proj");
        let sess = sample_session("fk-sess", "fk-proj");
        s.upsert_session(&sess);
        s.upsert_capex_stub(&sess);
        assert_eq!(s.list_capex_entries("fk-proj").len(), 1);

        // A note/task with a VALID (or null) project_id is accepted...
        assert!(s.create_note(Some("fk-proj"), None, "ok", "", false, "[]").is_ok());
        assert!(s.create_note(None, None, "ok-null", "", false, "[]").is_ok());
        assert!(s.create_task(None, "ok", None, "todo", "medium", "[]", "manual", None, None, None, None).is_ok());

        // ...but a DANGLING project_id trips the FK (Node 400s the same case — its
        // better-sqlite3 connection defaults foreign_keys=ON; ours does too now).
        let bad_note = s.create_note(Some("ghost-proj"), None, "x", "", false, "[]");
        assert!(bad_note.is_err(), "FK must reject a note with a non-existent project_id");
        assert!(bad_note.unwrap_err().contains("FOREIGN KEY"), "rusqlite surfaces the SQLite FK message");
        let bad_task = s.create_task(Some("ghost-proj"), "x", None, "todo", "medium", "[]", "manual", None, None, None, None);
        assert!(bad_task.is_err(), "FK must reject a task with a non-existent project_id");

        // A note with a dangling session_id is rejected too.
        assert!(s.create_note(Some("fk-proj"), Some("ghost-sess"), "x", "", false, "[]").is_err());
    }

    #[test]
    fn empty_capex_summary_and_categories() {
        let s = tmp_store();
        let sum = s.get_capex_summary("nope", None, None);
        assert_eq!(sum.total_sessions, 0);
        assert_eq!(sum.total_cost_microdollars, 0);
        assert!(sum.by_month.is_empty());
        assert!(s.list_categories().is_empty(), "no projects → no categories");
    }

    #[test]
    fn runtime_apps_serializes_as_array_not_string() {
        // The dashboard consumes runtimeApps as string[] (.length / .map). The
        // column stores a JSON-string, so it must be parsed-then-emitted as an
        // array over HTTP — never double-encoded.
        let p = PmProject {
            id: "p1".into(),
            name: "My Web".into(),
            runtime_apps: Some(r#"["web","api"]"#.into()),
            ..Default::default()
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["runtimeApps"], serde_json::json!(["web", "api"]));
        assert!(v["runtimeApps"].is_array(), "must be a JSON array, not a string");

        // Absent → field omitted entirely (skip_serializing_if).
        let empty = PmProject { id: "p2".into(), runtime_apps: None, ..Default::default() };
        let v2 = serde_json::to_value(&empty).unwrap();
        assert!(v2.get("runtimeApps").is_none());
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
        // Seed a session + capex stub so cascade-delete is observable.
        s.upsert_session(&sample_session("s1", "p1"));
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
