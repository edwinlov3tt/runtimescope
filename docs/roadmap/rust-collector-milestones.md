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
- [x] **A — Capex read/report DONE (9 routes):** `capex/:projectId` (+`?month`/`?confirmed`), `/summary` (+date range), `PUT capex/:projectId/:entryId` (partial, adjusted-cost recompute), `POST …/confirm`, `/export` (CSV — unquoted header, quoted rows, Node parity), `capex-all` (cross-project JSON aggregation), `categories`. **XLSX-divergence routes** `capex-report/:projectId` + `capex-report-all` serve the CSV fallback (decided 2026-05-31 — exceljs bytes aren't reproducible; dashboard only downloads). pm_store grew `list_capex_entries_filtered`/`update_capex_entry`/`confirm_capex_entry`/`get_capex_summary`/`export_capex_csv`/`list_categories` + `CapexSummary`/`CapexByMonth`; `PmProject` gained `category`. **Gated by `pm-capex.conformance.test.ts` (8 empty-state/degenerate cases) green vs Node AND Rust → 93/93; populated aggregation covered by 2 pm_store unit tests (53 total).**
- [x] **B — Tasks DONE (5 routes):** GET (+`?project_id`/`?status`), POST (201, UUID-v4 id via SQLite `randomblob` — no dep, defaults todo/medium/manual/`labels:[]`), PUT (partial), DELETE, `PUT …/reorder` (status=done stamps `completedAt`). pm_store: `create_task`/`update_task`/`delete_task`/`list_tasks`/`reorder_task` + `PmTask` (labels via the generalized `serialize_json_string_array`). **Gated by `pm-tasks.conformance.test.ts` — a full create→update→reorder→delete round-trip (6 cases) green vs Node AND Rust → 99/99; +1 pm_store unit test (55 total) + a uuid-v4 format test.**
- [x] **C — Notes DONE (4 routes):** GET (+`?project_id`/`?pinned=1`, `pinned DESC, updated_at DESC`), POST (201, UUID-v4 id, defaults Untitled/`''`/false/`tags:[]`), PUT (partial), DELETE. pm_store: `create_note`/`update_note`/`delete_note`/`list_notes` + `PmNote`. **Gated by `pm-notes.conformance.test.ts` — full create→update→delete + pinned-ordering + `?pinned` filter (6 cases) green vs Node AND Rust → 105/105; +1 pm_store unit test (56 total).**
- [x] **FK-enforcement pass DONE.** `PmStore::open` now sets `PRAGMA foreign_keys = ON` and the schema declares the FKs matching Node exactly (`pm_tasks/pm_notes/pm_capex/pm_sessions → pm_projects`, `pm_notes/pm_capex → pm_sessions`, `pm_api_keys → pm_workspaces ON DELETE CASCADE`; `pm_projects` has none). `create_task`/`create_note` now return `Result` and the routes map a dangling-ref FK violation → **400** (Node's `createX` throws → 400 with the identical `"FOREIGN KEY constraint failed"` message — gated by `pm-notes.conformance.test.ts` green vs both). **De-risked:** discovery's insert order is parent-first (`upsert_project` → `upsert_session` → `upsert_capex_stub`, pm_discovery.rs:275/300/302) and `delete_project` deletes children before the parent — both verified, and a `foreign_keys_enforced_parity_with_node` unit test proves the discovery sequence succeeds under FK while dangling refs are rejected. (Existing Rust pm.dbs predate the constraints — `IF NOT EXISTS` won't add them — but Rust is pre-release, so only fresh installs matter.) Suite 116/116; collector-core 64 unit tests.
- [x] **D — Memory (4) + Rules (3) DONE (7 routes):** filesystem-backed, keyed on a pm.db project. Memory: GET list (`~/.claude/projects/<claudeProjectKey>/memory/*.md` → `{filename,content,sizeBytes}`; no project/key → `{data:[],count:0}`), GET/PUT/DELETE single (404 "Project not found" / "File not found"). Rules: GET all-scopes + GET/PUT `/{scope}` (CLAUDE.md at global/project/local; invalid scope → 400 *before* project lookup, matching Node). **Security:** `sanitize_filename` ports Node exactly (strip `/`,`\`,`..`); `rules_paths`/`read_rule_file` port `getRulesPaths`/`readRuleFile`. **Gated by `pm-memory-rules.conformance.test.ts` (5 no-project/invalid-scope cases) green vs both → 110/110; the file-I/O helpers covered by 2 server.rs unit tests (sanitize-traversal + scope-paths). Populated I/O needs a discovered project the harness can't seed (same split as capex).**
- [x] **E — Project/session ops DONE (4 routes):** `projects/summaries` (raw snake_case rows — `getProjectSummaries` quirk), `projects/export-csv` (two-section PROJECTS/SESSIONS CSV, `csvEscape` + dated filename), `sessions/stats` (filters + `modelBreakdown`), `POST sessions/{id}/refresh` (404 / re-index via the new `reindex_project_sessions` reusing `index_sessions`). pm_store: `get_project_summaries`/`session_stats_filtered`/`list_sessions_filtered` + `ProjectSummary`/`ModelBreakdown` + UTC date-range helpers. **Gated by `pm-project-ops.conformance.test.ts` (4 empty-state cases) green vs both → 114/114; +1 pm_store unit test (59 total).**
  - **FIX (corrects M5 read port):** the shipped Rust `SessionStats` was shaped WRONG vs Node — it serialized `avgActiveMinutes` (Node: **`avgSessionMinutes`**) and OMITTED `modelBreakdown` entirely. Slipped through M5 because the only stats path exercised was a 404. The new `sessions/stats` empty-shape assertion now gates the corrected struct; `pm_project_by_id`'s `stats` field is fixed by the same change.
  - ⚠️ **Conformance suite flakiness (note, not a regression):** at 29 spec files the full `npm run conformance` occasionally drops ONE vs-Node test (`event-read-shapes`/`data-history-shapes`) under parallel MCP/collector process contention — each passes 13/13 and 1/1 in isolation. Worth a concurrency cap (`poolOptions`) as the suite grows; not blocking.
- [x] **F — Git DONE (6 routes):** `status/log/diff` (GET) + `stage/unstage/commit` (POST), via `run_git` → `std::process::Command` (**argv, NO shell**, `--` before user paths — mirrors Node `execFileSync('git', …)`), run under `spawn_blocking`. Ports `parseGitStatus` (index/worktree/untracked + `R old -> new` rename `oldPath`), the `git log` `%H%x00…%x01` format → `{hash,shortHash,subject,message,author,relativeDate,refs}`, and the commit-hash extraction. Per-route non-repo behavior matched (status/log/diff degrade gracefully; stage/unstage/commit → 400 "Not a git repo"). **Gated by `pm-git.conformance.test.ts` (all six → 404 no-project) green vs both → 115/115; plus 4 collector-core unit tests incl. a LIVE `git` run (status+log) against this repo + a porcelain-parse fixture (index/worktree/rename/untracked).**
- [x] **G — Dev-server (3) + scripts (1):** spawn/track/kill a dev process (stateful PID map) + read `package.json` scripts. **DEDICATED + gap-free (user). Audit DONE → [`../research/0004-node-dev-server-audit.md`](../research/0004-node-dev-server-audit.md).** Headline Node issues: (1) `shell:true` + body `command` = **command injection**; (2) **stop orphans the real server** — kills the shell pid, not the process group (no `detached`/`killpg`), so the server keeps its port while the API says `killed:true`; (3) **single-port log-scrape** detection, `running` flips on first byte not a real listen; (4) `detectedPort` **never persisted or tied back to monitoring/network capture**; (5) in-memory map → **restart orphans + `GET` lies**; (6) **no SSH/devcontainer/forwarded-port awareness**. Rust design (in the audit): argv-no-shell + own process-group + group-kill; poll the child tree's real listening sockets; persist + re-attach on restart; tie the port back to the project; devcontainer detect-and-warn — lifecycle proven by a real spawned-process integration test. 3 open questions logged for the user (stop-semantics divergence, SSH-forward scope, port→monitoring wiring). `scripts` (pure package.json read) is separable + autonomously gateable.
  - [x] **`scripts` DONE** (Slice G step 1): `GET /api/pm/projects/{id}/scripts` — 404 no-project, `{scripts:{},recommended:null}` no-path, else package.json `scripts` + `recommended` (first of dev/start/serve). Gated by a pm-project-ops 404 case green vs both → 119/119; 4 server.rs unit tests (recommended precedence, fall-through, none, missing/malformed).
  - [x] **Dev-server process-control DONE** (Slice G steps 2-4): `GET/POST/DELETE /api/pm/projects/{id}/dev-server`. **Closes the Node bugs, doesn't port them** (`crates/collector-core/src/dev_server.rs` = OS primitives; `server.rs` = handlers + the `Arc<Mutex<HashMap>>` managed map + re-attach). **(1)** argv + **no shell** (resolve_launch validates/rejects injection); **(2)** spawn in its **own process group** (`process_group(0)`) + stop via `kill(-pgid, SIGTERM)`→escalate `SIGKILL` (intended divergence from Node's orphaning — Rust-test-gated, NOT conformance-gated); **(3)** **real listen detection** via the child tree's sockets (`lsof -a -g <pgid>`), all ports, `running` only once actually listening; **(4)** persist to `pm.db` `pm_dev_servers` + **re-attach on restart** (liveness-check pgid, prune dead → GET stays honest); **(5)** **devcontainer detect-and-warn** (ports marked `isContainerLocal`); **(6)** **active auto-attach** (`autoAttach` hint ties the detected port back to monitoring; no-op on empty/duplicate/container-local). Deterministic shapes gated green vs both by `pm-dev-server.conformance.test.ts` (5 cases: GET→stopped, POST/DELETE→404). The lifecycle is proven by a **real spawned-process integration test** (`dev_server::lifecycle_tests` — spawn a grandchild listener → detect its real port → group-kill → **port freed + no orphan**) + a persistence/re-attach test (`slice_g_dev_server_tests`) + 9 unit tests. Dashboard live-updates: GET is the poll source of truth (no WS broadcast channel — deferred, see PR + patterns doc).
- [~] **Core (3):** `/api/events/timeline` **DONE** — the route already merged all families chronologically (`store.timeline`); this pass added Node's remaining `since_seconds` (cutoff `now - secs*1000`) + `session_id` (exact / comma-list = `matchesSessionFilter`) filters to `query_timeline` + the handler. Gated by 2 new cases in `http-ingest-and-routes.conformance.test.ts` (session isolation + old-event exclusion) green vs both → 118/118.
- [x] **`/api/processes` + `/api/ports` DONE — and they're PER-BINARY (the "read the consumer" finding):** Node's standalone `collector-server` builds `HttpServer(store, undefined, …)` (no `ProcessMonitor`) → both routes return `{data:[],count:0}`, `DELETE` → 500 "Process monitor not available" (**dormant**, like the DB-connections engine); only `mcp-server` does `new ProcessMonitor(store).start()` → **live** ps/lsof data. Rust mirrors this with a `process_monitor: bool` threaded through `serve()` (collector-server `false` → empty; mcp-server `true` → live), backed by the new `process_monitor.rs` (`scan_dev_processes`/`port_usage`/`kill_process`; ports `PROCESS_PATTERNS` classification + `ps aux`/`lsof`, reusing `dev_server::parse_lsof_listen_ports`). **Gated by `process-monitor.conformance.test.ts`:** the standalone empty + DELETE-500 paths asserted EQUAL green-vs-both; the live mcp path shape-only (envelope + `DevProcess`/`PortUsage` item shape + port-sort). 3 collector-core unit tests (classifier parity, non-dev drop, real-listener `listen_ports` detection). **Suite 128/128 vs Node AND Rust.**
- **🎉 M5.5 (Dashboard API parity) COMPLETE** — all 44 pm routes + 3 core endpoints ported; the full dashboard HTTP surface now runs on the Rust collector. Two intended divergences (dev-server group-kill; processes/ports live only on mcp) are Rust-test-gated + documented.

**Estimate:** comparable to M5 — 44+3 routes, the bulk is characterizing untested Node behavior (esp. capex aggregation, git output parsing, dev-server lifecycle). Git/dev-server are the highest-risk (process control + untrusted params).

**Estimate:** beyond the original ~1.5 wk — characterizing 4.4K untested LOC before porting is the bulk of the work.

## Milestone 6 — `cli` + curl-install + dashboard embed (serial, ~0.5 wk)

Scoping + current state: [`../handoffs/m6-tee-up.md`](../handoffs/m6-tee-up.md). **Decisions (user, 2026-06-01):**
start with Slice A (dashboard embed); CLI = **essential set** (service install/stop/start/restart/status +
dashboard + version — defer the doctor/mcp-doctor diagnostics); curl-install + self-update + signed
releases = **fast-follow after v0.11.0 ships**.

- [x] **Slice A — dashboard embed DONE.** `rust-embed` (with `debug-embed`) compiles
  `packages/dashboard/dist` into `collector-core`; `serve_dashboard` ports Node `http-server.ts:897-955`
  — `/dashboard[/…]` + `/assets/*` (Vite absolute paths) → embedded file, extensionless `/dashboard`
  routes fall back to `index.html` (SPA client routing), Node's exact content-type map, index.html
  no-cache / hashed assets cache-forever. Public route; path traversal inherently safe (only embedded
  keys resolve). **Verified serving from `/tmp` with no `packages/dashboard` reachable** (the embed
  guarantee). Gated by `dashboard-embed.conformance.test.ts` (4 cases: shell/asset/SPA-fallback/404)
  green vs Node AND Rust → **132/132**. (Release prereq: `npm run build -w packages/dashboard` before
  the Rust build so the dist is present to embed.)
- [x] **Slice B — CLI essential set DONE.** `crates/cli`: `service install/uninstall/status/restart/stop`
  (launchd macOS / systemd-user Linux, argv no-shell), `dashboard [--network]` (open browser; LAN URL via
  UDP-connect IP), `version`/`help`. Plist/unit templates + lifecycle flows port `service.ts` faithfully,
  **adapted to exec the `collector-server` binary** (sibling of `runtimescope` or on PATH), not
  node+standalone.js. Dep-free (readyz poll via raw TCP). Doctor/mcp-doctor + npm self-update deferred.
  Verified read-only against the live launchd service (status parsed PID); a real `install` was NOT run
  (would hijack the existing service). **Adversarial audit-agent workflow** (3 reviewers + per-finding
  re-verification): lifecycle-parity + template-fidelity came back **parity**; security-and-edge found
  **5 confirmed bugs, all fixed** — (1,2) `restart_launchd/systemd` silently ignored `launchctl/systemctl`
  failures → now `run_checked` surfaces non-zero exits (the "never discard a Result on a write path" rule;
  also applied to the `install` load/enable steps); (3) readyz poll parsed the HTTP **status line** instead
  of a `" 200"` substring; (4) added `RUNTIMESCOPE_HTTP_PORT` support (readyz + dashboard URL had hardcoded
  6768); (5) systemd `ExecStart` now quoted (spaces-in-path). 6 cli unit tests; clippy clean.
- [x] **Slice D — first-run cutover guard DONE.** `collector-core/src/migration.rs::first_run_guard` runs
  in both binaries before opening the stores. Detects **genuine Node-era data** via the `events.session_id`
  nullability signal (Node = `NOT NULL`, Rust = nullable — the M1 difference), NOT merely "a db exists" — so
  a db already written by the Rust port is recognized as migrated and **left untouched** (no false-positive
  backup of live Rust data; verified the real `~/.runtimescope` collector.db is Rust-schema). On Node-era
  data: **default** moves `collector.db*`/`pm.db*` to `legacy-backup-<ts>/` + warns + starts fresh;
  **`RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1`** leaves them in place (opens as-is). Idempotent via a `.rust-store`
  marker. 5 unit tests (fresh / rust-era-adopt / node-era-backup / preserve / idempotent) + smoke-verified on
  a real Node-schema db. Conformance unaffected (fresh temp HOME → no-op) → 132/132.
- **🎉 M6 COMPLETE** (Slices A + B + D). Distribution (`install.sh` + self-update vs signed GitHub Releases,
  `~/.runtimescope/bin` layout, the signed-release CI workflow) is the **documented post-v0.11.0 fast-follow**.

**Team?** No — small, integration-flavored, owner-facing.

## Milestone 7 — Gate, cutover, ship (serial, ~1 wk) — 🟡 GATE MET, cutover pending

- [x] Full `npm run conformance` green against the Rust binary. **132/132 vs Node AND Rust (serial; parallel has the GPT #7 port-collision flake).**
- [x] `npm run stress` 7/7; `npm run bench:compare -- node <rust>` within gates (target: Rust beats Node). **Stress 7/7 both ways. Bench: all 5 gates pass with margin — throughput 146% of Node, p99 0.26× (Rust 2.4ms vs Node 9.3ms after the group-commit + fsync work), RSS 0.13× (8× better), no leak, zero drops. Verified green in CI.** See `reviews/0003`.
- [x] Signed-binary release workflow + the conformance/bench gate in CI. **GREEN IN CI (run 26788781393): `rust.yml` runs build/clippy/test + conformance-vs-Rust (serial) + `bench:compare` on every PR/main; `release-binaries.yml` gates on conformance then ships universal (arm64+x86_64) codesigned macOS binaries + SHA256SUMS on a `v*` tag (signing optional — gated on `APPLE_CERTIFICATE_BASE64`/`APPLE_SIGNING_IDENTITY` secrets; unsigned + noticed if absent).**
- [x] Delete `packages/collector|mcp-server|cli`; verify git-tag rollback. **Done (`ab1095d`, 135 files). Rollback tag `node-reference-v0.10.13` verified — restored + re-deleted collector to confirm. Harnesses repointed to the Rust binaries; post-cutover gate green (conformance 132/132 vs Rust, stress 7/7, bench SLO, 233 unit tests).**
- [~] v0.11.0; deprecate Node packages (final v0.10.13) on npm; completion report; CURRENT_STATE + HANDOFF → Phase SDK-Channel-Migration. **v0.11.0 version bump done (`5fc3e34`); completion report (`reports/m7-rust-cutover-completion-report.md`) + CURRENT_STATE updated. PENDING (outward-facing, operator action): push the `v0.11.0` tag (→ npm publish + signed binaries) and `npm deprecate` the Node packages (needs npm auth). See the report §6.**

**Gate run 2026-06-01:** kicking off M7's gate before the irreversible delete caught
**5 Rust divergences in HTTP surfaces conformance never covered** (Node 7/7 → Rust 3/7
on stress) **+ ingest perf gaps** — all fixed (`15d3ed0` divergences, `67a4934` txn
batching, `90228ec` WAL group-commit, `fc9b2e2` fsync-not-F_FULLFSYNC). Standing up
the CI gate then exposed a 6th issue: the Rust build hard-depends on the gitignored
`packages/dashboard/dist/` via rust-embed, so a fresh checkout couldn't compile —
fixed with a `build.rs` that ensures the folder exists (`98eabe1`). Final: all three
`rust.yml` jobs green in CI. Vindicates running the gate first. Detail:
`reviews/0003-m7-gate-findings.md`.

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
