# Architecture Overview

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| SDK (Browser) | TypeScript, zero deps | Monkey-patches fetch/XHR/console/React Profiler/Zustand/Redux in the browser |
| SDK Transport | WebSocket (native browser API) | Streams events with batching, reconnection, offline queue |
| Collector | Node.js, `ws` library | WebSocket server + ring buffer + issue detection engine |
| Server SDK | TypeScript, `ws` | Node.js instrumentation (Prisma, pg, Knex, Drizzle, MySQL2, SQLite) |
| Dashboard | React 19, Vite, Zustand, Tailwind CSS | Real-time monitoring UI with PM features |
| MCP Server | `@modelcontextprotocol/sdk`, `zod` | stdio transport MCP server exposing 44 tools to Claude Code |
| Build | `tsup`, TypeScript 5.4+ | Bundling for all 6 packages (CJS/ESM/IIFE for SDK) |
| Monorepo | npm workspaces | 6 packages under `packages/` |
| Tests | Vitest | 444 tests across 32 files |

## Directory Structure

```
runtimescope/
├── packages/
│   ├── sdk/                    # Browser SDK (@runtimescope/sdk)
│   │   ├── src/
│   │   │   ├── index.ts        # RuntimeScope.connect() entry
│   │   │   ├── transport.ts    # WebSocket transport with batching
│   │   │   ├── types.ts        # SDK-side type definitions
│   │   │   ├── interceptors/
│   │   │   │   ├── fetch.ts    # fetch() monkey-patch
│   │   │   │   ├── xhr.ts      # XMLHttpRequest monkey-patch
│   │   │   │   ├── console.ts  # console.* monkey-patch
│   │   │   │   ├── state-stores.ts   # Zustand/Redux subscription
│   │   │   │   ├── performance.ts    # PerformanceObserver (Web Vitals)
│   │   │   │   └── react-renders.ts  # React Profiler hook
│   │   │   └── utils/
│   │   └── package.json
│   │
│   ├── collector/              # Event collector (@runtimescope/collector)
│   │   ├── src/
│   │   │   ├── index.ts        # Exports
│   │   │   ├── server.ts       # WebSocket server, connection management, command dispatch
│   │   │   ├── store.ts        # EventStore (ring buffer + query methods)
│   │   │   ├── ring-buffer.ts  # Generic circular buffer (10K capacity)
│   │   │   ├── issue-detector.ts  # 8 pattern detectors
│   │   │   └── types.ts        # Canonical type definitions
│   │   └── package.json
│   │
│   └── mcp-server/             # MCP server (@runtimescope/mcp-server)
│       ├── src/
│       │   ├── index.ts        # Main: starts collector + MCP, registers tools
│       │   └── tools/
│       │       ├── network.ts      # get_network_requests
│       │       ├── console.ts      # get_console_messages
│       │       ├── session.ts      # get_session_info, clear_events
│       │       ├── issues.ts       # detect_issues
│       │       ├── timeline.ts     # get_event_timeline
│       │       ├── state.ts        # get_state_changes
│       │       ├── renders.ts      # get_render_summary
│       │       ├── performance.ts  # get_performance_metrics
│       │       ├── dom-snapshot.ts # capture_dom_snapshot
│       │       ├── har.ts         # export_har
│       │       └── errors.ts      # get_errors
│       └── package.json
│
├── docs/                       # PRD and design documents
├── .claude/                    # Documentation system
├── package.json                # Monorepo root
└── README.md
```

## Data Flow

```
Browser (SDK) --WebSocket--> Collector --in-process--> MCP Server --stdio--> Claude Code
```

1. SDK patches browser APIs (fetch, XHR, console, React Profiler, state stores, PerformanceObserver)
2. Intercepted events are batched (default: 50 events or 100ms interval) and sent via WebSocket
3. Collector receives events and stores them in a 10K ring buffer (in-memory, no persistence yet)
4. MCP server runs in the same process as the collector, sharing the EventStore
5. Claude Code queries tools via stdio MCP protocol

## Key Components

### SDK (`packages/sdk`)
- **Purpose**: Lightweight browser instrumentation (zero production deps)
- **Entry**: `RuntimeScope.connect(config)` / `RuntimeScope.disconnect()`
- **Transport**: Batched WebSocket with exponential backoff reconnection, offline queue (1K events)
- **Interceptors**: fetch, XHR, console, state stores (Zustand/Redux), React Profiler, Performance Observer
- **Privacy**: Header redaction, configurable `beforeSend` filter

### Collector (`packages/collector`)
- **Purpose**: Receives WebSocket streams, stores events, runs analysis
- **Storage**: In-memory ring buffer (10K events, FIFO eviction)
- **Issue Detection**: 8 patterns — failed requests, slow requests, N+1, console error spam, high error rate, excessive re-renders, large state updates, poor Web Vitals
- **Command Protocol**: Bidirectional — can send commands to SDK (e.g., capture DOM snapshot)

### MCP Server (`packages/mcp-server`)
- **Purpose**: Exposes collector data as MCP tools for Claude Code
- **Tools**: 11 registered tools (see TOOLS.md)
- **Lifecycle**: Starts collector on launch, kills stale processes on same port, graceful shutdown on stdin close

## Environment Variables

| Variable | Purpose | Required | Default |
|----------|---------|----------|---------|
| `RUNTIMESCOPE_PORT` | WebSocket collector port | No | `9090` |
| `RUNTIMESCOPE_BUFFER_SIZE` | Max events in ring buffer | No | `10000` |

## Event Types

| Type | Source Interceptor | Data Captured |
|------|-------------------|---------------|
| `network` | fetch, XHR | URL, method, status, headers, timing, body (opt), GraphQL detection |
| `console` | console.* | Level, message, args, stack trace, source file |
| `session` | SDK init | App name, connection time, SDK version |
| `state` | Zustand/Redux | Store ID, library, phase, state snapshot, diff |
| `render` | React Profiler | Component profiles (name, count, duration, velocity, cause) |
| `dom_snapshot` | On-demand (command) | Full HTML, viewport, scroll, element count |
| `performance` | PerformanceObserver | Web Vitals (LCP, FCP, CLS, TTFB, FID, INP) with ratings |

## WebSocket Protocol

| Message Type | Direction | Purpose |
|-------------|-----------|---------|
| `handshake` | SDK -> Collector | Session registration (appName, sdkVersion, sessionId) |
| `event` | SDK -> Collector | Batched event payload |
| `heartbeat` | SDK -> Collector | Keep-alive |
| `command` | Collector -> SDK | Server-initiated commands (e.g., capture DOM) |
| `command_response` | SDK -> Collector | Response to server commands |
