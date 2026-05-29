# Current State

**Snapshot date:** 2026-05-29 (post-Wire-Protocol-Lock)
**Snapshot commit:** Phase Tauri-Tray committed (`c9dfe33`); bench/seam (`2800c4e`); Wire-Protocol-Lock conformance suite + specs + ADR-0006 (this snapshot). See [`reports/phase-wire-protocol-lock-completion-report.md`](./reports/phase-wire-protocol-lock-completion-report.md).

**Active phase:** Phase Rust-Collector (target **v0.11.0**). **Milestone 0 complete (2026-05-29)** — Wire-Protocol-Lock shipped (v0.10.13, published to npm); Playwright→Node sidecar ([ADR-0007](./decisions/0007-playwright-node-sidecar.md)); command-channel→mcp embeds core in-process ([ADR-0008](./decisions/0008-rust-mcp-embeds-collector-core.md)); rmcp 1.7 + rusqlite dedicated-thread validated by spikes ([research 0001](./research/0001-rust-foundational-spikes.md)). **Next: Milestone 1** — `collector-core` spine + one green vertical slice (serial, one author; see [`roadmap/rust-collector-milestones.md`](./roadmap/rust-collector-milestones.md)).

This file is updated when releases land or gates change. It is *not* a running log — for that, see [`CHANGELOG.md`](./CHANGELOG.md).

## Published versions

| Package | Version | Registry |
|---|---|---|
| `@runtimescope/sdk` | 0.10.13 | npm |
| `@runtimescope/server-sdk` | 0.10.13 | npm |
| `@runtimescope/workers-sdk` | 0.10.13 | npm |
| `@runtimescope/collector` | 0.10.13 | npm |
| `@runtimescope/mcp-server` | 0.10.13 | npm |
| `runtimescope` (CLI) | 0.10.13 | npm |
| `runtimescope` (Python) | 0.10.12 | PyPI |
| `@runtimescope/tray` | 0.1.0 | **workspace-private** — manual `.dmg` distribution on GitHub Releases (auto-updater pending P1; see Phase Tauri-Tray completion report §4.1) |
| Plugin (Claude marketplace) | 0.10.16 | edwinlov3tt/runtimescope marketplace |

> **v0.10.13 (Wire-Protocol-Lock) published 2026-05-29** — tag `v0.10.13`, conformance gate ran green in CI before publish. The **final Node release**. **v0.11.0 is intentionally skipped — reserved as the clean number for the Rust collector.** (Python SDK still at 0.10.12 — not part of the JS release train.)

## Gate status

| Gate | Command | Status |
|---|---|---|
| Build (existing packages + tray) | `npm run build` | ✅ all 13 existing packages + new `packages/tray` build clean. Pre-existing playground build-script issue persists at the inherited HEAD — see Tauri-Tray completion report §4.2 |
| Unit tests | `npm test` | ✅ **586 / 0** |
| Stress harness | `npm run stress` | ✅ **7 / 7** scenarios |
| Wire-protocol conformance | `npm run conformance` | ✅ **15 / 15** (5 specs) — the Rust port's acceptance gate (ADR-0006) |
| Benchmark | `npm run bench` | ✅ Node baseline at `bench/baselines/node.json` (~59k evt/s, p99 ~7ms, no leak) |
| Tray Rust unit | `cd packages/tray/src-tauri && cargo test --lib` | ✅ **2 / 0** |
| Tray release build | `cd packages/tray && cargo tauri build` | ✅ produces `RuntimeScope_0.1.0_aarch64.dmg` (2.6 MB), ad-hoc signed |
| Smoke: published CLI | `runtimescope --version` | ✅ → `0.10.12` |
| Smoke: npx MCP | `npx -y @runtimescope/mcp-server@latest` | ✅ boots, MCP transport ready in <20s with warm npx cache |
| Smoke: parent-death exit | spawn `runtimescope-mcp` → close stdin | ✅ exits in 5ms with code 0 |
| Smoke: launchd collector | `runtimescope service status` | ✅ green, PID assigned, version 0.10.12 |
| Smoke: `service stop` (new) | `runtimescope service stop` then `restart` | ✅ unloads plist, HTTP stops responding; `service restart` brings the daemon back through ~30s WAL replay |
| Smoke: tray binary | launch `RuntimeScope.app` for 10s | ✅ 92 MB RSS, no crash, no stderr noise |

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

## What Phase Tauri-Tray shipped (v0.1.0, this snapshot)

[Completion report](./reports/phase-tauri-tray-completion-report.md) — full detail. Summary:

- **`@runtimescope/tray@0.1.0`** — Tauri 2 + React menu-bar app for macOS (≥ 13.0), ad-hoc signed `.dmg` at `packages/tray/src-tauri/target/release/bundle/dmg/RuntimeScope_0.1.0_aarch64.dmg`.
- **`runtimescope service stop`** added to the CLI (mirrors `restartLaunchd()` minus the load step). Unloads the launchd plist or systemd unit without removing it — the tray's "Quit Service" button shells out to this.
- **`docs/specs/tray-api-surface.md`** — first file under `docs/specs/`; locks the HTTP endpoints the tray reads (`/api/health`, `/api/sessions`, npm-latest). Becomes input to Phase Wire-Protocol-Lock.
- **`rust-toolchain.toml`** at the repo root pins Rust 1.95.0.

## Open deferrals

- **D1 (Tauri-Tray):** Auto-updater wired but disabled — owner must complete P1 (signing keys + `gh secret set TAURI_SIGNING_PRIVATE_KEY`) to unblock. v0.1.0 ships as manual-download `.dmg`.
- **D2 (Tauri-Tray):** Owner-side smoke check on the `.dmg`. Checklist in the completion report §6.
- **Pre-existing (§4.2 of Tauri-Tray report):** `npm run build` fails on the `runtimescope-playground` workspace (missing `build` script). 13 existing + tray all build clean; the playground error is independent of this phase.

Next phase is **Phase Wire-Protocol-Lock** per the updated [`roadmap/MASTER_PHASE_PLAN.md`](./roadmap/MASTER_PHASE_PLAN.md).

## Local environment (project owner's primary machine)

| Surface | State |
|---|---|
| launchd collector | running, v0.10.12, port 6768. Smoke-tested through stop/restart during Phase Tauri-Tray. |
| Tray app | **v0.1.0 built but not yet installed.** `.dmg` at `packages/tray/src-tauri/target/release/bundle/dmg/RuntimeScope_0.1.0_aarch64.dmg` |
| Data | ~/.runtimescope/projects/ holds 44 projects of historical SQLite + WAL — will be wiped on Rust collector cutover (accepted per ADR-0002) |

The Node daemon stays running through Phase Tauri-Tray (it's what the tray controls during the interim). The `launchctl unload` advice in the second instance's strategic proposal was rejected in favor of "tray-first, daemon stays running for tray's benefit" — see ADR-0002 §"What we are explicitly NOT doing."

## Known issues not in the audit

See [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) (legacy doc, to be migrated into `audits/` going forward).
