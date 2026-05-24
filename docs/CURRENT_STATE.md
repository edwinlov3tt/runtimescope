# Current State

**Snapshot date:** 2026-05-24 (post-Audit, post ADR-0002 + ADR-0003)
**Snapshot commit:** `662969f` — *feat(audit): close audit 0001 — process lifetime + resource hygiene (v0.10.9)*

This file is updated when releases land or gates change. It is *not* a running log — for that, see [`CHANGELOG.md`](./CHANGELOG.md).

## Published versions

| Package | Version | Registry |
|---|---|---|
| `@runtimescope/sdk` | 0.10.9 | npm |
| `@runtimescope/server-sdk` | 0.10.9 | npm |
| `@runtimescope/workers-sdk` | 0.10.9 | npm |
| `@runtimescope/collector` | 0.10.9 | npm |
| `@runtimescope/mcp-server` | 0.10.9 | npm |
| `runtimescope` (CLI) | 0.10.9 | npm |
| `runtimescope` (Python) | 0.10.9 | PyPI |
| Plugin (Claude marketplace) | 0.10.13 | edwinlov3tt/runtimescope marketplace |

## Gate status

| Gate | Command | Status |
|---|---|---|
| Build | `npm run build` | ✅ clean across 13 workspace packages |
| Unit tests | `npm test` | ✅ **586 / 0** |
| Stress harness | `npm run stress` | ✅ **7 / 7** scenarios |
| Smoke: published CLI | `runtimescope --version` | ✅ → `0.10.9` |
| Smoke: npx MCP | `npx -y @runtimescope/mcp-server@latest` | ✅ boots, MCP transport ready in <20s with warm npx cache |
| Smoke: parent-death exit | spawn `runtimescope-mcp` → close stdin | ✅ exits in 5ms with code 0 |
| Smoke: launchd collector | `runtimescope status` | ✅ green, no SDKs connected |

## What v0.10.8 fixed

- **MCP server zombie loop** (HIGH). When Claude Code exited, the npx-spawned MCP server got reparented to init and could enter an `uncaughtException → console.error → uncaughtException` loop against a closed stderr pipe, pegging CPU at 80%+ forever. Observed in prod: 7 orphans, oldest accumulated 39h44m of CPU time over 4 days.
  - Fix: stdin-close watchdog (`stdin.on('end' | 'error')` → `process.exit(0)`) + EPIPE-safe stderr writes in the `uncaughtException` and `unhandledRejection` handlers.
  - Verified: spawn → close stdin → exits in **12ms** with code 0.

- **Per-project SQLite handle leak** (HIGH). Each project's SQLite store stayed open in `CollectorServer.sqliteStores: Map` for the life of the process — never evicted. Each handle holds a WAL FD + ~2-3MB page cache. On the user's machine with 44 historical projects, that's ~100MB of permanent baseline RSS.
  - Fix: LRU eviction. 5-minute idle timeout, 60s sweep, never evict stores belonging to live SDK clients.
  - Memory-leak stress scenario: 47% growth → 30% growth across 10 cycles. Gate tightened from 50% → 40%.

## What v0.10.9 closed

[Audit 0001](./audits/0001-collector-process-lifetime.md) — all 5 findings landed together. Phase Audit completion report: [`reports/phase-audit-completion-report.md`](./reports/phase-audit-completion-report.md).

- **F1** — All 118 stderr writes now flow through the EPIPE-safe `safeLog.error` helper. 10 new unit tests pin the contract.
- **F2** — All 7 long-running `setInterval` timers `.unref?.()`. Defense in depth — exit is no longer gated on `stop()` being called.
- **F3** — WAL handle LRU eviction mirrors v0.10.8's SQLite store fix. 3 regression tests.
- **F4** — Standalone collector parent-death watchdog, gated on `fstatSync(0).isSocket()` to avoid /dev/null EOF in launchd/systemd/stdio-ignore cases.
- **F5** — `pendingCommands` timeout cleanup regression test (3 tests covering timeout, send-fail, response-clears-timer).

## Open deferrals

None from Phase Audit. Next phase is **Phase Tauri-Tray** per the updated [`roadmap/MASTER_PHASE_PLAN.md`](./roadmap/MASTER_PHASE_PLAN.md) (re-ordered post-audit per [ADR-0002](./decisions/0002-rust-port-sequence-and-distribution.md)).

## Local environment (project owner's primary machine)

| Surface | State |
|---|---|
| launchd collector | running, PID 23147 (re-installed after v0.10.8) — **still on v0.10.8**, needs `npm install -g runtimescope@latest && runtimescope service install` to deploy the v0.10.9 binary |
| Tray app | not yet built (Phase Tauri-Tray) |
| Data | ~/.runtimescope/projects/ holds 44 projects of historical SQLite + WAL — will be wiped on Rust collector cutover (accepted per ADR-0002) |

The Node daemon stays running through Phase Tauri-Tray (it's what the tray controls during the interim). The `launchctl unload` advice in the second instance's strategic proposal was rejected in favor of "tray-first, daemon stays running for tray's benefit" — see ADR-0002 §"What we are explicitly NOT doing."

## Known issues not in the audit

See [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) (legacy doc, to be migrated into `audits/` going forward).
