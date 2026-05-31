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
CREATE TABLE IF NOT EXISTS pm_deleted_projects (
  path TEXT PRIMARY KEY,
  name TEXT,
  deleted_at INTEGER NOT NULL
);
";

#[derive(Clone, Debug)]
pub struct PmWorkspace {
    pub id: String,
    pub name: String,
    pub slug: String,
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

#[derive(Clone, Debug, Default)]
pub struct PmProject {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub path: Option<String>,
    pub claude_project_key: Option<String>,
    pub runtimescope_project: Option<String>,
    pub phase: String,
    pub project_status: String,
    pub sdk_installed: bool,
    /// JSON-encoded array of runtime app names (mirrors Node's `runtime_apps` TEXT column).
    pub runtime_apps: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A parsed/indexed Claude session row (the parser's metrics + file bookkeeping).
#[derive(Clone, Debug, Default)]
pub struct PmSession {
    pub id: String,
    pub project_id: String,
    pub jsonl_path: String,
    pub jsonl_size: i64,
    pub first_prompt: Option<String>,
    pub summary: Option<String>,
    pub slug: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,
    pub git_branch: Option<String>,
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
    pub ended_at: Option<i64>,
    pub active_minutes: f64,
    pub compaction_count: i64,
    pub pre_compaction_tokens: Option<i64>,
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

    #[test]
    fn slugify_matches_node() {
        assert_eq!(slugify("Acme  Corp"), "acme-corp");
        assert_eq!(slugify("a--b"), "a-b");
        assert_eq!(slugify("Work_Stuff!"), "work-stuff");
        assert_eq!(slugify("--trim--"), "trim");
    }
}
