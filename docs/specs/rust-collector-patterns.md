# Rust collector — patterns & conventions

The conventions the M1 vertical slice established and the M2–M4 fan-out followed.
**Exit criterion for M1:** a new engineer/agent can add a tool, route, or event
type from this doc without asking how. Read alongside [`wire-protocol.md`](./wire-protocol.md),
[ADR-0006](../decisions/0006-conformance-tests-are-the-spec.md) (tests are the spec),
and [ADR-0008](../decisions/0008-rust-mcp-embeds-collector-core.md) (embed topology).

## Crates

```
collector-core   lib   store, server (axum WS+HTTP), wal, auth, command hub, event types
collector-server bin   thin: collector_core::serve()
mcp-server       bin   embeds collector-core in-process; the rmcp tool surface
cli              bin   (M6)
```
`collector-core::serve()` is shared by both bins. The MCP server starts the
collector in-process and shares the **one** `StoreHandle` — no IPC, no bridge
(ADR-0008). The command channel (`CommandHub`) is in-process too.

## The Store seam — how tools and routes read

Everything reads through `StoreHandle` (async, cloneable handle to the
dedicated-DB-owner thread). HTTP routes and MCP tools call the **same** methods:

- `events_by_type(kind, project) -> Vec<Value>` — **newest-first** (SQL `ORDER BY id DESC`). The workhorse.
- `timeline(project, types) -> Vec<Value>` — cross-type, **insertion order** (`id ASC`).
- `events_for_app(app)` / `event_count_for_app(app)` — appName-scoped (history tools; see "scoping").
- `event_count(project)`, `sessions()`, `register_session`, `add_batch`, `save_snapshot`, `session_history`.

Add a store method by adding a `Cmd` variant + a handler arm in the owner loop +
an async wrapper on `StoreHandle`. The owner thread owns the `rusqlite::Connection`
and the in-memory `sessions` Vec; never expose either directly.

## The event model — raw `Value`, not typed structs (decision)

Events are stored and read as `serde_json::Value`, not per-EventType Rust structs.
This is deliberate, not unfinished:

- Node's `types.ts` interfaces are **compile-time only** — Node casts `as NetworkEvent`
  at runtime with no validation. Forcing serde deserialization into typed structs
  would be **stricter than Node**: an event with an unexpected/missing field would
  fail to deserialize and be dropped, where Node (and our `Value` access) proceed.
  That's a divergence risk for zero behavioral gain — every tool already works on
  `Value` field access and passes conformance.
- The validation boundary is `event.rs::VALID_EVENT_TYPES` (the exact 19-type set
  from Node's `EventType` union). `POST /api/events` rejects anything outside it;
  `event_type_of()` reads the `eventType` (or legacy `type`) discriminant.
- Read fields defensively: `e.get("field").and_then(Value::as_str|as_i64|as_f64)`
  with a default. Mirror Node's field names exactly (camelCase: `normalizedQuery`,
  `metricName`, `componentName`, …).

If a typed struct is ever genuinely needed, make it lenient (`Option` + `#[serde(default)]`)
so it never fails where Node wouldn't.

## Durability / WAL — truncate-after-commit (decision)

The owner thread does, per batch: **WAL append + fsync (`commit`) → SQLite
`INSERT OR IGNORE` → `wal.truncate()`**. The durability ack is `Result`; a write
failure is surfaced, never a false `Ok` (audit #5).

- The JSONL WAL is **bounded** — `truncate()` after every committed batch (and after
  startup recovery) keeps it O(in-flight), not O(history). Boot replays only the
  in-flight window.
- **No sealed-file rotation.** Node rotates sealed segments because it checkpoints
  SQLite periodically; we truncate immediately after each commit, so rotation is
  unnecessary. `Wal::recover()` still *reads* `sealed-*.jsonl` defensively (forward-compat
  / a Node-written dir), but the write path never creates them.
- Crash-safe: a crash between SQLite insert and truncate just replays on restart
  (deduped by `event_id`). `Wal::open` heals a torn tail (truncates to the last
  complete newline-terminated line) so events after a tear survive.
- Tests live in `wal.rs` (`append_after_torn_tail_recovers_everything`,
  `truncate_clears_the_active_wal`, `recovery_stops_at_a_torn_tail`).

## MCP tools — the rmcp pattern

One file per family in `tools/` (`core`, `status`, `event_reads`, `diagnostics`,
`api_discovery`, `database`, `process_infra`, `sessions_history`, `setup_workspaces`,
`recon`). Each is an `impl Mcp` block:

```rust
#[tool_router(router = my_family_router, vis = "pub")]
impl Mcp {
    #[tool(description = "...")]
    async fn my_tool(&self, Parameters(args): Parameters<MyArgs>) -> Result<CallToolResult, ErrorData> {
        let events = self.store.events_by_type("network", args.project_id.as_deref()).await;
        // reshape → standard envelope
        Ok(envelope(json!({ "summary": ..., "data": ..., "issues": [...], "metadata": {...} })))
    }
}
```

- Args: a `#[derive(Debug, Deserialize, schemars::JsonSchema)]` struct (camelCase via
  `#[serde(rename)]` where needed). Match Node's input schema exactly — extra args are a divergence.
- `main.rs::Mcp::new` merges family routers with `+`: `Self::core_router() + Self::status_router() + …`.
  `#[tool_handler(router = self.tool_router)]` points at the merged field.
- **Every tool returns the same envelope**: `{ summary, data, issues, metadata }`.
  Shared helpers in `tools/mod.rs`: `envelope(v)`, `now_ms()`, `iso_ms(ms)` (epoch→ISO,
  the #1 reshaping need — surface timestamps as ISO strings, not raw numbers).
- Deferred stubs carry `metadata.deferred: true` (audit #8) so the catalog count
  doesn't mask them.

## HTTP routes

`/api/events/{kind}` is one generic handler (`kind_to_event_type` maps `renders→render`;
unknown kind → 404). Filters applied in the handler match Node's per-route query params
(`method`/`url_pattern`/`since_seconds`/`level`/`search`/`session_id`; `status` is a no-op,
matching Node). `timeline` is a special-cased cross-type merge. `POST /api/events`
ingests (backfills missing `eventId`/`sessionId`/`timestamp`). Public routes
(health/readyz/metrics) skip auth; the rest require `Authorization: Bearer`.

## projectId vs appName scoping (audit #7)

`SessionInfo` keeps `app_name` and `project_id` **distinct**. Events are stored under
`project = projectId ?? appName`. Two rules:
- projectId-scoped reads (network/console/… tools, `?project_id=`) filter the `project` column.
- **appName-addressed** tools (`get_historical_events`, `list_projects`, `get_session_history`)
  scope by appName via the session→sessionId map (`events_for_app`) — so two apps sharing
  one projectId don't merge. `project_key()` = `projectId ?? appName` for the legacy grouping key.

## Conformance discipline (the load-bearing rule)

Tests in `tests/conformance/specs/*.conformance.test.ts` are the executable contract
(ADR-0006). They run against Node (source of truth) and the Rust binaries via the same
harness — swap with `RUNTIMESCOPE_COLLECTOR_CMD` / `RUNTIMESCOPE_MCP_CMD`.

- **Author green-vs-Node FIRST**, then make Rust match. A spec that passes against a
  stub is worse than none.
- Assert **shapes/filters/derived fields**, not counts/existence. Use exact field names,
  null-vs-absent, number-vs-string, ordering.
- **Separate `it` blocks** so one failure can't mask later assertions (the monolithic-block
  trap from audit round 2).
- A happy-path fixture is not a parity test — exercise the cases the fixture doesn't
  (multi-session, renders/web-vitals, UTF-8, multi-app) — round 2/3 of audit 0002.

## Two findings worth internalizing

- **Read the consumer before building an engine.** Three "big engines" (DB schema
  introspection, DB connections, infra platforms) turned out to be **dormant in Node** —
  `addConnection`/`loadFromConfig` are never called, so every reachable path returns
  "nothing configured". Matching that empty response *is* parity; building a driver
  engine would make Rust do something Node doesn't. Always check "is anything feeding this?"
- **Hardening beyond Node is OK on ungated destructive paths.** `restart_dev_server`
  (no shell — argv under `nohup`) and `purge_caches` (`safe_purge_base`: absolute, no `..`)
  are stricter than Node's `shell:true` + unvalidated paths. The gated parity paths stay
  identical; the divergence is documented + Rust-side unit-tested. Treat tool inputs as untrusted.

## Where things live

| Add a… | Where |
|---|---|
| MCP tool | `tools/<family>.rs`, register router in `main.rs::Mcp::new` |
| HTTP route | `server.rs` (extend `kind_to_event_type` or add a handler) |
| Event type | `event.rs::VALID_EVENT_TYPES` (+ HTTP route in `kind_to_event_type` if read over HTTP) |
| Store query | `Cmd` variant + owner-loop arm + `StoreHandle` wrapper in `store.rs` |
| Conformance spec | `tests/conformance/specs/<name>.conformance.test.ts` (auto-discovered) |
