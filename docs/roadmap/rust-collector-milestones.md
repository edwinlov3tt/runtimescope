# Phase Rust-Collector — milestones & agent-team strategy

> Companion to [`../handoffs/phase-rust-collector-handoff.md`](../handoffs/phase-rust-collector-handoff.md). That doc is the *what* and the *contract*; this is the *order* and the *who* (serial vs. agent-team fan-out).

## The governing shape: serial spine → parallel ribs → serial close

A from-scratch Rust port has a hard critical path (everything depends on `collector-core`) but parallel interiors (63 MCP tools, 4 engines, N route handlers are mutually independent). The failure mode of throwing a team at it on day one is **convention drift**: 63 agents inventing 63 error-handling styles, 63 envelope-shaping helpers, 63 ways to call the store — which costs more to reconcile than it saved.

So the rule is: **one coherent author settles the conventions and proves one vertical slice end-to-end. Only then do you fan out.**

```
M0 ─ M1   serial, one author      ← spine + conventions + 1 green slice
M2..M5    fan out (with care)     ← ribs: tools, engines, routes; pm/ as own track
M6 ─ M7   serial, one author      ← close: integrate, gate, embed, cutover
```

## "A lot of sessions?" — yes. Here's the honest shape.

ADR-0002 budgets **~8 weeks**. In Claude-Code working-session terms that's **dozens of sessions**, not a handful. A team compresses *wall-clock* on M2–M5 but not total effort/tokens. M1 and M7 are the make-or-break milestones and want undistracted serial attention. Don't let the team-parallelism tempt you into rushing M1 — a shaky `Store` trait or event-type model poisons everything downstream.

---

## Milestone 0 — Prerequisites & decisions (serial, ~2–3 days) — ✅ COMPLETE (2026-05-29)

**Gate to enter the phase at all.** All four resolved:

- [x] Phase Wire-Protocol-Lock shipped (v0.10.13): `npm run conformance` green against Node — the acceptance gate exists.
- [x] **Playwright strategy → Node sidecar** ([ADR-0007](../decisions/0007-playwright-node-sidecar.md)). `mcp-server` keeps `scan_website` + browser-recon by spawning a lazy Node sidecar; everything else stays pure Rust.
- [x] **`rmcp` 1.7.0 validated** ([research note 0001](../research/0001-rust-foundational-spikes.md)). Throwaway spike served a tool over stdio JSON-RPC with the exact `{summary,data,issues,metadata}` envelope; input schema auto-derives from the Rust struct via `schemars` (the zod replacement). Stable 1.x API.
- [x] **rusqlite concurrency → dedicated DB-owner thread** fed via `mpsc`/`oneshot` ([research note 0001](../research/0001-rust-foundational-spikes.md)). Spike: 5000 concurrent-task inserts, WAL active, ~33k ins/sec. (Mirrors the current single-writer EventStore.)
- [x] **Command-channel mechanism → `mcp-server` embeds `collector-core` in-process** ([ADR-0008](../decisions/0008-rust-mcp-embeds-collector-core.md)). Closes the `wire-protocol.md` §5 open question: separate crates, same process when MCP is active; `send_command` stays in-process — no bridge.

**Team?** No. These were judgment calls + spikes. **Done — proceed to M1.**

## Milestone 1 — Spine: `collector-core` + one vertical slice (serial, ~1 wk) — 🟡 IN PROGRESS

The most important week of the phase. **One author. No fan-out.**

- [x] Workspace `Cargo.toml` + 4 crate skeletons (`collector-core`, `collector-server`, `mcp-server`, `cli`) + CI wiring (`.github/workflows/rust.yml`: `cargo build/clippy -D warnings/test` on macos-14). Built clean first try (axum 0.8.9, rmcp 1.7.0, tokio).
- [x] **Vertical slice GREEN against the Rust binaries, via the same conformance harness that validates Node:**
  - `collector-server`: `event-roundtrip` 2/2 — WS handshake → ingest → `/api/events/network` query → project_id isolation (`RUNTIMESCOPE_COLLECTOR_CMD=…/collector-server npx vitest … event-roundtrip`).
  - `mcp-server`: the `get_network_requests` data round-trip — SDK → embedded in-process collector → MCP tool reads the shared `Store` (`RUNTIMESCOPE_MCP_CMD=…/mcp-server`). Proves the ADR-0008 embed-in-process topology.
- [x] Patterns established by the slice: the `{summary,data,issues,metadata}` envelope, the rmcp `#[tool]` + schemars-arg pattern, the axum route-handler signature, and **the `Store` query seam both HTTP routes and MCP tools call** (`events_by_type`). `collector-core::serve()` is shared by both bins.
- [x] **Persistence + durability** (rusqlite WAL-mode + a JSONL WAL with fsync-before-commit, behind the dedicated-DB-owner thread fed via mpsc/oneshot — research 0001 / ADR-0008). The `durability` conformance test passes against `collector-server`. 2 WAL unit tests (roundtrip + torn-tail). The store API went async; HTTP handlers + the MCP tool `await` it.
- [x] **Auth** (`RUNTIMESCOPE_AUTH_TOKEN`): WS handshake gate (no/invalid token → close **4001** within 5s; valid token accepted), HTTP `Authorization: Bearer` gate (gated routes → **401**), the public-route set (health/readyz/metrics) reachable without auth, `/api/health.authEnabled`, and a minimal `/metrics`. Makes the `handshake` + `http-contracts` specs fully green.
- [x] **Conformance gate broadened to 17 tests / 7 specs** (all green vs the Node source-of-truth) so "green" is a real done-signal, not a network-only shape-check. Added `event-families` (every event type → `/api/events/*`, gates M2) + `mcp-tool-families` (get_console_messages/get_session_info/detect_issues read the store, gates M3). **Rust binaries: 13/17** — `handshake` 3/3, `event-roundtrip` 2/2, `http-contracts` 6/6, `durability` 1/1, `mcp-tools` data-roundtrip. The 4 gaps are the roadmap: `event-families`→M2; `mcp-tool-families` + `mcp-tools` catalog/command-channel→M3.
- [ ] **Remaining M1:** the full 19 serde event types (slice persists events as raw `Value` JSON in the `data` column — fine for storage, but typed access is needed for issue-detection etc.); WAL sealed-file rotation + bounded truncation (`wal.ts` `rotate`/`deleteSealed` — not exercised by the one-restart durability test); a short written patterns doc. Then M1 is done and M3's fan-out can begin.

**Exit criterion:** a second engineer (or agent) could look at the slice + patterns doc and write a new tool/route/engine without asking how. The slice proves the shape; persistence + the type set complete it.

**Team?** No — this is the convention-setting pass by definition.

## Milestone 2 — `collector-server`: WS + HTTP (~1.5 wk) — 🟢 GATE MET

> **Gate: `event-families.conformance.test.ts` green against the Rust collector — DONE.** The full read API across every event type passes (Rust 13/17 → 14/17).

- [x] **Generic event read API** `/api/events/{kind}` (one handler — the M1 `Store.events_by_type` + the WS ingest were already type-agnostic, so per-type fan-out wasn't needed). `renders`→`render` route↔type quirk handled. Turns `event-families` green. Plus `/api/projects` (sessions grouped by app).
- [x] WS handshake (5s auth timeout, close 4001) + event-batch ingest — done in M1.
- [x] HTTP router skeleton + public/auth gate + `/metrics` — done in M1.
- [ ] **Not gated by conformance, deferred:** the `requestId` command-channel *send* (shared with M3 — needed by `get_dom_snapshot`); `/api/events/timeline` (aggregate/merge, not a single-type filter); `/api/processes` + `/api/ports` (OS process logic — overlaps M4's process-monitor engine); static dashboard serving (M6, `include_bytes!`).

**Team?** Partial — one author does the WS + router skeleton; route handlers fan out.

## Milestone 3 — `mcp-server`: the 63 tools (heavy fan-out, ~1.5 wk) — 🟢 CONFORMANCE GATE MET

> **Gate: `mcp-tool-families` + `mcp-tools` catalog (≥60) + command-channel — ALL GREEN. Rust conformance 17/17.**

- [x] **64 tools registered** across 10 family modules (`tools/*.rs`), each `#[tool_router(router = …, vis = "pub")]` merged in `Mcp::new`. Done via an 8-agent Workflow fan-out (one family per agent, writing its own file) + serial integration. Built first try; clippy clean.
- [x] **Real store-reads** (~40): all event-family reads, `detect_issues`/`runtime_qa_check`/`capture_har`, api-discovery over network events, recon over stored `recon_*` events, `list_projects`, query log/perf, `get_session_info`, the command-channel `get_dom_snapshot`.
- [ ] **Deferred stubs (registered + valid envelope, but `data: null`)** — these need capabilities the collector doesn't have yet and are **the real remaining work, mostly M4/M5**: DB introspection (`get_schema_map`/`get_table_data`/`modify_table_data`/`get_database_connections`/`suggest_indexes`), OS/infra (all of `process-monitor` + `infra-connector`), `pm/` (`workspaces/*`, `setup_project`, `get_project_config`), and the Playwright-sidecar tools (`scan_website`, `get_style_diff`). The catalog/`mcp-tool-families` gate passes because the store-read tools it samples are real — but **17/17 conformance does NOT mean these stubs work**.

The biggest LOC chunk and the most parallelizable — the agent fan-out is what made it ~1 turn instead of days.

- [ ] Tool-registration pattern proven in M1; now batch the 63 tools by family (core / api / database / process / infra / session / history / scanner / recon / setup).
- [ ] Each tool: serde input validation → `Store` call → standard envelope. The conformance `mcp-driver` + per-tool smoke is the check.
- [ ] Scanner + browser-recon tools follow the ADR-0007 decision (likely the sidecar — isolate them).

**Team?** **Yes — this is the textbook fan-out.** Batch tools across agents (e.g. 5–8 agents, ~8–12 tools each), each handed the patterns doc + the conformance spec for its family. Reconcile against `cargo clippy` + conformance, not by eyeball.

## Milestone 4 — Engines + recon (fan-out, ~1 wk) — 🟡 IN PROGRESS

- [x] **`scan_website` REAL via the recon sidecar (ADR-0007 payoff).** mcp-server spawns the Node sidecar (`mcp-server/src/sidecar.rs`, one-shot newline-JSON over stdio) and proxies `scan_website` → verified end-to-end: a live scan of example.com returns 6 recon events (`recon_metadata/design_tokens/fonts/layout_tree/accessibility/asset_inventory`) through the Rust mcp-server. Sidecar launch command via `RUNTIMESCOPE_RECON_SIDECAR`. **Browser resolution + bundling is M6** (the smoke needed `PLAYWRIGHT_BROWSERS_PATH` at the installed Chromium; curl-install must ship/locate it).
- [x] **`scan_website` ingests → the recon read-family is real.** scan_website stores its captured `recon_*` events under a project; `get_page_metadata` / `get_design_tokens` / `get_font_info` / `get_layout_tree` / `get_accessibility_tree` / `get_asset_inventory` read them back. Verified end-to-end on example.com (real tokens/metadata/fonts), including across a restart (persistence).
- [x] **process-monitor read tools real** (`get_dev_processes`, `get_port_usage`) via dep-free OS introspection (`ps`/`lsof`, async, whole-word hint matching). Verified against the live machine.
- [x] **Database family real / parity-matched** (gated by `database-introspection.conformance.test.ts`, 61/61). `suggest_indexes` is now a real store-read — ports `query-monitor.ts suggestIndexes` (regex WHERE/ORDER-BY column extraction, >100ms filter, dedup by `(table, sorted-cols)`, `estimatedImpact` buckets, `suggestedSQL`). **Key finding: the "DB-introspection engine" was a phantom** — Node's `ConnectionManager.addConnection` is *never called* anywhere in the repo, so connection-based introspection is dormant in Node too; every reachable call returns "no connections configured". So `get_database_connections` (empty list), `get_schema_map`/`get_table_data` (`data:null` + guidance), and `modify_table_data` (Node's raw-string response) now **match Node exactly** rather than carrying a `deferred` marker. No pg/mysql/sqlite driver engine was needed for parity — live driver introspection + a connection-registration path is a **shared latent gap** (unbuilt in BOTH Node and Rust), deferred to whenever that feature is actually wired.
- [x] **Selector-recon tools** (`get_computed_styles`, `get_element_snapshot`). The reshaping path (property-group/specific filtering, variations issues, snapshot summary + zero-dimension flag) is real and **conformance-gated** by `recon-selector-shapes.conformance.test.ts` (63/63). The **live sidecar fallback** is wired — when nothing is stored for a selector but a page was scanned, the tools derive the last-scanned URL (from stored `recon_*` events) and call the sidecar's `computed_styles`/`element_snapshot` methods (already supported), build + cache a synthetic event, and reshape it. Like `scan_website`, the live browser path needs a manual smoke with `PLAYWRIGHT_BROWSERS_PATH` (M6 bundles the browser); not Node-conformance-gateable.
- [ ] **Remaining M4:** `get_style_diff` (no stored type); mutating process tools (`kill_process`/`purge_caches`/`restart_dev_server` — need care); `infra-connector` (external platform APIs — needs tokens/config, lower priority).

**Team?** The remaining engine stubs map cleanly to per-engine agents (as M3 did for tools).

## Milestone 5 — `pm/` project-manager subsystem (own serial track, ~1.5 wk)

~4.4K LOC, stateful, interconnected (pm-store, pm-routes, project-discovery, session-parser). **Not rib-shaped** — don't fan out *within* it. But it *can* run as a parallel track to M3–M4 (different author/agent, different subsystem).

- [ ] Port with the existing TS tests as the behavioral spec (session-transcript parsing has many edge cases).

**Team?** One dedicated author/agent for the whole subsystem, running concurrently with the M3–M4 fan-out.

## Milestone 6 — `cli` + curl-install + dashboard embed (serial, ~0.5 wk)

- [ ] Port `service.ts` shell-outs (incl. the new `service stop`) to `std::process::Command`.
- [ ] **New:** `install.sh` + self-update against signed GitHub Releases; `~/.runtimescope/bin` layout; `runtimescope` on PATH.
- [ ] `include_bytes!` the dashboard build output; verify `/dashboard` serves with no `packages/dashboard` on disk.
- [ ] First-run data-wipe warning + `RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1`.

**Team?** No — small, integration-flavored, owner-facing.

## Milestone 7 — Gate, cutover, ship (serial, ~1 wk)

- [ ] Full `npm run conformance` green against the Rust binary.
- [ ] `npm run stress` 7/7; `npm run bench:compare -- node <rust>` within gates (target: Rust beats Node).
- [ ] Signed-binary release workflow + the conformance/bench gate in CI.
- [ ] Delete `packages/collector|mcp-server|cli`; verify git-tag rollback.
- [ ] v0.11.0; deprecate Node packages (final v0.10.13) on npm; completion report; CURRENT_STATE + HANDOFF → Phase SDK-Channel-Migration.

**Team?** No — this is the careful close. One author owns the destructive cutover.

---

## Critical-path / parallelism summary

```
M0 ─▶ M1 ─▶ M2 ─┬─▶ M3 (team) ─┐
                ├─▶ M4 (team) ─┤
                └─▶ M5 (solo, parallel track) ─┴─▶ M6 ─▶ M7
```

- **Serial, no team:** M0, M1, M6, M7 (the spine and the close).
- **Team fan-out:** M3 (63 tools — biggest win), M4 (4 engines), partial M2 (routes).
- **Parallel solo track:** M5 (`pm/`) overlaps M3–M4.

The wall-clock win from a team is concentrated in M3. Everything else is either too serial (spine/close) or already small. So: **invest the team in the 63 tools, after the skeleton is proven — and nowhere before M1 is green.**
