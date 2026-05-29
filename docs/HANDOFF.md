# RuntimeScope — Active Handoff

> **5-minute orientation. Read this first.**

## What is RuntimeScope right now

A runtime monitoring system for Claude Code. Long-running TypeScript collector daemon (Node 20+) ingests events from instrumented apps over WebSocket, persists to SQLite + WAL, exposes them as MCP tools and an HTTP dashboard. A native macOS menu-bar tray (Tauri 2 + React) gives at-a-glance visibility into the running collector.

- **Distributed via:** npm (collector, mcp-server, 4 SDKs, CLI), PyPI (Python SDK), a Claude Code plugin marketplace, and a manual `.dmg` on GitHub Releases for the tray.
- **Latest published:** **v0.10.12** (collector, mcp-server, sdk, server-sdk, workers-sdk, runtimescope CLI; Python on PyPI), plugin **v0.10.16**, tray **v0.1.0** (workspace-private — manual `.dmg`).
- **Latest commit on `main`:** `538a399` — *fix(cli): bump readyz install poll 30s → 60s (v0.10.12)*. Phase Tauri-Tray work is uncommitted at the time of this handoff snapshot.

## Where the active work is

**Phase: Wire-Protocol-Lock (next up — handoff doc not yet written).**

Trigger: Phase Tauri-Tray shipped v0.1.0 of `@runtimescope/tray` ([completion report](./reports/phase-tauri-tray-completion-report.md)). The tray locks three HTTP endpoints as its contract (documented in [`docs/specs/tray-api-surface.md`](./specs/tray-api-surface.md)) — the next phase consolidates that surface + adds a conformance test suite that the Rust collector must pass.

**Phase plan:** [`roadmap/MASTER_PHASE_PLAN.md`](./roadmap/MASTER_PHASE_PLAN.md)
**Decisions driving sequencing:**
- [`decisions/0001-audit-then-rust.md`](./decisions/0001-audit-then-rust.md) — original audit-first decision (the audit half is Accepted; the "what's next" half is superseded by ADR-0002)
- [`decisions/0002-rust-port-sequence-and-distribution.md`](./decisions/0002-rust-port-sequence-and-distribution.md) — post-audit phase sequence + no-migration + curl-install
- [`decisions/0003-sdk-distribution-channels.md`](./decisions/0003-sdk-distribution-channels.md) — CDN-default + npm-with-provenance + CLI-vendored

## What Phase Tauri-Tray left for the next phase

Direct inputs for Wire-Protocol-Lock:

- **[`docs/specs/tray-api-surface.md`](./specs/tray-api-surface.md)** — the three endpoints the tray reads. The first file under `docs/specs/`; established the file convention for that directory. This document is the *input* — Wire-Protocol-Lock writes `docs/specs/wire-protocol.md` as the *output*.
- **`packages/tray/`** — a concrete client to validate the locked surface against. Acceptance test: tray builds and runs unchanged against any collector implementation that conforms to the locked surface.

Open deferrals (see CURRENT_STATE.md and the Tauri-Tray completion report for detail):
- **D1** — auto-updater: blocked on owner-side P1 (Tauri signing keys + GitHub secret). v0.1.0 ships as manual `.dmg`.
- **D2** — owner-side smoke check of the `.dmg`.
- **Pre-existing build issue** — `npm run build` errors on the `runtimescope-playground` workspace (missing `build` script). Decide in a future phase whether to add `--if-present` or stub a script.

## What's next after this phase

Per the master phase plan:

1. **Phase Tauri-Tray** (**SHIPPED v0.1.0** — see [completion report](./reports/phase-tauri-tray-completion-report.md)).
2. **Phase Wire-Protocol-Lock (current next)** — thin spec + conformance test suite. The Rust port's acceptance gate. Inherits the tray as a concrete client. Targeted at v0.11.0 of the workspace surface. ~2-3d.
3. **Phase Rust-Collector** (v0.12.0) — 4 Rust crates, dashboard embedded, curl-install, fresh data on cutover (no migration). ~8 weeks.
4. **Phase SDK-Channel-Migration** (v0.13.0) — `cdn.runtimescope.dev` + `runtimescope sdk install` + npm-with-provenance. ~2 weeks.

## Resolution order when uncertain

1. The active phase brief (in [`handoffs/`](./handoffs/) — for Wire-Protocol-Lock, the brief is not yet written; until it is, the [Tauri-Tray completion report](./reports/phase-tauri-tray-completion-report.md) + [`docs/specs/tray-api-surface.md`](./specs/tray-api-surface.md) are the load-bearing inputs).
2. The audit findings in [`audits/`](./audits/).
3. ADRs in [`decisions/`](./decisions/).
4. [`../CLAUDE.md`](../CLAUDE.md) operating manual.

If those don't resolve it: stop and ask the project owner. Do not guess.
