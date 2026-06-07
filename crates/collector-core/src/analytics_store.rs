//! Analytics subsystem store — product-analytics / ROI (ADR-0012, slice 1).
//!
//! A SQLite DB (`analytics.db`) **separate** from `collector.db` (events) and
//! `pm.db` (coding-session project management). It holds the *people who use a
//! monitored app* and the ROI model — deliberately distinct from `pm_sessions`
//! (Claude-Code coding sessions): conflating them corrupts both (the
//! projectId/projectName lesson). See `docs/specs/analytics-data-model.md`.
//!
//! Privacy by construction: `analytics_users` (anon id, role, consent, first/last
//! seen) is what the dashboard reads; PII (email, ip) lives in a separate
//! `analytics_user_pii` table exposed only through an admin-token path. Like
//! `pm_store`, ops are low-frequency → a shared `Arc<Mutex<Connection>>`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    // Fall back to 0 rather than panic if the clock is before the epoch.
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Default fully-loaded role rates ($/hr) — from the KPI methodology
/// (`~/kpis/docs/METHODOLOGY.md`). Seeded once; editable via `set_role_rate`.
const DEFAULT_ROLES: &[(&str, f64)] = &[
    ("Coordinator", 40.0),
    ("Specialist", 50.0),
    ("DCM", 55.0),
    ("Account Exec", 65.0),
    ("Director", 85.0),
];

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS analytics_users (
  anon_id    TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT '',
  consent    INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
-- PII boundary: read only through the admin-token de-anon path. Never joined
-- into a dashboard read.
CREATE TABLE IF NOT EXISTS analytics_user_pii (
  anon_id TEXT PRIMARY KEY,
  email   TEXT NOT NULL,
  ip      TEXT,
  FOREIGN KEY (anon_id) REFERENCES analytics_users(anon_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS analytics_roles (
  role        TEXT PRIMARY KEY,
  hourly_rate REAL NOT NULL
);
-- ROI engine (slice 3). `fn_name` is the custom-event name (the 'function').
CREATE TABLE IF NOT EXISTS analytics_baselines (
  fn_name    TEXT PRIMARY KEY,
  manual_min REAL NOT NULL,
  tool_min   REAL NOT NULL,
  per_item   INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'admin',
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS analytics_baseline_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  fn_name    TEXT NOT NULL,
  manual_min REAL NOT NULL,
  tool_min   REAL NOT NULL,
  per_item   INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT,
  reason     TEXT
);
CREATE TABLE IF NOT EXISTS analytics_baseline_submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fn_name     TEXT NOT NULL,
  manual_min  REAL NOT NULL,
  anon_id     TEXT,
  submitted_at INTEGER NOT NULL
);
-- proj_* are manager targets; actuals are computed LIVE from ROI (not stored).
CREATE TABLE IF NOT EXISTS analytics_projections (
  quarter      TEXT PRIMARY KEY,
  proj_hours   REAL NOT NULL DEFAULT 0,
  proj_value   REAL NOT NULL DEFAULT 0,
  actual_hours REAL NOT NULL DEFAULT 0,
  actual_value REAL NOT NULL DEFAULT 0,
  notes        TEXT,
  set_by       TEXT
);
-- Uptime / status (slice 5). Probe targets + per-check history + incidents.
CREATE TABLE IF NOT EXISTS analytics_monitored_apps (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  probe_path  TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_uptime_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id     TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  source     TEXT NOT NULL,   -- 'probe' | 'heartbeat'
  state      INTEGER NOT NULL, -- 0 up / 1 degraded / 2 down
  resp_ms    INTEGER,
  FOREIGN KEY (app_id) REFERENCES analytics_monitored_apps(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_uptime_checks_app_time ON analytics_uptime_checks(app_id, checked_at);
CREATE TABLE IF NOT EXISTS analytics_incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT NOT NULL,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL,  -- 'down' | 'degraded'
  started_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY (app_id) REFERENCES analytics_monitored_apps(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_incidents_app_open ON analytics_incidents(app_id, resolved_at);
-- Headless surveys (slice 4, ADR-0014). Definitions scoped to a workspace;
-- end-users addressed by projectId at fetch time. answers/questions/targeting JSON.
CREATE TABLE IF NOT EXISTS analytics_surveys (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | active | inactive
  questions    TEXT NOT NULL DEFAULT '[]',
  targeting    TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_survey_responses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id    TEXT NOT NULL,
  anon_id      TEXT NOT NULL,
  external_id  TEXT,
  answers      TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  UNIQUE (survey_id, anon_id), -- once-per-user (ADR-0014); handler also 409s early
  FOREIGN KEY (survey_id) REFERENCES analytics_surveys(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_survey_responses ON analytics_survey_responses(survey_id, anon_id);
CREATE TABLE IF NOT EXISTS analytics_survey_dismissals (
  survey_id    TEXT NOT NULL,
  anon_id      TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (survey_id, anon_id),
  FOREIGN KEY (survey_id) REFERENCES analytics_surveys(id) ON DELETE CASCADE
);
-- Admin de-anon audit (slice 6): every PII reveal through the X-Admin-Key path is
-- logged here (who/when/what), so PII access is itself auditable.
CREATE TABLE IF NOT EXISTS analytics_admin_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,   -- list_users | deanon_user
  target      TEXT,            -- anon_id, when applicable
  accessed_at INTEGER NOT NULL,
  ip          TEXT
);
";

#[derive(Clone, Debug, Serialize)]
pub struct AnalyticsUser {
    #[serde(rename = "anonId")]
    pub anon_id: String,
    pub role: String,
    pub consent: bool,
    #[serde(rename = "firstSeen")]
    pub first_seen: i64,
    #[serde(rename = "lastSeen")]
    pub last_seen: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct AnalyticsRole {
    pub role: String,
    #[serde(rename = "hourlyRate")]
    pub hourly_rate: f64,
}

/// De-anonymized record — admin-token path only.
#[derive(Clone, Debug, Serialize)]
pub struct AnalyticsUserPii {
    #[serde(rename = "anonId")]
    pub anon_id: String,
    pub email: String,
    pub ip: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Baseline {
    #[serde(rename = "fn")]
    pub fn_name: String,
    #[serde(rename = "manualMin")]
    pub manual_min: f64,
    #[serde(rename = "toolMin")]
    pub tool_min: f64,
    #[serde(rename = "perItem")]
    pub per_item: bool,
    pub source: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Clone)]
pub struct AnalyticsStore {
    conn: Arc<Mutex<Connection>>,
}

impl AnalyticsStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        // Skip dir creation for `:memory:` (and any parentless path).
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", true).map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        // Migrate projections created before notes/set_by existed (slice-3a).
        // CREATE IF NOT EXISTS won't add columns; ALTER + ignore "duplicate column".
        let _ = conn.execute("ALTER TABLE analytics_projections ADD COLUMN notes TEXT", []);
        let _ = conn.execute("ALTER TABLE analytics_projections ADD COLUMN set_by TEXT", []);
        // external_id (slice 4): the app's own user id, set via identify, for joining
        // survey responses back to the app's user table.
        let _ = conn.execute("ALTER TABLE analytics_users ADD COLUMN external_id TEXT", []);
        let store = AnalyticsStore { conn: Arc::new(Mutex::new(conn)) };
        store.seed_roles()?;
        Ok(store)
    }

    fn seed_roles(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        for (role, rate) in DEFAULT_ROLES {
            conn.execute(
                "INSERT OR IGNORE INTO analytics_roles (role, hourly_rate) VALUES (?1, ?2)",
                params![role, rate],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Stable, deterministic anon id from an email (same email → same id), so the
    /// dashboard never needs the email. 16 uppercase hex chars (8 bytes of
    /// SHA-256) — a 64-bit space, so the birthday bound keeps collisions
    /// negligible well past any realistic user count (4 bytes was ~50% at ~65k).
    pub fn anon_id_for(email: &str) -> String {
        let mut h = Sha256::new();
        h.update(email.trim().to_lowercase().as_bytes());
        let d = h.finalize();
        d[..8].iter().map(|b| format!("{b:02X}")).collect()
    }

    /// Record/refresh an end-user identity (SDK `identify()`). Upserts the anon
    /// user (role/consent + last_seen; first_seen set once) and the PII row.
    /// Returns the anon id the SDK then stamps on its `track()` events.
    /// `role`/`consent` are optional: when `None` the existing value is preserved
    /// (a re-identify that omits `consent` must NOT silently revoke it). Callers
    /// should pass `ip = None` unless `consent == Some(true)`.
    pub fn identify(
        &self,
        email: &str,
        role: Option<&str>,
        consent: Option<bool>,
        external_id: Option<&str>,
        ip: Option<&str>,
    ) -> Result<String, String> {
        let anon = Self::anon_id_for(email);
        let now = now_ms();
        let consent_i: Option<i64> = consent.map(|c| c as i64);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_users (anon_id, role, consent, external_id, first_seen, last_seen)
             VALUES (?1, COALESCE(?2, ''), COALESCE(?3, 0), ?5, ?4, ?4)
             ON CONFLICT(anon_id) DO UPDATE SET
               role = COALESCE(?2, analytics_users.role),
               consent = COALESCE(?3, analytics_users.consent),
               external_id = COALESCE(?5, analytics_users.external_id),
               last_seen = ?4",
            params![anon, role, consent_i, now, external_id],
        )
        .map_err(|e| e.to_string())?;
        // On an explicit consent revocation, CLEAR any previously-stored IP (don't
        // COALESCE-preserve it) — honoring the consent boundary on revoke, not just
        // on capture. Otherwise preserve the prior IP when this call omits one.
        let revoke = consent == Some(false);
        conn.execute(
            "INSERT INTO analytics_user_pii (anon_id, email, ip) VALUES (?1, ?2, ?3)
             ON CONFLICT(anon_id) DO UPDATE SET
               email = excluded.email,
               ip = CASE WHEN ?4 THEN NULL ELSE COALESCE(excluded.ip, analytics_user_pii.ip) END",
            params![anon, email.trim().to_lowercase(), ip, revoke],
        )
        .map_err(|e| e.to_string())?;
        Ok(anon)
    }

    /// Anonymized user (NO PII) — the dashboard read path.
    pub fn get_user(&self, anon_id: &str) -> Option<AnalyticsUser> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT anon_id, role, consent, first_seen, last_seen FROM analytics_users WHERE anon_id = ?1",
            params![anon_id],
            |r| {
                Ok(AnalyticsUser {
                    anon_id: r.get(0)?,
                    role: r.get(1)?,
                    consent: r.get::<_, i64>(2)? != 0,
                    first_seen: r.get(3)?,
                    last_seen: r.get(4)?,
                })
            },
        )
        .optional()
        .unwrap_or_else(|e| {
            // A real DB error must not masquerade as a 404 "not found".
            tracing::warn!("analytics get_user failed: {e}");
            None
        })
    }

    pub fn list_users(&self) -> Vec<AnalyticsUser> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT anon_id, role, consent, first_seen, last_seen FROM analytics_users ORDER BY last_seen DESC",
        ) {
            Ok(s) => s,
            Err(e) => { tracing::warn!("analytics query failed (prepare): {e}"); return Vec::new() }
        };
        let rows = stmt.query_map([], |r| {
            Ok(AnalyticsUser {
                anon_id: r.get(0)?,
                role: r.get(1)?,
                consent: r.get::<_, i64>(2)? != 0,
                first_seen: r.get(3)?,
                last_seen: r.get(4)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => { tracing::warn!("analytics query failed (rows): {e}"); Vec::new() }
        }
    }

    /// De-anonymized record — ADMIN PATH ONLY. Callers MUST gate this behind the
    /// admin token; it is never reachable from a dashboard read route.
    pub fn get_pii(&self, anon_id: &str) -> Option<AnalyticsUserPii> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT anon_id, email, ip FROM analytics_user_pii WHERE anon_id = ?1",
            params![anon_id],
            |r| Ok(AnalyticsUserPii { anon_id: r.get(0)?, email: r.get(1)?, ip: r.get(2)? }),
        )
        .optional()
        .unwrap_or_else(|e| {
            tracing::warn!("analytics get_pii failed: {e}");
            None
        })
    }

    pub fn roles(&self) -> Vec<AnalyticsRole> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT role, hourly_rate FROM analytics_roles ORDER BY hourly_rate") {
            Ok(s) => s,
            Err(e) => { tracing::warn!("analytics query failed (prepare): {e}"); return Vec::new() }
        };
        let rows = stmt.query_map([], |r| Ok(AnalyticsRole { role: r.get(0)?, hourly_rate: r.get(1)? }));
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => { tracing::warn!("analytics query failed (rows): {e}"); Vec::new() }
        }
    }

    pub fn set_role_rate(&self, role: &str, hourly_rate: f64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_roles (role, hourly_rate) VALUES (?1, ?2)
             ON CONFLICT(role) DO UPDATE SET hourly_rate = excluded.hourly_rate",
            params![role, hourly_rate],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Insert/update a baseline, appending a history row (audit trail, ADR-0012).
    #[allow(clippy::too_many_arguments)] // baseline fields are clearer flat than in a struct here
    pub fn upsert_baseline(
        &self,
        fn_name: &str,
        manual_min: f64,
        tool_min: f64,
        per_item: bool,
        source: &str,
        changed_by: Option<&str>,
        reason: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        Self::upsert_baseline_conn(&conn, fn_name, manual_min, tool_min, per_item, source, changed_by, reason)
            .map_err(|e| e.to_string())
    }

    /// Upsert a baseline + append history on a given connection (no locking) —
    /// shared by the public `upsert_baseline` and the transactional
    /// `accept_submission` so both write the baseline + history atomically.
    #[allow(clippy::too_many_arguments)]
    fn upsert_baseline_conn(
        conn: &rusqlite::Connection,
        fn_name: &str,
        manual_min: f64,
        tool_min: f64,
        per_item: bool,
        source: &str,
        changed_by: Option<&str>,
        reason: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = now_ms();
        conn.execute(
            "INSERT INTO analytics_baselines (fn_name, manual_min, tool_min, per_item, source, updated_at, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(fn_name) DO UPDATE SET
               manual_min = excluded.manual_min, tool_min = excluded.tool_min,
               per_item = excluded.per_item, source = excluded.source,
               updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            params![fn_name, manual_min, tool_min, per_item as i64, source, now, changed_by],
        )?;
        conn.execute(
            "INSERT INTO analytics_baseline_history (fn_name, manual_min, tool_min, per_item, changed_at, changed_by, reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![fn_name, manual_min, tool_min, per_item as i64, now, changed_by, reason],
        )?;
        Ok(())
    }

    pub fn list_baselines(&self) -> Vec<Baseline> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT fn_name, manual_min, tool_min, per_item, source, updated_at FROM analytics_baselines ORDER BY fn_name",
        ) {
            Ok(s) => s,
            Err(e) => { tracing::warn!("analytics query failed (prepare): {e}"); return Vec::new() }
        };
        let rows = stmt.query_map([], |r| {
            Ok(Baseline {
                fn_name: r.get(0)?,
                manual_min: r.get(1)?,
                tool_min: r.get(2)?,
                per_item: r.get::<_, i64>(3)? != 0,
                source: r.get(4)?,
                updated_at: r.get(5)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => { tracing::warn!("analytics query failed (rows): {e}"); Vec::new() }
        }
    }
}

/// A crowdsourced baseline estimate (frontline validation, ADR-0012).
#[derive(Clone, Debug, Serialize)]
pub struct BaselineSubmission {
    pub id: i64,
    #[serde(rename = "fn")]
    pub fn_name: String,
    #[serde(rename = "estManualMin")]
    pub est_manual_min: f64,
    #[serde(rename = "anonId")]
    pub anon_id: Option<String>,
    #[serde(rename = "submittedAt")]
    pub submitted_at: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct BaselineHistoryEntry {
    #[serde(rename = "manualMin")]
    pub manual_min: f64,
    #[serde(rename = "toolMin")]
    pub tool_min: f64,
    #[serde(rename = "perItem")]
    pub per_item: bool,
    #[serde(rename = "changedAt")]
    pub changed_at: i64,
    #[serde(rename = "changedBy")]
    pub changed_by: Option<String>,
    pub reason: Option<String>,
}

/// A manager projection — `proj_*` are targets; actuals are derived live (the
/// `actual_*` columns are unused by reads). `notes`/`set_by` are metadata.
#[derive(Clone, Debug, Serialize)]
pub struct Projection {
    pub quarter: String,
    #[serde(rename = "projHours")]
    pub proj_hours: f64,
    #[serde(rename = "projValue")]
    pub proj_value: f64,
    pub notes: Option<String>,
    #[serde(rename = "setBy")]
    pub set_by: Option<String>,
}

impl AnalyticsStore {
    /// (manual, tool, per_item) for a feature's current baseline, if any.
    pub fn add_submission(&self, fn_name: &str, est_manual_min: f64, anon_id: Option<&str>) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_baseline_submissions (fn_name, manual_min, anon_id, submitted_at) VALUES (?1, ?2, ?3, ?4)",
            params![fn_name, est_manual_min, anon_id, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_submissions(&self) -> Vec<BaselineSubmission> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, fn_name, manual_min, anon_id, submitted_at FROM analytics_baseline_submissions ORDER BY submitted_at DESC",
        ) {
            Ok(s) => s,
            Err(e) => { tracing::warn!("analytics query failed (prepare): {e}"); return Vec::new() }
        };
        let rows = stmt.query_map([], |r| {
            Ok(BaselineSubmission {
                id: r.get(0)?,
                fn_name: r.get(1)?,
                est_manual_min: r.get(2)?,
                anon_id: r.get(3)?,
                submitted_at: r.get(4)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => { tracing::warn!("analytics query failed (rows): {e}"); Vec::new() }
        }
    }

    /// Dismiss a submission. Returns true if a row was removed.
    pub fn delete_submission(&self, id: i64) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM analytics_baseline_submissions WHERE id = ?1", params![id])
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    /// Accept a submission: set the feature's baseline `manual_min` to the
    /// estimate (preserving tool/per_item), source=`crowd`, then dismiss it — all
    /// in ONE transaction so a concurrent edit/second-accept can't interleave or
    /// double-apply (read→upsert→history→delete are atomic).
    pub fn accept_submission(&self, id: i64) -> Result<bool, String> {
        let mut guard = self.conn.lock().unwrap();
        let tx = guard.transaction().map_err(|e| e.to_string())?;
        let row: Option<(String, f64)> = tx
            .query_row(
                "SELECT fn_name, manual_min FROM analytics_baseline_submissions WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((fn_name, est)) = row else { return Ok(false) }; // tx drops → rollback (no-op)
        // Preserve the current tool/per_item within the same transaction.
        let (tool, per_item) = tx
            .query_row(
                "SELECT tool_min, per_item FROM analytics_baselines WHERE fn_name = ?1",
                params![fn_name],
                |r| Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or((0.0, false));
        Self::upsert_baseline_conn(&tx, &fn_name, est, tool, per_item, "crowd", None, Some("accepted crowd submission"))
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM analytics_baseline_submissions WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub fn baseline_history(&self, fn_name: &str) -> Vec<BaselineHistoryEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT manual_min, tool_min, per_item, changed_at, changed_by, reason FROM analytics_baseline_history WHERE fn_name = ?1 ORDER BY changed_at DESC",
        ) {
            Ok(s) => s,
            Err(e) => { tracing::warn!("analytics query failed (prepare): {e}"); return Vec::new() }
        };
        let rows = stmt.query_map(params![fn_name], |r| {
            Ok(BaselineHistoryEntry {
                manual_min: r.get(0)?,
                tool_min: r.get(1)?,
                per_item: r.get::<_, i64>(2)? != 0,
                changed_at: r.get(3)?,
                changed_by: r.get(4)?,
                reason: r.get(5)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => { tracing::warn!("analytics query failed (rows): {e}"); Vec::new() }
        }
    }

    pub fn list_projections(&self) -> Vec<Projection> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT quarter, proj_hours, proj_value, notes, set_by FROM analytics_projections ORDER BY quarter DESC",
        ) {
            Ok(s) => s,
            Err(e) => { tracing::warn!("analytics query failed (prepare): {e}"); return Vec::new() }
        };
        let rows = stmt.query_map([], |r| {
            Ok(Projection {
                quarter: r.get(0)?,
                proj_hours: r.get(1)?,
                proj_value: r.get(2)?,
                notes: r.get(3)?,
                set_by: r.get(4)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => { tracing::warn!("analytics query failed (rows): {e}"); Vec::new() }
        }
    }

    pub fn upsert_projection(
        &self,
        quarter: &str,
        proj_hours: f64,
        proj_value: f64,
        notes: Option<&str>,
        set_by: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_projections (quarter, proj_hours, proj_value, notes, set_by)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(quarter) DO UPDATE SET
               proj_hours = excluded.proj_hours, proj_value = excluded.proj_value,
               notes = excluded.notes, set_by = excluded.set_by",
            params![quarter, proj_hours, proj_value, notes, set_by],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ── Uptime / status (slice 5) ───────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct MonitoredApp {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(rename = "probePath")]
    pub probe_path: Option<String>,
    pub enabled: bool,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Incident {
    pub id: i64,
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub severity: String,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "resolvedAt")]
    pub resolved_at: Option<i64>,
}

/// Lowercase slug: alnum runs joined by '-'. Empty ⇒ "app".
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    let s = out.trim_end_matches('-').to_string();
    if s.is_empty() {
        "app".to_string()
    } else {
        s
    }
}

impl AnalyticsStore {
    /// Register a probe target. `id` is a slug of `name`; a duplicate slug errors.
    pub fn add_app(&self, name: &str, url: &str, probe_path: Option<&str>) -> Result<MonitoredApp, String> {
        let id = slugify(name);
        let now = now_ms();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_monitored_apps (id, name, url, probe_path, enabled, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
            params![id, name, url, probe_path, now],
        )
        .map_err(|e| format!("could not add app (duplicate name?): {e}"))?;
        Ok(MonitoredApp { id, name: name.to_string(), url: url.to_string(), probe_path: probe_path.map(String::from), enabled: true, created_at: now })
    }

    pub fn list_apps(&self) -> Vec<MonitoredApp> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn
            .prepare("SELECT id, name, url, probe_path, enabled, created_at FROM analytics_monitored_apps ORDER BY name")
        {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("analytics list_apps failed (prepare): {e}");
                return Vec::new();
            }
        };
        let rows = stmt.query_map([], |r| {
            Ok(MonitoredApp {
                id: r.get(0)?,
                name: r.get(1)?,
                url: r.get(2)?,
                probe_path: r.get(3)?,
                enabled: r.get::<_, i64>(4)? != 0,
                created_at: r.get(5)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => {
                tracing::warn!("analytics list_apps failed (rows): {e}");
                Vec::new()
            }
        }
    }

    /// Stop monitoring (cascades checks + incidents). True if a row was removed.
    pub fn delete_app(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM analytics_monitored_apps WHERE id = ?1", params![id])
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    pub fn record_check(&self, app_id: &str, source: &str, state: u8, resp_ms: Option<i64>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_uptime_checks (app_id, checked_at, source, state, resp_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![app_id, now_ms(), source, state as i64, resp_ms],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Checks for an app since `since_ms`, as `(checked_at, state, resp_ms)`.
    pub fn recent_checks(&self, app_id: &str, since_ms: i64) -> Vec<(i64, u8, Option<i64>)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT checked_at, state, resp_ms FROM analytics_uptime_checks WHERE app_id = ?1 AND checked_at >= ?2 ORDER BY checked_at",
        ) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("analytics recent_checks failed (prepare): {e}");
                return Vec::new();
            }
        };
        let rows = stmt.query_map(params![app_id, since_ms], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? as u8, r.get::<_, Option<i64>>(2)?))
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => {
                tracing::warn!("analytics recent_checks failed (rows): {e}");
                Vec::new()
            }
        }
    }

    /// The currently-open incident for an app, if any.
    pub fn ongoing_incident(&self, app_id: &str) -> Option<Incident> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, app_id, type, severity, started_at, resolved_at FROM analytics_incidents
             WHERE app_id = ?1 AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1",
            params![app_id],
            |r| {
                Ok(Incident {
                    id: r.get(0)?,
                    app_id: r.get(1)?,
                    kind: r.get(2)?,
                    severity: r.get(3)?,
                    started_at: r.get(4)?,
                    resolved_at: r.get(5)?,
                })
            },
        )
        .optional()
        .unwrap_or_else(|e| {
            tracing::warn!("analytics ongoing_incident failed: {e}");
            None
        })
    }

    pub fn open_incident(&self, app_id: &str, kind: &str, severity: &str) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_incidents (app_id, type, severity, started_at) VALUES (?1, ?2, ?3, ?4)",
            params![app_id, kind, severity, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    /// Resolve all open incidents for an app. Returns how many were closed.
    pub fn resolve_incidents(&self, app_id: &str) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE analytics_incidents SET resolved_at = ?2 WHERE app_id = ?1 AND resolved_at IS NULL",
            params![app_id, now_ms()],
        )
        .unwrap_or(0)
    }

    /// Incidents filtered by `status` (`ongoing`|`resolved`|`all`) since `since_ms`.
    pub fn list_incidents(&self, status: &str, since_ms: Option<i64>) -> Vec<Incident> {
        let cond = match status {
            "ongoing" => "resolved_at IS NULL",
            "resolved" => "resolved_at IS NOT NULL",
            _ => "1=1",
        };
        let sql = format!(
            "SELECT id, app_id, type, severity, started_at, resolved_at FROM analytics_incidents
             WHERE {cond} AND started_at >= ?1 ORDER BY started_at DESC"
        );
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("analytics list_incidents failed (prepare): {e}");
                return Vec::new();
            }
        };
        let rows = stmt.query_map(params![since_ms.unwrap_or(0)], |r| {
            Ok(Incident {
                id: r.get(0)?,
                app_id: r.get(1)?,
                kind: r.get(2)?,
                severity: r.get(3)?,
                started_at: r.get(4)?,
                resolved_at: r.get(5)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => {
                tracing::warn!("analytics list_incidents failed (rows): {e}");
                Vec::new()
            }
        }
    }

    /// Prune uptime checks older than `older_than_ms` (keeps the store bounded).
    pub fn prune_uptime_checks(&self, older_than_ms: i64) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM analytics_uptime_checks WHERE checked_at < ?1", params![older_than_ms])
            .unwrap_or(0)
    }
}

// ── Headless surveys (slice 4) ──────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct Survey {
    pub id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    pub name: String,
    pub status: String,
    pub questions: Value,
    pub targeting: Value,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

fn json_text(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".to_string())
}
fn parse_json(s: &str, fallback: Value) -> Value {
    serde_json::from_str(s).unwrap_or(fallback)
}

impl AnalyticsStore {
    fn row_to_survey(r: &rusqlite::Row) -> rusqlite::Result<Survey> {
        let q: String = r.get(4)?;
        let t: String = r.get(5)?;
        Ok(Survey {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            name: r.get(2)?,
            status: r.get(3)?,
            questions: parse_json(&q, Value::Array(vec![])),
            targeting: parse_json(&t, json!({})),
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
        })
    }

    /// Create a survey. `id` is `sv_<8hex>` derived from name+time (stable per call).
    pub fn create_survey(
        &self,
        workspace_id: Option<&str>,
        name: &str,
        status: &str,
        questions: &Value,
        targeting: &Value,
    ) -> Result<Survey, String> {
        let now = now_ms();
        let mut h = Sha256::new();
        h.update(name.as_bytes());
        h.update(now.to_le_bytes());
        let id = format!("sv_{}", h.finalize()[..4].iter().map(|b| format!("{b:02x}")).collect::<String>());
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_surveys (id, workspace_id, name, status, questions, targeting, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, workspace_id, name, status, json_text(questions), json_text(targeting), now],
        )
        .map_err(|e| e.to_string())?;
        Ok(Survey {
            id,
            workspace_id: workspace_id.map(String::from),
            name: name.to_string(),
            status: status.to_string(),
            questions: questions.clone(),
            targeting: targeting.clone(),
            created_at: now,
            updated_at: now,
        })
    }

    /// Surveys, optionally scoped to a workspace (None ⇒ all).
    pub fn list_surveys(&self, workspace_id: Option<&str>) -> Vec<Survey> {
        let conn = self.conn.lock().unwrap();
        let sql = "SELECT id, workspace_id, name, status, questions, targeting, created_at, updated_at
                   FROM analytics_surveys WHERE (?1 IS NULL OR workspace_id = ?1) ORDER BY created_at DESC";
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("analytics list_surveys failed (prepare): {e}");
                return Vec::new();
            }
        };
        let rows = stmt.query_map(params![workspace_id], Self::row_to_survey);
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => {
                tracing::warn!("analytics list_surveys failed (rows): {e}");
                Vec::new()
            }
        }
    }

    /// Active surveys an end-user in workspace `ws` may see: that workspace's
    /// surveys PLUS global (workspace_id IS NULL) ones. When `ws` is None (the
    /// project is unknown / has no workspace), ONLY global surveys — never every
    /// tenant's (the cross-tenant leak guard).
    pub fn list_active_surveys_for(&self, ws: Option<&str>) -> Vec<Survey> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, workspace_id, name, status, questions, targeting, created_at, updated_at
             FROM analytics_surveys
             WHERE status = 'active' AND (workspace_id IS NULL OR (?1 IS NOT NULL AND workspace_id = ?1))
             ORDER BY created_at DESC",
        ) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("analytics list_active_surveys_for failed (prepare): {e}");
                return Vec::new();
            }
        };
        let rows = stmt.query_map(params![ws], Self::row_to_survey);
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => {
                tracing::warn!("analytics list_active_surveys_for failed (rows): {e}");
                Vec::new()
            }
        }
    }

    pub fn get_survey(&self, id: &str) -> Option<Survey> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, workspace_id, name, status, questions, targeting, created_at, updated_at
             FROM analytics_surveys WHERE id = ?1",
            params![id],
            Self::row_to_survey,
        )
        .optional()
        .unwrap_or_else(|e| {
            tracing::warn!("analytics get_survey failed: {e}");
            None
        })
    }

    /// Update a survey's editable fields. Returns true if the row existed.
    pub fn update_survey(&self, id: &str, name: &str, status: &str, questions: &Value, targeting: &Value) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let n = conn
            .execute(
                "UPDATE analytics_surveys SET name = ?2, status = ?3, questions = ?4, targeting = ?5, updated_at = ?6 WHERE id = ?1",
                params![id, name, status, json_text(questions), json_text(targeting), now_ms()],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    pub fn delete_survey(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM analytics_surveys WHERE id = ?1", params![id]).map(|n| n > 0).unwrap_or(false)
    }

    /// True if the user already answered OR dismissed the survey (once-per-user).
    pub fn has_interacted(&self, survey_id: &str, anon_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        let answered: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM analytics_survey_responses WHERE survey_id = ?1 AND anon_id = ?2",
                params![survey_id, anon_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if answered > 0 {
            return true;
        }
        let dismissed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM analytics_survey_dismissals WHERE survey_id = ?1 AND anon_id = ?2",
                params![survey_id, anon_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        dismissed > 0
    }

    pub fn record_response(&self, survey_id: &str, anon_id: &str, external_id: Option<&str>, answers: &Value) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        // Fall back to the user's stored external_id when the call omits one.
        let ext: Option<String> = match external_id {
            Some(e) => Some(e.to_string()),
            None => conn
                .query_row("SELECT external_id FROM analytics_users WHERE anon_id = ?1", params![anon_id], |r| r.get(0))
                .optional()
                .ok()
                .flatten(),
        };
        conn.execute(
            "INSERT INTO analytics_survey_responses (survey_id, anon_id, external_id, answers, submitted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![survey_id, anon_id, ext, json_text(answers), now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn dismiss_survey(&self, survey_id: &str, anon_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_survey_dismissals (survey_id, anon_id, dismissed_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(survey_id, anon_id) DO UPDATE SET dismissed_at = excluded.dismissed_at",
            params![survey_id, anon_id, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn response_count(&self, survey_id: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM analytics_survey_responses WHERE survey_id = ?1", params![survey_id], |r| r.get(0))
            .unwrap_or(0)
    }

    /// Responses for a survey (admin) — `{anonId, externalId, answers, submittedAt}`.
    pub fn list_responses(&self, survey_id: &str) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT anon_id, external_id, answers, submitted_at FROM analytics_survey_responses WHERE survey_id = ?1 ORDER BY submitted_at DESC",
        ) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("analytics list_responses failed (prepare): {e}");
                return Vec::new();
            }
        };
        let rows = stmt.query_map(params![survey_id], |r| {
            let answers: String = r.get(2)?;
            Ok(json!({
                "anonId": r.get::<_, String>(0)?,
                "externalId": r.get::<_, Option<String>>(1)?,
                "answers": parse_json(&answers, json!({})),
                "submittedAt": r.get::<_, i64>(3)?,
            }))
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => {
                tracing::warn!("analytics list_responses failed (rows): {e}");
                Vec::new()
            }
        }
    }
}

// ── Admin de-anon + audit (slice 6) ─────────────────────────────────────────

/// A de-anonymized user record — **PII**, only ever returned through the
/// X-Admin-Key path (slice 6), never the dashboard reads.
#[derive(Clone, Debug, Serialize)]
pub struct AnalyticsUserDeanon {
    #[serde(rename = "anonId")]
    pub anon_id: String,
    pub email: Option<String>,
    pub ip: Option<String>,
    pub role: String,
    pub consent: bool,
    #[serde(rename = "externalId")]
    pub external_id: Option<String>,
    #[serde(rename = "firstSeen")]
    pub first_seen: i64,
    #[serde(rename = "lastSeen")]
    pub last_seen: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct AdminAuditEntry {
    pub id: i64,
    pub action: String,
    pub target: Option<String>,
    #[serde(rename = "accessedAt")]
    pub accessed_at: i64,
    pub ip: Option<String>,
}

impl AnalyticsStore {
    fn row_to_deanon(r: &rusqlite::Row) -> rusqlite::Result<AnalyticsUserDeanon> {
        Ok(AnalyticsUserDeanon {
            anon_id: r.get(0)?,
            role: r.get(1)?,
            consent: r.get::<_, i64>(2)? != 0,
            external_id: r.get(3)?,
            first_seen: r.get(4)?,
            last_seen: r.get(5)?,
            email: r.get(6)?,
            ip: r.get(7)?,
        })
    }

    /// De-anonymized user list (anon + PII joined). Admin path only.
    pub fn list_users_deanon(&self) -> Vec<AnalyticsUserDeanon> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT u.anon_id, u.role, u.consent, u.external_id, u.first_seen, u.last_seen, p.email, p.ip
             FROM analytics_users u LEFT JOIN analytics_user_pii p ON p.anon_id = u.anon_id
             ORDER BY u.last_seen DESC",
        ) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("analytics list_users_deanon failed (prepare): {e}");
                return Vec::new();
            }
        };
        let rows = stmt.query_map([], Self::row_to_deanon);
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => {
                tracing::warn!("analytics list_users_deanon failed (rows): {e}");
                Vec::new()
            }
        }
    }

    /// One de-anonymized user, or None if the anon id is unknown.
    pub fn get_user_deanon(&self, anon_id: &str) -> Option<AnalyticsUserDeanon> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT u.anon_id, u.role, u.consent, u.external_id, u.first_seen, u.last_seen, p.email, p.ip
             FROM analytics_users u LEFT JOIN analytics_user_pii p ON p.anon_id = u.anon_id
             WHERE u.anon_id = ?1",
            params![anon_id],
            Self::row_to_deanon,
        )
        .optional()
        .unwrap_or_else(|e| {
            tracing::warn!("analytics get_user_deanon failed: {e}");
            None
        })
    }

    /// Record a PII-access event (every admin de-anon read). Returns the Result —
    /// callers MUST fail closed (don't reveal PII if the audit write didn't land).
    #[must_use = "fail closed: do not return PII if the audit write failed"]
    pub fn log_admin_access(&self, action: &str, target: Option<&str>, ip: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_admin_audit (action, target, accessed_at, ip) VALUES (?1, ?2, ?3, ?4)",
            params![action, target, now_ms(), ip],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_admin_audit(&self, limit: i64) -> Vec<AdminAuditEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn
            .prepare("SELECT id, action, target, accessed_at, ip FROM analytics_admin_audit ORDER BY accessed_at DESC LIMIT ?1")
        {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("analytics list_admin_audit failed (prepare): {e}");
                return Vec::new();
            }
        };
        let rows = stmt.query_map(params![limit.max(1)], |r| {
            Ok(AdminAuditEntry { id: r.get(0)?, action: r.get(1)?, target: r.get(2)?, accessed_at: r.get(3)?, ip: r.get(4)? })
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(e) => {
                tracing::warn!("analytics list_admin_audit failed (rows): {e}");
                Vec::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        // Unique per call — a process-global counter so parallel tests never share
        // a path even when now_ms() collides.
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("analytics-{}-{}-{}.db", std::process::id(), now_ms(), n))
    }

    #[test]
    fn identify_splits_pii_and_is_deterministic() {
        let path = tmp();
        let s = AnalyticsStore::open(&path).unwrap();

        // identify is deterministic: same email → same anon id.
        let a1 = s.identify("Sara.Chen@Company.com", Some("Specialist"), Some(true), Some("ext-42"), Some("10.0.0.1")).unwrap();
        let a2 = s.identify("sara.chen@company.com ", Some("Specialist"), Some(true), None, None).unwrap();
        assert_eq!(a1, a2, "same email (case/space-insensitive) → same anon id");
        assert_eq!(a1.len(), 16, "anon id is 16 hex chars (8 bytes)");

        // Re-identify with consent omitted (None) must NOT revoke prior consent.
        s.identify("sara.chen@company.com", None, None, None, None).unwrap();
        assert!(s.get_user(&a1).unwrap().consent, "omitted consent must be preserved, not revoked");
        assert_eq!(s.get_user(&a1).unwrap().role, "Specialist", "omitted role preserved");

        // The dashboard read carries NO email/ip.
        let u = s.get_user(&a1).expect("user exists");
        assert_eq!(u.role, "Specialist");
        assert!(u.consent);
        let json = serde_json::to_string(&u).unwrap();
        assert!(!json.contains("sara"), "anon user must not serialize PII: {json}");
        assert!(!json.contains("email"));

        // PII is reachable only via the explicit admin path.
        let pii = s.get_pii(&a1).expect("pii exists");
        assert_eq!(pii.email, "sara.chen@company.com");
        assert_eq!(pii.ip.as_deref(), Some("10.0.0.1")); // preserved when later omitted

        // first_seen stays fixed across re-identify; last_seen advances.
        assert!(u.first_seen <= u.last_seen);

        // Consent revocation CLEARS the stored IP (not just stops capturing new).
        s.identify("sara.chen@company.com", None, Some(false), None, None).unwrap();
        assert!(!s.get_user(&a1).unwrap().consent, "consent revoked");
        assert!(s.get_pii(&a1).unwrap().ip.is_none(), "IP cleared on consent revocation");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn seeds_roles_and_audits_baselines() {
        let path = tmp();
        let s = AnalyticsStore::open(&path).unwrap();

        let roles = s.roles();
        assert_eq!(roles.len(), 5);
        assert!(roles.iter().any(|r| r.role == "Director" && (r.hourly_rate - 85.0).abs() < 0.01));

        s.upsert_baseline("geocode-addresses", 8.0, 2.4, true, "admin", Some("ed"), Some("init")).unwrap();
        s.upsert_baseline("geocode-addresses", 8.0, 2.0, true, "admin", Some("ed"), Some("faster tool")).unwrap();
        let bl = s.list_baselines();
        assert_eq!(bl.len(), 1, "upsert, not duplicate");
        assert!((bl[0].tool_min - 2.0).abs() < 0.01, "latest value wins");

        // history keeps both revisions (audit trail)
        let conn = s.conn.lock().unwrap();
        let hist: i64 = conn
            .query_row("SELECT COUNT(*) FROM analytics_baseline_history WHERE fn_name='geocode-addresses'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hist, 2, "every baseline change is recorded");

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn submissions_accept_dismiss_and_projections() {
        let path = tmp();
        let s = AnalyticsStore::open(&path).unwrap();
        s.upsert_baseline("geocode", 8.0, 2.4, true, "admin", None, Some("seed")).unwrap();

        let id = s.add_submission("geocode", 6.0, Some("A3F7")).unwrap();
        let id2 = s.add_submission("export", 20.0, None).unwrap();
        assert_eq!(s.list_submissions().len(), 2);

        // Accept geocode → baseline manual=6, tool/per_item preserved, source=crowd.
        assert!(s.accept_submission(id).unwrap());
        let bl = s.list_baselines();
        let geo = bl.iter().find(|b| b.fn_name == "geocode").unwrap();
        assert_eq!(geo.manual_min, 6.0);
        assert!((geo.tool_min - 2.4).abs() < 0.01 && geo.per_item);
        assert_eq!(geo.source, "crowd");
        assert_eq!(s.list_submissions().len(), 1, "accepted submission removed");
        assert!(!s.accept_submission(id).unwrap(), "second accept of the same id is a no-op (atomic delete)");
        assert!(s.baseline_history("geocode").len() >= 2, "seed + accept recorded");

        // Dismiss the other.
        assert!(s.delete_submission(id2));
        assert_eq!(s.list_submissions().len(), 0);

        // Projections upsert (notes/set_by; actuals are derived, not stored).
        s.upsert_projection("Q1 2026", 1200.0, 68000.0, Some("headcount +2"), Some("Director")).unwrap();
        s.upsert_projection("Q1 2026", 1300.0, 70000.0, None, Some("Director")).unwrap();
        let projs = s.list_projections();
        assert_eq!(projs.len(), 1);
        assert_eq!(projs[0].proj_hours, 1300.0);
        assert_eq!(projs[0].set_by.as_deref(), Some("Director"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn uptime_apps_checks_and_incidents_roundtrip() {
        let path = tmp();
        let s = AnalyticsStore::open(&path).unwrap();

        let app = s.add_app("My API", "https://api.example.com", Some("/health")).unwrap();
        assert_eq!(app.id, "my-api");
        assert!(s.add_app("My API", "https://x", None).is_err(), "duplicate slug errors");
        assert_eq!(s.list_apps().len(), 1);

        s.record_check(&app.id, "probe", 0, Some(120)).unwrap();
        s.record_check(&app.id, "probe", 2, None).unwrap();
        assert_eq!(s.recent_checks(&app.id, now_ms() - 86_400_000).len(), 2);

        assert!(s.ongoing_incident(&app.id).is_none());
        let id = s.open_incident(&app.id, "Slow response (512ms)", "degraded").unwrap();
        assert_eq!(s.ongoing_incident(&app.id).unwrap().id, id);
        assert_eq!(s.list_incidents("ongoing", None).len(), 1);
        assert_eq!(s.resolve_incidents(&app.id), 1);
        assert!(s.ongoing_incident(&app.id).is_none());
        assert_eq!(s.list_incidents("resolved", None).len(), 1);

        // delete cascades checks + incidents (FK ON DELETE CASCADE).
        assert!(s.delete_app(&app.id));
        assert_eq!(s.recent_checks(&app.id, 0).len(), 0);
        assert_eq!(s.list_incidents("all", None).len(), 0);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn surveys_create_target_respond_dismiss() {
        let path = tmp();
        let s = AnalyticsStore::open(&path).unwrap();
        let anon = s.identify("dev@co.com", Some("Specialist"), Some(true), Some("ext-99"), None).unwrap();

        let q = json!([{ "id": "q1", "type": "rating", "required": true }, { "id": "q2", "type": "text" }]);
        let t = json!({ "roles": ["Specialist"], "samplePct": 100 });
        let sv = s.create_survey(Some("ws1"), "CSAT", "active", &q, &t).unwrap();
        assert!(sv.id.starts_with("sv_"));
        assert_eq!(s.list_surveys(Some("ws1")).len(), 1);
        assert_eq!(s.list_surveys(Some("other")).len(), 0, "workspace-scoped");
        assert_eq!(s.get_survey(&sv.id).unwrap().questions[0]["id"], "q1");

        // respond (externalId omitted → resolved from the user's stored ext-99).
        assert!(!s.has_interacted(&sv.id, &anon));
        s.record_response(&sv.id, &anon, None, &json!({ "q1": 5, "q2": "great" })).unwrap();
        assert!(s.has_interacted(&sv.id, &anon), "answered ⇒ once-per-user suppress");
        assert_eq!(s.response_count(&sv.id), 1);
        let resp = s.list_responses(&sv.id);
        assert_eq!(resp[0]["externalId"], "ext-99", "external_id resolved from the user record");
        assert_eq!(resp[0]["answers"]["q1"], 5);

        // a different user: dismissal suppresses too.
        let anon2 = s.identify("b@co.com", Some("Director"), Some(true), None, None).unwrap();
        s.dismiss_survey(&sv.id, &anon2).unwrap();
        assert!(s.has_interacted(&sv.id, &anon2), "dismissed ⇒ suppress");

        // update + delete (cascades responses/dismissals).
        assert!(s.update_survey(&sv.id, "CSAT v2", "inactive", &q, &t).unwrap());
        assert_eq!(s.get_survey(&sv.id).unwrap().status, "inactive");
        assert!(s.delete_survey(&sv.id));
        assert!(s.get_survey(&sv.id).is_none());
        assert_eq!(s.response_count(&sv.id), 0);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn deanon_joins_pii_and_audit_logs() {
        let path = tmp();
        let s = AnalyticsStore::open(&path).unwrap();
        let anon = s.identify("Jo@Co.com", Some("Director"), Some(true), Some("ext-1"), Some("1.2.3.4")).unwrap();

        // De-anon joins the PII the anon reads never expose.
        let d = s.get_user_deanon(&anon).expect("deanon record");
        assert_eq!(d.email.as_deref(), Some("jo@co.com"));
        assert_eq!(d.ip.as_deref(), Some("1.2.3.4"));
        assert_eq!(d.role, "Director");
        assert_eq!(d.external_id.as_deref(), Some("ext-1"));
        assert_eq!(s.list_users_deanon().len(), 1);
        assert!(s.get_user_deanon("ZZZZZZZZ").is_none());

        // Audit log (newest first).
        s.log_admin_access("list_users", None, Some("10.0.0.1")).unwrap();
        s.log_admin_access("deanon_user", Some(&anon), Some("10.0.0.1")).unwrap();
        let audit = s.list_admin_audit(50);
        assert_eq!(audit.len(), 2);
        assert_eq!(audit[0].action, "deanon_user");
        assert_eq!(audit[0].target.as_deref(), Some(anon.as_str()));

        let _ = std::fs::remove_file(&path);
    }
}
