# RuntimeScope — Active Handoff

> **5-minute orientation. Read this first.**

## What is RuntimeScope right now

A runtime monitoring system for Claude Code. Long-running TypeScript collector daemon (Node 20+) ingests events from instrumented apps over WebSocket, persists to SQLite + WAL, exposes them as MCP tools and an HTTP dashboard. A native macOS menu-bar tray (Tauri 2 + React) gives at-a-glance visibility into the running collector.

- **Distributed via:** npm (collector, mcp-server, 4 SDKs, CLI), PyPI (Python SDK), a Claude Code plugin marketplace, and a manual `.dmg` on GitHub Releases for the tray.
- **Latest published:** **v0.10.12** (collector, mcp-server, sdk, server-sdk, workers-sdk, runtimescope CLI; Python on PyPI), plugin **v0.10.16**, tray **v0.1.0** (workspace-private — manual `.dmg`).
- **Latest commit on `main`:** `538a399` — *fix(cli): bump readyz install poll 30s → 60s (v0.10.12)*. Phase Tauri-Tray work is uncommitted at the time of this handoff snapshot.

## Where the active work is

**Phase: Rust-Collector (target v0.11.0) — Milestone 0 COMPLETE; Milestone 1 is next.** [Handoff](./handoffs/phase-rust-collector-handoff.md) + [milestones](./roadmap/rust-collector-milestones.md).

Wire-Protocol-Lock shipped as **v0.10.13** (published to npm 2026-05-29, conformance gate green in CI — the final Node release). The wire contract is **executable**: `npm run conformance` (15/5) is the Rust port's acceptance gate via `RUNTIMESCOPE_COLLECTOR_CMD` / `RUNTIMESCOPE_MCP_CMD` (ADR-0006).

**Milestone 0 decisions (all made — see [milestones](./roadmap/rust-collector-milestones.md)):**
- Playwright → **Node sidecar** ([ADR-0007](./decisions/0007-playwright-node-sidecar.md)).
- Command channel → **mcp-server embeds collector-core in-process** ([ADR-0008](./decisions/0008-rust-mcp-embeds-collector-core.md)); closes the `wire-protocol.md` §5 open question — no cross-process bridge.
- **rmcp 1.7** + **rusqlite dedicated-DB-thread** validated by spikes ([research 0001](./research/0001-rust-foundational-spikes.md)).

**Milestone 1 in progress.** The Cargo workspace + 4 crates (`crates/collector-core|collector-server|mcp-server|cli`) build clean (axum 0.8 + rmcp 1.7 + rusqlite 0.40 + tokio). Green against the Rust binaries via the conformance harness: `collector-server` passes `event-roundtrip` **and `durability`** (persistence: rusqlite WAL-mode + a JSONL WAL with fsync-before-commit behind the dedicated-DB-owner thread — events survive SIGKILL + restart), and `mcp-server` passes the `get_network_requests` round-trip (ADR-0008 embed-in-process). **Remaining M1 (still serial, one author):** the full 19 serde event types, auth (handshake-4001 / HTTP-401), WAL rotation/truncation, a short patterns doc. The agent-team fan-out (M3) does not start until the spine is complete. Toolchain: Rust 1.95.0.

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
2. **Phase Wire-Protocol-Lock** (**COMPLETE — v0.10.13 in-tree, publish pending** — see [completion report](./reports/phase-wire-protocol-lock-completion-report.md)). Conformance suite + specs + ADR-0006 landed; 15/15 green. A 0.10.x patch, not a minor bump.
3. **Phase Rust-Collector** (**v0.11.0** — the clean reserved number) — 4 Rust crates, dashboard embedded, curl-install, fresh data on cutover (no migration). ~8 weeks. Plan written ahead of time: [`handoffs/phase-rust-collector-handoff.md`](./handoffs/phase-rust-collector-handoff.md) (contract + module→crate map + hard spots) and [`roadmap/rust-collector-milestones.md`](./roadmap/rust-collector-milestones.md) (milestones + agent-team fan-out strategy).
4. **Phase SDK-Channel-Migration** (v0.12.0) — `cdn.runtimescope.dev` + `runtimescope sdk install` + npm-with-provenance. ~2 weeks.

## Resolution order when uncertain

1. The active phase brief — [`handoffs/phase-rust-collector-handoff.md`](./handoffs/phase-rust-collector-handoff.md) + [`roadmap/rust-collector-milestones.md`](./roadmap/rust-collector-milestones.md). The executable contract is [`tests/conformance/`](../tests/conformance/) (run `npm run conformance`); the spec docs ([`wire-protocol.md`](./specs/wire-protocol.md), [`mcp-tool-surface.md`](./specs/mcp-tool-surface.md)) mirror it — **if a doc and a green test disagree, the test wins** (ADR-0006).
2. The audit findings in [`audits/`](./audits/).
3. ADRs in [`decisions/`](./decisions/).
4. [`../CLAUDE.md`](../CLAUDE.md) operating manual.

If those don't resolve it: stop and ask the project owner. Do not guess.
