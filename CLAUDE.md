# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
npm install              # Install all workspace dependencies
npm run build            # Build all packages (sdk, server-sdk, workers-sdk, collector, mcp-server)
```

Individual packages:
```bash
npm run build -w packages/collector
npm run build -w packages/sdk
npm run build -w packages/server-sdk
npm run build -w packages/workers-sdk
npm run build -w packages/mcp-server
```

## Testing

```bash
npm test                 # Run all tests (289 tests across 23 files)
npm test -- --reporter=verbose  # Verbose output
```

Run a single test file:
```bash
npx vitest run packages/mcp-server/src/__tests__/network-tool.test.ts
npx vitest run packages/mcp-server/src/__integration__/pipeline.test.ts
```

Tests use Vitest with `pool: 'forks'` for native module compatibility. Integration tests start a real CollectorServer on port 0 (OS-assigned) and simulate the SDK via WebSocket.

## Register as MCP Server

```bash
claude mcp add runtimescope node packages/mcp-server/dist/index.js
```

## Architecture

Seven-package npm workspace monorepo. Single data flow: SDK → Collector → MCP tools → Claude Code. The scanner can also visit any URL directly via Playwright.

```
@runtimescope/sdk (browser, zero deps)
    │  WebSocket (ws://localhost:6767)
    ▼
@runtimescope/workers-sdk (Cloudflare Workers, zero deps)
    │  HTTP POST (to collector /api/events)
    ▼
@runtimescope/collector (Node.js, depends on: ws)
    │  Shared EventStore (in-process)
    ▼
@runtimescope/mcp-server (Node.js, depends on: collector, @modelcontextprotocol/sdk, zod)
    │  stdio (JSON-RPC)
    ▼
Claude Code
```

The MCP server and collector run in a **single Node.js process** — the MCP server starts the collector internally and shares the `EventStore` instance in-memory. There is no IPC between them.

### SDK (`packages/sdk/`)

Zero-dependency browser SDK. Builds to ESM + IIFE (global `RuntimeScope`). Monkey-patches browser APIs via interceptors that each return a restore function.

- **Interceptor pattern**: `interceptXxx(emit, sessionId, options?) → () => void`
- **Transport**: WebSocket client with batching (50 events / 100ms), offline queue (1K max), exponential backoff reconnect
- **Bidirectional**: Transport receives server→SDK commands (e.g., `capture_dom_snapshot`) and sends responses
- All diagnostic logging uses `_log` (saved `console.debug.bind(console)` before interceptors patch it) to avoid recursion — hidden by default in Chrome DevTools

### Workers SDK (`packages/workers-sdk/`)

Zero-dependency SDK for Cloudflare Workers. Sends events via HTTP POST to the collector's `/api/events` endpoint (not WebSocket — Workers can't hold persistent connections).

- **`withRuntimeScope(handler, config)`**: Wraps a Workers fetch handler to capture request/response metrics, errors, and console output. Flushes via `ctx.waitUntil()`.
- **Binding wrappers**: `instrumentD1()`, `instrumentKV()`, `instrumentR2()` wrap Cloudflare bindings to capture operations with timing. `scopeD1()`, `scopeKV()`, `scopeR2()` auto-wire to the active request context.
- **Transport**: `WorkersTransport` — no timers, explicit `flush()` call per request. FIFO queue with configurable max size.
- **Types are self-contained** — mirrors event types from `collector/src/types.ts` plus Cloudflare-specific binding interfaces.

### Collector (`packages/collector/`)

- **RingBuffer**: Fixed-size FIFO (default 10K events), `query()` returns newest-first, `toArray()` returns oldest-first
- **EventStore**: Wraps RingBuffer with typed query methods per event type
- **CollectorServer**: WebSocket server with handshake protocol, port retry on EADDRINUSE, bidirectional command channel for on-demand captures
- **Issue detector**: Pattern-matching functions run against event arrays, return `DetectedIssue[]` sorted by severity

### MCP Server (`packages/mcp-server/`)

44 tools registered with `@modelcontextprotocol/sdk`. Each tool module exports `registerXxxTools(server, store, ...)`.

- **Core (12)**: network, console, session, issues, timeline, state, renders, performance, dom-snapshot, har, errors + clear
- **API Discovery (5)**: api-discovery (catalog, health, docs, service map, changes)
- **Database (7)**: database (query log, performance, schema, table data, modify, connections, index suggestions)
- **Process Monitor (3)**: process-monitor (dev processes, kill, port usage)
- **Infrastructure (4)**: infra-connector (deploy logs, runtime logs, build status, overview)
- **Session Diff (2)**: session-diff (compare sessions, session history)
- **Scanner (2)**: scanner (scan_website via Playwright headless, get_sdk_snippet for universal SDK installation)
- **Recon (9)**: recon tools (page metadata, design tokens, layout tree, fonts, accessibility, assets, computed styles, element snapshot, style diff)
- All tools return the same envelope: `{ summary, data, issues, metadata: { timeRange, eventCount, sessionId } }`
- Input validation via zod@3 schemas
- **`get_sdk_snippet`** generates installation code for ANY tech stack (React, Flask, Django, Rails, PHP, WordPress, etc.) — never tell users RuntimeScope is incompatible with their stack

## Key Conventions

- **ESM with `.js` extensions** in all TypeScript imports (e.g., `import { Foo } from './foo.js'`)
- **Types are duplicated** between `sdk/src/types.ts` and `collector/src/types.ts` — the SDK is intentionally dependency-free, so it mirrors the collector's types. Keep them in sync.
- **`collector/src/types.ts` is the canonical source** — it's re-exported via `export * from './types.js'` in the collector barrel and consumed by the MCP server
- Build tool is **tsup** — configs in each package's `tsup.config.ts`
- SDK targets `es2020`, collector and MCP server target `node20`
- MCP server version and SDK version (`SDK_VERSION` constant) should stay in sync across `sdk/src/index.ts`, `server-sdk/src/index.ts`, and `workers-sdk/src/transport.ts`

## Engineering practices & review discipline

These are hard-won from the Rust-port audit (`docs/audits/`), where a green test suite masked real divergences. Follow them, especially when porting/replacing a component or generating code in bulk.

- **A gate is only as strong as what it asserts. "Green" must mean the contract holds.** When replacing a reference implementation (e.g. the Rust collector vs. the Node one), the equivalence test must **diff full observable behavior against the reference** — response *shapes*, every query filter, status codes, error frames, field types — not counts or existence. *A test that still passes against a stub is worse than no test: it manufactures false confidence.* The Rust collector passed 17/17 while `POST /api/events` 404'd and every `/api/events/*` filter was ignored.
- **Before declaring a surface "ported," enumerate its consumers and its full route/method table — that's the checklist.** The HTTP API has explicit per-route filters + `POST /api/events` ingest (Workers SDK + Python SDK depend on it); collapsing N explicit routes into one generic handler is a **smell** unless you've verified every route's behavior. Read the *consumers* (SDK reconnect logic keys off the `AUTH_FAILED` frame; the dashboard depends on reshaped fields), not just the producer.
- **"Compiles + clippy-clean" ≠ correct** — never sufficient for ported or agent/parallel-generated code. Each ported unit needs a **behavioral check against its source** (run it, diff output). The M3 fan-out produced 60 tools; only ~5 were behavior-verified, and several were silently shaped wrong.
- **Test the failure paths, not just the happy path** — for durability/correctness code this *is* the contract: crash mid-write, torn/partial data, disk/DB errors, restart-after-N-restarts. The torn-tail recovery "worked" on the happy test but dropped good data after a real tear.
- **Never discard a `Result` on a write/IO path** (`let _ = wal.commit()` is a data-loss smell). Propagate it; an `add_batch`/ack that returns success while the write failed is silent data loss. Surface failures via logs/metrics/return type.
- **Secrets compare in constant time; replicate protocol *signals* exactly.** Token checks must not short-circuit (timing leak), and a from-scratch reimplementation must preserve the exact frames/codes consumers branch on (`AUTH_FAILED` vs `AUTH_TIMEOUT` — getting it wrong caused a bad-token reconnect storm).
- **Treat tool inputs as untrusted.** A tool that takes a URL/path/command (e.g. `scan_website` → Playwright `page.goto`) needs scheme/host allowlisting (block `file://`, private/internal IPs — SSRF), and never shell-split env into argv.
- **Don't let placeholders satisfy a readiness gate.** Deferred/stub tools must be *explicitly marked unavailable* and **excluded** from "done" metrics — `tools/list >= 60` counting `data: null` stubs is gaming the signal, not measuring parity.
- **Keep distinct domain concepts as distinct fields**, even when they sometimes share a value. `projectName` (= `appName`) and the runtime `projectId` are separate in `collector/src/types.ts` — collapsing them corrupts session/project metadata. Mirror the canonical types faithfully.
- **Periodically attack your own gate:** ask "what would pass this test that shouldn't?" If you can't answer, the gate isn't proven. Re-run the auditor's differential probe pattern (spawn reference + candidate, diff real outputs) whenever a parity claim is on the line.

## Publishing to npm

All 4 public packages are published under the `@runtimescope` org. A GitHub Action (`.github/workflows/publish.yml`) handles automated publishing.

To release a new version:
```bash
npm version 0.7.0 --workspaces --no-git-tag-version  # Bump all package.json files
# Also update SDK_VERSION in packages/sdk/src/index.ts, packages/server-sdk/src/index.ts, and packages/workers-sdk/src/transport.ts
git add -A && git commit -m "v0.7.0"
git tag v0.7.0
git push && git push --tags                            # Triggers GitHub Action → npm publish
```

The `NPM_TOKEN` GitHub secret must be set for the action to authenticate. Packages are published with `--access public`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIMESCOPE_PORT` | `6767` | WebSocket collector port |
| `RUNTIMESCOPE_HTTP_PORT` | `6768` | HTTP API port (for dashboard) |
| `RUNTIMESCOPE_BUFFER_SIZE` | `10000` | Hot-tier read window — caps how many newest events the read API + `buffer_size` gauge return (the durable store keeps more) |
| `RUNTIMESCOPE_RETENTION_DAYS` | `90` | Retention window — a daily sweep deletes stored events + session snapshots older than this and `VACUUM`s. `0` keeps events forever. (The Rust collector stores durably with no ring eviction, so this bounds `collector.db` growth.) |
| `RUNTIMESCOPE_MAX_SNAPSHOTS` | `10` | Max `VACUUM INTO` snapshot backups kept under `~/.runtimescope/snapshots/`; older ones are pruned by the same sweep |
| `RUNTIMESCOPE_HOST` | `127.0.0.1` | Standalone collector bind address (ADR-0010). Set `0.0.0.0` to expose on all interfaces — only behind a reverse proxy/tunnel with TLS + auth. The embedded MCP collector always binds loopback. |
| `RUNTIMESCOPE_INGEST_RATE` | `120` | Per-client ingest rate limit, sustained req/s for `POST /api/events` + the SDK WS handshake (ADR-0010). `0` disables. Loopback clients are exempt. |
| `RUNTIMESCOPE_INGEST_BURST` | `2×rate` | Token-bucket burst size for the ingest limiter |
| `RUNTIMESCOPE_TRUST_PROXY` | _unset_ | Set `1` when behind a reverse proxy/tunnel so the rate limiter keys on the real client IP (`CF-Connecting-IP` / `X-Forwarded-For`) instead of the proxy's address |
| `RUNTIMESCOPE_MCP_TRANSPORT` | `stdio` | MCP transport: `stdio` (local default) or `http` (Streamable HTTP for remote access, ADR-0011; equivalent to `mcp --http`) |
| `RUNTIMESCOPE_MCP_HTTP_PORT` | `6770` | Port for the remote MCP HTTP transport (distinct from the collector ports); bearer-gated, requires `RUNTIMESCOPE_AUTH_TOKEN` |
| `RUNTIMESCOPE_MOSAIC_URL` | _unset_ | Mosaic `mc-daemon` sidecar URL (ADR-0013, slice 3b — analytics forecast/trace/narrative). Unset ⇒ the SQL ROI path is authoritative and those endpoints 503 `MOSAIC_NOT_CONFIGURED`. Loopback http. |
| `RUNTIMESCOPE_MOSAIC_KEY` | _unset_ | Bearer token for the Mosaic daemon's `/api/v1` |
| `RUNTIMESCOPE_MOSAIC_CUBE` | `roi` | Cube name the collector syncs ROI facts to / queries |
| `RUNTIMESCOPE_MOSAIC_SYNC_SECS` | `60` | Period (s, min 5) of the background fact sync to the cube (only when Mosaic is configured) |

Both the MCP server and standalone collector use the same default ports (6767/6768). Only one should run at a time. The SDK defaults to `ws://localhost:6767`. The dashboard Vite proxy defaults to `http://127.0.0.1:6768`.
