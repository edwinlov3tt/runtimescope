# Pre-M7 Review Package — RuntimeScope Rust port

> **Purpose.** Orientation + a critical self-assessment for independent reviewers,
> before the M7 cutover (which DELETES the Node packages). Read this, then produce
> your own report. **Assume there is at least one real bug in the code and find it.**
> Be adversarial: a "looks fine" pass is a failed review.
>
> **State:** M0–M6 complete. Conformance **132/132 vs Node AND Rust**. ~89
> collector-core unit tests + cli/server tests. Not yet shipped (v0.11.0 = M7).

---

## 1. How to verify (do this first)

```bash
npm install && cargo build
cargo clippy --workspace            # CI gate: -D warnings
cargo test --workspace
# Conformance BOTH ways:
npm run conformance                                   # vs Node (source of truth)
RUNTIMESCOPE_COLLECTOR_CMD=$PWD/target/debug/collector-server \
RUNTIMESCOPE_MCP_CMD=$PWD/target/debug/mcp-server \
  npm run conformance                                 # vs Rust
```

**Known flake (do not let it mask a real failure):** under the ~33-file parallel
suite, `event-read-shapes` / `data-history-shapes` occasionally drop ONE vs-Node
test from process contention. Re-run the named spec in isolation
(`npx vitest run --config tests/conformance/vitest.config.ts <name>`) to confirm.
**A reviewer should treat "it's just the flake" with suspicion** — verify, and
recommend the concurrency cap (`poolOptions`) M7 should add. If you can make a
*different* spec flake, that's a finding.

## 2. What's built (by subsystem)

- **`collector-core`** (lib, shared by both server bins):
  - `store.rs` — events via a **dedicated DB-owner thread** (mpsc/oneshot) over
    rusqlite WAL + a JSONL WAL (`wal.rs`, fsync-before-commit, truncate-after-commit).
  - `server.rs` — axum WS (SDK handshake/ingest/command channel) + the full HTTP API.
  - `auth.rs` — per-binary `AuthMode` (standalone honors `RUNTIMESCOPE_AUTH_TOKEN`
    comma-split; mcp is config-file-only), constant-time compare, bearer parse.
  - `event.rs` — `VALID_EVENT_TYPES` (19, exact Node match); events are raw `Value`.
  - pm subsystem: `pm_store.rs` (workspaces/api-keys/projects/sessions/capex/notes/
    tasks/dev-servers, FK-enforced), `pm_discovery.rs` (Claude-project scan +
    over-discovery fix), `pm_project_manager.rs` (RS-project discovery), `pm_session_parser.rs`
    (cost/token/active-time from Claude JSONL).
  - `dev_server.rs` — process-group spawn + group-kill + lsof socket detection.
  - `process_monitor.rs` — on-demand ps/lsof dev-process + port scan (mcp-only).
  - `migration.rs` — Node→Rust first-run cutover guard.
  - dashboard embed (`rust-embed`) served at `/dashboard`.
- **`collector-server`** (bin) — standalone daemon (`AuthMode::Standalone`, process_monitor=false).
- **`mcp-server`** (bin) — embeds collector-core in-process (ADR-0008); rmcp tool surface;
  `AuthMode::Mcp`, process_monitor=true; Node recon sidecar for `scan_website`.
- **`cli`** (bin) — `service` lifecycle (launchd/systemd) + `dashboard` + `version`.

## 3. Decisions made (and where to challenge them)

| Decision | Rationale | Challenge it |
|---|---|---|
| Events are raw `Value`, not typed structs | Node casts `as T` w/ no runtime validation; typed serde would be *stricter* (drop where Node proceeds) | Does any tool mis-read a field because there's no schema? Defensive `.get()` everywhere? |
| Conformance tests ARE the spec (ADR-0006) | The Node suite was green while real divergences hid; gate must diff *shapes* | **Where is a path NOT conformance-gated?** (recon live, dev-server lifecycle, process_monitor live, CLI). Those are where bugs hide. |
| WAL truncate-after-commit, no rotation | O(in-flight) WAL; crash-replay deduped | Torn-tail across a sealed segment? fsync cost under high ingest? |
| Per-binary `AuthMode` / `process_monitor` | Faithful to Node's two wirings | Is the standalone-vs-mcp behavior actually correct end-to-end, or just unit-tested? |
| pm FK enforcement ON (pragma + constraints) | Node's better-sqlite3 defaults FK ON; we matched | Insert ordering under FK in *partial/interrupted* discovery? `delete_project` cascade correctness? |
| XLSX capex routes serve **CSV** | exceljs bytes aren't reproducible; dashboard only downloads | A user scripting against `.xlsx` gets `.csv` — acceptable? |
| Recon via Node Playwright sidecar (ADR-0007) | Pure-Rust browser automation is out of scope | Sidecar lifecycle, error frames, the browser-bundling gap (fast-follow). |

**Intended divergences (Rust-test-gated, NOT Node-conformance-gated — verify each is correct, not just "documented"):**
over-discovery fix (`is_real_project`); dev-server **group-kill** (fixes Node's orphan bug); capex
**confirmed-preservation** (fixes Node's clobber-on-reindex); always-full-parse sessions; security hardening
(no-shell respawn, `safe_purge_base`, traversal guards); the systemd `ExecStart` quoting; the migration backup.

## 4. What remains (M7 + fast-follow)

- **M7 (the cutover):** full conformance + `npm run stress` (7/7) + `bench:compare` gate in CI; signed-binary
  release workflow; **delete `packages/collector|mcp-server|cli`** (the Node reference — irreversible);
  verify git-tag rollback; ship v0.11.0; deprecate the npm packages.
- **Fast-follow:** curl-install + self-update + signed GitHub Releases + `~/.runtimescope/bin`; dev-server v2
  (dashboard WS broadcast; SSH/forward-table resolution; background scan cache); process_monitor background
  cache; conformance concurrency cap; CLI doctor/mcp-doctor; `get_style_diff` capture path.

## 5. Corners cut / known limitations (honest)

1. **Not conformance-gated** (the soft underbelly): the recon live-browser path, the dev-server start/stop
   *lifecycle* (only the 404 surface + a Rust integration test), the process_monitor *live* path (shape-only),
   the entire CLI service lifecycle (unit tests + read-only status only — **no real install/stop cycle was run**).
2. **No real CLI install cycle was executed** — `service install` would hijack the live launchd service, so it
   was never end-to-end tested. The plist/unit are unit-tested as strings only. **A reviewer should mentally
   (or in a VM) trace an actual install→running→stop→uninstall.**
3. **process_monitor scans on-demand** (ps + lsof per request, lsof per matched pid) — no background cache like
   Node. Latency + load under repeated dashboard polls; the classification is manual substring/word matching
   (no regex) and may mis-bucket.
4. **dev-server**: poll-only (no WS push to the dashboard); SSH/forward = detect-and-warn (no resolution);
   on-demand socket poll; persistence re-attach trusts the stored pgid (PID/pgid **reuse** after a reboot is
   not validated beyond `kill(-pgid,0)`).
5. **Migration guard keys only off `collector.db`'s events schema.** A *mixed* state (Node-era `pm.db` but
   Rust-era `collector.db`, or vice versa) is not handled — the Node pm.db wouldn't be backed up. Partial
   backup-rename failure (some files moved, some not) leaves a split state.
6. **Dashboard embed needs `npm run build` before `cargo build`** (compile-time embed). No `build.rs` guard
   asserts the dist exists/is fresh → a stale or empty embed ships silently.
7. **Windows**: CLI service + dev-server + process_monitor are Unix-only (stubbed on Windows).
8. **The pm.db uses a single `Arc<Mutex<Connection>>`** (unlike the event store's owner-thread). Fine for
   low-freq pm ops, but the dev-server map + persistence + discovery add write contention — unproven under load.

## 6. Optimization opportunities

- process_monitor background scan cache (match Node; cut per-request ps/lsof).
- Event reads (`events_by_type`/`timeline`) fetch rows then filter in Rust — push filters into SQL for large buffers.
- WAL fsync-per-batch cost under high ingest (consider group-commit).
- Dashboard embed adds ~1.1 MB to every binary — acceptable, but note it.
- pm.db on the owner-thread pattern if write contention shows up.

## 7. Edge cases to attack (assume one of these bites)

- **dev-server start race:** two concurrent `POST .../dev-server` for one project — the 409 "already running"
  check and the map insert are **not atomic** (TOCTOU). Two spawns?
- **process_monitor `kill_process`:** PID reuse — killing a recycled pid. Also: parsing `ps aux` / `lsof` with
  locale-dependent or pathological output (very long command lines, embedded spaces/newlines, non-UTF8).
- **Migration:** backup-rename failing midway; the `is_node_era` read-only open while a Node `-wal` is present
  (does SQLite refuse to read?); a `collector.db` with NO `events` table.
- **FK + capex:** the `confirmed`-preservation `CASE` SQL — does it actually preserve on EVERY re-index path?
  Re-discovery insert order if a session references a project that failed to upsert.
- **session-parser:** the cost/token math + `js_round` half-up + the empty-model→sonnet quirk — float drift,
  divide-by-zero, a JSONL with malformed/huge entries, compaction edge.
- **auth:** empty/whitespace token; comma-split env with empty entries (`"a,,b"`); a config `apiKeys[].key`
  that's empty; constant-time compare with length-mismatch.
- **timeline `since_seconds`:** clock skew / a future timestamp; `session_id` comma-list with empties.
- **CSV export:** a field containing `"`/newline/comma — is `csv_escape` applied everywhere it's needed
  (project name, slug, notes)? An un-escaped field is an injection/corruption bug.
- **dashboard SPA:** `/dashboard/../../etc/passwd` style — rust-embed only resolves embedded keys (safe), but
  verify there's no path that escapes; content-type for an unmapped extension.
- **WAL:** torn tail at exactly a newline boundary; a sealed-`*` file written by Node; recovery after N restarts.

## 8. Beyond-Node: gaps in the Node system worth fixing in the port

Node bugs we ALREADY fixed (verify they're truly fixed, not just moved): dev-server orphaning (group-kill),
capex confirmed-clobber, over-discovery, no-shell/traversal hardening. **Further opportunities** (candidate
scope to exceed Node, for discussion — NOT committed):

- A real **Node→Rust data migration** (import the legacy pm.db/events into the Rust schema) instead of
  just backing it up — users keep their history.
- **Dev-server → monitoring** is half-wired (auto-attach hint exists); finish the loop (auto-scan/inject).
- **process_monitor**: real port-forward/devcontainer resolution (currently detect-and-warn).
- **Lenient structured event validation** at ingest (raw `Value` today) — catch malformed events without
  Node's silent-cast behavior, surfaced via metrics.
- **Observability**: structured tracing + richer `/metrics` (the Rust port could expose far more than Node).
- **Backpressure / ring-buffer bounds** on ingest under flood (does the WAL/owner-thread queue bound?).

## 9. Reviewer assignments (suggested)

Split by subsystem; each reviewer: read the Rust + the Node reference, run the relevant tests, and **try to
break it**. Report findings as `{severity, file:line, evidence, repro, Node-ref, fix}`.

1. **Store + WAL durability** (`store.rs`, `wal.rs`) — crash/torn-tail/restart, the owner-thread, dedup.
2. **pm_store + FK + capex** (`pm_store.rs`) — FK ordering, the CASE SQL, CSV escaping, the snake_case quirk.
3. **dev_server + process_monitor** (`dev_server.rs`, `process_monitor.rs`) — process groups, races, ps/lsof parsing.
4. **auth + server routing + dashboard** (`auth.rs`, `server.rs`) — per-binary seams, traversal, content-types.
5. **session-parser + discovery** (`pm_session_parser.rs`, `pm_discovery.rs`, `pm_project_manager.rs`) — the math, the over-discovery filter.
6. **CLI + migration** (`cli/`, `migration.rs`) — the install lifecycle (trace it), the cutover guard's mixed-state gaps.

**The bar: each reviewer must surface at least one concrete, reproducible concern (bug, gap, or edge case) or
explicitly justify why their subsystem is genuinely clean. "LGTM" is not an acceptable review.**

## 10. First bug-hunt — findings & resolution (round 1, automated adversarial pass)

A 6-subsystem adversarial workflow (each finding independently re-verified) returned **16 confirmed
findings; no subsystem came back clean.** Resolution (commit follows this doc):

**FIXED (10):**
- **CRITICAL — `POST /api/events` returned 200 on a failed persist** (`server.rs`). Now returns 500
  `DURABILITY_ERROR`. Intended improvement over Node (whose `addEvent` is void + also 200s on failure);
  happy-path unchanged → conformance still 132/132.
- **CRITICAL — migration `is_node_era` could mis-skip backup → data loss.** A read-only open of a WAL-mode
  Node db can spuriously fail (needs `-shm`); the old code returned false (= "Rust-era, don't back up") on
  any failure. Now: open read-write (handles WAL); **a file that exists but won't open is treated as legacy
  and backed up** (data-safety bias; a genuinely-Rust store is short-circuited by the marker first).
- **HIGH — migration backup failures were swallowed** → split state. `backup_legacy` now returns `Err`
  listing un-moved files; `first_run_guard` returns `Result`; **both binaries abort** rather than start on a
  half-migrated store (clearing the marker so a fixed retry re-runs).
- **HIGH — concurrent `first_run_guard` (two binaries) could double-back-up.** Marker is now claimed
  atomically (`create_new`); the loser skips.
- **HIGH — `SaveSnapshot` swallowed the INSERT error** (`store.rs`) → QA check reported "saved" on failure.
  Now threads `Result`; the tool surfaces "⚠ Snapshot NOT persisted".
- **HIGH — discovery clobbered a session with zeros** if its JSONL vanished between `read_dir` and `stat`
  (`pm_discovery.rs`). Now skips the session on a metadata error.
- **HIGH — dev-server start race (TOCTOU)** → two concurrent same-project POSTs could double-spawn
  (`server.rs`). Now an atomic `dev_starting` reservation (+ Drop guard to release on every path); the
  second POST gets 409 "already starting".
- **HIGH/divergence — launchd plist XML injection** (`cli/service.rs`): a path with `& < >` corrupted the
  plist. Now `xml_escape`d (fixes a latent Node bug too).
- **HIGH — `add_batch` counted deduped/empty events as stored** (`store.rs`). `Ok(true)`/`Ok(false)` split;
  return value is now honest (it was discarded in the POST handler, so impact was low — fixed anyway).
- **`word()` multibyte boundary bug** (`process_monitor.rs`) — surfaced by a regression test written to
  *disprove* the audit's (incorrect) panic claim. Byte-level alnum boundary checks treated a multibyte char
  adjacent to the needle as a word boundary → `word("ánode","node")` falsely matched → process
  mis-classification. Now char-aware (`is_alphanumeric` on the adjacent char).

**DISMISSED after independent scrutiny (be skeptical of the audit too):**
- **WAL-truncate-failure → error:** the proposed fix would make a successful, durable persist return 500
  (the data IS in SQLite; truncate is best-effort cleanup, and next-boot replay is safe). Current
  log-and-ack-Ok is correct.
- **`word()` panic:** the needles are ASCII so every `find` offset is a char boundary — it cannot panic
  (proven by the regression test). The finding was directionally right (multibyte) but wrong on mechanism
  (it's a false-match, not a panic — fixed above).

**DEFERRED — dev-server / process-monitor hardening follow-up (real, lower-probability, need coherent design):**
- **`kill_process` / re-attach PID & pgid reuse** — after a reboot a stored pgid can be reused; killing by a
  bare pid/pgid could hit the wrong process. Mitigation: verify process-command identity before
  killing, and don't trust a persisted pgid across a reboot (compare boot time). *Round-2 must design this.*
- **`lsof` NAME parsing** assumes a single-token last column; `lsof -F` (NUL-delimited field output) is robust.
- **Migration mixed-state** (Node-era `pm.db` but Rust-era/absent `collector.db`) — deliberately NOT
  auto-handled: a reliable Node-vs-Rust `pm.db` signal doesn't exist without risking a false-positive backup
  of a live Rust `pm.db`, so the guard keys off `collector.db` (safe + correct for the common cases). A user
  who manually deleted only `collector.db` keeps their Node `pm.db` un-backed-up — documented residual.

**Note for round 2:** this was ONE automated pass and it found real bugs in every subsystem — including in
code written the same session. Assume it missed some. The deferred items + the un-gated paths (§5) are the
priority hunting grounds. Independent human/instance review still required before M7 sign-off.
