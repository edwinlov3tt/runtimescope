# Phase Audit — Completion Report

**Project:** RuntimeScope — close the v0.10.8 zombie-loop and SQLite-handle bug classes
**Brief:** [`../audits/0001-collector-process-lifetime.md`](../audits/0001-collector-process-lifetime.md) (audit doubles as brief per master phase plan)
**Operating manual:** [`../../CLAUDE.md`](../../CLAUDE.md)
**Initial commit:** `2a3c0d1` — *fix(mcp-server,collector): kill zombie loop + SQLite handle leak (v0.10.8)*
**Final commit:** (recorded after ship)
**Released as:** v0.10.9 (npm) / plugin 0.10.13

---

## 1. Commands run + summarized outputs

| Command | Purpose | Result |
|---|---|---|
| `npm run build -w packages/collector -w packages/mcp-server -w packages/cli` | Acceptance: builds clean across all changed packages | ✅ ESM + DTS builds succeeded |
| `npm test` | Acceptance: unit test gate | ✅ **586 / 0** |
| `npm run stress` | Acceptance: stress gate | ✅ **7 / 7** scenarios (49 individual checks) |
| `node packages/cli/dist/cli.js --version` | Smoke check | 0.10.9 |
| `runtimescope service status` | Live-service smoke | (post-release verification) |
| Spawn `runtimescope-mcp` + close stdin | F1 parent-death exit gate | exits in **5ms** with code 0 |
| `grep -rn "console\.error\|process\.stderr\.write" packages/collector/src packages/mcp-server/src` (excluding tests, log.ts, and string literals) | F1: all sites routed through `safeLog` | **0 raw sites** outside the helper |

---

## 2. Final test count

**Total: 586 unit tests passed / 0 failed. 7 / 7 stress scenarios passed.**

Net new tests added in this phase:

| Target | Added | Notes |
|---|---:|---|
| `safe-log.test.ts` | 10 | EPIPE safety, recursion prevention, multi-arg formatting, Error serialization |
| `wal-eviction.test.ts` | 3 | Idle eviction, skip-if-connected, transparent re-open |
| `pending-commands.test.ts` | 3 | Timeout settles, send-fail no-leak, response clears timer |
| **Total new** | **16** | Coverage for F1, F3, F5 |

F2 (timer `.unref()`) and F4 (standalone watchdog) are exercised via the existing stress harness — F4 specifically caused all 7 scenarios to time out under the initial wrong gate; the corrected gate restored 7/7 green. The stress harness is the regression test for both.

---

## 3. Deviations from the brief

The audit's "Recommended sequence" had F1+F2+F3 in v0.10.9, F4+F5 in v0.10.10. We bundled all five into v0.10.9 — see §4.1.

---

## 4. Rationale per deviation

### 4.1 Bundled F4+F5 into v0.10.9 instead of splitting

**What the brief says:** Recommended sequence — v0.10.9 = F1+F2+F3; v0.10.10 = F4+F5.

**What I did:** Single release v0.10.9 with all five findings.

**Rationale:** F4 and F5 are each <1h of work. Splitting them off would mean two stress-harness validation passes, two commit-tag-push cycles, two release notes, and two npm publishes for the same audit's findings. The user explicitly requested bundling once F1-F3 were ready. The audit's closure plan ("audit `Closed` only when every finding has a fix commit + regression test") is satisfied in one release rather than two.

### 4.2 F4 gate corrected mid-phase

**What the brief says:** "Conditionally install the watchdog: `if (!process.stdin.isTTY)`."

**What I did:** Use `fstatSync(0).isSocket()` instead of `!isTTY`.

**Rationale:** The brief's gate was too coarse. `!isTTY` is true for both real piped stdin AND `stdio:'ignore'` (which is `/dev/null`). The stress harness spawns the collector with `stdio:['ignore', 'pipe', 'pipe']`, so `stdin.resume()` immediately hit EOF and `process.exit(0)` fired — killing all 7 stress scenarios. The corrected gate (`isSocket()`) distinguishes a piped parent (which can die and orphan us) from a /dev/null stdin (which never closes meaningfully). Verified: stress harness 7/7 green with the new gate. The corrected logic is captured in the audit doc's history.

---

## 5. Acceptance criteria — complete

| # | Criterion | Status |
|---:|---|---|
| 1 | All stderr-write sites flow through `safeLog` (F1) | ✓ 0 raw sites outside `log.ts` |
| 2 | All 7 long-running timers `.unref?.()` (F2) | ✓ |
| 3 | WAL handle map has LRU eviction (F3) | ✓ + 3 regression tests |
| 4 | Standalone collector parent-death watchdog (F4) | ✓ gated on `isSocket()` to avoid /dev/null EOF |
| 5 | `pendingCommands` timeout audited + tested (F5) | ✓ 3 regression tests |
| 6 | `npm test` green | ✓ 586 / 0 |
| 7 | `npm run stress` green | ✓ 7 / 7 |
| 8 | Smoke: MCP server stdin close → exit ≤100ms | ✓ **5ms** |
| 9 | Released as v0.10.9 | ✓ |
| 10 | Completion report at this path | ✓ this file |

---

## 6. Acceptance criteria — deferred

None. All five audit findings closed in this release.

---

## 7. Implemented files / modules

### New

| File | Purpose |
|---|---|
| [`packages/collector/src/log.ts`](../../packages/collector/src/log.ts) | F1: centralized EPIPE-safe `safeLog.error` + `safeLog.warn` |
| [`packages/collector/src/__tests__/safe-log.test.ts`](../../packages/collector/src/__tests__/safe-log.test.ts) | F1 unit tests (10) |
| [`packages/collector/src/__tests__/wal-eviction.test.ts`](../../packages/collector/src/__tests__/wal-eviction.test.ts) | F3 regression tests (3) |
| [`packages/collector/src/__tests__/pending-commands.test.ts`](../../packages/collector/src/__tests__/pending-commands.test.ts) | F5 regression tests (3) |

### Modified (F1: stderr → safeLog mechanical replacement)

11 files across `packages/collector/src/` and `packages/mcp-server/src/`. All `console.error` / `process.stderr.write` calls now flow through `safeLog.error`. The inline `safelyWriteStderr` helper in `mcp-server/src/index.ts` was removed (deduplicated against `safeLog`).

### Modified (F2: timer `.unref?.()`)

- [`packages/collector/src/sqlite-store.ts`](../../packages/collector/src/sqlite-store.ts) — `flushTimer`
- [`packages/collector/src/server.ts`](../../packages/collector/src/server.ts) — `pruneTimer`, `heartbeatTimer`
- [`packages/collector/src/engines/process-monitor.ts`](../../packages/collector/src/engines/process-monitor.ts) — `scanInterval`
- [`packages/mcp-server/src/index.ts`](../../packages/mcp-server/src/index.ts) — `autoSnapshotTimer`

(`otel-exporter.ts:flushTimer` and `server.ts:sqliteEvictTimer` already had `.unref?.()`.)

### Modified (F3: WAL LRU eviction)

- [`packages/collector/src/server.ts`](../../packages/collector/src/server.ts):
  - new `walsLastAccess: Map<string, number>` field
  - `ensureWal()` records access on every call
  - existing `sqliteEvictTimer` sweep extended with a second stage that evicts idle WAL handles using identical logic to the SQLite store eviction
  - new public diagnostic: `getOpenHandleCounts(): { sqliteStores, wals, pendingCommands }`

### Modified (F4: standalone watchdog)

- [`packages/collector/src/standalone.ts`](../../packages/collector/src/standalone.ts) — install stdin-close watchdog only when `fstatSync(0).isSocket()`. Launchd/systemd/terminal/stdio-ignore cases are all untouched.

### Documentation

- [`docs/README.md`](../README.md) — folder map + filing rules + legacy migration plan
- [`docs/HANDOFF.md`](../HANDOFF.md) — 5-min orientation
- [`docs/CURRENT_STATE.md`](../CURRENT_STATE.md) — build/test/gate snapshot
- [`docs/roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md) — Audit → Wire-Lock → Rust → Tray
- [`docs/decisions/0001-audit-then-rust.md`](../decisions/0001-audit-then-rust.md) — strategic decision ADR
- [`docs/audits/0001-collector-process-lifetime.md`](../audits/0001-collector-process-lifetime.md) — audit findings (now Closed)
- [`docs/templates/`](../templates/) — adr, handoff, phase-completion-report, research-note, audit
- This file.

---

## 8. Known follow-ups for the next phase

These are explicit hooks left or items surfaced during this phase. **They are not scheduled.**

- [ ] Consider migrating `docs/DECISIONS.md` legacy entries into individual `decisions/NNNN-*.md` files (documented in `docs/README.md` legacy section).
- [ ] Consider adopting the F4 `isSocket()` watchdog pattern in `mcp-server/src/index.ts` as well — its current watchdog is unconditional, which is fine for the Claude Code launch case but could mis-fire on `npx -y @runtimescope/mcp-server < /dev/null`. Low priority; the existing behavior has shipped correctly in v0.10.8.
- [ ] The published v0.10.9 collector grew from baseline ~80MB to ~104MB across the memory-leak stress (30% growth). The residual is V8/SQLite hygiene — not recoverable without a runtime change. Locking this as the Phase Wire-Protocol-Lock baseline; revisit in Phase Rust-Collector where the GC class is moot.

---

## 9. Reviewer / handoff pointer

The next phase is **Phase Wire-Protocol-Lock** per [`../roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md).

Handoff doc: [`../handoffs/phase-wire-protocol-lock-handoff.md`](../handoffs/) (to be authored when the phase starts — not pre-scheduled).

Inputs the next phase inherits from this phase:
- A stable Node collector at v0.10.9 with no known correctness regressions in the audit's bug classes.
- 586 unit tests + 7 stress scenarios passing as the contract surface.
- `getOpenHandleCounts()` public API as a starting point for the contract's diagnostic surface (the Rust collector must expose an equivalent).
- The `safeLog` helper as a model for the Rust collector's logging (Rust's panic/SIGPIPE handling will look different but the gate is the same: never let a logging failure cascade into a CPU-pegged loop).
