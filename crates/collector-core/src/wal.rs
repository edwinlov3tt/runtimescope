//! Write-ahead log — the durability contract from `docs/specs/wire-protocol.md` §8.
//!
//! `append(events)` then `commit()` ⇒ the bytes are `fsync`'d to stable storage
//! before `commit()` returns (here: `File::sync_all`). Recovery is torn-tail
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
    /// Open (create) the active WAL under `dir`.
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        create_dir_all(dir)?;
        let active = OpenOptions::new()
            .create(true)
            .append(true)
            .open(Self::active_path(dir))?;
        Ok(Wal { active, seq: 0 })
    }

    fn active_path(dir: &Path) -> PathBuf {
        dir.join("active.jsonl")
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

    /// fsync the active file. Durability contract: returns only once the bytes
    /// are on stable storage.
    pub fn commit(&mut self) -> std::io::Result<()> {
        self.active.sync_all()
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
