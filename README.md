# RuntimeScope

Runtime profiling for web apps, piped directly into Claude Code via MCP.

RuntimeScope intercepts network requests, console output, state changes, component renders, Web Vitals, and database queries from your running app, streams them over WebSocket to a local collector, and exposes everything as 33 MCP tools — so Claude Code can see exactly what your app is doing at runtime.

```
Browser (SDK) --WebSocket--> [Collector + MCP Server] --stdio--> Claude Code
```

---

## Installation

### Prerequisites

- Node.js 20+
- npm 9+
- Claude Code CLI (`claude`)

### 1. Clone & Build

```bash
git clone https://github.com/edwinlov3tt/runtimescope runtime-profiler
cd runtime-profiler
npm install
npm run build
```

### 2. Register with Claude Code

```bash
claude mcp add runtimescope node packages/mcp-server/dist/index.js
```

This registers RuntimeScope as an MCP server. Claude Code will automatically start the collector when it launches.

### 3. Add the SDK to Your App

**Option A — npm install (recommended for projects in the same workspace)**

```bash
# From your app's directory
npm install ../runtime-profiler/packages/sdk
```

```typescript
import { RuntimeScope } from '@runtimescope/sdk';

RuntimeScope.connect({
  serverUrl: 'ws://localhost:9090',
  appName: 'my-app',
});
```

**Option B — Script tag (no build step)**

```html
<script src="path/to/runtime-profiler/packages/sdk/dist/index.global.js"></script>
<script>
  RuntimeScope.RuntimeScope.connect({
    serverUrl: 'ws://localhost:9090',
    appName: 'my-app',
  });
</script>
```

### 4. Verify Connection

Start your app, then ask Claude Code:

> "Use get_session_info to check if the SDK is connected."

---

## Claude Prompt

Copy and paste this prompt into Claude Code to give it full context on how to use RuntimeScope:

> You have access to RuntimeScope, a runtime profiling MCP server for web apps. It captures network requests, console output, state changes, component renders, Web Vitals, database queries, and more from the running app via a browser SDK.
>
> **Workflow:**
> 1. Start with `get_session_info` to verify the SDK is connected
> 2. Use `clear_events` before reproducing an issue for a clean capture
> 3. After the user reproduces the issue, run `detect_issues` to get prioritized problems with evidence and fix suggestions
> 4. Use `get_event_timeline` to trace the causal chain in chronological order
> 5. Drill into specifics with targeted tools: `get_network_requests` (filter by URL/status/method), `get_console_messages` (filter by level/search), `get_errors_with_source_context` (errors with source code), `get_state_snapshots` (state mutations), `get_render_profile` (component re-renders), `get_performance_metrics` (Web Vitals)
> 6. For API analysis: `get_api_catalog` discovers endpoints, `get_api_health` shows latency/error rates, `get_service_map` maps external service topology
> 7. For database analysis: `get_query_log` shows captured queries, `get_query_performance` detects N+1 and slow queries, `suggest_indexes` recommends indexes
> 8. Capture snapshots: `get_dom_snapshot` for current page HTML, `capture_har` for network export
> 9. Compare sessions: `compare_sessions` to detect regressions between test runs
> 10. DevOps: `get_dev_processes` for running processes, `get_port_usage` for port conflicts, `get_deploy_logs` for deployment history
>
> All tools return a consistent JSON envelope with `summary`, `data`, `issues`, and `metadata` fields. Use the `since_seconds` parameter on most tools to scope queries to a time window. The `detect_issues` tool is the best starting point — it runs all pattern detectors and returns prioritized results.

---

## MCP Tools (33)

### Core Runtime (12 tools)

| Tool | Description |
|------|-------------|
| `detect_issues` | **Start here.** Runs all pattern detectors — failed requests, slow requests, N+1, error spam, re-render storms, poor Web Vitals. Returns prioritized issues with evidence and fix suggestions |
| `get_event_timeline` | Chronological view of all events for tracing causal chains. Filter by `event_types` and `since_seconds` |
| `get_network_requests` | Fetch/XHR requests with URL, method, status, timing, headers, body sizes, GraphQL detection. Filter by `url_pattern`, `status`, `method` |
| `get_console_messages` | Console output (log/warn/error/info/debug/trace) with stack traces. Filter by `level`, `search` text |
| `get_state_snapshots` | Zustand/Redux state snapshots with diffs, action history, and thrashing detection. Filter by `store_name` |
| `get_render_profile` | React component render counts, velocity, durations, and causes. Flags suspicious components. Filter by `component_name` |
| `get_performance_metrics` | Web Vitals (LCP, FCP, CLS, TTFB, FID, INP) with ratings. Filter by `metric_name` |
| `get_dom_snapshot` | Live DOM capture from the running app. Returns HTML, URL, viewport, element count |
| `capture_har` | Export network requests as HAR 1.2 JSON (Chrome DevTools compatible) |
| `get_errors_with_source_context` | Console errors with parsed stack traces and source code context fetched from dev server |
| `get_session_info` | Check SDK connection status and event statistics |
| `clear_events` | Reset event buffer and session tracking for a clean capture |

### API Discovery (5 tools)

| Tool | Description |
|------|-------------|
| `get_api_catalog` | Discover all API endpoints, auto-grouped by service. Shows normalized paths, call counts, auth patterns. Filter by `service`, `min_calls` |
| `get_api_health` | Health metrics per endpoint: success rate, p50/p95 latency, error codes. Filter by `endpoint`, `since_seconds` |
| `get_api_documentation` | Generate markdown API docs from observed traffic. Filter by `service` |
| `get_service_map` | Topology map of external services with detected platforms (Supabase, Stripe, Vercel, etc.) |
| `get_api_changes` | Compare API endpoints between two sessions — added, removed, modified |

### Database (7 tools)

| Tool | Description |
|------|-------------|
| `get_query_log` | Captured SQL queries with timing, rows, source ORM. Filter by `table`, `min_duration_ms`, `search` |
| `get_query_performance` | Aggregated query stats with N+1 and slow query detection |
| `get_schema_map` | Database schema introspection: tables, columns, types, foreign keys, indexes |
| `get_table_data` | Read rows from a table with pagination, WHERE, and ORDER BY |
| `modify_table_data` | Insert/update/delete rows (localhost only, safety guarded) |
| `get_database_connections` | List configured database connections with health status |
| `suggest_indexes` | Index suggestions based on captured query patterns, with `CREATE INDEX` SQL |

### Process Monitor (3 tools)

| Tool | Description |
|------|-------------|
| `get_dev_processes` | List running dev processes (Next.js, Vite, Docker, etc.) with PID, port, memory, CPU. Filter by `type`, `project` |
| `kill_process` | Terminate a dev process by PID (SIGTERM or SIGKILL) |
| `get_port_usage` | Show which processes are bound to which ports. Filter by `port` |

### Infrastructure (4 tools)

| Tool | Description |
|------|-------------|
| `get_deploy_logs` | Deployment history from Vercel, Cloudflare, Railway. Filter by `platform`, `deploy_id` |
| `get_runtime_logs` | Runtime logs from deployment platforms. Filter by `level`, `since_seconds` |
| `get_build_status` | Current deployment status per connected platform |
| `get_infra_overview` | Infrastructure overview combining config with auto-detection from network traffic |

### Session Comparison (2 tools)

| Tool | Description |
|------|-------------|
| `compare_sessions` | Compare two sessions: API latency, render counts, Web Vitals, query performance. Shows regressions and improvements |
| `get_session_history` | List past sessions with build metadata and event counts |

See [docs/TOOLS.md](docs/TOOLS.md) for the full parameter reference with types, defaults, and example prompts.

---

## Detected Patterns

`detect_issues` runs these pattern detectors automatically:

| Pattern | Trigger | Severity |
|---------|---------|----------|
| Failed requests | HTTP 4xx/5xx | HIGH (5xx) / MEDIUM (4xx) |
| Slow requests | Duration > 3s | MEDIUM |
| N+1 requests | Same endpoint > 5x in 2s | MEDIUM |
| Console error spam | Same error > 5x in 10s | MEDIUM |
| High error rate | > 30% of console messages are errors | HIGH |
| Excessive re-renders | Component render velocity > 4/sec | MEDIUM |
| Large state updates | State snapshot > 100KB | MEDIUM |
| Poor Web Vitals | Any metric rated "poor" | HIGH (LCP/CLS) / MEDIUM (others) |

---

## SDK Configuration

```typescript
RuntimeScope.connect({
  serverUrl: 'ws://localhost:9090',  // Collector WebSocket URL
  appName: 'my-app',                // Identifies this app in session info

  // Capture toggles
  captureNetwork: true,              // Intercept fetch (default: true)
  captureXhr: true,                  // Intercept XMLHttpRequest (default: true)
  captureConsole: true,              // Intercept console.* (default: true)
  captureBody: false,                // Capture request/response bodies (default: false)
  maxBodySize: 65536,                // Max body size in bytes (default: 64KB)
  capturePerformance: false,         // Web Vitals via web-vitals (default: false)
  captureRenders: false,             // React render tracking (default: false)

  // State tracking
  stores: {},                        // Zustand/Redux store refs (default: {})

  // Privacy
  redactHeaders: ['authorization', 'cookie', 'set-cookie'],
  beforeSend: (event) => event,      // Filter/modify events before sending

  // Build metadata (for session comparison)
  buildMeta: {
    gitCommit: 'abc1234',
    gitBranch: 'main',
  },

  // Transport tuning
  batchSize: 50,                     // Events per batch (default: 50)
  flushIntervalMs: 100,              // Batch flush interval (default: 100ms)
});
```

---

## Project Structure

```
packages/
  sdk/           # Browser SDK (zero deps, ~3KB gzipped)
  collector/     # WebSocket receiver + ring buffer + issue detection + engines
  mcp-server/    # MCP stdio server with 33 tools
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIMESCOPE_PORT` | `9090` | WebSocket collector port |
| `RUNTIMESCOPE_HTTP_PORT` | `9091` | HTTP API port (for dashboard) |
| `RUNTIMESCOPE_BUFFER_SIZE` | `10000` | Max events in ring buffer |

## License

MIT
