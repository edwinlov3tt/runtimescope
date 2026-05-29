# RuntimeScope wire protocol — locked invariants

> **Status:** Locked as of v0.11.0 (Phase Wire-Protocol-Lock).
> **Audience:** anyone implementing a RuntimeScope collector (Node today, Rust at v0.12.0) or any SDK that talks to one.
> **This document is a thin mirror. The implementation is truth, and [`tests/conformance/`](../../tests/conformance/) is the executable contract** ([ADR-0006](../decisions/0006-conformance-tests-are-the-spec.md)). Where this doc and a green conformance test disagree, the test wins and this doc is re-derived. Each invariant cites a `file:line` source and, where applicable, the conformance spec that guards it.

Run the contract: `npm run conformance` (passes against the v0.10.12 Node collector; becomes the Rust acceptance gate via `RUNTIMESCOPE_COLLECTOR_CMD` / `RUNTIMESCOPE_MCP_CMD`).

This complements [`tray-api-surface.md`](./tray-api-surface.md) (the 3 endpoints the tray locks) and [`mcp-tool-surface.md`](./mcp-tool-surface.md) (the 63-tool catalog). This file covers the full SDK↔collector + persistence surface.

---

## 1. Transport & ports

- WebSocket collector: `ws://<host>:6767` (`RUNTIMESCOPE_PORT`). SDKs hold one persistent connection per session.
- HTTP API: `http://<host>:6768` (`RUNTIMESCOPE_HTTP_PORT`). Also serves the dashboard.
- Workers SDK (no persistent socket) ingests via `POST /api/events` instead of WS.

## 2. WebSocket message envelope

Every WS frame is JSON ([`types.ts:794`](../../packages/collector/src/types.ts#L794)):

```ts
{ type: 'event' | 'handshake' | 'heartbeat' | 'command' | 'command_response';
  payload: unknown; timestamp: number; sessionId: string }
```

**Invariant:** `type` discriminates `payload`. Unknown `type` values are ignored, not fatal.

## 3. Handshake — *guarded by `handshake.conformance.test.ts`*

First frame must be a handshake ([`types.ts:801`](../../packages/collector/src/types.ts#L801), handler [`server.ts:848`](../../packages/collector/src/server.ts#L848)):

```ts
HandshakePayload { appName: string; sdkVersion: string; sessionId: string;
                   authToken?: string; projectId?: string }
```

Invariants:
- A valid handshake registers a session — observable via `GET /api/sessions` (`isConnected: true`) and the `/api/health` connected count.
- `projectId` is optional; absent → the collector derives a project name from `appName`.
- **Auth on:** a socket that doesn't authenticate within **5 seconds** is closed with **WS close code 4001** and an `{type:'error', payload:{code:'AUTH_TIMEOUT'}}` frame ([`server.ts:776–800`](../../packages/collector/src/server.ts#L776-L800)). A correct `authToken` in the handshake is accepted.
- Auth is **off by default** ([`auth.ts`](../../packages/collector/src/auth.ts)); when off, no handshake auth is required and the 5s timer doesn't arm.

## 4. Event ingest — *guarded by `event-roundtrip.conformance.test.ts`*

`{ type:'event', payload: { events: RuntimeEvent[] } }` ([`types.ts:809`](../../packages/collector/src/types.ts#L809)). Non-array `events` is dropped silently.

Every event extends `BaseEvent { eventId, sessionId, timestamp }` + a `type` ∈ the **19 EventTypes** ([`types.ts:8`](../../packages/collector/src/types.ts#L8)): `network, console, session, state, render, dom_snapshot, performance, database, custom, navigation, ui, recon_metadata, recon_design_tokens, recon_fonts, recon_layout_tree, recon_accessibility, recon_computed_styles, recon_element_snapshot, recon_asset_inventory`.

Invariants:
- Events sent over WS become queryable over HTTP with fields intact.
- Events are isolated by `project_id` — a query scoped to one project never returns another's.
- SDK-side batching (50 events / 100ms) is **not** a wire invariant — the server only requires an array.

## 5. Command channel (server→SDK) — *guarded by `mcp-tools.conformance.test.ts`*

On-demand captures ([`types.ts:815`](../../packages/collector/src/types.ts#L815)). Server sends `{type:'command', payload:{command, requestId, params?}}`; SDK replies `{type:'command_response', requestId, command, payload, timestamp, sessionId}` ([`CommandResponse` types.ts:825](../../packages/collector/src/types.ts#L825)).

Commands: `capture_dom_snapshot`, `capture_performance_metrics`, `clear_renders`, `recon_scan`, `recon_computed_styles`, `recon_element_snapshot`, `recon_layout_tree`.

**Invariant:** responses correlate to requests by **`requestId`** ([`server.ts:1006,1055`](../../packages/collector/src/server.ts#L1006)); an unmatched `requestId` is dropped; a command times out (default 10s) if no response.

> ⚠️ **Rust-port design note (open):** today the trigger lives in the MCP tool layer, which calls `collector.sendCommand()` **in-process** (mcp-server embeds the collector). [ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md) splits these into separate Rust bins — the Rust design must provide an equivalent path (shared process, or an internal collector↔mcp bridge) for this channel. The conformance test pins the **observable** behavior; the mechanism is the Rust phase's to design. Resolve before Milestone 2 of Phase Rust-Collector.

## 6. Heartbeat

`{type:'heartbeat'}` frames + WS ping/pong keep-alive; pong resets the liveness flag. No application payload.

## 7. HTTP API — *guarded by `http-contracts.conformance.test.ts`*

Routes keyed `"<METHOD> <path>"` ([`http-server.ts`](../../packages/collector/src/http-server.ts)). Locked shapes:

| Route | Status / body |
|---|---|
| `GET /api/health` | `200 { status:"ok", version, timestamp, uptime, sessions, authEnabled }` ([:147](../../packages/collector/src/http-server.ts#L147)) |
| `GET /readyz` | `200 {status:"ready"}` warm / `503 {status:"starting"}` ([:164](../../packages/collector/src/http-server.ts#L164)) |
| `GET /metrics` | `200` Prometheus text (`content-type: text/plain; version=0.0.4`) ([:177](../../packages/collector/src/http-server.ts#L177)) |
| `GET /api/sessions` | `{ data: SessionInfo[], count }` ([:229](../../packages/collector/src/http-server.ts#L229)) |
| `GET /api/events/<type>` | `{ data: Event[], count }`, scoped by `?project_id=` ([:329+](../../packages/collector/src/http-server.ts#L329)) |
| `POST /api/events` | HTTP ingest (Workers SDK path) ([:457](../../packages/collector/src/http-server.ts#L457)) |
| unknown route | `404 { error, path }` ([:1017](../../packages/collector/src/http-server.ts#L1017)) |

**Public/auth gate ([`http-server.ts:836–843`](../../packages/collector/src/http-server.ts#L836-L843)) — itself an invariant.** Public (no auth even when auth is on): `/api/health`, `/readyz`, `/metrics`, `/runtimescope.js`, `/snippet`, `/dashboard`, `/dashboard/*`, `/assets/*`. Everything else is gated; without a token a gated route returns **401**.

**Auth:** HTTP uses `Authorization: Bearer <key>` ([`auth.ts:55`](../../packages/collector/src/auth.ts#L55)).

## 8. Persistence — *guarded by `durability.conformance.test.ts`*

**SQLite** (`journal_mode = WAL`, [`sqlite-store.ts:142`](../../packages/collector/src/sqlite-store.ts#L142)). Logical schema (the Rust port writes a *fresh* store with the same observable query results; same-schema is the default-and-safest reading — no byte-compat with better-sqlite3 required):

- `events(id, event_id UNIQUE, session_id, project, event_type, timestamp, data)` — indexes: `session_id`, `event_type`, `timestamp`, `(event_type, timestamp)`, `project`.
- `sessions(session_id PK, project, app_name, connected_at, disconnected_at, sdk_version, event_count, is_connected, build_meta, project_id)` — indexes: `project`, `project_id`.
- `session_snapshots(id, session_id→sessions, project, label, metrics, created_at)` — indexes: `session_id`, `(project, created_at)`.

**WAL durability — the #1 reimplementation invariant** ([`wal.ts:98`](../../packages/collector/src/wal.ts#L98)):
- `append(events)` then `commit()` ⇒ bytes are **`fsync`'d to stable storage before `commit()` returns**.
- A committed event survives an ungraceful kill (SIGKILL, no drain) and is recovered on next start. *(The conformance test kills the collector mid-run and asserts full recovery.)*
- Recovery tolerates a **torn tail**: replay stops at the last `fsync`'d line; bytes after are discarded ([`wal.ts:162,180`](../../packages/collector/src/wal.ts#L162)).
- Sealed-file rotation: `fsync`, close, rename to `sealed-<ts>-<seq>.jsonl`.

## 9. What is NOT locked here

- SDK-side batching/dedup/backoff (SDK concern, not wire).
- Throughput / latency / memory — those are the **bench** contract ([`bench/README.md`](../../bench/README.md)), not correctness.
- Internal HTTP routes (`/api/pm/*`, `/api/v1/admin/*`) — documented but evolvable; not part of the external lock.
