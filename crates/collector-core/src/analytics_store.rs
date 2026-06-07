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
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
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
    /// dashboard never needs the email. 8 uppercase hex chars (4 bytes of SHA-256)
    /// — ~4.3B space, ample for internal-tools scale.
    pub fn anon_id_for(email: &str) -> String {
        let mut h = Sha256::new();
        h.update(email.trim().to_lowercase().as_bytes());
        let d = h.finalize();
        format!("{:02X}{:02X}{:02X}{:02X}", d[0], d[1], d[2], d[3])
    }

    /// Record/refresh an end-user identity (SDK `identify()`). Upserts the anon
    /// user (role/consent + last_seen; first_seen set once) and the PII row.
    /// Returns the anon id the SDK then stamps on its `track()` events.
    pub fn identify(
        &self,
        email: &str,
        role: &str,
        consent: bool,
        ip: Option<&str>,
    ) -> Result<String, String> {
        let anon = Self::anon_id_for(email);
        let now = now_ms();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_users (anon_id, role, consent, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(anon_id) DO UPDATE SET
               role = excluded.role, consent = excluded.consent, last_seen = excluded.last_seen",
            params![anon, role, consent as i64, now],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO analytics_user_pii (anon_id, email, ip) VALUES (?1, ?2, ?3)
             ON CONFLICT(anon_id) DO UPDATE SET
               email = excluded.email, ip = COALESCE(excluded.ip, analytics_user_pii.ip)",
            params![anon, email.trim().to_lowercase(), ip],
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
        .ok()
        .flatten()
    }

    pub fn list_users(&self) -> Vec<AnalyticsUser> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT anon_id, role, consent, first_seen, last_seen FROM analytics_users ORDER BY last_seen DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
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
            Err(_) => Vec::new(),
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
        .ok()
        .flatten()
    }

    pub fn roles(&self) -> Vec<AnalyticsRole> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT role, hourly_rate FROM analytics_roles ORDER BY hourly_rate") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |r| Ok(AnalyticsRole { role: r.get(0)?, hourly_rate: r.get(1)? }));
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
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
        let now = now_ms();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analytics_baselines (fn_name, manual_min, tool_min, per_item, source, updated_at, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(fn_name) DO UPDATE SET
               manual_min = excluded.manual_min, tool_min = excluded.tool_min,
               per_item = excluded.per_item, source = excluded.source,
               updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            params![fn_name, manual_min, tool_min, per_item as i64, source, now, changed_by],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO analytics_baseline_history (fn_name, manual_min, tool_min, per_item, changed_at, changed_by, reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![fn_name, manual_min, tool_min, per_item as i64, now, changed_by, reason],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_baselines(&self) -> Vec<Baseline> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT fn_name, manual_min, tool_min, per_item, source, updated_at FROM analytics_baselines ORDER BY fn_name",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
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
            Err(_) => Vec::new(),
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
    fn current_baseline(&self, fn_name: &str) -> Option<(f64, f64, bool)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT manual_min, tool_min, per_item FROM analytics_baselines WHERE fn_name = ?1",
            params![fn_name],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
        )
        .optional()
        .ok()
        .flatten()
    }

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
            Err(_) => return Vec::new(),
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
            Err(_) => Vec::new(),
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
    /// estimate (preserving tool/per_item), source=`crowd`, then dismiss it.
    pub fn accept_submission(&self, id: i64) -> Result<bool, String> {
        let row: Option<(String, f64)> = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT fn_name, manual_min FROM analytics_baseline_submissions WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
        };
        let Some((fn_name, est)) = row else { return Ok(false) };
        let (_, tool, per_item) = self.current_baseline(&fn_name).unwrap_or((est, 0.0, false));
        self.upsert_baseline(&fn_name, est, tool, per_item, "crowd", None, Some("accepted crowd submission"))?;
        self.delete_submission(id);
        Ok(true)
    }

    pub fn baseline_history(&self, fn_name: &str) -> Vec<BaselineHistoryEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT manual_min, tool_min, per_item, changed_at, changed_by, reason FROM analytics_baseline_history WHERE fn_name = ?1 ORDER BY changed_at DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
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
            Err(_) => Vec::new(),
        }
    }

    pub fn list_projections(&self) -> Vec<Projection> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT quarter, proj_hours, proj_value, notes, set_by FROM analytics_projections ORDER BY quarter DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
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
            Err(_) => Vec::new(),
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
        let a1 = s.identify("Sara.Chen@Company.com", "Specialist", true, Some("10.0.0.1")).unwrap();
        let a2 = s.identify("sara.chen@company.com ", "Specialist", true, None).unwrap();
        assert_eq!(a1, a2, "same email (case/space-insensitive) → same anon id");
        assert_eq!(a1.len(), 8, "anon id is 8 hex chars");

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
}
