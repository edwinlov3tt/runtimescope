# Rust foundational spikes — rmcp + rusqlite are viable; pick the dedicated-DB-thread model

**Status:** `active`
**Created:** 2026-05-29
**Last touched:** 2026-05-29
**Spans phases:** Rust-Collector (Milestone 0 → Milestone 1)

---

## Conclusion (one sentence)

Both load-bearing Rust dependencies are validated by throwaway spikes: **`rmcp` 1.7.0** serves a RuntimeScope-style tool over stdio JSON-RPC with the exact `{summary,data,issues,metadata}` envelope and an auto-derived input schema, and **`rusqlite` 0.40** drives WAL-mode SQLite from concurrent tokio tasks cleanly via a **dedicated DB-owner thread fed over an mpsc channel** (~33k single inserts/sec) — so the 63-tool MCP port and the async-server-over-sync-SQLite question are both de-risked before Milestone 1.

## Why this matters

Two of the four Milestone 0 questions were "does the ecosystem even support what we need?" — if `rmcp` couldn't reproduce our envelope/stdio contract, or if `rusqlite` forced an awkward async story, the crate layout would change. Settling them now means Milestone 1 builds the real `collector-core` spine on proven footing instead of discovering a wall mid-port.

## Evidence

Throwaway spikes built under `/tmp/rs-spikes` against the pinned toolchain (rustc/cargo **1.95.0**), then deleted. Reproducing means re-creating them; the salient code and outputs:

### `rmcp` 1.7.0 — MCP stdio tool server

A one-tool server (`get_network_requests`) using the macro API (`#[tool_router]`, `#[tool]`, `#[tool_handler]`, `Parameters<T>`, `.serve(stdio())`). Driven with raw newline-delimited JSON-RPC:

```
FINDING rmcp: initialize -> ok; caps: ['tools'] | server: {name: rmcp, version: 1.7.0}
FINDING rmcp: tools/list -> ['get_network_requests']   (inputSchema present: True)
FINDING rmcp: tools/call -> envelope keys: [data, issues, metadata, summary] | projectId: proj_x  (isError: False)
```

Takeaways:
- **The macro API compiled essentially as written** — the only fix needed was that `ServerInfo`/`Implementation` are `#[non_exhaustive]` (no struct literals; use the default `get_info()` or mutate `::default()`).
- **Input schemas derive from Rust structs via `schemars`** — this is the direct replacement for the per-tool `zod` schemas. A `#[derive(Deserialize, schemars::JsonSchema)]` arg struct becomes the tool's `inputSchema` automatically.
- **The envelope is just `Content::text(json.to_string())`** inside `CallToolResult::success(...)` — matches what [`mcp-tools.conformance.test.ts`](../../tests/conformance/specs/mcp-tools.conformance.test.ts) asserts.
- rmcp is on a **stable 1.x line** (1.7.0), past the pre-1.0 API churn that made older tutorials misleading.

### `rusqlite` 0.40 — async server over sync SQLite

Model under test: a **dedicated thread owns the `Connection`**, async tasks send requests over a `tokio::sync::mpsc` channel and get answers over `oneshot`. 5000 inserts issued from concurrent `tokio::spawn` tasks:

```
FINDING rusqlite: inserted 5000 events from concurrent tokio tasks via a single DB-owner thread
FINDING rusqlite: count=5000 (expected 5000) -> PASS
FINDING rusqlite: 5000 inserts in ~150ms (~33k ins/sec)
FINDING rusqlite: WAL active (PRAGMA journal_mode=WAL asserted during the run)
```

Takeaways:
- `PRAGMA journal_mode=WAL` + `synchronous=NORMAL` work as expected; the `bundled` feature compiles SQLite in (no system dep).
- The **dedicated-owner-thread** model mirrors the current EventStore's single-writer design and sidesteps `Connection: !Sync` cleanly. (The simpler `tokio::task::spawn_blocking` + a connection pool also works, but a single owner matches the existing semantics and makes WAL ordering trivial to reason about.)
- ~33k single round-trip inserts/sec is ample headroom — real ingest batches, so the per-insert channel cost amortizes. (The `bench/` suite is the real perf gate.)

## Where it shows up in the codebase

- **rmcp** → the future `crates/mcp-server`; the pattern replaces [`packages/mcp-server/src/tools/*.ts`](../../packages/mcp-server/src/tools/) (zod schemas → schemars-derived; envelope unchanged).
- **rusqlite dedicated-thread** → the future `crates/collector-core` store; replaces [`packages/collector/src/sqlite-store.ts`](../../packages/collector/src/sqlite-store.ts) + the single-writer discipline in [`store.ts`](../../packages/collector/src/store.ts).

## Open / deferred

- The dedicated-thread channel's backpressure + batching policy is a Milestone 1 detail (the spike used an unbounded-ish 1024 channel and per-insert round-trips; real ingest batches an event array per WS frame).
- rmcp's capability/`get_info` customization (instructions, server name/version) is cosmetic and deferred to Milestone 3.
