# RuntimeScope MCP Tools Reference

33 tools available. All tools return a consistent JSON envelope:

```json
{
  "summary": "Human-readable summary of results",
  "data": [ /* structured event data */ ],
  "issues": [ /* any detected anti-patterns */ ],
  "metadata": {
    "timeRange": { "from": 1234567890, "to": 1234567920 },
    "eventCount": 847,
    "sessionId": "abc-123"
  }
}
```

---

# Core Runtime Tools

## detect_issues

**Start here.** Runs all pattern detectors against captured runtime data and returns prioritized issues.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | all events | Analyze events from the last N seconds |
| `severity_filter` | `"high"` \| `"medium"` \| `"low"` | all | Only return issues at this severity or above |

**Detected Patterns:**

| Pattern | Trigger | Severity |
|---------|---------|----------|
| Failed requests | HTTP 4xx/5xx responses | HIGH (5xx) / MEDIUM (4xx) |
| Slow requests | Duration > 3 seconds | MEDIUM |
| N+1 requests | Same endpoint called > 5 times within 2 seconds | MEDIUM |
| Console error spam | Same error message repeated > 5 times in 10 seconds | MEDIUM |
| High error rate | > 30% of console messages are errors | HIGH |
| Excessive re-renders | Component render velocity > 4/sec | MEDIUM |
| Large state updates | State snapshot > 100KB serialized | MEDIUM |
| Poor Web Vitals | Any metric rated "poor" | HIGH (LCP/CLS) / MEDIUM (others) |

Each issue includes `evidence` (specific data points) and `suggestion` (what to fix).

**Example prompt:** *"My app feels slow. Run detect_issues and tell me what's wrong."*

---

## get_event_timeline

Chronological view of ALL events interleaved by timestamp. Essential for understanding causal chains.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | 60 | Only return events from the last N seconds |
| `event_types` | array of event types | all | Filter by event type (`network`, `console`, `session`, `state`, `render`, `performance`, `dom_snapshot`) |
| `limit` | number | 200 (max 1000) | Max events to return |

Events are returned in chronological order (oldest first), so you can trace sequences like: API call failed → error logged → state update → re-render.

**Example prompt:** *"Show me the event timeline from the last 30 seconds so I can see what happened in order."*

---

## get_network_requests

All captured fetch and XHR requests with URL, method, status, timing, headers, body sizes, and GraphQL operation detection.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | all | Only return requests from the last N seconds |
| `url_pattern` | string | none | Filter by URL substring match |
| `status` | number | none | Filter by HTTP status code |
| `method` | string | none | Filter by HTTP method (GET, POST, etc.) |

**Inline issue detection:** Flags failed requests (4xx/5xx), slow requests (>3s), and N+1 patterns.

**Example prompt:** *"Show me all failed API requests in the last 60 seconds."*

---

## get_console_messages

Captured console output (log, warn, error, info, debug, trace) with message text, serialized args, and stack traces for errors.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `level` | `"log"` \| `"warn"` \| `"error"` \| `"info"` \| `"debug"` \| `"trace"` | all | Filter by console level |
| `since_seconds` | number | all | Only return messages from the last N seconds |
| `search` | string | none | Search message text (case-insensitive substring match) |

**Inline issue detection:** Flags error spam (same error >5x in 10s).

**Example prompt:** *"Show me all console errors from the last 2 minutes."*

---

## get_state_snapshots

State store snapshots and diffs from Zustand or Redux stores. Shows state changes over time with action history and mutation frequency.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `store_name` | string | none | Filter by store name/ID |
| `since_seconds` | number | all | Only return events from the last N seconds |

Detects store thrashing (>10 updates/sec in a 1-second window). Requires `stores` config option in the SDK.

**Example prompt:** *"Show me all state changes in the auth store from the last 30 seconds."*

---

## get_render_profile

React component render profiles showing render counts, velocity, durations, and render causes. Flags suspicious components.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `component_name` | string | none | Filter by component name (substring match) |
| `since_seconds` | number | all | Only return events from the last N seconds |

Requires `captureRenders: true` in the SDK config. `actualDuration` requires React dev mode or `<Profiler>`.

**Example prompt:** *"Which components are re-rendering the most? Show me the render profile."*

---

## get_performance_metrics

Web Vitals performance metrics (LCP, FCP, CLS, TTFB, FID, INP) with values and ratings based on web.dev thresholds.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `metric_name` | `"LCP"` \| `"FCP"` \| `"CLS"` \| `"TTFB"` \| `"FID"` \| `"INP"` | all | Filter by specific metric |
| `since_seconds` | number | all | Only return metrics from the last N seconds |

Requires `capturePerformance: true` in the SDK config.

**Example prompt:** *"What are my Core Web Vitals scores? Is anything rated poor?"*

---

## get_dom_snapshot

Capture a live DOM snapshot from the running web app. Returns the full HTML along with URL, viewport, scroll position, and element count.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_size` | number | 500000 | Maximum HTML size in bytes (larger pages truncated) |

Sends a command to the SDK via the bidirectional WebSocket channel. Requires an active SDK session. 10-second timeout.

**Example prompt:** *"Capture the current DOM so I can see what the page looks like."*

---

## capture_har

Export captured network requests as a HAR (HTTP Archive) 1.2 JSON. Standard format compatible with Chrome DevTools, Charles Proxy, etc.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | all | Only include requests from the last N seconds |

Includes request/response headers, body content (if `captureBody` enabled in SDK), and timing data.

**Example prompt:** *"Export a HAR file of all the network requests from my last test."*

---

## get_errors_with_source_context

Console errors with parsed stack traces and surrounding source code lines fetched from the dev server.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | all | Only return errors from the last N seconds |
| `fetch_source` | boolean | true | Whether to fetch source files for context lines |
| `context_lines` | number | 5 | Lines to show above and below the error line |

Parses Chrome/V8 and Firefox stack trace formats. Fetches source from localhost URLs (skips node_modules). Max 50 errors, 2s timeout per file.

**Example prompt:** *"Show me all errors with the source code around where they happened."*

---

## get_session_info

Check if the SDK is connected and see overall event statistics.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *(none)* | — | — | — |

Returns connected sessions with app name, SDK version, connection time, event count, and connection status.

**Example prompt:** *"Is the RuntimeScope SDK connected to my app?"*

---

## clear_events

Reset the event buffer and session tracking to start a fresh capture.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *(none)* | — | — | — |

Clears all events from the 10,000-event ring buffer and all session records.

**Example prompt:** *"Clear all events so I can do a clean test of this workflow."*

---

# API Discovery Tools

## get_api_catalog

Discover all API endpoints the app is communicating with, auto-grouped by service. Shows normalized paths, call counts, auth patterns, and inferred response shapes.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `service` | string | none | Filter by service name (e.g. "Supabase", "Your API") |
| `min_calls` | number | none | Only show endpoints with at least N calls |

Auto-detects services by base URL and groups endpoints under them. Normalizes path parameters (e.g., `/users/123` → `/users/:id`).

**Example prompt:** *"Show me all the API endpoints my app is calling, grouped by service."*

---

## get_api_health

Get health metrics for discovered API endpoints: success rate, latency percentiles (p50/p95), error rates and error codes.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `endpoint` | string | none | Filter by endpoint path substring |
| `since_seconds` | number | all | Only consider requests from the last N seconds |

Flags endpoints with >50% error rate or p95 latency >5s.

**Example prompt:** *"Which API endpoints have the highest error rates?"*

---

## get_api_documentation

Generate API documentation from observed network traffic. Shows endpoints, auth, latency, and inferred response shapes in markdown format.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `service` | string | none | Generate docs for a specific service only |

Returns raw markdown (not the standard JSON envelope). Built from actual traffic, not specs.

**Example prompt:** *"Generate API docs from the network traffic you've observed."*

---

## get_service_map

Get a topology map of all external services the app communicates with, including detected platforms (Supabase, Vercel, Stripe, etc.), call counts, and latency.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *(none)* | — | — | — |

Auto-detects known platforms by URL patterns. Shows auth type, endpoint count, error rate, and average latency per service.

**Example prompt:** *"What external services is my app talking to?"*

---

## get_api_changes

Compare API endpoints between two sessions. Detects added/removed endpoints and response shape changes.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `session_a` | string | **required** | First session ID |
| `session_b` | string | **required** | Second session ID |

Useful for detecting API drift between deploys or code changes.

**Example prompt:** *"Compare the APIs called in session A vs session B — did anything change?"*

---

# Database Tools

## get_query_log

Get captured database queries with SQL, timing, rows returned, and source ORM. Requires server-side SDK instrumentation.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | all | Only return queries from the last N seconds |
| `table` | string | none | Filter by table name |
| `min_duration_ms` | number | none | Only return queries slower than N ms |
| `search` | string | none | Search query text |

Flags query errors and slow queries (>500ms).

**Example prompt:** *"Show me all database queries that took over 100ms."*

---

## get_query_performance

Get aggregated database query performance stats: avg/max/p95 duration, call counts, N+1 detection, and slow query analysis.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | all | Analyze queries from the last N seconds |

Groups queries by normalized pattern and shows top 20 by frequency. Detects N+1 queries (same pattern repeated rapidly) and slow queries.

**Example prompt:** *"Are there any N+1 query patterns or slow queries in my app?"*

---

## get_schema_map

Get the full database schema: tables, columns, types, foreign keys, and indexes. Requires a configured database connection.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `connection_id` | string | first available | Connection ID |
| `table` | string | none | Introspect a specific table only |

**Example prompt:** *"Show me the database schema for the users table."*

---

## get_table_data

Read rows from a database table with pagination. Requires a configured database connection.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `table` | string | **required** | Table name to read |
| `connection_id` | string | first available | Connection ID |
| `limit` | number | 50 (max 1000) | Max rows |
| `offset` | number | 0 | Pagination offset |
| `where` | string | none | SQL WHERE clause (without WHERE keyword) |
| `order_by` | string | none | SQL ORDER BY clause (without ORDER BY keyword) |

**Example prompt:** *"Show me the last 10 rows from the orders table."*

---

## modify_table_data

Insert, update, or delete rows in a LOCAL DEV database. Safety guarded: localhost only, WHERE required for update/delete, max 100 affected rows, wrapped in transaction.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `table` | string | **required** | Table name |
| `operation` | `"insert"` \| `"update"` \| `"delete"` | **required** | Operation type |
| `connection_id` | string | first available | Connection ID |
| `data` | object | none | Row data (for insert/update) |
| `where` | string | none | WHERE clause (required for update/delete) |

**Example prompt:** *"Insert a test user into the users table."*

---

## get_database_connections

List all configured database connections with their health status.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *(none)* | — | — | — |

**Example prompt:** *"Which database connections are configured and are they healthy?"*

---

## suggest_indexes

Analyze captured database queries and suggest missing indexes based on WHERE/ORDER BY columns and query performance.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | all | Analyze queries from the last N seconds |

Returns suggested `CREATE INDEX` SQL statements with estimated impact (high/medium/low) and the query pattern that triggered the suggestion.

**Example prompt:** *"Based on the queries you've seen, what indexes should I add?"*

---

# Process Monitor Tools

## get_dev_processes

List all running dev processes (Next.js, Vite, Prisma, Docker, databases, etc.) with PID, port, memory, and CPU usage.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | string | none | Filter by process type (next, vite, docker, postgres, etc.) |
| `project` | string | none | Filter by project name |

Detects orphaned processes, high memory/CPU usage, and port conflicts.

**Example prompt:** *"What dev processes are running on my machine right now?"*

---

## kill_process

Terminate a dev process by PID. Default signal is SIGTERM; use SIGKILL for force kill.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pid` | number | **required** | Process ID to kill |
| `signal` | `"SIGTERM"` \| `"SIGKILL"` | SIGTERM | Signal to send |

**Example prompt:** *"Kill the orphaned Next.js process on PID 12345."*

---

## get_port_usage

Show which dev processes are bound to which ports. Useful for debugging port conflicts.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `port` | number | none | Filter by specific port number |

**Example prompt:** *"What's running on port 3000?"*

---

# Infrastructure Tools

## get_deploy_logs

Get deployment history from connected platforms (Vercel, Cloudflare, Railway). Shows build status, branch, commit, and timing.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project` | string | "default" | Project name |
| `platform` | string | none | Filter by platform (vercel, cloudflare, railway) |
| `deploy_id` | string | none | Get details for a specific deployment |

**Example prompt:** *"Show me the last few deployments on Vercel."*

---

## get_runtime_logs

Get runtime error/info logs from connected deployment platforms.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project` | string | "default" | Project name |
| `platform` | string | none | Filter by platform |
| `level` | string | none | Filter by log level (info, warn, error) |
| `since_seconds` | number | all | Only return logs from the last N seconds |

**Example prompt:** *"Show me runtime errors from my Vercel deployment."*

---

## get_build_status

Get the current deployment status for each connected platform.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project` | string | "default" | Project name |

**Example prompt:** *"What's the current build status across all my deploy targets?"*

---

## get_infra_overview

Overview of which platforms a project uses, combining explicit configuration with auto-detection from network traffic.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project` | string | none | Project name |

**Example prompt:** *"Give me an overview of the infrastructure my app is using."*

---

# Session Comparison Tools

## compare_sessions

Compare two sessions: render counts, API latency, errors, Web Vitals, and query performance. Shows regressions and improvements.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `session_a` | string | **required** | First session ID (baseline) |
| `session_b` | string | **required** | Second session ID (comparison) |
| `project` | string | "default" | Project name |

Compares endpoint latency, component render counts, Web Vitals, and query durations. Classifies each delta as regression, improvement, or unchanged.

**Example prompt:** *"Compare my last two sessions — did anything get slower?"*

---

## get_session_history

List past sessions with build metadata, event counts, and timestamps. Requires SQLite persistence.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project` | string | "default" | Project name |
| `limit` | number | 20 | Max sessions to return |

**Example prompt:** *"Show me the session history for this project."*

---

# Recommended Workflow

1. **Check connection:** `get_session_info` — verify the SDK is connected
2. **Clear slate:** `clear_events` — start fresh before reproducing the issue
3. **Reproduce the issue** in the browser
4. **Detect issues:** `detect_issues` — get prioritized problems with evidence and fix suggestions
5. **Dig deeper:** `get_event_timeline` — trace the causal chain in chronological order
6. **Investigate specifics:** Use targeted tools:
   - `get_network_requests` — filter by URL, status, method
   - `get_console_messages` — filter by level, search text
   - `get_errors_with_source_context` — see error source code
   - `get_state_snapshots` — inspect state mutations
   - `get_render_profile` — find excessive re-renders
   - `get_performance_metrics` — check Web Vitals
7. **API analysis:** `get_api_catalog` to discover endpoints, `get_api_health` for latency/error rates, `get_service_map` for topology
8. **Database analysis:** `get_query_log` for captured queries, `get_query_performance` for N+1 and slow query detection, `suggest_indexes` for optimization
9. **Capture snapshots:** `get_dom_snapshot` to see the page, `capture_har` for full network export
10. **Compare sessions:** `compare_sessions` to detect regressions between test runs
11. **DevOps:** `get_dev_processes` to check running processes, `get_deploy_logs` for deployment history

## SDK Configuration

```typescript
RuntimeScope.connect({
  serverUrl: 'ws://localhost:9090',
  appName: 'my-app',
  captureNetwork: true,      // Fetch interception (default: true)
  captureXhr: true,           // XHR interception (default: true)
  captureConsole: true,       // Console interception (default: true)
  captureBody: false,         // Request/response body capture (default: false)
  maxBodySize: 65536,         // Max body size in bytes (default: 64KB)
  capturePerformance: false,  // Web Vitals (default: false)
  captureRenders: false,      // React render tracking (default: false)
  stores: {},                 // Zustand/Redux store refs (default: {})
  beforeSend: (event) => event,  // Filter/modify events before sending
  redactHeaders: ['authorization', 'cookie'],
});
```

## SDK Data Captured

| Category | What It Captures |
|----------|------------------|
| Network (fetch) | URL, method, status, headers (redacted), request/response body, duration, TTFB, GraphQL operation, error phase |
| Network (XHR) | Same as fetch, with `source: 'xhr'` |
| Console | Level, message text, serialized args, stack trace (errors/trace only) |
| State | Store ID, library (Zustand/Redux), phase (init/update), state, diff, action |
| Renders | Component name, render count, velocity, duration, cause, suspicious flag |
| Performance | LCP, FCP, CLS, TTFB, FID, INP with ratings |
| DOM Snapshot | Full HTML, URL, viewport, scroll position, element count |
| Database | SQL query, duration, rows returned/affected, operation type, tables accessed, source ORM |
| Session | App name, SDK version, connection time |

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `RUNTIMESCOPE_PORT` | 9090 | WebSocket collector port |
| `RUNTIMESCOPE_BUFFER_SIZE` | 10000 | Max events in ring buffer |
