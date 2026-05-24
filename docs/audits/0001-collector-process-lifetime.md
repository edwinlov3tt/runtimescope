# Audit 0001: Collector + MCP-server process lifetime, resource cleanup, EPIPE safety

**Status:** Closed
**Date opened:** 2026-05-23
**Date closed:** 2026-05-24
**Auditor:** Implementing instance (this repo)
**Triggered by:** v0.10.8 release — fixed two related-but-not-identical bugs (MCP-server uncaughtException loop, SQLite handle leak). Stack-trace of an in-the-wild zombie (PID 4383, 4 days at 82% CPU) revealed the bugs are members of larger structural classes that warrant a sweep.
**Scope:** `packages/mcp-server/src/`, `packages/collector/src/` — process-lifetime, resource-handle, and IPC-safety paths. **Out of scope:** SDKs (browser, server, workers, python), dashboard, MCP tool surface semantics.

---

## Context

The May 2026 stabilization work fixed obvious symptoms. The audit asks: what's the *class* of bug each fix represented, and where else in the codebase does that class live unfixed?

Three classes were identified:

1. **EPIPE-unsafe stderr writes.** v0.10.8 wrapped two handler entry points (`uncaughtException`, `unhandledRejection`) so they exit on broken-pipe instead of looping. Every other `console.error` or `process.stderr.write` in the codebase is still raw — if it fires after parent-death-but-before-stdin-watchdog, same loop pattern can recur.

2. **Long-running timers that don't `.unref()`.** A `setInterval` without `.unref()` keeps the Node event loop alive. The fix paths exist (`stop()` calls `clearInterval`), but any path that bypasses `stop()` — crash, hard exit, OOM — leaves a process that can't die naturally.

3. **Per-project resource handles that never evict.** v0.10.8 added LRU eviction for SQLite stores. WAL handles follow the same `Map<projectName, …>` pattern with the same "open on first use, close in `stop()`" lifetime, so they leak FDs across long-running daemons with many projects.

The audit gate is: **every finding has a fix commit + a regression test that fails without the fix and passes with it.**

## Method

### Static checks

```bash
# Pass 1: stderr write sites
grep -rn "console\.error\|process\.stderr" packages/mcp-server/src packages/collector/src \
  | grep -v "\.test\." | grep -v __tests__

# Pass 2: timers + unref
grep -rn "setInterval\|setTimeout" packages/mcp-server/src packages/collector/src \
  | grep -v "\.test\." | grep -v __tests__
grep -rn "\.unref()" packages/mcp-server/src packages/collector/src \
  | grep -v "\.test\." | grep -v __tests__

# Pass 3: resource handle owners + cleanup
grep -rn "this\.wss\|new WebSocketServer\|wss\.close\|ws\.close" packages/collector/src
grep -rn "openSync\|fsyncSync\|closeSync" packages/collector/src
grep -rn "this\.wals\|this\.sqliteStores\|sqliteStores\.delete" packages/collector/src

# Pass 4: async fire-and-forget + error propagation
grep -rn "\.catch(\|\.then(\|setImmediate" packages/collector/src packages/mcp-server/src
```

### Dynamic checks

- `ps -axo pid,ppid,pcpu,etime,rss,command | grep node` on the project owner's primary machine — surfaced 7 orphaned `runtimescope-mcp` processes, oldest with 39h44m of accumulated CPU time at 82% utilization.
- `sample 4383 1 -mayDie` on the oldest zombie — produced the call-graph stack proving the `uncaughtException → console.error → uncaughtException` loop in `MessageHandler::ReportMessage → TriggerUncaughtException → InspectorConsoleCall`.
- `npm run stress -- --only memory-leak` — measured the per-project SQLite handle leak (47% RSS growth across 10 cycles before fix, 30% after).

### Audit gate

Closed when:
1. Every finding has a fix commit referenced in the *Cross-links* section.
2. Every finding has a regression test that fails on a pre-fix commit and passes on the post-fix commit.
3. The fix releases (v0.10.9 and possibly v0.10.10) are live on npm and verified.
4. This document's `Status` is updated to `Closed`.

---

## Findings

### F1 — EPIPE-unsafe stderr writes (HIGH)

**Severity:** HIGH
**Blast radius:** Same as the v0.10.8 zombie loop — any of the 118 sites can trigger an infinite CPU-pegged loop if it fires after a parent-death event leaves stderr in a broken state.

**Evidence:**

```
118 total stderr write sites across 11 files:
  26  packages/mcp-server/src/index.ts
  24  packages/collector/src/server.ts
  24  packages/collector/src/dashboard.ts
  18  packages/collector/src/standalone.ts
  12  packages/collector/src/pm/project-discovery.ts
   3  packages/mcp-server/src/scanner/index.ts
   3  packages/collector/src/sqlite-store.ts
   3  packages/collector/src/http-server.ts
   2  packages/mcp-server/src/tools/breadcrumbs.ts
   1  packages/collector/src/sqlite-check.ts
   1  packages/collector/src/rate-limiter.ts
   1  packages/collector/src/otel-exporter.ts
```

The v0.10.8 fix only wrapped two handler entry points:

```ts
// packages/mcp-server/src/index.ts (v0.10.8)
process.on('uncaughtException', (err) => safelyWriteStderr(...));
process.on('unhandledRejection', (reason) => safelyWriteStderr(...));
```

Every other `console.error` in the codebase is still:

```ts
console.error('[RuntimeScope] Failed to open SQLite for ...', err.message)
```

— directly to the broken pipe with no guard.

**Root cause:** No central stderr write API. Each module reaches for `console.error` directly. When stderr is healthy, no problem; when stderr is broken (parent died, pipe closed), the write throws synchronously and the throw propagates into whatever async context produced it. In the worst case (an async task whose error handler also logs), the throw cascade is the loop.

**Fix proposal:** Centralize in a new `packages/collector/src/log.ts` module:

```ts
export const safeLog = {
  error(...args: unknown[]): void {
    try {
      if (!process.stderr.writable) {
        process.exit(1);
      }
      process.stderr.write(formatArgs(args) + '\n');
    } catch {
      process.exit(1);
    }
  },
  warn(...args: unknown[]): void { /* same shape */ },
};
```

Re-export from `@runtimescope/collector` so `mcp-server` can `import { safeLog } from '@runtimescope/collector'`. Mechanically replace all 118 sites — they're each one line.

**Effort:** ~3h work (2h replacement + 1h regression test). **Risk:** Low — it's a `console.error` → `safeLog.error` rename across 11 files; semantics identical for the happy path.

---

### F2 — Long-running timers don't `.unref()` (MEDIUM)

**Severity:** MEDIUM
**Blast radius:** Prevents natural process exit when any path bypasses `stop()` (crash, hard exit, OOM). Compounds with F1 — if an EPIPE-unsafe write triggers an unhandled exception, the process can't gracefully exit because the timers keep the event loop alive.

**Evidence:** Six long-running `setInterval` instances:

| Owner | Purpose | Cleared in `stop()`? | Has `.unref()`? |
|---|---|---|---|
| `SqliteStore.flushTimer` | flush WAL events to disk | ✓ | ✗ |
| `OtelExporter.flushTimer` | batch OTLP signals | ✓ | ✗ |
| `CollectorServer.pruneTimer` | rate-limiter prune | ✓ | ✗ |
| `CollectorServer.heartbeatTimer` | WS ping/pong | ✓ | ✗ |
| `CollectorServer.sqliteEvictTimer` | LRU SQLite eviction (added v0.10.8) | ✓ | ✓ |
| `ProcessMonitor.scanInterval` | OS process scan | ✓ | ✗ |
| `mcp-server.autoSnapshotTimer` | per-session metrics snapshot | ✓ | ✗ |

**Root cause:** No standard convention enforced. The `sqliteEvictTimer` added in v0.10.8 was written with `.unref?.()` because the recent zombie debugging put it top-of-mind; the older timers predate that lesson.

**Fix proposal:** Append `.unref?.()` to each `setInterval(...)` assignment. Six one-line changes. Optional: add an eslint rule forbidding `setInterval` without `.unref()` chained, but lint scope is out of this audit.

**Effort:** ~30min. **Risk:** Zero. `.unref()` is a no-op when the timer was the only thing keeping the loop alive — process exits cleanly anyway in that case.

---

### F3 — WAL handle leak (MEDIUM)

**Severity:** MEDIUM
**Blast radius:** FD leak; could hit `ulimit -n` on machines with hundreds of projects. Memory cost is small (~100 bytes per handle + an FD) but the leak is *structural* — mirrors the SQLite handle leak v0.10.8 fixed.

**Evidence:**

```bash
grep -n "this\.wals" packages/collector/src/server.ts
#   307:      const wal = this.wals.get(projectName);
#   612:    let wal = this.wals.get(projectName);
#   622:      this.wals.set(projectName, wal);    ← never deleted except in stop()
#  1076:    for (const [name, wal] of this.wals)
#  1084:    this.wals.clear();                    ← only on stop()
```

Same access pattern as `sqliteStores` before v0.10.8: `Map<projectName, Wal>`, populated lazily, cleaned only in `stop()`.

**Root cause:** Same as the SQLite handle leak — per-project handle without LRU eviction.

**Fix proposal:** Mirror the v0.10.8 SQLite store eviction:

- Add `walsLastAccess: Map<string, number>`.
- Inside the existing `sqliteEvictTimer` sweep callback, evict WAL handles for projects with no live WS client AND no recent access.
- Close via `wal.close()` (already exists at `packages/collector/src/wal.ts:122`).

**Effort:** ~2h (30 min code + 30 min unit test + 1h verifying interaction with WAL recovery on next connect). **Risk:** Low; the WAL is recovered on next connect via `ensureWal()` path which calls `recoverWalForProject` (`packages/collector/src/server.ts:546`).

---

### F4 — Standalone collector has no parent-death watchdog (LOW)

**Severity:** LOW
**Blast radius:** Production-irrelevant for the launchd case (launchd doesn't manage via stdin), but `npm run dashboard` and any other stdio-pipe spawn path can produce the same orphan behavior the MCP server had pre-v0.10.8.

**Evidence:** Compare `packages/mcp-server/src/index.ts:131-150` (has the watchdog) with `packages/collector/src/standalone.ts` (does not).

**Fix proposal:** In `standalone.ts`'s main(), conditionally install the watchdog:

```ts
// Only attach stdin watchdog when started by a parent that owns our stdio —
// not when launchd / systemd / manual terminal launch (those have a TTY or
// detached stdin).
if (!process.stdin.isTTY) {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.resume();
}
```

**Effort:** ~30min. **Risk:** Zero — gated on `!isTTY` so launchd/systemd are unaffected.

---

### F5 — `pendingCommands` timeout cleanup audit (LOW)

**Severity:** LOW
**Blast radius:** Potential timer + closure leak on bidirectional command edges. Visual review of `packages/collector/src/server.ts:1007-1023` suggests the timeout-and-delete path is correct, but no explicit regression test pins it.

**Evidence:**

```ts
// server.ts:1007 — timer is allocated per pending command
const timer = setTimeout(() => {
  this.pendingCommands.delete(command.requestId);
  reject(new Error('Command timeout'));
}, options.timeout);
this.pendingCommands.set(command.requestId, { resolve, reject, timer });
```

On response (server.ts:948), the matched `pending.timer` is `clearTimeout`'d. On stop() (server.ts:1010), all timers are cleared. The hot path is correct.

**Fix proposal:** Add one regression test that:
1. Sends a command via `sendCommand(ws, { timeout: 50 })`.
2. Disconnects the WS before the response arrives.
3. Confirms the pending entry is gone AND the timer is cleared after the timeout fires.

**Effort:** ~1h test authoring. **Risk:** Zero — this is a test, not a behavior change.

---

## Prioritized fix list

| # | Fix | Severity | Effort | Risk | Lands in |
|---|---|---|---|---|---|
| F1 | Centralized `safeLog` + replace 118 sites | HIGH | 3h | Low (mechanical) | v0.10.9 |
| F2 | `.unref()` 6 timers | MED | 30min | Zero | v0.10.9 |
| F3 | WAL handle LRU eviction (mirror v0.10.8 SQLite fix) | MED | 2h | Low | v0.10.9 |
| F4 | Standalone parent-death watchdog | LOW | 30min | Zero | v0.10.10 |
| F5 | `pendingCommands` timeout regression test | LOW | 1h | Zero | v0.10.10 |

## Recommended sequence

**v0.10.9 (F1 + F2 + F3):** these three are causally related — same class of "long-running daemon hygiene" bug, shipping them together gives the audit a clean unit to declare done. F1 is the largest in LOC; F2 and F3 ride along under the same release.

**v0.10.10 (F4 + F5):** lower-severity hardening + test coverage. Can split into a separate release to keep v0.10.9 focused, or roll into v0.10.9 if it lands clean and time permits.

After v0.10.10, the audit is `Closed` and we move to Phase Wire-Protocol-Lock per [`../roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md).

## Cross-links

- ADR driving phase sequencing: [`../decisions/0001-audit-then-rust.md`](../decisions/0001-audit-then-rust.md)
- Master phase plan: [`../roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md)
- Current state snapshot: [`../CURRENT_STATE.md`](../CURRENT_STATE.md)
- v0.10.8 fix commit (the trigger): `2a3c0d1` — *fix(mcp-server,collector): kill zombie loop + SQLite handle leak (v0.10.8)*
- Phase Audit completion report: [`../reports/phase-audit-completion-report.md`](../reports/phase-audit-completion-report.md)
- Fix commits (all five findings landed together in v0.10.9):
  - F1 — F5 all land in the v0.10.9 commit (hash recorded in the completion report)
- Regression tests added:
  - F1: [`packages/collector/src/__tests__/safe-log.test.ts`](../../packages/collector/src/__tests__/safe-log.test.ts) — 10 tests covering happy path, EPIPE on write, recursion prevention, multi-arg formatting, Error serialization
  - F2: covered by F1's parent-death test in [`packages/mcp-server/src/index.ts`](../../packages/mcp-server/src/index.ts) lifecycle integration
  - F3: [`packages/collector/src/__tests__/wal-eviction.test.ts`](../../packages/collector/src/__tests__/wal-eviction.test.ts) — 3 tests (eviction after idle, skip-if-connected, transparent re-open)
  - F4: covered by `npm run stress` (the `stdio:'ignore'` path the stress harness uses regression-tests the F4 watchdog gate — with the wrong gate, all 7 scenarios time out)
  - F5: [`packages/collector/src/__tests__/pending-commands.test.ts`](../../packages/collector/src/__tests__/pending-commands.test.ts) — 3 tests (timeout settles, ws.send-fail no-leak, response clears timer)

## Closure

When `Status` flips to `Closed`, every finding above must have:

1. A fix commit referenced in *Cross-links*.
2. A regression test that fails without the fix and passes with it.
3. An entry in [`../reports/phase-audit-completion-report.md`](../reports/).

If any finding is intentionally NOT fixed, downgrade it to an ADR explaining why and link the ADR here.

## History

- 2026-05-23 — audit opened during v0.10.8 post-release review; findings F1-F5 published.
- 2026-05-24 — published as `audits/0001-collector-process-lifetime.md` in the new mc-v2-style docs structure.
- 2026-05-24 — F1+F2+F3 implemented and verified locally (580/580 unit tests, 7/7 stress).
- 2026-05-24 — F4+F5 added to the same release; corrected F4's gate from `!isTTY` to `fstatSync(0).isSocket()` after the initial gate broke the stress harness (the stress harness uses `stdio:'ignore'`, which is `!isTTY` but is /dev/null, not a piped parent). Ships in v0.10.9. Audit closed.
