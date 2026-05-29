# RuntimeScope — Active Handoff

> **5-minute orientation. Read this first.**

## What is RuntimeScope right now

A runtime monitoring system for Claude Code. Long-running TypeScript collector daemon (Node 20+) ingests events from instrumented apps over WebSocket, persists to SQLite + WAL, exposes them as MCP tools and an HTTP dashboard. A native macOS menu-bar tray (Tauri 2 + React) gives at-a-glance visibility into the running collector.

- **Distributed via:** npm (collector, mcp-server, 4 SDKs, CLI), PyPI (Python SDK), a Claude Code plugin marketplace, and a manual `.dmg` on GitHub Releases for the tray.
- **Latest published:** **v0.10.12** (collector, mcp-server, sdk, server-sdk, workers-sdk, runtimescope CLI; Python on PyPI), plugin **v0.10.16**, tray **v0.1.0** (workspace-private — manual `.dmg`).
- **Latest commit on `main`:** `538a399` — *fix(cli): bump readyz install poll 30s → 60s (v0.10.12)*. Phase Tauri-Tray work is uncommitted at the time of this handoff snapshot.

## Where the active work is

**Phase: Rust-Collector (next — [handoff ready](./handoffs/phase-rust-collector-handoff.md) + [milestones](./roadmap/rust-collector-milestones.md)).**

Trigger: Phase Wire-Protocol-Lock is substantively complete ([completion report](./reports/phase-wire-protocol-lock-completion-report.md)). The wire contract is now **executable**: `npm run conformance` (15 tests / 5 specs) passes against the Node collector and becomes the Rust port's acceptance gate via `RUNTIMESCOPE_COLLECTOR_CMD` / `RUNTIMESCOPE_MCP_CMD` (ADR-0006). Specs: [`wire-protocol.md`](./specs/wire-protocol.md), [`mcp-tool-surface.md`](./specs/mcp-tool-surface.md). **v0.11.0 is bumped in-tree but not yet published** — `git tag v0.11.0 && git push --tags` when ready.

One open question handed forward (must be decided before Rust Milestone 2): the server→SDK command channel is triggered in-process today; ADR-0002 splits collector and mcp-server into separate Rust bins, so that mechanism needs a design. Flagged in `wire-protocol.md` §5.

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
2. **Phase Wire-Protocol-Lock** (**COMPLETE — v0.11.0 in-tree, publish pending** — see [completion report](./reports/phase-wire-protocol-lock-completion-report.md)). Conformance suite + specs + ADR-0006 landed; 15/15 green.
3. **Phase Rust-Collector** (v0.12.0) — 4 Rust crates, dashboard embedded, curl-install, fresh data on cutover (no migration). ~8 weeks. Plan written ahead of time: [`handoffs/phase-rust-collector-handoff.md`](./handoffs/phase-rust-collector-handoff.md) (contract + module→crate map + hard spots) and [`roadmap/rust-collector-milestones.md`](./roadmap/rust-collector-milestones.md) (milestones + agent-team fan-out strategy).
4. **Phase SDK-Channel-Migration** (v0.13.0) — `cdn.runtimescope.dev` + `runtimescope sdk install` + npm-with-provenance. ~2 weeks.

## Resolution order when uncertain

1. The active phase brief — [`handoffs/phase-rust-collector-handoff.md`](./handoffs/phase-rust-collector-handoff.md) + [`roadmap/rust-collector-milestones.md`](./roadmap/rust-collector-milestones.md). The executable contract is [`tests/conformance/`](../tests/conformance/) (run `npm run conformance`); the spec docs ([`wire-protocol.md`](./specs/wire-protocol.md), [`mcp-tool-surface.md`](./specs/mcp-tool-surface.md)) mirror it — **if a doc and a green test disagree, the test wins** (ADR-0006).
2. The audit findings in [`audits/`](./audits/).
3. ADRs in [`decisions/`](./decisions/).
4. [`../CLAUDE.md`](../CLAUDE.md) operating manual.

If those don't resolve it: stop and ask the project owner. Do not guess.
