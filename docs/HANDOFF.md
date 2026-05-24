# RuntimeScope — Active Handoff

> **5-minute orientation. Read this first.**

## What is RuntimeScope right now

A runtime monitoring system for Claude Code. Long-running TypeScript collector daemon (Node 20+) ingests events from instrumented apps over WebSocket, persists to SQLite + WAL, exposes them as MCP tools and an HTTP dashboard.

- **Distributed via:** npm (collector, mcp-server, 4 SDKs, CLI) and a Claude Code plugin marketplace.
- **Latest published:** **v0.10.8** (collector, mcp-server, sdk, server-sdk, workers-sdk, runtimescope CLI), plugin **v0.10.12**.
- **Latest commit:** `2a3c0d1` — *fix(mcp-server,collector): kill zombie loop + SQLite handle leak (v0.10.8)*.

## Where the active work is

**Phase: Tauri-Tray** (next up — not yet started).

Trigger: Phase Audit shipped as v0.10.9 ([`audits/0001`](./audits/0001-collector-process-lifetime.md) is Closed; see [`reports/phase-audit-completion-report.md`](./reports/phase-audit-completion-report.md)). Post-audit strategic review produced [ADR-0002](./decisions/0002-rust-port-sequence-and-distribution.md) and [ADR-0003](./decisions/0003-sdk-distribution-channels.md), which re-ordered the rest of the plan: **tray ships first** (validates Rust toolchain, gives the owner an immediate "is the daemon running?" answer), then wire-lock, then Rust collector, then SDK CDN migration.

**Phase plan:** [`roadmap/MASTER_PHASE_PLAN.md`](./roadmap/MASTER_PHASE_PLAN.md)
**Decisions driving sequencing:**
- [`decisions/0001-audit-then-rust.md`](./decisions/0001-audit-then-rust.md) — original audit-first decision (the audit half is Accepted; the "what's next" half is superseded by ADR-0002)
- [`decisions/0002-rust-port-sequence-and-distribution.md`](./decisions/0002-rust-port-sequence-and-distribution.md) — post-audit phase sequence + no-migration + curl-install
- [`decisions/0003-sdk-distribution-channels.md`](./decisions/0003-sdk-distribution-channels.md) — CDN-default + npm-with-provenance + CLI-vendored

## What's next after this phase

Per the master phase plan:

1. **Phase Tauri-Tray** (current) — native macOS menu-bar app, ~5-7d. Talks to existing v0.10.8/9 collector via HTTP API; no Rust collector code yet.
2. **Phase Wire-Protocol-Lock** (v0.11.0) — scoped to ~2-3d. Thin spec + conformance test suite. The Rust port's acceptance gate.
3. **Phase Rust-Collector** (v0.12.0) — 4 Rust crates, dashboard embedded, curl-install, fresh data on cutover (no migration). ~8 weeks.
4. **Phase SDK-Channel-Migration** (v0.13.0) — `cdn.runtimescope.dev` + `runtimescope sdk install` + npm-with-provenance. ~2 weeks.

## Resolution order when uncertain

1. The active phase brief (in [`specs/`](./specs/) once authored).
2. The audit findings in [`audits/`](./audits/).
3. ADRs in [`decisions/`](./decisions/).
4. [`../CLAUDE.md`](../CLAUDE.md) operating manual.

If those don't resolve it: stop and ask the project owner. Do not guess.
