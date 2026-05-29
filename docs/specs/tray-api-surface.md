# Tray API Surface

> **Status:** Locked for the duration of Phase Tauri-Tray. Becomes part of the
> wire protocol locked in Phase Wire-Protocol-Lock.
> **Audience:** anyone implementing the RuntimeScope collector (Node today,
> Rust at v0.12.0) and anyone modifying [`@runtimescope/tray`](../../packages/tray/).

This document enumerates **every** HTTP endpoint the tray
([`packages/tray`](../../packages/tray/)) calls. The tray reads from this
surface and nothing else — no SQLite, no `~/.runtimescope/` files, no
WebSocket subscriptions, no imports from `@runtimescope/collector`.

The shapes documented here are derived from the live route handlers in
[`packages/collector/src/http-server.ts`](../../packages/collector/src/http-server.ts)
and the type definitions in
[`packages/collector/src/types.ts`](../../packages/collector/src/types.ts).
If the implementation and this document drift, **the implementation is
truth** — re-derive this document.

This is the first file under [`docs/specs/`](.). The convention established:

> One file per locked surface. Each file states the consumer, derives shapes
> from the implementation, and is the input contract for the next phase that
> consolidates it. Specs do not own behavior; the code does. They cite their
> source of truth so the file stays a thin mirror that's cheap to refresh.

## Index

- [Endpoints called by the tray](#endpoints-called-by-the-tray)
  - [`GET /api/health`](#get-apihealth)
  - [`GET /api/sessions`](#get-apisessions)
  - [`GET https://registry.npmjs.org/runtimescope/latest`](#get-httpsregistrynpmjsorgruntimescopelatest)
- [Polling cadence](#polling-cadence)
- [Error semantics](#error-semantics)
- [v0.12.0 transition (Rust collector + GitHub Releases)](#v0120-transition-rust-collector--github-releases)
- [What the tray deliberately does NOT call](#what-the-tray-deliberately-does-not-call)

## Endpoints called by the tray

### `GET /api/health`

**Source of truth:** [`http-server.ts:147–156`](../../packages/collector/src/http-server.ts#L147-L156).
**Auth:** none. Always public per the route definition.
**Cadence:** every 5 seconds while the dropdown window is visible, paused
otherwise.

Request:

```http
GET /api/health HTTP/1.1
Host: 127.0.0.1:6768
Accept: application/json
```

Success (HTTP 200) JSON body:

```json
{
  "status": "ok",
  "version": "0.10.12",
  "timestamp": 1779642988965,
  "uptime": 2560,
  "sessions": 1,
  "authEnabled": false
}
```

| Field | Type | Notes |
|---|---|---|
| `status` | `string` | Always `"ok"` from this endpoint today. Tray currently does not branch on this — it would prefer that distinction live on `/readyz`. |
| `version` | `string` | semver of the running collector. Compared against npm's latest for the update banner. |
| `timestamp` | `number` | Server wall-clock at the moment of the response, ms since epoch. Tray ignores. |
| `uptime` | `number` | Seconds since the collector booted. Drives the "uptime 12h 4m" line. |
| `sessions` | `number` | Connected-session count (derived inside the collector from `getSessionInfo().filter(s => s.isConnected).length`). |
| `authEnabled` | `boolean` | Whether the collector's auth layer is on. Tray uses this to decide whether `/api/sessions` is expected to 401. |

### `GET /api/sessions`

**Source of truth:** [`http-server.ts:229–232`](../../packages/collector/src/http-server.ts#L229-L232) (route) +
[`types.ts:726–734`](../../packages/collector/src/types.ts#L726-L734) (shape).
**Auth:** required iff `authEnabled` is true. With auth on but no token, the
collector replies HTTP 401 — the tray surfaces a yellow status and a note.
**Cadence:** alongside `/api/health` (5 s while window visible).

Success (HTTP 200) JSON body:

```json
{
  "data": [
    {
      "sessionId": "ses_abc123",
      "appName": "my-web",
      "connectedAt": 1779640000000,
      "sdkVersion": "0.10.12",
      "eventCount": 4521,
      "isConnected": true,
      "projectId": "proj_xyz789"
    }
  ],
  "count": 1
}
```

| Field | Type | Notes |
|---|---|---|
| `data[i].sessionId` | `string` | Tray displays `sessionId.slice(0, 8) + "…"`. |
| `data[i].appName` | `string` | The app's friendly name (the SDK init's `appName`). Tray displays this directly. **Note:** the brief's §B table called this `projectName` — it does not exist. `appName` is canonical. |
| `data[i].isConnected` | `boolean` | Tray filters to only connected sessions. |
| `data[i].connectedAt` | `number` | Ms since epoch. Tray currently ignores. |
| `data[i].sdkVersion` | `string` | The SDK version reported by the connected client. Tray ignores in v0.1. |
| `data[i].eventCount` | `number` | Total events captured. Tray ignores in v0.1. |
| `data[i].projectId` | `string?` | Optional. Tray ignores in v0.1; future per-project filtering may use it. |
| `count` | `number` | Length of `data`. Convenience field. |

The tray maps each entry to a `SessionSummary` containing only `sessionId`,
`appName`, and `isConnected`. Other fields are deliberately dropped so the
tray can't accidentally start to depend on them — keeping the locked
surface minimal.

### `GET https://registry.npmjs.org/runtimescope/latest`

**Source of truth:** npm public registry. Standard `package@latest` lookup.
**Auth:** none.
**Cadence:** every 60 seconds (once per 12 health-tick cycles) while the
dropdown is visible. Result is cached so the next visible cycle re-uses it.

Request:

```http
GET https://registry.npmjs.org/runtimescope/latest HTTP/1.1
Accept: application/json
```

Success (HTTP 200) JSON body (truncated):

```json
{
  "name": "runtimescope",
  "version": "0.10.12",
  "...": "other fields ignored"
}
```

Tray reads only `version`. The comparison uses a deliberately loose semver
parser (strips pre-release suffixes) — see
[`collector_client.rs:parse_version`](../../packages/tray/src-tauri/src/collector_client.rs)
for the exact algorithm.

> **TODO(v0.12.0):** Per [ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md),
> the Rust collector is not published to npm. The tray's "latest version"
> source must swap to the GitHub Releases manifest at
> `https://github.com/edwinlov3tt/runtimescope/releases/latest`. This is
> isolated to a single Rust function (`latest_published_version`) — the
> consuming UI does not change.

## Polling cadence

| Trigger | Endpoint(s) called |
|---|---|
| Dropdown shown (user clicks tray icon) | Immediate snapshot via the `health_snapshot` IPC command — returns cached value to the React layer, then kicks off a fresh `/api/health` + `/api/sessions` and emits the result via the `health-snapshot` event. |
| Every 5 s while dropdown visible | `GET /api/health` then `GET /api/sessions`. |
| Every 60 s while dropdown visible (i.e. every 12th poll) | Add `GET https://registry.npmjs.org/runtimescope/latest` to the above. |
| Dropdown hidden / window unfocused | Polling pauses entirely. The next show resumes from the paused tick. |
| User clicks Restart/Update/Quit Service | Tray shells out to `runtimescope service <sub>`; on return, fires one immediate refresh. |

Polling uses `tokio::time::interval` with `MissedTickBehavior::Delay` so a
macOS sleep/wake cycle does not unleash a burst of catch-up requests against
the local HTTP API.

## Error semantics

| Observation | Tray reaction |
|---|---|
| `/api/health` times out or 5xx | Status color **red**. `errorReason: "Collector not responding on :6768."` |
| `/api/health` returns HTTP 4xx (excluding 401) | Status color **red**. `errorReason: "Collector returned HTTP <status>."` |
| `/api/health` returns 401 | Status color **red**. `errorReason: "Collector requires authentication."` (v0.1 cannot configure auth headers from the tray UI; document in CURRENT_STATE.md as a known limitation.) |
| `/api/health` OK, `/api/sessions` returns 401 | Status color **yellow**. `errorReason: "Authenticated endpoints unreachable (set RUNTIMESCOPE_API_KEY)."` |
| `/api/health` OK, `/api/sessions` returns non-401 error | Status color **yellow**. `errorReason: "Could not list sessions."` |
| Both endpoints OK | Status color **green**. No error reason. |
| `registry.npmjs.org` unreachable | Tray falls back to the cached `latest_version`; update banner shows iff the cache is newer than the running version. No status color change. |

The 1.5 s per-request timeout on `CollectorClient` ensures a slow collector
cannot ever back-pressure into the next 5 s tick.

## v0.12.0 transition (Rust collector + GitHub Releases)

Per [ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md):

- **`/api/health`** — must be preserved by the Rust collector, exact shape.
  This is the locked surface.
- **`/api/sessions`** — must be preserved by the Rust collector, exact
  shape. Fields the tray ignores in v0.1 (`connectedAt`, `sdkVersion`,
  `eventCount`, `projectId`) may be stripped or kept; the tray won't break
  either way.
- **npm `runtimescope@latest`** — irrelevant in the Rust era. Tray code
  contains a single function (`latest_published_version` in
  [`collector_client.rs`](../../packages/tray/src-tauri/src/collector_client.rs))
  to swap to a GitHub Releases manifest at v0.12.0.
- **CLI shell-outs** — the tray invokes `runtimescope service restart`,
  `runtimescope service stop`, `runtimescope service update`. The
  implementations of these commands change at v0.12.0 (curl-install instead
  of `npm install -g`), but the command shapes do not. The tray needs no
  changes for that transition.

## What the tray deliberately does NOT call

These are explicit non-dependencies, listed so the next implementer doesn't
"helpfully" introduce them and break the locked surface.

- `/api/events` (the bulk event ingest endpoint) — events are SDK→collector,
  not tray→collector.
- `/api/projects` — a richer per-project view; the tray uses `/api/sessions`
  for v0.1.
- `/readyz` — overlaps with `/api/health`; the tray prefers the latter
  because it returns the richer payload in one request.
- `/metrics` — Prometheus surface, irrelevant.
- `/api/v1/admin/snapshot` — admin-only and rate-limited; out of scope.
- WebSocket `/api/ws/events` — the SDK transport, not for clients.
- `/api/pm/*` — process-monitor sub-routes; out of scope.
- Any filesystem read of `~/.runtimescope/`, including SQLite stores or logs.
  ("Open Logs" launches the OS default `.log` viewer via `open <path>`; the
  tray itself never reads the file.)

When Phase Wire-Protocol-Lock starts, every endpoint in the "called by the
tray" section above goes into the locked spec. The "deliberately NOT called"
section is the negative space that **doesn't** need to be in the locked
spec.
