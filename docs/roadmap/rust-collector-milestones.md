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

## Milestone 1 — Spine: `collector-core` + one vertical slice (serial, ~1 wk) — 🟢 DONE

The most important week of the phase. **One author. No fan-out.**

- [x] Workspace `Cargo.toml` + 4 crate skeletons (`collector-core`, `collector-server`, `mcp-server`, `cli`) + CI wiring (`.github/workflows/rust.yml`: `cargo build/clippy -D warnings/test` on macos-14). Built clean first try (axum 0.8.9, rmcp 1.7.0, tokio).
- [x] **Vertical slice GREEN against the Rust binaries, via the same conformance harness that validates Node:**
  - `collector-server`: `event-roundtrip` 2/2 — WS handshake → ingest → `/api/events/network` query → project_id isolation (`RUNTIMESCOPE_COLLECTOR_CMD=…/collector-server npx vitest … event-roundtrip`).
  - `mcp-server`: the `get_network_requests` data round-trip — SDK → embedded in-process collector → MCP tool reads the shared `Store` (`RUNTIMESCOPE_MCP_CMD=…/mcp-server`). Proves the ADR-0008 embed-in-process topology.
- [x] Patterns established by the slice: the `{summary,data,issues,metadata}` envelope, the rmcp `#[tool]` + schemars-arg pattern, the axum route-handler signature, and **the `Store` query seam both HTTP routes and MCP tools call** (`events_by_type`). `collector-core::serve()` is shared by both bins.
- [x] **Persistence + durability** (rusqlite WAL-mode + a JSONL WAL with fsync-before-commit, behind the dedicated-DB-owner thread fed via mpsc/oneshot — research 0001 / ADR-0008). The `durability` conformance test passes against `collector-server`. 2 WAL unit tests (roundtrip + torn-tail). The store API went async; HTTP handlers + the MCP tool `await` it.
- [x] **Auth** (`RUNTIMESCOPE_AUTH_TOKEN`): WS handshake gate (no/invalid token → close **4001** within 5s; valid token accepted), HTTP `Authorization: Bearer` gate (gated routes → **401**), the public-route set (health/readyz/metrics) reachable without auth, `/api/health.authEnabled`, and a minimal `/metrics`. Makes the `handshake` + `http-contracts` specs fully green.
- [x] **Conformance gate broadened to 17 tests / 7 specs** (all green vs the Node source-of-truth) so "green" is a real done-signal, not a network-only shape-check. Added `event-families` (every event type → `/api/events/*`, gates M2) + `mcp-tool-families` (get_console_messages/get_session_info/detect_issues read the store, gates M3). **Rust binaries: 13/17** — `handshake` 3/3, `event-roundtrip` 2/2, `http-contracts` 6/6, `durability` 1/1, `mcp-tools` data-roundtrip. The 4 gaps are the roadmap: `event-families`→M2; `mcp-tool-families` + `mcp-tools` catalog/command-channel→M3.
- [x] **M1-tidy DONE — patterns doc written ([`../specs/rust-collector-patterns.md`](../specs/rust-collector-patterns.md)); the other two items resolved as decisions, not refactors:**
  - **Event model = raw `Value`, not typed structs (decided, documented).** The conformance-driven build implemented every tool on `Value` field access and passes 68/68. Node's `types.ts` is compile-time-only (casts `as T` with no runtime validation), so forcing serde-typed deserialization would be *stricter* than Node — events with unexpected shapes would drop where Node proceeds. Net regression risk, zero behavioral gain. The validation boundary is `event.rs::VALID_EVENT_TYPES`, an **exact match** to Node's 19-type `EventType` union (verified).
  - **WAL bounding DONE; rotation unnecessary.** `truncate()` after every committed batch (+ after recovery) keeps the JSONL WAL O(in-flight), so Node's sealed-file rotation isn't needed (`recover()` still reads `sealed-*` defensively). Crash-safe (torn-tail heal + dedup-on-replay); 4 WAL unit tests. (Audit Phase D.)

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

## Milestone 4 — Engines + recon (fan-out, ~1 wk) — 🟢 GATE MET (one documented stub left)

- [x] **`scan_website` REAL via the recon sidecar (ADR-0007 payoff).** mcp-server spawns the Node sidecar (`mcp-server/src/sidecar.rs`, one-shot newline-JSON over stdio) and proxies `scan_website` → verified end-to-end: a live scan of example.com returns 6 recon events (`recon_metadata/design_tokens/fonts/layout_tree/accessibility/asset_inventory`) through the Rust mcp-server. Sidecar launch command via `RUNTIMESCOPE_RECON_SIDECAR`. **Browser resolution + bundling is M6** (the smoke needed `PLAYWRIGHT_BROWSERS_PATH` at the installed Chromium; curl-install must ship/locate it).
- [x] **`scan_website` ingests → the recon read-family is real.** scan_website stores its captured `recon_*` events under a project; `get_page_metadata` / `get_design_tokens` / `get_font_info` / `get_layout_tree` / `get_accessibility_tree` / `get_asset_inventory` read them back. Verified end-to-end on example.com (real tokens/metadata/fonts), including across a restart (persistence).
- [x] **process-monitor read tools real** (`get_dev_processes`, `get_port_usage`) via dep-free OS introspection (`ps`/`lsof`, async, whole-word hint matching). Verified against the live machine.
- [x] **Database family real / parity-matched** (gated by `database-introspection.conformance.test.ts`, 61/61). `suggest_indexes` is now a real store-read — ports `query-monitor.ts suggestIndexes` (regex WHERE/ORDER-BY column extraction, >100ms filter, dedup by `(table, sorted-cols)`, `estimatedImpact` buckets, `suggestedSQL`). **Key finding: the "DB-introspection engine" was a phantom** — Node's `ConnectionManager.addConnection` is *never called* anywhere in the repo, so connection-based introspection is dormant in Node too; every reachable call returns "no connections configured". So `get_database_connections` (empty list), `get_schema_map`/`get_table_data` (`data:null` + guidance), and `modify_table_data` (Node's raw-string response) now **match Node exactly** rather than carrying a `deferred` marker. No pg/mysql/sqlite driver engine was needed for parity — live driver introspection + a connection-registration path is a **shared latent gap** (unbuilt in BOTH Node and Rust), deferred to whenever that feature is actually wired.
- [x] **Selector-recon tools** (`get_computed_styles`, `get_element_snapshot`). The reshaping path (property-group/specific filtering, variations issues, snapshot summary + zero-dimension flag) is real and **conformance-gated** by `recon-selector-shapes.conformance.test.ts` (63/63). The **live sidecar fallback** is wired — when nothing is stored for a selector but a page was scanned, the tools derive the last-scanned URL (from stored `recon_*` events) and call the sidecar's `computed_styles`/`element_snapshot` methods (already supported), build + cache a synthetic event, and reshape it. Like `scan_website`, the live browser path needs a manual smoke with `PLAYWRIGHT_BROWSERS_PATH` (M6 bundles the browser); not Node-conformance-gateable.
- [x] **Mutating process tools** (`kill_process`, `purge_caches`, `restart_dev_server`). Real OS ops via `kill`/`du`/`std::fs::remove_dir_all`/`lsof` (cwd) + detached `nohup` respawn; `restart` ports the type-classify + `inferStartCommand` + cwd logic. The **safety + degenerate paths are conformance-gated** by `process-infra-shapes.conformance.test.ts` — refuse PID<2/self before any OS call (kill + restart), `restart` not-found, `purge_caches` no-cache. The destructive happy paths (actually killing/deleting/respawning) need a manual smoke against a real process/dir, like `scan_website` — not Node-conformance-gateable.
- [x] **infra-connector** (`get_deploy_logs`/`get_runtime_logs`/`get_build_status`/`get_infra_overview`). Same finding as the DB family: Node's `InfraConnector.loadFromConfig` is **never called** (+ needs `VERCEL_TOKEN`/etc.), so no platform client is ever loaded → the three log tools return **empty** (matching Node), and `get_infra_overview` is a **real store-read** that detects platforms (Vercel/Cloudflare/Railway/Supabase/Firebase/Netlify) from network-request hostnames. All four conformance-gated.
- [ ] **Remaining M4:** `get_style_diff` only — no stored `recon_style_diff` event type exists in either Node or Rust to diff against, so it stays a registered, `deferred`-marked stub until that capture path is built.

**Team?** Not needed — M4 is essentially complete.

## Milestone 5 — `pm/` project-manager subsystem (serial, critical path) — 🔴 LAUNCH BLOCKER (decided [ADR-0009](../decisions/0009-pm-subsystem-in-v0.11.0.md), 2026-05-30)

~4.4K LOC, stateful, interconnected (pm-store 1659, pm-routes 1345, project-discovery 797, session-parser 342, pm-types 235). **Not rib-shaped** — don't fan out *within* it. Decided to ship in v0.11.0 (full parity at cutover); `pm/` is orthogonal to the core loop but provides workspaces, workspace API keys, project discovery, Claude-session cost/CapEx analysis, and the `/api/pm/*` dashboard UI.

- [ ] **⚠️ `pm/` has NO Node test coverage** — the original "port against existing TS tests" premise is false. So: **conformance-first** — write `*.conformance.test.ts` against the **Node `pm/`** first (characterize the untested behavior + spec the port), then make Rust pass. Gate via the 4 workspace MCP tools (`McpDriver`) + the `/api/pm/*` HTTP routes (`spawnCollector`); cover `session-parser` edge cases (cost/token/active-time/compaction from JSONL) with Rust unit tests + end-to-end discover→list assertions.
- [~] Port order: pm-types → pm-store (SQLite schema + CRUD) → session-parser → project-discovery → pm-routes → wire the 4 MCP workspace tools + the workspace-API-key auth path.
  - [x] **Workspace + API-key layer DONE — `pm-workspaces.conformance.test.ts` (6 tests) green vs Node AND Rust (74/74).** `collector-core/src/pm_store.rs` is the Rust `PmStore`: a separate `pm.db` (Arc<Mutex<Connection>>, low-freq so no owner thread), `pm_workspaces`/`pm_api_keys`/`pm_projects` schema, auto-"Personal", `ws_`/`tk_` IDs via SQLite `randomblob` (no RNG dep), SHA-256 key hash (`sha2`), Node's slug derivation. The 4 MCP tools (`list_workspaces`/`create_workspace`/`create_workspace_api_key`/`move_project_to_workspace`) are wired off `Mcp.pm`. 4 pm_store Rust unit tests.
  - [x] **session-parser DONE** — `collector-core/src/pm_session_parser.rs` ports `session-parser.ts` (cost/token/active-time/compaction from Claude-Code JSONL). Characterized **conformance-first via a 6-agent workflow** that ran the real Node parser over edge-case fixtures and captured exact outputs (pm/ has no Node tests); 11 Rust unit tests assert those Node-captured values. Quirks replicated: fuzzy pricing (`MODEL_PRICING` order breaks ties; empty model → sonnet, not 0), `Math.round` half-up, strict active-time idle gap, `toolUseResult` truthy-only suppression, `firstHumanSeen` pre-extraction latch, `msg.usage ?? obj.usage` precedence + last-seen model, `costUSD ?? cost_usd` direct add. Added `chrono` (ISO ts) to collector-core. NOT yet wired into a tool — project-discovery consumes it next.
  - [x] **project-discovery (Claude) DONE** (`collector-core/src/pm_discovery.rs`): path mapping (`slugify_path`, `decode_claude_key` + greedy hyphen-aware `resolve_path_segments`, `to_period`), the **over-discovery fix** `is_real_project`, and the orchestration (`discover_claude_projects` → `process_claude_project` → `index_sessions` → `build_session` via the parser). pm-store grew `pm_projects`(full)/`pm_sessions`/`pm_deleted_projects` schema + `upsert_project` (default-workspace assign, COALESCE merge, sticky `sdk_installed`) / `upsert_session` / `session_jsonl_size` (incremental skip) / `is_deleted_path` / `detect_sdk_installed`. **Wired live**: a backgrounded `spawn_blocking` at mcp-server startup scans the real `~/.claude/projects` (no-op on the harness's temp HOME → conformance still 74/74). 8 pm_discovery + 4 pm_store unit/integration tests.
    - **Improvements over Node (intentional, ADR-0009):** (1) a Claude dir is registered ONLY if its decoded path resolves to an existing dir AND that dir is a real project root (VCS/build marker or explicit `.runtimescope/`), excluding home/system roots — Node registers *every* dir (even unresolvable keys via a `slugifyPath(key)` fallback). (2) Always full-parse sessions (Node's `sessions-index.json` fast-path zeroes token/cost). Both diverge from Node → gated by Rust tests, not Node conformance.
  - [x] **pm-routes (read + discover subset) DONE** — threaded `PmStore` into `serve()`/`AppState` (both `collector-server` + the embedded mcp-server pass it). Added `POST /api/pm/discover`, `GET /api/pm/projects` (+`?workspace_id`), `GET /api/pm/projects/{id}` (404 / project+stats), `GET /api/pm/sessions` (+`?project_id`/limit/offset), `GET /api/pm/sessions/{id}`, `GET /api/pm/workspaces`. PmStore grew `get_session`/`list_sessions`/`session_stats`; row structs are `Serialize` (camelCase). Gated by `pm-routes.conformance.test.ts` (6 tests via the embedded HTTP port — workspace/empty-projects/empty-sessions/discover-0/404s, green vs Node AND Rust on the fresh harness HOME → **80/80**). Deferred routes: tasks/notes/memory/capex/export/summaries + the workspace/project/session **write** CRUD.
  - [x] **workspace-API-key WS auth DONE** — `PmStore::get_workspace_by_api_key` (SHA-256 hash → join, revoked/expired filter, `last_used_at` bump) + `parse_authed_handshake` now accepts EITHER the global token OR a valid `tk_…` workspace key (the key bypasses the global check), matching Node `server.ts`. Locked by a Rust unit test (valid/bogus/empty/expired). **Not Node-conformance-gated** — surfacing it revealed a pre-existing **auth-enablement divergence** (below); the end-to-end keyed handshake also spans two processes/pm.dbs in the harness. Verified by unit test + construction-parity with Node's handshake gate.
    - ⚠️ **Carried-forward finding (reconcile at M7):** the Rust MCP server enables auth from `RUNTIMESCOPE_AUTH_TOKEN` (`AuthManager::from_env`), but Node's MCP server enables it from `config.json` `auth.enabled`/`apiKeys` (`globalConfig.auth`), NOT the env var. The standalone collector honors the env on both (so `auth-frames` is green via `spawnCollector`), but the MCP-embedded auth-enablement source differs. Reconcile before cutover (Rust MCP should also read the config-file auth, or document the env as the Rust convention).
  - [x] **M5 fast-follow DONE (worktree-isolated workflow + integration):** (a) **RS-project discovery** — `pm_project_manager.rs` (ProjectManager over `~/.runtimescope/projects` + `discover_runtimescope_projects`, merge-by-id/name, runtimeApps), wired into the discover route + startup alongside Claude discovery; (b) **capex stub** — `pm_capex_entries` + `upsert_capex_stub` (default expensed/unconfirmed) called from `index_sessions`; (c) **pm-routes write CRUD** — POST/PUT/DELETE workspaces (+ default-delete guard), PUT/DELETE projects, POST/DELETE api-keys, PUT project workspace + the pm_store methods, gated by `pm-routes-write.conformance.test.ts`; (d) **auth-enablement reconcile** — `AuthManager` now honors `~/.runtimescope/config.json` `auth` (enabled + apiKeys) AND the env token, matching Node's config-driven enablement. **Suite 85/85 vs Node AND Rust; collector-core 47 unit tests.** (Pending: adversarial review.)
  - [x] **M5 adversarial review DONE + findings closed** (4-area workflow: auth/RS-discovery/capex/write-CRUD, each finding independently re-verified). Closed: (1) **capex data-loss** — `ON CONFLICT` clobbered user-confirmed entries on re-index → now `CASE`-guarded (intentional divergence from Node's bug, Rust-tested); (2) **runtimeApps double-encoding** — JSON-string column serialized raw, breaking the dashboard's `string[]` consumer → `serialize_with` emits the array; (3) **auth per-binary wiring** — collapsed `from_env()` split into `AuthMode::Standalone` (env token, comma-split, config-precedence) vs `AuthMode::Mcp` (config-only), bearer parser now matches Node's `/^Bearer\s+(\S+)$/i` exactly — **fully reconciles the carried-forward finding above**; (4) path-traversal flag was a verified false-positive (Rust char-for-char matches Node). **85/85 vs Node AND Rust; collector-core 51 unit tests.** Documented in `docs/specs/rust-collector-patterns.md`.
  - **M5 COMPLETE + REVIEWED.**
- [ ] Narrow scope if characterization shows dead/buggy Node paths (the dormant-engine lesson).

## Milestone 5.5 — Dashboard API parity (serial, conformance-first) — 🟡 IN PROGRESS (scope decided 2026-05-31)

The dashboard is a standalone Vite app that talks to the collector **purely over the HTTP API** (no static-serving cutover needed). M5 shipped 11 of Node's **55** `/api/pm/*` routes; the remaining **44** + 3 core endpoints (`/api/events/timeline`, `/api/processes`, `/api/ports`) are what the dashboard's PM surface needs. **Decision (user, 2026-05-31): port the full dashboard API to Rust before cutover.** Conformance-first per ADR-0006: characterize the **untested** Node `pm-routes.ts` (1345 LOC) per slice → spec → port → green-vs-both.

Slices (independent; tables for tasks/notes/capex already exist in `pm_store.rs`):
- [ ] **A — Capex read/report (9):** `capex-all`, `capex-report-all`, `capex-report/:projectId`, `capex/:projectId`, `capex/:projectId/summary`, `capex/:projectId/export` (CSV), `PUT capex/:projectId/:entryId`, `POST …/confirm` (exercises the confirmed-preservation fix), `categories`. Read + aggregation; table exists.
- [ ] **B — Tasks (5):** GET/POST/PUT/DELETE + `PUT …/reorder`. `pm_tasks` table exists; needs CRUD methods + routes.
- [ ] **C — Notes (4):** GET/POST/PUT/DELETE. `pm_notes` table exists.
- [ ] **D — Memory (4) + Rules (3):** filesystem-backed (no table) — reads project files by `:filename`/`:scope`. **Security: path-traversal sanitize the params** (reuse the `get_project_dir` guard pattern).
- [ ] **E — Project/session ops (4):** `projects/summaries`, `projects/export-csv`, `sessions/stats`, `POST sessions/:id/refresh` (re-parse one session).
- [ ] **F — Git (6):** `status/diff/log/commit/stage/unstage` via `execFileSync`-equivalent (`std::process::Command`, **argv, no shell** — matches Node + our security posture).
- [ ] **G — Dev-server (3) + scripts (1):** spawn/track/kill a dev process (stateful PID map) + read `package.json` scripts.
- [ ] **Core (3):** `/api/events/timeline` (aggregate/merge), `/api/processes`, `/api/ports` (the M2/M4-deferred OS endpoints the dashboard consumes).

**Estimate:** comparable to M5 — 44+3 routes, the bulk is characterizing untested Node behavior (esp. capex aggregation, git output parsing, dev-server lifecycle). Git/dev-server are the highest-risk (process control + untrusted params).

**Estimate:** beyond the original ~1.5 wk — characterizing 4.4K untested LOC before porting is the bulk of the work.

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
