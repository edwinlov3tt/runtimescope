# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
npm install              # Install all workspace dependencies
npm run build            # Build all 3 packages (collector → mcp-server → sdk)
```

Individual packages:
```bash
npm run build -w packages/collector
npm run build -w packages/sdk
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

Three-package npm workspace monorepo. Single data flow: Browser SDK → WebSocket → Collector → MCP tools → Claude Code.

```
@runtimescope/sdk (browser, zero deps)
    │  WebSocket (ws://localhost:9090)
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
- All diagnostic logging uses `_log` (saved `console.error.bind(console)` before interceptors patch it) to avoid recursion

### Collector (`packages/collector/`)

- **RingBuffer**: Fixed-size FIFO (default 10K events), `query()` returns newest-first, `toArray()` returns oldest-first
- **EventStore**: Wraps RingBuffer with typed query methods per event type
- **CollectorServer**: WebSocket server with handshake protocol, port retry on EADDRINUSE, bidirectional command channel for on-demand captures
- **Issue detector**: Pattern-matching functions run against event arrays, return `DetectedIssue[]` sorted by severity

### MCP Server (`packages/mcp-server/`)

33 tools registered with `@modelcontextprotocol/sdk`. Each tool module exports `registerXxxTools(server, store, ...)`.

- **Core (12)**: network, console, session, issues, timeline, state, renders, performance, dom-snapshot, har, errors + clear
- **API Discovery (5)**: api-discovery (catalog, health, docs, service map, changes)
- **Database (7)**: database (query log, performance, schema, table data, modify, connections, index suggestions)
- **Process Monitor (3)**: process-monitor (dev processes, kill, port usage)
- **Infrastructure (4)**: infra-connector (deploy logs, runtime logs, build status, overview)
- **Session Diff (2)**: session-diff (compare sessions, session history)
- All tools return the same envelope: `{ summary, data, issues, metadata: { timeRange, eventCount, sessionId } }`
- Input validation via zod@3 schemas

## Key Conventions

- **ESM with `.js` extensions** in all TypeScript imports (e.g., `import { Foo } from './foo.js'`)
- **Types are duplicated** between `sdk/src/types.ts` and `collector/src/types.ts` — the SDK is intentionally dependency-free, so it mirrors the collector's types. Keep them in sync.
- **`collector/src/types.ts` is the canonical source** — it's re-exported via `export * from './types.js'` in the collector barrel and consumed by the MCP server
- Build tool is **tsup** — configs in each package's `tsup.config.ts`
- SDK targets `es2020`, collector and MCP server target `node20`
- MCP server version and SDK version (`SDK_VERSION` constant in `sdk/src/index.ts`) should stay in sync

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIMESCOPE_PORT` | `9090` | WebSocket collector port |
| `RUNTIMESCOPE_HTTP_PORT` | `9091` | HTTP API port (for dashboard) |
| `RUNTIMESCOPE_BUFFER_SIZE` | `10000` | Max events in ring buffer |
