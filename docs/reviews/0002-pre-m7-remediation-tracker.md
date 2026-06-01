# Pre-M7 Remediation Tracker — RuntimeScope Rust port

**Purpose:** the single sign-off ledger for M7 (which deletes the Node reference — *irreversible*).
Consolidates every finding from four independent sources and records its disposition with the commit
that closed it. M7 may proceed only when every row is **FIXED** or an explicitly-accepted **DEFERRED**
with a tracked fast-follow.

Sources:
- **R1** — round-1 automated adversarial hunt (6 subsystems vs Node parity). Detail in `0001-pre-m7-review-package.md §10`.
- **R2** — round-2 differently-seeded hunt (6 failure-mode lenses: panic/overflow, leaks, concurrency, security, un-gated, numeric).
- **C** — external Claude instance review (F1–F4).
- **G** — external GPT instance review (#1–#7).

Closing commits: `1e60ae7` (review pkg), `670a1bf` (R1 ×10), `daba2ac` (security ×2),
`200fcdf` (pgid-reuse + numeric + migration-race).

**Gate at sign-off:** clippy `--workspace --all-targets` clean · `cargo test --workspace` green ·
conformance **132/132 vs Node AND Rust** (modulo the known harness port-collision flake — G#7, below).

---

## A. CRITICAL — all FIXED

| ID | Finding | Disposition | Commit |
|----|---------|-------------|--------|
| R1-1 | `POST /api/events` returned **200 on a failed persist** → silent data loss. Now 500 `DURABILITY_ERROR`. Beyond-Node improvement (Node's `addEvent` is void + also 200s on failure). Happy path unchanged. | FIXED | `daba2ac` |
| R1-2 / C-F4 / G#2 | Migration `is_node_era` could **mis-skip backup**; concurrent loser could open **un-backed-up** Node data. Marker now claimed (`create_new`, "in-progress") **before** backup, flipped "complete" only after; loser **waits** then **aborts if the marker vanishes** (winner failed). Exists-but-unopenable → treated as legacy (safety bias). | FIXED | `670a1bf` + `200fcdf` |
| G#1 | `kill_process` accepted **pid < 2 / 0 / -1** → `kill(-1, sig)` is a *mass signal to every process the user owns*. Now refuses `pid < 2` and self-pid. | FIXED | `daba2ac` |
| C-F1 / G#3 | **SSRF** — `scan_website` host allowlist bypassable via octal/hex/abbreviated IPv4 (`0177.0.0.1`, `127.1`, `2130706433`, `0x7f000001`). Now `parse_ipv4_relaxed` (inet_aton semantics, deterministic — macOS getaddrinfo does *not* canonicalize these) + a resolution layer for DNS names; matrix test rejects all forms. | FIXED | `daba2ac` |
| C-F3 / G#4 / R2 | **pgid reuse after reboot** — `reattach_dev_servers` trusted a persisted pgid via `group_alive()` alone; post-reboot the kernel recycles pgids, so a stale pgid names a stranger's group and a later DELETE group-kills it. Now stamp `boot_time` at spawn (`/proc/stat btime` / `sysctl kern.boottime`) + a `boot_time` column; reattach **prunes any record not from the current boot** before the liveness check. Test: live pgid + stale boot → pruned, no stranger kill. | FIXED | `200fcdf` |

## B. HIGH — all FIXED (R1)

| ID | Finding | Commit |
|----|---------|--------|
| R1-3 | Migration backup failures swallowed → split state. `backup_legacy` returns `Err`; both binaries **abort** + clear marker for a clean retry. | `670a1bf` |
| R1-4 | `SaveSnapshot` swallowed the INSERT error → QA reported "saved" on failure. Now surfaces "⚠ Snapshot NOT persisted". | `670a1bf` |
| R1-5 | Discovery clobbered a session with zeros if its JSONL vanished between `read_dir`/`stat`. Now skips on metadata error. | `670a1bf` |
| R1-6 | Dev-server start **TOCTOU** → double-spawn. Atomic `dev_starting` reservation + Drop guard; 2nd POST → 409. | `670a1bf` |
| R1-7 | launchd plist **XML injection** (`& < >` in a path). Now `xml_escape`d (fixes a latent Node bug too). | `670a1bf` |
| R1-8 | `add_batch` counted deduped/empty events as stored. `Ok(true)`/`Ok(false)` split; return value now honest. | `670a1bf` |
| R1-9 | `word()` **multibyte boundary** false-match (`word("ánode","node")` matched) → process mis-classification. Now char-aware. *Surfaced by a regression test written to **disprove** the audit's (wrong) panic claim — the bug was real but the mechanism was a false-match, not a panic.* | `daba2ac` |

## C. MEDIUM — numeric hardening, all FIXED (R2)

| ID | Finding | Commit |
|----|---------|--------|
| R2-1 | `js_round` on non-finite `f64` (NaN/inf). Rust ≥1.45 **saturates** `f64 as i64` (NOT UB — so the audit's CRITICAL/panic rating was wrong; **downgraded**), but mis-buckets cost. Now `is_finite` guard → 0. | `200fcdf` |
| R2-2 | `parse_timestamp` `n.as_f64() as i64` on non-finite. Now filters `is_finite` before the cast. | `200fcdf` |
| R2-3 | Negative token counts not clamped. Now `.max(0)`. | `200fcdf` |
| R2-4 | capex scaling didn't route through `js_round` (drift vs Node). Now shared. | `200fcdf` |
| R2-5 | `export_capex_csv` didn't escape embedded `"` → CSV injection/corruption on notes/slug/etc. Now escaped on all text columns. | `200fcdf` |

## D. DISMISSED after independent scrutiny

*(Being skeptical of the audits caught two bad "fixes" before they shipped.)*

| Finding | Why dismissed |
|---------|---------------|
| WAL-truncate-failure → return 500 (R1) | The data **is** durably in SQLite; truncate is best-effort cleanup and next-boot replay is safe. The proposed fix would make a *successful* persist return 500. Current log-and-ack-`Ok` is correct. |
| `word()` **panic** (R1) | Needles are ASCII → every `find` offset is a char boundary → cannot panic (proven by the regression test). Directionally right (multibyte) but wrong mechanism — the *false-match* it implied was real and is fixed (R1-9). |
| Float-UB **crash** rating (R2-1) | `f64 as i64` saturates since Rust 1.45, doesn't UB/crash. Re-rated to a correctness bug; still guarded. |

## E. DEFERRED — accepted M7 fast-follow backlog

Each is real, lower-probability, and needs a coherent design rather than a point patch. **None blocks M7**
provided it ships as tracked work. Grouped by theme.

**Dev-server / process-monitor robustness**
- Dev-server **stdout/stderr pipe deadlock** + log-reader task cancellation + unbounded WS channel (backpressure).
- CommandHub **pending-orphan** on disconnect; dev-server monitor/handler races.
- `lsof` NAME parsing assumes a single-token last column → use **`lsof -F`** (NUL-delimited fields). *(R1 deferred.)*
- **Slow dev-server stuck in "starting"** — no timeout transitions it to failed (G#5). Needs a start deadline + status reaper.

**Install / service (CLI)**
- launchd/systemd **PATH lacks `lsof`/`npm`** (C-F2) — add `/usr/sbin` + **capture install-time PATH** into the unit.
- Install **readiness-fail → non-zero exit** + **port preflight** (G#6: no foreign-collector preflight, never fails).
- `launchctl` restart missing `-w`.

**Migration / data**
- **Mixed-state** (Node-era `pm.db` but Rust/absent `collector.db`) deliberately NOT auto-handled — no reliable Node-vs-Rust `pm.db` signal without risking a false-positive backup of a live Rust `pm.db`. Documented residual; guard keys off `collector.db`.

**Security / hardening**
- SSRF **DNS-rebinding TOCTOU** — resolve-then-connect gap; needs a pinned-IP socket or a sidecar resolver. Documented sidecar fast-follow.
- Recon sidecar **error handling**.
- `git project.path` **traversal** guard.
- `RUNTIMESCOPE_HOST` bind — **documented-but-unimplemented**; has a security implication (don't advertise external bind until enforced).

**Harness (not product code)**
- **G#7 / conformance port-collision flake** — the mcp-driver port allocator doesn't bind-probe/retry, so under parallel load one spec intermittently hits "Address already in use". **Reproduced on both Node and Rust**; passes on re-run/in isolation. Fix = bind-probe + retry in the allocator. *Tracked as a test-infra task, not a port defect.*

---

## F. M7 readiness checklist

- [x] All CRITICAL fixed + behavior-tested (§A)
- [x] All HIGH fixed (§B)
- [x] Numeric hardening fixed (§C)
- [x] Dismissals justified, not hand-waved (§D)
- [x] Deferred backlog enumerated + accepted (§E)
- [x] clippy clean · workspace tests green · conformance 132/132 both ways (flake noted)
- [ ] **Independent human/instance confirmation of this ledger** (the irreversible-delete gate)
- [ ] Snapshot/tag the Node packages immediately before deletion (recoverable if a regression surfaces)
