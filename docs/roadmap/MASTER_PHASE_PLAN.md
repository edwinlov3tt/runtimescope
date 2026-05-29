# Master Phase Plan

**Status:** Active
**Owner:** edwin@edwinlovett.com + the implementing Claude instance in this repo
**Last updated:** 2026-05-24 (post-Audit, post ADR-0002 + ADR-0003)

This is the single source of truth for what phase is next. **Do not invent phase names without updating this file.**

## Operating principles

1. **Each phase produces a completion report.** No exceptions. The report goes in [`../reports/`](../reports/).
2. **Each phase hands off via a handoff doc.** The handoff embeds the next-phase prompt verbatim — that prompt IS the contract.
3. **The wire protocol is sacred from Phase Wire-Protocol-Lock onward.** Any change must be an ADR before it lands. SDK compat depends on this.
4. **Once the Rust collector ships, the Node packages stop releasing.** v0.10.9 is the final Node release. Bug-fix releases happen only against the Rust collector.
5. **Distribution channels are layered, not replaced.** The Rust collector ships via curl-install. SDKs ship via CDN (default) + CLI-vendored + npm-with-provenance (fallback). Removing any channel is an ADR-worthy decision.

## Phase sequence

```
DONE   ──▶  Phase Audit (v0.10.9)
              audit/0001 closed, all five findings shipped

DONE   ──▶  Phase Tauri-Tray (tray @ v0.1.0; workspace at v0.10.12)
              native macOS menu-bar app, ad-hoc signed for personal use
              talks to existing Node collector via HTTP API only

DONE   ──▶  Phase Wire-Protocol-Lock (v0.10.13)
              tests/conformance/ as the executable spec — 15/15 green
              thin spec (invariants only) + ADR-0006
              no behavior change (a 0.10.x patch, NOT a minor bump)

we are here ──▶  Phase Rust-Collector (v0.11.0)   ← the clean number, reserved for Rust
                  ~8 weeks
                  4 Rust crates replace 3 Node packages
                  dashboard embedded via include_bytes!
                  fresh data on cutover (no migration)
                  curl-install replaces npm install -g

                Phase SDK-Channel-Migration (v0.12.0)
                  ~2 weeks
                  cdn.runtimescope.dev for browser + Workers SDK
                  CLI-vendored install path
                  npm gets --provenance (fallback only)
```

> **Version note (2026-05-29, [ADR-0002 addendum](../decisions/0002-rust-port-sequence-and-distribution.md)):** Wire-Protocol-Lock ships as a `0.10.x` patch (v0.10.13), not v0.11.0 — it's no-behavior-change tooling. **v0.11.0 is reserved as the clean number for the Rust collector**; the rest of the sequence shifts down one minor.

## Phase Tauri-Tray (current)

**Goal:** ship a native macOS menu-bar app that shows collector + MCP status, sessions list, version, and an "update available" notification with one-click update. Validates the Rust toolchain before the larger collector port.

**Stack:**
- Tauri 2 (Rust shell + system webview)
- Reuses dashboard's React/TS for the dropdown UI
- Talks to `http://127.0.0.1:6768/api/*` only (the existing Node collector during this phase, the Rust collector starting in Phase Rust-Collector)
- Distribution: ad-hoc signed for personal use first (the project owner's Apple Developer ID is required if/when distribution opens up)

**Scope for v1 (defer everything else to v2):**

| In | Out |
|---|---|
| Tray icon with status color (green/yellow/red) | Notifications for collector events |
| Dropdown: collector PID, port, uptime, version | Per-session detail views |
| Sessions list (active apps) | History/timeline view |
| Update banner with one-click `runtimescope service update` | Auto-launch on macOS login |
| "Open Dashboard" / "Open Logs" / "Restart Service" / "Quit Service" | Linux/Windows trays |
| Status polling every 5s via existing HTTP API | Real-time WS subscription |
| Auto-update for the tray app itself (Tauri updater) | App Store distribution |

**Acceptance criteria:**
1. Tray icon visible in macOS menu bar, color reflects collector health.
2. Dropdown shows PID, port, uptime (from `/api/health`), session count (from `/api/sessions`), live SDK app names.
3. "Update Available" banner appears when `/api/health`'s `version` < npm registry's `latest`.
4. Restart/Quit/Open commands shell out to the existing `runtimescope` CLI; no direct collector manipulation.
5. Tauri auto-update channel configured (manifest hosted on GitHub Releases).
6. Smoke: build dmg, install on the project owner's primary machine, sees correct status for the running launchd collector.
7. Phase completion report at `../reports/phase-tauri-tray-completion-report.md`.

**Out of scope:**
- Any Rust code that talks to the collector internals (the tray is HTTP-only).
- Any change to the collector itself.
- Any new MCP tool surface.

**Estimated effort:** 5–7 days, with ~1 day for code-signing + notarization setup.

**Estimated effort:** 5–7 days.

## Phase Wire-Protocol-Lock (next)

**Goal:** before any Rust collector code is written, lock the contract the Rust collector must honor. Both as a written spec (thin, invariants-only) and as an executable test suite (the real source of truth).

**Deliverables:**
- [`../specs/wire-protocol.md`](../specs/) — ~2 pages, invariants only:
  - WebSocket handshake structure
  - Event message envelope
  - Bidirectional command/response shape
  - HTTP `/api/*` endpoint contracts (request schema, response schema, status codes)
  - SQLite schema invariants (which columns, which constraints, what migration story)
  - WAL durability ordering (`fsync` before SQLite write)
  - Auth model
- [`../specs/mcp-tool-surface.md`](../specs/) — index of the 55 MCP tools and their input/output shapes (each tool already has a zod schema in code; this doc is a static index)
- `tests/conformance/` — SDK-driven black-box tests that work against any collector binary:
  - Spawn the binary as a subprocess
  - Use the real `@runtimescope/sdk` to send events
  - Use the real `@runtimescope/mcp-server` to query
  - Assert observable behavior (events round-trip, sessions appear, queries return expected shapes)
  - Passes against v0.10.9 today; will be the Rust port's acceptance gate
- ADR-0004 (TBD): "Conformance tests are the executable spec; the spec doc is documentation."

**Acceptance criteria:**
1. Specs cover every wire format the JS SDKs depend on (verified by code excerpts in the spec doc).
2. Conformance test suite passes against the v0.10.9 Node collector.
3. Ships as v0.10.13 (a 0.10.x patch — no behavior change; v0.11.0 reserved for Rust).
4. Completion report at `../reports/phase-wire-protocol-lock-completion-report.md`.

**Out of scope:**
- Any Rust code.
- Any new MCP tool surface or behavior change.

**Estimated effort:** 2–3 days.

## Phase Rust-Collector

**Goal:** port the Node collector + MCP server + CLI to Rust against the locked wire protocol. Ship as a single curl-installable bundle, no npm.

**Crate layout:**

| Crate | Type | Replaces |
|---|---|---|
| `crates/collector-core` | lib | logic in `packages/collector/src/` (ring buffer, sqlite/WAL, engines, project manager) |
| `crates/collector-server` | bin | `packages/collector/src/standalone.ts` — WS + HTTP server |
| `crates/mcp-server` | bin | `packages/mcp-server/` — stdio JSON-RPC + tool registrations |
| `crates/cli` | bin | `packages/cli/` — service install, status, doctor, mcp doctor |

**Core deps:**
- `tokio` — async runtime
- `axum` — HTTP server
- `tokio-tungstenite` — WS server
- `rusqlite` — SQLite (bundled)
- `serde` + `serde_json` — JSON
- `tracing` — structured logging (replaces console.error / safeLog)

**Distribution:**
- `curl -sSL https://runtimescope.dev/install.sh | sh` — installer drops 4 binaries under `~/.runtimescope/bin/`, prepends to PATH
- Single `runtimescope` command on PATH
- Self-update via signed binary releases on GitHub Releases (manifest at `runtimescope.dev/manifest.json` per Tauri-style updater pattern)
- macOS arm64 + x86_64, Linux x86_64 + arm64 — Windows TBD
- **No npm install for the CLI ever again.**

**Data:**
- **Fresh data on cutover** (per [ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md)). First Rust collector run clears `~/.runtimescope/` after a one-time warning. Opt-out via `RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1`.
- SQLite schema designed clean from scratch; not constrained to match the Node collector's schema.

**Dashboard:**
- Built Vite output embedded into `crates/collector-server` via `include_bytes!`.
- No npm install required for end users to access the dashboard.
- Build machine still needs Node for dashboard build; that's our problem, not the user's.

**Sub-phases (each ships its own completion report):**

| Sub-phase | Scope |
|---|---|
| 3a | `crates/collector-core` scaffold; ring buffer + types port |
| 3b | rusqlite + WAL durability path (passes the conformance suite's durability tests) |
| 3c | WS server (handshake + event ingest) — full conformance pass for SDK→server flow |
| 3d | HTTP `/api/*` endpoints — conformance pass for tool→server flow |
| 3e | MCP server: stdio JSON-RPC + 55 tools — full integration with JS SDK |
| 3f | CLI: service install, doctor, mcp doctor, sdk install (scaffold for Phase 4) |
| 3g | Dashboard embed + curl-install script + signed releases + auto-update |
| 3h | Canary + cutover docs + v0.11.0 release |

**Acceptance criteria for the phase as a whole:**
1. Rust collector passes the conformance suite from Phase Wire-Protocol-Lock.
2. All existing JS SDKs work unchanged against the Rust collector.
3. All 55 MCP tools work unchanged.
4. `curl -sSL https://runtimescope.dev/install.sh | sh` installs cleanly on macOS arm64.
5. `runtimescope service install` installs and starts the Rust collector.
6. Tray app picks up the Rust collector without changes (HTTP API is the contract).
7. `packages/collector/`, `packages/mcp-server/`, `packages/cli/` deleted from the repo. Git tag v0.10.13 preserves the final Node code.
8. Ships as v0.11.0.

**Estimated effort:** 8 weeks honest. Each sub-phase produces a completion report; cumulative reports become the de-facto changelog.

## Phase SDK-Channel-Migration

**Goal:** flip the SDK distribution from npm-as-primary to CDN-as-primary, with npm-with-provenance as fallback and CLI-vendored as opt-in. Per [ADR-0003](../decisions/0003-sdk-distribution-channels.md).

**Deliverables:**
- `cdn.runtimescope.dev` (Cloudflare R2 + Pages) hosting versioned SDK assets:
  - `cdn.runtimescope.dev/sdk@<semver>.js` (browser, IIFE) and `.mjs` (ESM)
  - `cdn.runtimescope.dev/workers-sdk@<semver>.js` (ESM)
  - `cdn.runtimescope.dev/server-sdk@<semver>.cjs` and `.mjs`
  - `cdn.runtimescope.dev/sri.json` — canonical SRI hash index
- CI workflow that on release:
  - Builds each SDK
  - Generates sha384 SRI hashes
  - Uploads to R2 under the versioned path
  - Updates `sri.json` with the new entry
  - Publishes to npm with `--provenance` (OIDC-signed)
  - Updates the docs site's install snippet to reference the new versions
- `runtimescope sdk install <browser|server|workers> [--version <semver>]` in the Rust CLI:
  - Fetches from CDN
  - Verifies against `sri.json`
  - Writes a single file into the user's project (configurable path)
  - `runtimescope sdk update <name>` — re-fetches and overwrites
  - `runtimescope sdk outdated` — checks all installed SDKs against latest
- Updated docs:
  - Browser SDK quick-start: `<script src="https://cdn.runtimescope.dev/sdk@1.0.0.js" integrity="sha384-...">`
  - Workers SDK quick-start: `import { ... } from 'https://cdn.runtimescope.dev/workers-sdk@1.0.0.js'`
  - Server SDK quick-start: `runtimescope sdk install server` (CLI-vendored as primary; npm noted as fallback)

**Acceptance criteria:**
1. `runtimescope.dev` domain owned, `cdn.runtimescope.dev` resolves to Cloudflare.
2. R2 bucket configured, Cloudflare Pages routing in place.
3. CI publishes to R2 + npm in a single workflow run; SRI hashes match the artifacts.
4. `runtimescope sdk install browser` works on a fresh machine, fetches the latest CDN version, writes the file, refuses to write if SRI mismatches.
5. `npm audit signatures @runtimescope/sdk` verifies provenance.
6. Docs updated end-to-end.
7. Ships as v0.12.0.

**Estimated effort:** ~2 weeks (including domain setup + CDN infrastructure + CI rework).

## Out of plan (intentionally unscheduled)

- **Linux/Windows tray support.** The macOS tray ships first. Add platforms only after the Rust collector port stabilizes.
- **Migrating the dashboard to Leptos/Dioxus.** Embed-via-`include_bytes!` removes the supply-chain concern; rewriting is out of scope.
- **Hosted SaaS collector.** Local-first stays.
- **Replacing `exceljs` / `better-sqlite3`** — both go away when the Node collector retires.
- **Workspace-key authentication, multi-tenant routing, etc.** — out of scope for the Rust port; revisit only after v0.12.0 (SDK-Channel-Migration) ships.
- **Data migration from v0.10.x to v0.11.x.** Explicitly accepted as data loss per ADR-0002. Revisit only when there's a second user.

## Proposed but not yet scheduled

- **Switch internal monorepo tooling from npm to pnpm.** Captured as [ADR-0005 (Proposed)](../decisions/0005-pnpm-over-npm-for-internal-tooling.md). Trigger: early Phase Rust-Collector when the Node collector is days from retirement. Not acted on until then.

## Revision policy

This file changes when:
- A phase ships (mark complete, link the report, advance "we are here").
- A phase splits or merges (state why; archive prior version if non-trivial).
- A new phase enters the queue (add it, with rationale).

This file does **not** change for tactical pivots inside a phase — those go in ADRs.

## Recent changes to this plan

- **2026-05-24** — Initial version (Audit → Wire-Lock → Rust → Tray sequence).
- **2026-05-24** — Updated per [ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md) + [ADR-0003](../decisions/0003-sdk-distribution-channels.md). Re-ordered: Tray-first, no data migration, CDN-default SDKs, curl-install for the Rust CLI. Audit Phase now reflected as DONE (shipped as v0.10.9).
