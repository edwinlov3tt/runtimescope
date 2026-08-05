//! Write-ahead log — the durability contract from `docs/specs/wire-protocol.md` §8.
//!
//! `append(events)` then `commit()` ⇒ the bytes are `fsync`'d to stable storage
//! before `commit()` returns (`fsync(2)` — crash-durable; see `commit`). Recovery is torn-tail
//! tolerant: replay stops at the first unparseable line, because a line that
//! never completed its `fsync` was never durable.
//!
//! All file scanning is BYTE-oriented, never `read_to_string`: a crash can tear
//! the file mid-UTF-8-codepoint (any non-ASCII string in an event), and a
//! whole-file UTF-8 validation failure must cost only the torn tail, not every
//! fsync'd line before it.
//!
//! The owner takes an exclusive advisory lock (`flock`) on the WAL dir for the
//! lifetime of the `Wal`, so a second process (e.g. an MCP server racing a
//! standalone collector) can never heal/replay/truncate a live WAL out from
//! under its owner.
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
    path: PathBuf,
    seq: u64,
    /// Set when an `append` failed partway: the file may end in a torn line.
    /// The next `append` must heal it first, or its lines would sit behind
    /// garbage that recovery stops at — fsync'd but unreachable.
    needs_heal: bool,
    /// Exclusive owner lock on the WAL dir (held open for the Wal's lifetime;
    /// the OS releases it on process death, including SIGKILL).
    _lock: File,
}

impl Wal {
    /// Open (create) the active WAL under `dir`. Takes the exclusive owner lock,
    /// then heals a torn tail: a crash mid-append can leave a partial/garbage
    /// final line; we truncate the file to its last complete, parseable,
    /// newline-terminated line BEFORE reopening for append, so future writes
    /// land on clean data and a later recovery doesn't stop early and skip them
    /// (audit #4). Restores `seq` from the last healed line so reopened WALs
    /// don't emit duplicate sequence numbers within one file.
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        create_dir_all(dir)?;
        let lock = Self::acquire_owner_lock(dir)?;
        let path = Self::active_path(dir);
        let seq = match Self::heal_torn_tail(&path) {
            Ok(last_seq) => last_seq,
            Err(e) => {
                // The active file exists but can't be read/truncated (real IO
                // error — permissions, disk). Appending after unknown bytes
                // risks stranding fsync'd data behind garbage, and silently
                // starting over would discard it. Set it aside, loudly, so the
                // bytes survive for manual recovery and the collector still
                // boots with a clean WAL.
                let aside = dir.join(format!(
                    "corrupt-{}.jsonl",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0)
                ));
                eprintln!(
                    "[RuntimeScope] durability: cannot heal WAL ({e}); moving {} aside to {}",
                    path.display(),
                    aside.display()
                );
                std::fs::rename(&path, &aside)?;
                0
            }
        };
        let active = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Wal { active, path, seq, needs_heal: false, _lock: lock })
    }

    fn active_path(dir: &Path) -> PathBuf {
        dir.join("active.jsonl")
    }

    /// Exclusive, non-blocking advisory lock on `dir/.owner.lock`. Fails fast
    /// with a clear error when another live process owns this WAL — better to
    /// refuse to start than to truncate a WAL someone else is fsyncing into.
    fn acquire_owner_lock(dir: &Path) -> std::io::Result<File> {
        let lock = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false) // contents irrelevant — only the flock matters
            .open(dir.join(".owner.lock"))?;
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            // SAFETY: `lock` owns a valid, open fd for the duration of the call.
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                let os = std::io::Error::last_os_error();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    format!(
                        "WAL at {} is owned by another running collector ({os}); \
                         refusing to open it as a second writer",
                        dir.display()
                    ),
                ));
            }
        }
        Ok(lock)
    }

    /// Truncate the active file to its last good-line boundary (byte-oriented,
    /// torn-UTF-8 safe). Returns the highest `seq` among the surviving lines.
    fn heal_torn_tail(path: &Path) -> std::io::Result<u64> {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e),
        };
        if bytes.is_empty() {
            return Ok(0);
        }
        let mut valid_len = 0usize;
        let mut last_seq = 0u64;
        for line in bytes.split_inclusive(|&b| b == b'\n') {
            if line.last() != Some(&b'\n') {
                break; // partial final line — never fsync'd, drop it
            }
            let trimmed = line.trim_ascii();
            if !trimmed.is_empty() {
                match serde_json::from_slice::<Value>(trimmed) {
                    Ok(entry) => {
                        if let Some(s) = entry.get("seq").and_then(Value::as_u64) {
                            last_seq = last_seq.max(s);
                        }
                    }
                    Err(_) => break, // unparseable line — torn; stop here
                }
            }
            valid_len += line.len();
        }
        if valid_len < bytes.len() {
            OpenOptions::new().write(true).open(path)?.set_len(valid_len as u64)?;
        }
        Ok(last_seq)
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
    ///
    /// A failed write may leave a torn final line mid-run; the next call heals
    /// it before appending (and refuses to append if it can't), so fsync'd lines
    /// written later are never stranded behind garbage that recovery stops at.
    pub fn append(&mut self, project: &str, events: &[Value]) -> std::io::Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        if self.needs_heal {
            let last_seq = Self::heal_torn_tail(&self.path)?;
            self.seq = self.seq.max(last_seq);
            self.needs_heal = false;
        }
        let mut buf = String::new();
        for ev in events {
            self.seq += 1;
            buf.push_str(
                &serde_json::json!({ "seq": self.seq, "project": project, "event": ev }).to_string(),
            );
            buf.push('\n');
        }
        if let Err(e) = self.active.write_all(buf.as_bytes()) {
            self.needs_heal = true;
            return Err(e);
        }
        Ok(())
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
    /// list of `(project, event)`. Torn-tail tolerant per file, byte-oriented
    /// (a torn multi-byte codepoint costs only the line it tore, never the
    /// fsync'd lines before it).
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
            let raw = match std::fs::read(&path) {
                Ok(b) => b,
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        eprintln!(
                            "[RuntimeScope] durability: cannot read WAL file {} during recovery: {e}",
                            path.display()
                        );
                    }
                    continue;
                }
            };
            for line in raw.split(|&b| b == b'\n') {
                let trimmed = line.trim_ascii();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_slice::<Value>(trimmed) {
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
    fn torn_utf8_tail_heals_and_keeps_prior_lines() {
        // The tear can split a multi-byte UTF-8 codepoint (any non-ASCII string
        // in an event). The file is then not valid UTF-8 as a whole; healing and
        // recovery must still keep every complete line before the tear instead
        // of dropping the entire file.
        let dir = std::env::temp_dir().join(format!("wal-utf8-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let good = json!({ "seq": 1, "project": "p", "event": { "eventId": "e1", "msg": "héllo wörld" } }).to_string();
        let mut bytes = good.clone().into_bytes();
        bytes.push(b'\n');
        // Torn line ending mid-codepoint: 'é' is 0xC3 0xA9 — write only 0xC3.
        bytes.extend_from_slice(b"{\"seq\":2,\"project\":\"p\",\"event\":{\"msg\":\"h");
        bytes.push(0xC3);
        std::fs::write(dir.join("active.jsonl"), &bytes).unwrap();

        // Recovery before healing must keep the good line (byte-oriented scan).
        let recovered = Wal::recover(&dir);
        assert_eq!(recovered.len(), 1, "good line before a torn codepoint must survive");
        assert_eq!(recovered[0].1["eventId"], "e1");

        // Healing must truncate only the torn tail; appends after it must land
        // on clean data and be recoverable.
        let mut wal = Wal::open(&dir).unwrap();
        wal.append("p", &[json!({ "eventId": "e2" })]).unwrap();
        wal.commit().unwrap();
        drop(wal);
        let recovered = Wal::recover(&dir);
        assert_eq!(recovered.len(), 2, "post-heal append must survive recovery");
        assert_eq!(recovered[1].1["eventId"], "e2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reopen_resumes_seq_after_healed_lines() {
        // seq must not restart at 0 while the active file still holds lines with
        // higher seqs — duplicate seq values would corrupt any consumer that
        // orders by it.
        let dir = std::env::temp_dir().join(format!("wal-seq-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        {
            let mut wal = Wal::open(&dir).unwrap();
            wal.append("p", &[json!({ "eventId": "e1" }), json!({ "eventId": "e2" })]).unwrap();
            wal.commit().unwrap();
        }
        {
            let mut wal = Wal::open(&dir).unwrap();
            wal.append("p", &[json!({ "eventId": "e3" })]).unwrap();
            wal.commit().unwrap();
        }
        let raw = std::fs::read_to_string(dir.join("active.jsonl")).unwrap();
        let seqs: Vec<u64> = raw
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap()["seq"].as_u64().unwrap())
            .collect();
        assert_eq!(seqs, vec![1, 2, 3], "reopen must resume seq, not restart it");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn second_owner_open_is_refused_while_first_is_live() {
        let dir = std::env::temp_dir().join(format!("wal-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let wal = Wal::open(&dir).unwrap();
        let second = Wal::open(&dir);
        assert!(second.is_err(), "a second live owner must be refused");
        drop(wal);
        // After the first owner is gone, opening succeeds again.
        assert!(Wal::open(&dir).is_ok(), "lock must be released with the owner");
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
