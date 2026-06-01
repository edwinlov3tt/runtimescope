//! Write-ahead log — the durability contract from `docs/specs/wire-protocol.md` §8.
//!
//! `append(events)` then `commit()` ⇒ the bytes are `fsync`'d to stable storage
//! before `commit()` returns (`fsync(2)` — crash-durable; see `commit`). Recovery is torn-tail
//! tolerant: replay stops at the first unparseable line, because a line that
//! never completed its `fsync` was never durable. Mirrors `packages/collector/
//! src/wal.ts`.
//!
//! Slice scope: a single active file. Sealed-file rotation + bounded truncation
//! (wal.ts `rotate`/`deleteSealed`) are an M1-completion TODO — not exercised by
//! the `durability` conformance test, which does one SIGKILL + restart.

use serde_json::Value;
use std::fs::{create_dir_all, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Wal {
    active: File,
    seq: u64,
}

impl Wal {
    /// Open (create) the active WAL under `dir`. Heals a torn tail first: a crash
    /// mid-append can leave a partial/garbage final line; we truncate the file to
    /// its last complete, parseable, newline-terminated line BEFORE reopening for
    /// append, so future writes land on clean data and a later recovery doesn't
    /// stop early and skip them (audit #4).
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        create_dir_all(dir)?;
        let path = Self::active_path(dir);
        Self::heal_torn_tail(&path);
        let active = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Wal { active, seq: 0 })
    }

    fn active_path(dir: &Path) -> PathBuf {
        dir.join("active.jsonl")
    }

    /// Truncate the active file to its last good-line boundary (best-effort).
    fn heal_torn_tail(path: &Path) {
        let Ok(content) = std::fs::read_to_string(path) else { return };
        if content.is_empty() {
            return;
        }
        let mut valid_len = 0usize;
        for line in content.split_inclusive('\n') {
            if !line.ends_with('\n') {
                break; // partial final line — never fsync'd, drop it
            }
            let trimmed = line.trim_end();
            if !trimmed.is_empty() && serde_json::from_str::<Value>(trimmed).is_err() {
                break; // unparseable line — torn; stop here
            }
            valid_len += line.len();
        }
        if valid_len < content.len() {
            if let Ok(f) = OpenOptions::new().write(true).open(path) {
                let _ = f.set_len(valid_len as u64);
            }
        }
    }

    /// Clear the active WAL. Safe to call once a batch's events are durably in
    /// SQLite (SQLite's own WAL owns their durability then) — bounds WAL growth +
    /// keeps recovery O(in-flight), not O(history) (audit #3). No fsync needed:
    /// a crash before the truncate hits disk just replays already-stored events
    /// (INSERT OR IGNORE dedups).
    pub fn truncate(&mut self) -> std::io::Result<()> {
        self.active.set_len(0)?;
        self.seq = 0;
        Ok(())
    }

    /// Append a batch as `{seq, project, event}` JSONL lines. The `project` is
    /// carried because it's derived from the session at ingest time and isn't on
    /// the event itself — recovery needs it to restore project scoping. Not
    /// durable until `commit`.
    pub fn append(&mut self, project: &str, events: &[Value]) -> std::io::Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let mut buf = String::new();
        for ev in events {
            self.seq += 1;
            buf.push_str(
                &serde_json::json!({ "seq": self.seq, "project": project, "event": ev }).to_string(),
            );
            buf.push('\n');
        }
        self.active.write_all(buf.as_bytes())
    }

    /// fsync the active file. Durability contract: returns only once the appended
    /// bytes have been handed to the storage stack (`fsync`), which survives a
    /// process crash and an OS crash — the SIGKILL crash-recovery contract.
    ///
    /// We deliberately use `fsync(2)`, NOT `File::sync_all` (which on macOS issues
    /// `fcntl(F_FULLFSYNC)` — a full drive-cache flush). F_FULLFSYNC per batch
    /// dominated p99 tail latency, and it only buys *power-loss* durability beyond
    /// `fsync` — a guarantee even SQLite's `synchronous=NORMAL/FULL` doesn't make
    /// by default on macOS, and one the Node collector (a RAM ring) never made at
    /// all. `fsync` keeps us strictly more durable than the reference while paying
    /// the cost that actually matches the contract we test.
    pub fn commit(&mut self) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            // SAFETY: `self.active` owns a valid, open fd for the duration of the call.
            if unsafe { libc::fsync(self.active.as_raw_fd()) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            self.active.sync_all()
        }
    }

    /// Replay every recovery file under `dir` into a flat, ingestion-ordered
    /// list of `(project, event)`. Torn-tail tolerant per file.
    pub fn recover(dir: &Path) -> Vec<(String, Value)> {
        let mut out = Vec::new();
        // Sealed files first (oldest-first by name), then the active file.
        let mut files: Vec<PathBuf> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut sealed: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("sealed-") && n.ends_with(".jsonl"))
                })
                .collect();
            sealed.sort();
            files.extend(sealed);
        }
        files.push(Self::active_path(dir));

        for path in files {
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            for line in raw.split('\n') {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(entry) => {
                        if let Some(ev) = entry.get("event") {
                            let project = entry
                                .get("project")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            out.push((project, ev.clone()));
                        }
                    }
                    // Torn tail — everything after the last fsync may be garbage.
                    Err(_) => break,
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn append_commit_then_recover_roundtrips() {
        let dir = std::env::temp_dir().join(format!("wal-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        {
            let mut wal = Wal::open(&dir).unwrap();
            wal.append("proj_a", &[json!({"eventId": "e1"}), json!({"eventId": "e2"})]).unwrap();
            wal.commit().unwrap();
        }
        let recovered = Wal::recover(&dir);
        assert_eq!(recovered.len(), 2);
        assert_eq!(recovered[0].0, "proj_a");
        assert_eq!(recovered[0].1["eventId"], "e1");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_after_torn_tail_recovers_everything() {
        // Audit #4: a torn tail must be HEALED on open, so events appended after
        // it are not lost on a later recovery. Without truncation, recovery would
        // stop at the torn line and skip the post-tear append.
        let dir = std::env::temp_dir().join(format!("wal-heal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let good = json!({ "seq": 1, "project": "p", "event": { "eventId": "e1" } }).to_string();
        // good line + a torn (partial, unterminated) line
        std::fs::write(dir.join("active.jsonl"), format!("{good}\n{{\"seq\":2,\"proj")).unwrap();

        // open() heals the torn tail; then we append a fresh batch + commit.
        let mut wal = Wal::open(&dir).unwrap();
        wal.append("p", &[json!({ "eventId": "e2" })]).unwrap();
        wal.commit().unwrap();

        let recovered = Wal::recover(&dir);
        assert_eq!(recovered.len(), 2, "post-tear append must survive recovery");
        assert_eq!(recovered[0].1["eventId"], "e1");
        assert_eq!(recovered[1].1["eventId"], "e2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn truncate_clears_the_active_wal() {
        let dir = std::env::temp_dir().join(format!("wal-trunc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut wal = Wal::open(&dir).unwrap();
        wal.append("p", &[json!({ "eventId": "e1" })]).unwrap();
        wal.commit().unwrap();
        wal.truncate().unwrap();
        assert_eq!(Wal::recover(&dir).len(), 0, "truncate empties the active WAL");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recovery_stops_at_a_torn_tail() {
        // A crash mid-append leaves a partial final line. Recovery must keep the
        // fsync'd lines before it and drop the garbage tail (durability §8).
        let dir = std::env::temp_dir().join(format!("wal-torn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let good = json!({ "seq": 1, "project": "p", "event": { "eventId": "ok" } }).to_string();
        let good2 = json!({ "seq": 2, "project": "p", "event": { "eventId": "ok2" } }).to_string();
        // Third line is truncated JSON (no fsync ever completed for it).
        std::fs::write(dir.join("active.jsonl"), format!("{good}\n{good2}\n{{\"seq\":3,\"proj")).unwrap();

        let recovered = Wal::recover(&dir);
        assert_eq!(recovered.len(), 2, "torn tail must be dropped");
        assert_eq!(recovered[1].1["eventId"], "ok2");
        std::fs::remove_dir_all(&dir).ok();
    }
}
