# Phase Wire-Protocol-Lock Handoff — freeze the contract before the Rust port

> **Audience:** the Claude Code instance in this repo that picks up Phase Wire-Protocol-Lock.
> **You inherit a green tree at `c9dfe33`** (Phase Tauri-Tray committed and pushed). Read this whole file before touching code.
> **This phase has no owner-side prerequisites.** Unlike Tauri-Tray, everything here is in your tool surface — no signing keys, no Apple account, no hardware. The launchd collector running (so conformance tests have something to hit) is the only precondition, and you can start it yourself.

---

## Why this phase exists (the one-paragraph version)

Phase Rust-Collector (v0.12.0) replaces three Node packages (`collector`, plus the parts of `mcp-server` that read the store) with Rust crates. The failure mode that phase must not hit: the Rust collector silently changes a JSON shape, a status code, a SQLite column, or the WebSocket handshake — and every already-published SDK (browser, server, workers, Python) breaks in the field with no compile error to catch it. **Wire-Protocol-Lock writes the contract down — and makes it executable — while the Node collector is still the source of truth.** The Rust port then has to pass that exact suite to be called done. This is the cheap insurance you buy before the expensive 8-week rewrite.

Per [ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md) (invariant #3): *"The wire protocol is sacred from Phase Wire-Protocol-Lock onward. Any change must be an ADR before it lands."* This phase is where "sacred" gets defined.

---

## Where Phase Tauri-Tray ended (your baseline)

- **Last commit:** `c9dfe33` — *feat(tray): Phase Tauri-Tray — native macOS menu-bar app (@runtimescope/tray 0.1.0)*
- **Published versions on npm:** CLI + 5 scoped packages at **0.10.12**; Python (PyPI) **0.10.12**; plugin (Claude marketplace) **0.10.16**. The tray is workspace-private at **0.1.0** (manual `.dmg`).
- **Test status:** 586 / 0 unit, 2 / 0 Rust (tray), 7 / 7 stress.
- **Gates green:** `npm run build` clean (13 packages + tray), `npm test` green, `npm run stress` green.
- **New since the audit:** `packages/tray/` exists; `runtimescope service stop` was added to the CLI (launchd + systemd); `docs/specs/tray-api-surface.md` locked the three HTTP endpoints the tray depends on; `rust-toolchain.toml` pins Rust **1.90.0** at the repo root.
- **Canonical MCP tool count:** **63 tools across 34 files** — `grep -c "server\.tool(" packages/mcp-server/src/tools/*.ts | awk -F: '{s+=$2}END{print s}'`. ⚠️ **The master phase plan says "55" — that is stale.** Your `mcp-tool-surface.md` deliverable must index 63, not 55.

---

## Phase Wire-Protocol-Lock prompt (this is your contract)

> **Goal:** before any Rust collector code is written, lock the contract the Rust collector must honor — both as a thin written spec (invariants only) and as an executable conformance suite (the real source of truth). **No behavior change.** Ships as **v0.11.0**.
>
> **Scope:** ~2–3 days. This is a documentation + test phase. You are not changing how the collector behaves; you are pinning down how it *already* behaves so a from-scratch reimplementation can be proven equivalent.
>
> **In scope:**
> - `docs/specs/wire-protocol.md` — thin (~2 pages), invariants only. Covers: WebSocket handshake, event-batch envelope, bidirectional command/response shape, HTTP `/api/*` contracts (request schema, response schema, status codes), SQLite schema invariants, WAL durability ordering, auth model. Each invariant cites a `file:line` in the current implementation as its source of truth (same convention `tray-api-surface.md` established).
> - `docs/specs/mcp-tool-surface.md` — a static index of the **63** MCP tools and their input/output envelope. Each tool already has a zod schema in code; this doc is a catalog, not a re-specification.
> - `tests/conformance/` — black-box, collector-agnostic tests that spawn *any* collector binary as a subprocess, drive it with the real `@runtimescope/sdk` and query it with the real `@runtimescope/mcp-server`, and assert observable behavior. **Must pass against the v0.10.12 Node collector today.** Becomes the Rust port's acceptance gate.
> - **ADR-0006** — *"Conformance tests are the executable spec; the spec doc is documentation."* (Note: the master plan calls this "ADR-0004 (TBD)" — that number is already taken by the install-blocker exception. Use **0006**; 0001–0005 exist.)
>
> **Out of scope:**
> - Any change to collector / SDK / mcp-server *behavior*. If a test reveals a bug, write it up as a SPEC QUESTION — do not fix it under this phase unless the owner approves, because a fix changes the contract you're trying to freeze.
> - The Rust collector itself. That's the next phase.
> - Performance benchmarking / load contracts. The conformance suite asserts *correctness of shape and behavior*, not throughput.
>
> **Acceptance criteria:**
> 1. Specs cover every wire format the JS/Python SDKs depend on, each line cross-referenced to a code excerpt.
> 2. Conformance suite passes green against the v0.10.12 Node collector.
> 3. Ships as v0.11.0. No behavior change (586 unit + 7 stress still green; existing snapshots unchanged).
> 4. Completion report at `docs/reports/phase-wire-protocol-lock-completion-report.md`.

---

## Context the prompt does NOT spell out — the actual wire surface

Everything below is derived from the live source at `c9dfe33`. **The implementation is truth.** Where a `file:line` is cited, re-check it before you write the spec line — code moves.

### A. The WebSocket protocol (`packages/collector/src/server.ts`, `types.ts`)

**Transport:** `ws://localhost:6767` (default; `RUNTIMESCOPE_PORT`). The SDK opens one persistent connection per session.

**Message envelope** — every frame is JSON ([`types.ts:794`](../../packages/collector/src/types.ts#L794)):

```ts
interface WSMessage {
  type: 'event' | 'handshake' | 'heartbeat' | 'command' | 'command_response';
  payload: unknown;        // shape determined by `type`
  timestamp: number;       // ms epoch
  sessionId: string;
}
```

**Handshake** — must be the first message ([`types.ts:801`](../../packages/collector/src/types.ts#L801), handler at [`server.ts:848`](../../packages/collector/src/server.ts#L848)):

```ts
interface HandshakePayload {
  appName: string;
  sdkVersion: string;
  sessionId: string;
  authToken?: string;      // required only when auth is enabled
  projectId?: string;      // falls back to derived project name if absent
}
```

- When auth is enabled, the server adds the socket to `pendingHandshakes` and **auto-closes it after 5 seconds** with WS close code **4001** ("Authentication timeout") and an `{type:'error', payload:{code:'AUTH_TIMEOUT'}}` frame ([`server.ts:776–800`](../../packages/collector/src/server.ts#L776-L800)). Lock the 5s window and the 4001 code as invariants.
- A successful handshake synthesizes a `session` event into the store (`eventId: session-<sessionId>`).

**Event batches** ([`types.ts:809`](../../packages/collector/src/types.ts#L809)): `payload` is `{ events: RuntimeEvent[] }`. The handler ignores non-array `events` ([`server.ts` event case](../../packages/collector/src/server.ts)). Batching policy (50 events / 100ms) lives in the SDK, not the protocol — **don't lock SDK batching as a wire invariant**; lock only that the server accepts an array.

**Every event extends `BaseEvent`** ([`types.ts:29`](../../packages/collector/src/types.ts#L29)):

```ts
interface BaseEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  // + a `type` discriminator (one of the 19 EventTypes below)
}
```

**The 19 `EventType`s** ([`types.ts:8`](../../packages/collector/src/types.ts#L8)): `network`, `console`, `session`, `state`, `render`, `dom_snapshot`, `performance`, `database`, `custom`, `navigation`, `ui`, `recon_metadata`, `recon_design_tokens`, `recon_fonts`, `recon_layout_tree`, `recon_accessibility`, `recon_computed_styles`, `recon_element_snapshot`, `recon_asset_inventory`. The spec should enumerate these and point at the per-type interface in `types.ts` rather than re-typing each field (the file is the catalog).

**Bidirectional command channel** — server→SDK on-demand captures ([`types.ts:815`](../../packages/collector/src/types.ts#L815)):

```ts
type ServerCommand =
  | { command: 'capture_dom_snapshot'; requestId: string; params?: {maxSize?: number} }
  | { command: 'capture_performance_metrics'; requestId: string }
  | { command: 'clear_renders'; requestId: string }
  | { command: 'recon_scan'; requestId: string; params?: {...} }
  | { command: 'recon_computed_styles'; requestId: string; params: {selector, properties?} }
  | { command: 'recon_element_snapshot'; requestId: string; params: {selector, depth?} }
  | { command: 'recon_layout_tree'; requestId: string; params?: {selector?, maxDepth?} };

interface CommandResponse {       // SDK→server reply, correlated by requestId
  type: 'command_response';
  requestId: string;
  command: string;
  payload: unknown;
  timestamp: number;
  sessionId: string;
}
```

The `requestId` correlation is the invariant. The Rust collector must issue commands and match responses by `requestId`.

**Heartbeat:** `type: 'heartbeat'` frames + WS ping/pong keep-alive. Pong resets the alive flag ([`server.ts` heartbeat loop](../../packages/collector/src/server.ts)).

### B. The HTTP API (`packages/collector/src/http-server.ts`)

Served on `http://127.0.0.1:6768` (default; `RUNTIMESCOPE_HTTP_PORT`). Routes registered in a `this.routes` map keyed `"<METHOD> <path>"`:

| Route | Auth | Notes |
|---|---|---|
| `GET /api/health` | public | status, version, uptime, sessions, authEnabled — **already locked by [`tray-api-surface.md`](../specs/tray-api-surface.md)** ([`http-server.ts:147`](../../packages/collector/src/http-server.ts#L147)) |
| `GET /api/sessions` | gated | per-session detail — **already locked by tray spec** ([`http-server.ts:229`](../../packages/collector/src/http-server.ts#L229)) |
| `GET /api/projects` | gated | [`http-server.ts:235`](../../packages/collector/src/http-server.ts#L235) |
| `GET /api/processes` / `GET /api/ports` | gated | process monitor ([`:282`](../../packages/collector/src/http-server.ts#L282), [`:318`](../../packages/collector/src/http-server.ts#L318)) |
| `GET /api/events/{network,console,state,renders,performance,database,timeline,custom,ui}` | gated | the read API the dashboard uses ([`:329`–`:437`](../../packages/collector/src/http-server.ts#L329)) |
| `POST /api/events` | gated | HTTP event ingest (the Workers SDK path) ([`:457`](../../packages/collector/src/http-server.ts#L457)) |
| `POST /api/v1/admin/snapshot` | gated | [`:191`](../../packages/collector/src/http-server.ts#L191) |
| `/api/pm/*` | gated | project-manager sub-router ([`:996`](../../packages/collector/src/http-server.ts#L996)) |
| `GET /readyz` | public | 200 `{status:"ready"}` / 503 `{status:"starting"}` — **tray-locked** |
| `GET /metrics` | public | Prometheus exposition |
| `GET /runtimescope.js`, `GET /snippet` | public | SDK delivery |
| `/dashboard`, `/dashboard/*`, `/assets/*` | public | static SPA (shipped inside the collector npm tarball since v0.10.11) |

**The public/auth gate** ([`http-server.ts:836–843`](../../packages/collector/src/http-server.ts#L836-L843)) is itself an invariant — which routes bypass auth is part of the contract. Lock the exact `isPublic` set. Unknown routes return `404 {error:"Not found", path}` ([`:1017`](../../packages/collector/src/http-server.ts#L1017)).

**Decide and document the conformance boundary.** `tray-api-surface.md` covers 3 endpoints. The dashboard hits the whole `/api/events/*` family. The conformance suite does NOT need to cover every endpoint at equal depth — but the spec must state which endpoints are *locked* (Rust must match byte-for-byte) vs. *internal* (may evolve). Recommendation: lock everything an external consumer touches (the SDK ingest paths, `/api/health`, `/api/sessions`, `/readyz`, `/metrics`, the SDK-delivery routes); treat `/api/events/*` read shapes as locked because the dashboard is a shipped artifact; treat `/api/pm/*` and `/api/v1/admin/*` as internal-but-documented. **Get the owner to confirm this boundary before writing the suite** — it's the one genuinely ambiguous scope call in this phase.

### C. Persistence invariants (`sqlite-store.ts`, `wal.ts`)

**SQLite** ([`sqlite-store.ts:142`](../../packages/collector/src/sqlite-store.ts#L142)) — `journal_mode = WAL`. Three tables:

- `events` — indexes on `session_id`, `event_type`, `timestamp`, `(event_type, timestamp)`, `project`
- `sessions` — indexes on `project`, `project_id`
- `session_snapshots` — indexes on `session_id`, `(project, created_at)`

Lock the **column set and the index set** as invariants (the Rust collector must produce a queryable store with the same logical shape; it need not be the same SQLite file format if it satisfies the same queries — but the default-and-safest contract is "same schema"). State this explicitly: is the invariant "same SQLite schema" or "same observable query results"? The conformance suite tests the latter; the spec should say the former is the implementation default.

**WAL durability** ([`wal.ts`](../../packages/collector/src/wal.ts)) — the ordering contract that matters most for a reimplementation:

- `append(events)` then `commit()` → bytes are `fsync`'d to stable storage before `commit()` returns ([`wal.ts:98`](../../packages/collector/src/wal.ts#L98)).
- Recovery tolerates a **torn tail**: replay stops at the last successfully-`fsync`'d line; anything after is treated as garbage ([`wal.ts:162,180`](../../packages/collector/src/wal.ts#L162)).
- Sealed-file rotation: `fsync`, close, rename to `sealed-<ts>-<seq>.jsonl`.

This `fsync`-before-`commit` ordering is the single most important durability invariant — write a conformance test that kills the collector mid-batch and asserts no torn-tail corruption on restart. **The existing [`stress/scenarios/crash-recovery.ts`](../../stress/scenarios/crash-recovery.ts) already does exactly this**, and as of `2800c4e` it launches the collector through the same `RUNTIMESCOPE_COLLECTOR_CMD` seam (see the next section) — so it *already* runs against the Rust binary unchanged. Your conformance durability test can be a thin port of it, or you may simply fold the stress scenario into the conformance gate.

### D. Auth model (`packages/collector/src/auth.ts`)

- `AuthManager.isEnabled()` — auth is off by default; enabled when a key is configured.
- HTTP: `Authorization: Bearer <key>` ([`auth.ts:55`](../../packages/collector/src/auth.ts#L55)). WS: `authToken` in the handshake payload.
- When disabled, all routes are reachable and the WS handshake skips the 5s auth timeout. When enabled, the `isPublic` set (§B) is the only unauthenticated surface.

Lock: header name, Bearer scheme, the handshake-token field, the default-off posture, and the public-route exemption list.

---

## Files you will CREATE

```
docs/specs/wire-protocol.md            ~2 pages, invariants only, each citing file:line
docs/specs/mcp-tool-surface.md         index of the 63 MCP tools + I/O envelope
docs/decisions/0006-conformance-tests-are-the-spec.md   the ADR
docs/reports/phase-wire-protocol-lock-completion-report.md

tests/conformance/                     NEW top-level test tree
├── README.md                          how to run against any collector binary
├── harness/
│   ├── spawn-collector.ts             REUSE stress/utils/spawn-collector.ts (seam exists)
│   ├── sdk-driver.ts                  REUSE stress/utils/sdk-driver.ts (exists)
│   └── mcp-driver.ts                  ★ the only genuinely new harness piece — query @runtimescope/mcp-server
└── specs/
    ├── handshake.conformance.test.ts  WS handshake, auth timeout, 4001
    ├── event-roundtrip.conformance.test.ts   send events → assert queryable
    ├── command-channel.conformance.test.ts   requestId correlation
    ├── http-contracts.conformance.test.ts    /api/* shapes + status codes
    └── durability.conformance.test.ts        kill mid-batch → no torn tail (port crash-recovery.ts)
```

The harness is the load-bearing design decision — and **the seam already exists, built ahead of this phase (commit `2800c4e`).** Do NOT reinvent it:

- [`stress/utils/spawn-collector.ts`](../../stress/utils/spawn-collector.ts) spawns the collector via **`RUNTIMESCOPE_COLLECTOR_CMD`** (defaults to the Node standalone; set the env var to any binary), waits for `/readyz`, isolates `$HOME`, tears down. It exports both `spawnCollector()` and `resolveCollectorCmd()`. **Reuse this** — either import it from `tests/conformance/`, or lift it into a shared `stress/utils` ↔ `tests/conformance/harness` module. Note the env var is `RUNTIMESCOPE_COLLECTOR_CMD` (a full command, may include args), not the `RUNTIMESCOPE_COLLECTOR_BIN` this doc originally guessed — match the one that exists.
- [`stress/utils/sdk-driver.ts`](../../stress/utils/sdk-driver.ts) already drives the real `@runtimescope/sdk` over WS. Reuse for the SDK side; you only need to add an MCP-query driver.
- A **performance** counterpart already exists too: [`bench/`](../../bench/) + [`stress/bench.ts`](../../stress/bench.ts) measure throughput, ingest latency, and memory-soak leak detection against the same seam, with a committed Node baseline at [`bench/baselines/node.json`](../../bench/baselines/node.json) and a `bench:compare` regression gate. The conformance suite is the *correctness* gate; the bench is the *performance* gate. Phase Rust-Collector runs both against the Rust binary with `RUNTIMESCOPE_COLLECTOR_CMD=./target/release/… npm run conformance && npm run bench:compare -- node <rust>`.

So your real harness work is narrower than this doc's file tree implies: write `mcp-driver.ts` (the only missing piece), the five `*.conformance.test.ts` specs, and the wire-up — building on the existing `spawn-collector.ts` + `sdk-driver.ts` rather than from scratch.

## Files you will most likely TOUCH

| Why | File | Action |
|---|---|---|
| Version bump to v0.11.0 | all `package.json` + `SDK_VERSION` constants | `npm version 0.11.0 --workspaces --no-git-tag-version`; update `SDK_VERSION` in sdk/server-sdk/workers-sdk per CLAUDE.md |
| Wire the conformance suite into CI | [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml) | add a `npm run conformance` step (or a separate workflow) — gate releases on it |
| Conformance npm script | [`../../package.json`](../../package.json) — root | add `"conformance": "vitest run tests/conformance"` |
| Phase bookkeeping | [`../CURRENT_STATE.md`](../CURRENT_STATE.md), [`../HANDOFF.md`](../HANDOFF.md) | at phase end: mark Wire-Protocol-Lock shipped, point at Phase Rust-Collector |

**Do NOT touch:** collector/SDK/mcp-server *behavior*. You may read all of it; you change none of it. The whole point of the phase is that the contract is frozen as-is.

---

## Reproducible commands (exit 0 today at `c9dfe33`)

```bash
cd /Users/edwinlovettiii/runtimescope
npm install
npm run build                  # 13 packages + tray, clean
npm test                       # 586 / 0
npm run stress                 # 7 / 7
runtimescope service status    # ✓ Service running — your conformance target
curl -fsS http://127.0.0.1:6768/api/health   # the live contract
```

If `service status` shows nothing running, start it yourself — this phase has no owner-side blocker:

```bash
runtimescope service install   # ~60s on a many-project machine; that's normal
```

---

## Final checklist before you call this phase done

- [ ] `docs/specs/wire-protocol.md` written — ~2 pages, every invariant cites a `file:line`.
- [ ] `docs/specs/mcp-tool-surface.md` indexes all **63** tools (not 55).
- [ ] `docs/decisions/0006-conformance-tests-are-the-spec.md` written and set to Accepted.
- [ ] `tests/conformance/` harness takes a collector-binary path and defaults to the Node collector.
- [ ] Conformance suite passes green against the v0.10.12 Node collector.
- [ ] The locked-vs-internal endpoint boundary (§B) is documented AND confirmed by the owner.
- [ ] Durability test kills the collector mid-batch and asserts no torn-tail corruption on restart.
- [ ] `npm run conformance` wired into the release path (publish.yml or a sibling workflow).
- [ ] All 586 unit + 7 stress still green — **no behavior changed**.
- [ ] Version bumped to v0.11.0 across the workspace (collector resumes releasing; this is a real version, not a tray-style private one).
- [ ] Completion report at [`../reports/phase-wire-protocol-lock-completion-report.md`](../reports/phase-wire-protocol-lock-completion-report.md) following [`../templates/phase-completion-report.md`](../templates/phase-completion-report.md).
- [ ] CURRENT_STATE.md + HANDOFF.md point at Phase Rust-Collector as next.

Resolution order if you're uncertain:

1. This handoff's prompt.
2. [`../roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md) — Phase Wire-Protocol-Lock section (deliverables + acceptance). ⚠️ its "55 tools" and "ADR-0004" references are stale (use 63 and ADR-0006).
3. [`../specs/tray-api-surface.md`](../specs/tray-api-surface.md) — the spec-file convention this phase scales up, and the 3 already-locked endpoints.
4. [`../decisions/0002-rust-port-sequence-and-distribution.md`](../decisions/0002-rust-port-sequence-and-distribution.md) — invariant #3 ("the wire protocol is sacred") is the mandate for this whole phase.
5. The live source under `packages/collector/src/` — **the implementation is truth.**
6. [`../../CLAUDE.md`](../../CLAUDE.md).

If those don't resolve it — especially the §B locked-vs-internal boundary — stop and write a SPEC QUESTION. Do not freeze a contract you're guessing at; a wrong invariant here costs the entire Rust port.

---

## Notes from the handing-off session

- **The implementation is the spec; the doc is a mirror.** That's the whole thesis of ADR-0006 you'll write. If the doc and the code disagree, the code wins and you re-derive the doc. The conformance suite is what makes that safe — it pins behavior so the doc can stay thin.
- **Resist fixing bugs.** If a conformance test surfaces a real bug in the Node collector, that's a genuinely good outcome — but fixing it *changes the contract you're freezing*. Write it up, get owner sign-off, and decide whether the fix lands here (and the Rust port inherits corrected behavior) or whether the bug is the contract (and the Rust port must replicate it). Either is defensible; silently picking one is not.
- **The harness seam is everything.** Spend your design time on `spawn-collector.ts` taking a binary path. Get that right and Phase Rust-Collector's acceptance gate is `RUNTIMESCOPE_COLLECTOR_BIN=./target/release/runtimescope-collector npm run conformance` with zero test edits.
- **You're the second spec under `docs/specs/`.** The tray spec set the convention (state the consumer, cite the source, stay thin). Follow it. `wire-protocol.md` is the same shape, just wider.
- **This phase resumes real versioning.** Tauri-Tray was deliberately private at 0.1.0; Wire-Protocol-Lock ships v0.11.0 on the published packages. The version bump is part of the deliverable.
