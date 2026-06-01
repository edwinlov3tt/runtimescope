//! First-run guard for the Node → Rust cutover (M6 Slice D).
//!
//! `~/.runtimescope` uses the **same filenames** under Node and the Rust port
//! (`collector.db`, `pm.db`), but the schemas differ (e.g. Rust made
//! `events.session_id` nullable; the pm schema gained tables + FKs). On the first
//! Rust run against a dir that still holds **Node-era** data we must not silently
//! operate on an incompatible store. Default: move the legacy dbs aside to a
//! timestamped backup and start fresh. `RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1` leaves
//! them untouched (open as-is). Idempotent via a `.rust-store` marker.
//!
//! The Node-vs-Rust signal is the `events` table's `session_id` nullability
//! (Node = `NOT NULL`, Rust = nullable — a deliberate M1 difference), NOT merely
//! "a db exists" — so a db already written by the Rust port is recognized as
//! migrated and left alone (no false-positive backup of live Rust data).

use std::path::{Path, PathBuf};

const MARKER: &str = ".rust-store";
const LEGACY_FILES: &[&str] = &[
    "collector.db", "collector.db-shm", "collector.db-wal",
    "pm.db", "pm.db-shm", "pm.db-wal",
];

/// Run once at collector startup, BEFORE opening the stores. Returns `Err` only
/// when a required backup FAILED — the caller should then abort rather than start
/// on un-migrated, incompatible Node data.
pub fn first_run_guard(data_dir: &Path) -> Result<(), String> {
    let marker = data_dir.join(MARKER);
    if marker.exists() {
        return Ok(()); // already handled on a prior run
    }
    let collector_db = data_dir.join("collector.db");
    if !collector_db.exists() {
        claim_marker(data_dir); // fresh install — nothing to migrate
        return Ok(());
    }
    if !is_node_era(&collector_db) {
        // Already a Rust-format store (e.g. created by a pre-marker Rust build) —
        // adopt it silently; do NOT back up live data.
        claim_marker(data_dir);
        return Ok(());
    }

    // Genuine Node-era data. Atomically claim the migration so two binaries
    // starting concurrently don't both back up (→ split state). Loser skips.
    if !claim_marker(data_dir) {
        return Ok(()); // another process is performing the cutover
    }

    if std::env::var("RUNTIMESCOPE_PRESERVE_LEGACY_DATA").as_deref() == Ok("1") {
        eprintln!(
            "[RuntimeScope] ⚠ Legacy Node-era data found in {} and RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1 \
             is set — leaving it untouched and opening as-is. The Rust store schema differs from Node's, \
             so this may misbehave; unset the variable to back the old data up and start fresh.",
            data_dir.display()
        );
        return Ok(());
    }

    match backup_legacy(data_dir) {
        Ok(dest) => {
            eprintln!(
                "[RuntimeScope] ⚠ Found legacy Node-era data — the Rust port uses an incompatible store. \
                 Moved it to {} and started fresh. (Set RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1 to leave the \
                 old files in place instead.)",
                dest.display()
            );
            Ok(())
        }
        Err(e) => {
            // Backing up failed → do NOT run on a half-migrated / incompatible
            // store. Clear the marker so a fixed retry re-runs the cutover.
            let _ = std::fs::remove_file(&marker);
            Err(format!(
                "legacy Node-era data backup failed: {e}. Move ~/.runtimescope/collector.db & pm.db aside \
                 manually (or set RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1), then restart."
            ))
        }
    }
}

/// Atomically claim the data dir via the marker (`create_new` — only the first
/// process succeeds). Returns true iff THIS call created it. Non-migration paths
/// ignore the bool (a concurrent fresh-install just means the other wrote it).
fn claim_marker(data_dir: &Path) -> bool {
    let _ = std::fs::create_dir_all(data_dir);
    match std::fs::OpenOptions::new().write(true).create_new(true).open(data_dir.join(MARKER)) {
        Ok(mut f) => {
            use std::io::Write;
            let _ = f.write_all(b"v1\n");
            true
        }
        Err(_) => false, // already existed (another process / prior run)
    }
}

/// True iff `collector.db`'s `events.session_id` column is `NOT NULL` (the Node
/// schema; Rust made it nullable). Data-safety bias: a file that **exists but
/// won't open/read** (locked by a running Node collector, WAL-mode read quirks,
/// corruption) is treated as legacy → backed up, never silently overwritten. A
/// genuinely-Rust store is short-circuited earlier by the marker, so this can't
/// false-positive a live Rust db.
fn is_node_era(db: &Path) -> bool {
    if !db.exists() {
        return false; // absent ≠ legacy
    }
    // Open read-WRITE (not read-only): a WAL-mode db can't always be opened
    // read-only without creating the -shm, so a read-only open could spuriously
    // fail on a perfectly good Node db and mis-skip the backup (data loss). We
    // only read the schema. If it won't open at all → treat as legacy (back up).
    let Ok(conn) = rusqlite::Connection::open(db) else {
        return true;
    };
    let Ok(mut stmt) = conn.prepare("PRAGMA table_info(events)") else { return true };
    let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(3)?))) else {
        return true;
    };
    for (name, notnull) in rows.flatten() {
        if name == "session_id" {
            return notnull == 1;
        }
    }
    false // no events table → empty/foreign db, not Node-era legacy data
}

/// Move the legacy db files into a timestamped `legacy-backup-<secs>/` dir.
/// Returns `Err` listing any file that could NOT be moved — a partial move is a
/// split state the caller must surface, not silently accept.
fn backup_legacy(data_dir: &Path) -> Result<PathBuf, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = data_dir.join(format!("legacy-backup-{ts}"));
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut errors = Vec::new();
    for name in LEGACY_FILES {
        let src = data_dir.join(name);
        if src.exists() {
            if let Err(e) = std::fs::rename(&src, dest.join(name)) {
                errors.push(format!("{name}: {e}"));
            }
        }
    }
    if errors.is_empty() {
        Ok(dest)
    } else {
        Err(format!("{} file(s) could not be moved: {}", errors.len(), errors.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // RUNTIMESCOPE_PRESERVE_LEGACY_DATA is process-global; serialize the tests that
    // read/mutate it so parallel runs don't clobber each other's env state.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "rs-mig-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn make_db(dir: &Path, node_era: bool) {
        let conn = rusqlite::Connection::open(dir.join("collector.db")).unwrap();
        let session = if node_era { "session_id TEXT NOT NULL" } else { "session_id TEXT" };
        conn.execute_batch(&format!(
            "CREATE TABLE events (id INTEGER PRIMARY KEY, event_id TEXT, {session}, project TEXT, \
             event_type TEXT, timestamp INTEGER, data TEXT);"
        ))
        .unwrap();
    }

    #[test]
    fn fresh_install_writes_marker_no_backup() {
        let d = tmp();
        first_run_guard(&d).expect("guard ok");
        assert!(d.join(MARKER).exists());
        assert!(std::fs::read_dir(&d).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with("legacy-backup")));
    }

    #[test]
    fn rust_era_db_is_adopted_silently_not_backed_up() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let d = tmp();
        make_db(&d, false); // Rust schema (session_id nullable)
        std::env::remove_var("RUNTIMESCOPE_PRESERVE_LEGACY_DATA");
        first_run_guard(&d).expect("guard ok");
        assert!(d.join(MARKER).exists());
        assert!(d.join("collector.db").exists(), "Rust-era db must NOT be moved");
        assert!(!has_backup(&d), "no backup for an already-Rust store");
    }

    #[test]
    fn node_era_db_is_backed_up_by_default() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let d = tmp();
        make_db(&d, true); // Node schema (session_id NOT NULL)
        std::fs::write(d.join("pm.db"), b"x").unwrap();
        std::env::remove_var("RUNTIMESCOPE_PRESERVE_LEGACY_DATA");
        first_run_guard(&d).expect("guard ok");
        assert!(d.join(MARKER).exists());
        assert!(!d.join("collector.db").exists(), "legacy collector.db moved aside");
        assert!(!d.join("pm.db").exists(), "legacy pm.db moved aside");
        assert!(has_backup(&d), "a legacy-backup dir was created");
    }

    #[test]
    fn node_era_db_is_preserved_in_place_with_env() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let d = tmp();
        make_db(&d, true);
        std::env::set_var("RUNTIMESCOPE_PRESERVE_LEGACY_DATA", "1");
        first_run_guard(&d).expect("guard ok");
        std::env::remove_var("RUNTIMESCOPE_PRESERVE_LEGACY_DATA");
        assert!(d.join(MARKER).exists());
        assert!(d.join("collector.db").exists(), "PRESERVE=1 leaves the db in place");
        assert!(!has_backup(&d), "PRESERVE=1 makes no backup");
    }

    #[test]
    fn marker_makes_it_idempotent() {
        let d = tmp();
        make_db(&d, true);
        std::fs::write(d.join(MARKER), b"v1\n").unwrap(); // pretend a prior run handled it
        first_run_guard(&d).expect("guard ok");
        assert!(d.join("collector.db").exists(), "marker present → no action");
        assert!(!has_backup(&d));
    }

    fn has_backup(d: &Path) -> bool {
        std::fs::read_dir(d)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("legacy-backup"))
    }
}
