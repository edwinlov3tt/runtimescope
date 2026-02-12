# Runtime Profiler MCP Server — PRD

## Project Name
**RuntimeScope** — Runtime Observability MCP for Web Applications

## Overview
An MCP server that bridges live application runtime data (renders, state changes, network requests, console output, and performance metrics) into Claude Code, enabling AI-powered performance analysis and issue detection that goes beyond what Playwright or browser console can surface. Inspired by Limelight's approach for React Native, adapted for web applications (React/Next.js).

## Problem Statement
Standard debugging tools show symptoms — a slow page, a failed request, a console error. They don't reveal the **causal chains** underneath: a Zustand store updating 73 times in 12 seconds because every component subscribes to the entire store, or a modal component mounting on every list item and multiplying re-render cost. This data exists at runtime but has no pathway into an AI agent's context. RuntimeScope creates that pathway.

## Architecture

### Three-Layer System

```
┌─────────────────────┐
│   Browser / App      │
│  ┌───────────────┐   │
│  │ Runtime Probe  │───┼──── WebSocket ────┐
│  │ (SDK)         │   │                    │
│  └───────────────┘   │                    ▼
└─────────────────────┘          ┌──────────────────┐
                                 │ Collector Server  │
                                 │ (Node.js + SQLite)│
                                 └────────┬─────────┘
                                          │
                                          │ Query API
                                          ▼
                                 ┌──────────────────┐
                                 │ MCP Server        │
                                 │ (stdio transport) │
                                 └────────┬─────────┘
                                          │
                                          ▼
                                 ┌──────────────────┐
                                 │ Claude Code       │
                                 └──────────────────┘
```

### Layer 1: Runtime Probe (Browser SDK)

A lightweight TypeScript module injected into the running app during development. It monkey-patches core browser APIs to intercept runtime data and streams it over WebSocket to the collector.

**Data Captured:**

| Category | Method | What It Captures |
|----------|--------|------------------|
| Network | Patch `fetch` and `XMLHttpRequest` | URL, method, status, headers, request/response body size, timing (TTFB, total duration), GraphQL operation detection |
| Renders | React Profiler API + `__REACT_DEVTOOLS_GLOBAL_HOOK__` | Component name, render duration, render reason (props changed, state changed, context changed, parent re-rendered), render count per component |
| State | Subscribe to Zustand/Redux stores | Store name, state diff (old → new), mutation frequency, subscriber count |
| Console | Patch `console.*` methods | Level (log/warn/error/debug), message, stack trace, source file, timestamp |
| Performance | `PerformanceObserver` API | Long tasks (>50ms), layout shifts (CLS), largest contentful paint (LCP), first input delay (FID), resource timing |
| DOM | `MutationObserver` (optional) | Large DOM mutations, element count over time |

**SDK API:**

```typescript
import { RuntimeScope } from '@runtimescope/sdk';

RuntimeScope.connect({
  enabled: process.env.NODE_ENV === 'development',
  serverUrl: 'ws://localhost:9090',
  appName: 'my-marketing-tool',

  // Optional: pass store references for state tracking
  stores: {
    user: useUserStore,
    campaign: useCampaignStore,
  },

  // Optional: filter what gets captured
  captureNetwork: true,
  captureRenders: true,
  captureConsole: true,
  capturePerformance: true,

  // Optional: redact sensitive data
  redactHeaders: ['authorization', 'cookie', 'x-api-key'],
  redactBodyPaths: ['password', 'token', 'secret'],
});
```

**Key Implementation Details:**

- Fetch interception: wrap `window.fetch` and `XMLHttpRequest.prototype.open/send` — capture timing via `performance.now()` delta, clone response to read body without consuming it
- React render tracking: use the React Profiler `onRender` callback for timing, and `__REACT_DEVTOOLS_GLOBAL_HOOK__` for "why did this render" data. No Babel plugin needed — Limelight proves this works
- State store subscription: call `store.subscribe()` on Zustand stores, `store.subscribe()` on Redux stores — capture state snapshots and compute diffs with a lightweight diffing function
- Console patching: wrap `console.log/warn/error/info/debug/trace`, capture `new Error().stack` for source location, serialize arguments with circular reference handling
- Performance metrics: use `PerformanceObserver` with `entryTypes: ['longtask', 'largest-contentful-paint', 'layout-shift', 'first-input']`
- All events get a `sessionId`, `timestamp`, and `eventId` before streaming

### Layer 2: Collector Server

A Node.js process that receives the WebSocket stream, stores events in a ring buffer (last 10,000 events in memory) with optional SQLite persistence for session replay. Provides a query API consumed by the MCP server.

**Storage:**

- In-memory ring buffer for real-time queries (last 10K events)
- SQLite database for session persistence and historical comparison
- Events indexed by type, timestamp, and component/store name

**Query API (internal, consumed by MCP layer):**

```typescript
interface CollectorAPI {
  // Raw queries
  getEvents(filter: EventFilter): RuntimeEvent[];
  getNetworkRequests(since?: number): NetworkEvent[];
  getRenderEvents(component?: string, since?: number): RenderEvent[];
  getStateChanges(store?: string, since?: number): StateChangeEvent[];
  getConsoleMessages(level?: string, since?: number): ConsoleEvent[];
  getPerformanceMetrics(since?: number): PerformanceEvent[];

  // Aggregated analysis
  getRenderSummary(since?: number): ComponentRenderSummary[];
  getNetworkSummary(since?: number): NetworkSummary;
  getStateMutationFrequency(since?: number): StoreMutationSummary[];

  // Issue detection (pattern matching)
  detectIssues(): DetectedIssue[];

  // Session management
  getActiveSessions(): Session[];
  clearEvents(): void;
}
```

**Issue Detection Patterns (built-in):**

| Pattern | Detection Logic | Severity |
|---------|----------------|----------|
| Store thrashing | >10 state updates per second for same store | High |
| Unnecessary renders | Component re-renders with identical props (reference equality check) | Medium |
| Render cascade | Single state change triggers >20 component re-renders | High |
| N+1 network requests | Same endpoint called >5 times within 2 seconds | Medium |
| Slow requests | Network request duration >3 seconds | Medium |
| Failed requests | HTTP 4xx/5xx responses | High |
| Console error spam | Same error message repeated >5 times in 10 seconds | Medium |
| Long tasks | Main thread blocked >100ms | High |
| Large DOM mutations | >500 DOM nodes added in single mutation | Medium |
| Memory-leaking listeners | Event listeners growing without cleanup | Medium |

### Layer 3: MCP Server

A stdio-transport MCP server that exposes the collector's data as tools queryable by Claude Code.

**Tools:**

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `get_render_summary` | Component render counts, durations, and render reasons | `since_seconds`, `component`, `min_count` |
| `get_render_details` | Detailed render events for a specific component | `component`, `since_seconds`, `include_props_diff` |
| `get_state_changes` | State store mutations with diffs | `store`, `since_seconds`, `include_diff` |
| `get_state_mutation_frequency` | How often each store updates (thrashing detection) | `since_seconds` |
| `get_network_requests` | All captured network requests with timing | `since_seconds`, `url_pattern`, `status`, `method` |
| `get_network_issues` | Slow, failed, or duplicate requests | `since_seconds`, `min_duration_ms` |
| `get_console_messages` | Console output with stack traces | `level`, `since_seconds`, `search` |
| `get_performance_metrics` | Web Vitals and long task data | `since_seconds`, `metric_type` |
| `detect_issues` | Run all pattern detectors and return prioritized issues | `severity_filter` |
| `get_session_info` | Current connected apps and session metadata | — |
| `get_event_timeline` | Chronological view of all events (for causal chain analysis) | `since_seconds`, `event_types` |
| `clear_events` | Reset the event buffer (start fresh capture) | — |

**Tool Response Format:**

All tools return structured JSON with consistent shape:

```json
{
  "summary": "Found 847 renders across 23 components in the last 30s",
  "data": [ /* structured event data */ ],
  "issues": [ /* any detected anti-patterns */ ],
  "metadata": {
    "timeRange": { "from": 1234567890, "to": 1234567920 },
    "eventCount": 847,
    "sessionId": "abc-123"
  }
}
```

## Project Structure

```
runtimescope/
├── packages/
│   ├── sdk/                          # Browser SDK (Layer 1)
│   │   ├── src/
│   │   │   ├── index.ts              # Main entry, RuntimeScope.connect()
│   │   │   ├── interceptors/
│   │   │   │   ├── fetch.ts          # Fetch/XHR interception
│   │   │   │   ├── console.ts        # Console patching
│   │   │   │   ├── react-renders.ts  # React Profiler integration
│   │   │   │   ├── state-stores.ts   # Zustand/Redux subscription
│   │   │   │   └── performance.ts    # PerformanceObserver
│   │   │   ├── transport.ts          # WebSocket client
│   │   │   ├── redaction.ts          # Sensitive data filtering
│   │   │   ├── utils/
│   │   │   │   ├── diff.ts           # State diffing
│   │   │   │   ├── serialize.ts      # Circular-safe serialization
│   │   │   │   └── stack-trace.ts    # Stack trace parsing
│   │   │   └── types.ts              # Shared event types
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── collector/                    # Collector Server (Layer 2)
│   │   ├── src/
│   │   │   ├── index.ts              # Server entry, WebSocket + HTTP
│   │   │   ├── store.ts              # Ring buffer + SQLite storage
│   │   │   ├── query.ts              # Query API implementation
│   │   │   ├── issue-detector.ts     # Pattern matching engine
│   │   │   ├── aggregators.ts        # Summary/stats computation
│   │   │   └── types.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── mcp-server/                   # MCP Server (Layer 3)
│       ├── src/
│       │   ├── index.ts              # MCP server entry (stdio)
│       │   ├── tools/
│       │   │   ├── renders.ts        # Render analysis tools
│       │   │   ├── state.ts          # State change tools
│       │   │   ├── network.ts        # Network request tools
│       │   │   ├── console.ts        # Console message tools
│       │   │   ├── performance.ts    # Performance metric tools
│       │   │   ├── issues.ts         # Issue detection tools
│       │   │   └── session.ts        # Session management tools
│       │   └── types.ts
│       ├── package.json
│       └── tsconfig.json
│
├── package.json                      # Monorepo root (npm workspaces)
├── tsconfig.base.json
└── README.md
```

## Tech Stack

- **Language:** TypeScript throughout
- **Monorepo:** npm workspaces
- **SDK:** Vanilla TypeScript, no dependencies (keep bundle tiny)
- **Collector:** Node.js, `ws` (WebSocket server), `better-sqlite3` (persistence)
- **MCP Server:** `@modelcontextprotocol/sdk`, `zod` (input validation)
- **Transport:** stdio (MCP ↔ Claude Code), WebSocket (SDK ↔ Collector)
- **Build:** `tsup` for all packages

## Claude Code Integration

### Installation

```bash
claude mcp add runtimescope node /path/to/runtimescope/packages/mcp-server/dist/index.js
```

### Example Interaction

```
You: "My app feels slow on the campaign dashboard page. Do you see any issues?"

Claude Code calls: detect_issues()
Claude Code calls: get_render_summary(since_seconds: 30)
Claude Code calls: get_state_changes(since_seconds: 30)
Claude Code calls: get_network_issues(since_seconds: 30)

Claude Code responds:
"I found 3 issues in the last 30 seconds:

1. **Store thrashing (HIGH):** The `campaignStore` updated 47 times in 12s.
   Every CampaignCard component subscribes to the entire store. When any
   field changes, all 50 cards re-render. Fix: use Zustand selectors —
   `useCampaignStore(s => s.campaigns[id])` instead of `useCampaignStore()`.

2. **Hidden component mounting (MEDIUM):** Each CampaignCard mounts an
   EditCampaignModal on every render (312 total mounts). The modal is
   conditionally shown but always mounted. Fix: move the modal to the
   parent and render it once with the selected campaign ID.

3. **Duplicate API calls (MEDIUM):** GET /api/campaigns/metrics called
   50 times in 2s (once per card mount). Fix: lift the data fetch to the
   parent component or use React Query with a shared cache key."
```

## Milestones

### M1: Core Pipeline (MVP)
- SDK: fetch interception + console patching + WebSocket transport
- Collector: WebSocket server + in-memory ring buffer + basic query API
- MCP: `get_network_requests`, `get_console_messages`, `get_session_info`, `clear_events`
- Test: inject SDK into a sample React app, query via Claude Code

### M2: React Render Tracking
- SDK: React Profiler integration + render reason detection
- Collector: render aggregation + unnecessary render detection
- MCP: `get_render_summary`, `get_render_details`
- Issue detector: unnecessary renders, render cascades

### M3: State Store Observability
- SDK: Zustand + Redux store subscription + state diffing
- Collector: mutation frequency tracking
- MCP: `get_state_changes`, `get_state_mutation_frequency`
- Issue detector: store thrashing

### M4: Performance + Issue Detection
- SDK: PerformanceObserver integration (Web Vitals, long tasks)
- Collector: full issue detection engine (all patterns)
- MCP: `get_performance_metrics`, `detect_issues`, `get_event_timeline`
- SQLite persistence for session replay

### M5: Edwin's Extensions (Marketing-Specific)
- `dataLayer.push()` interception for GTM/GA4 event auditing
- `gtag()` call capture for conversion tracking validation
- UTM parameter validation on outbound link clicks
- Campaign parameter completeness checks
- MCP tools: `get_tracking_events`, `validate_gtm_config`, `audit_utm_params`

## Non-Goals (For Now)
- Production monitoring (dev-only for now)
- React Native support (web-first)
- Visual UI/dashboard (Claude Code IS the UI)
- Multi-user collaboration
- Historical trending across sessions

## Success Criteria
- SDK adds <5ms overhead to intercepted operations
- SDK bundle size <15KB gzipped
- Collector handles 1,000 events/second without dropped messages
- MCP tools respond in <500ms for queries over 10K events
- Claude Code can identify the root cause of a performance issue in a single prompt exchange using the tool responses
