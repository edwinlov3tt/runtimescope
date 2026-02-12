# RuntimeScope — Complete Product Requirements Document (v2)

## Product Name
**RuntimeScope** — The Developer Observability Hub

## One-Liner
Everything your app is doing — network, renders, state, queries, processes, infrastructure — in one place, accessible to both you and your AI coding agent.

---

## Problem Statement

Building modern web apps means juggling a fragmented observability stack. Right now, understanding what your app is actually doing requires:

- **Chrome DevTools** for network requests and console output
- **React DevTools** for component renders and state
- **pgAdmin / Supabase dashboard** for database queries and schema
- **Vercel dashboard** for deploy logs and runtime errors
- **Cloudflare dashboard** for worker logs and analytics
- **Railway dashboard** for service logs
- **Activity Monitor / Task Manager** to find which dev servers are still running
- **Postman / Insomnia** to test and document API endpoints

Each tool shows one slice. None of them talk to each other. None of them are accessible to your AI coding agent. When your app is slow, you context-switch across 7 tabs trying to piece together what happened. When Claude Code tries to help debug, it can't see any of this data.

RuntimeScope replaces that workflow with a single local-first observability hub — a dashboard and MCP server that captures runtime data, discovers APIs, monitors database queries, tracks background processes, and connects to your deployment infrastructure. Everything is scoped by project, stored locally for privacy, and queryable by Claude Code (or any MCP-compatible AI agent) through a unified tool interface.

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      YOUR APPLICATIONS                       │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Next.js  │  │ CF Worker│  │ Express  │  │ Vite App │    │
│  │ + SDK    │  │ + SDK    │  │ + SDK    │  │ + SDK    │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       │              │              │              │          │
└───────┼──────────────┼──────────────┼──────────────┼─────────┘
        │              │              │              │
        └──────────────┴──────┬───────┴──────────────┘
                              │ WebSocket (port 9090)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    RUNTIMESCOPE CORE                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Collector Server                         │   │
│  │  ┌────────────┐  ┌─────────────┐  ┌──────────────┐  │   │
│  │  │ Ring Buffer│  │ SQLite Store│  │ Issue Detect  │  │   │
│  │  │ (10K evts) │  │ (persistent)│  │ (patterns)   │  │   │
│  │  └────────────┘  └─────────────┘  └──────────────┘  │   │
│  │  ┌────────────┐  ┌─────────────┐  ┌──────────────┐  │   │
│  │  │ API Catalog│  │ Query Mon.  │  │ Process Mon. │  │   │
│  │  │ (discovery)│  │ (DB queries)│  │ (dev servers)│  │   │
│  │  └────────────┘  └─────────────┘  └──────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
│                              │                               │
│              ┌───────────────┼───────────────┐               │
│              ▼               ▼               ▼               │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐    │
│  │ Dashboard UI │ │ MCP Server   │ │ Infra Connector  │    │
│  │ (Tauri/Web)  │ │ (stdio)      │ │ (MCP Hub)        │    │
│  └──────────────┘ └──────────────┘ └──────────────────┘    │
│                                             │                │
│                              ┌──────────────┼────────┐      │
│                              ▼              ▼        ▼      │
│                         ┌────────┐  ┌──────────┐ ┌──────┐  │
│                         │Vercel  │  │Cloudflare│ │Rail- │  │
│                         │API/MCP │  │API/MCP   │ │way   │  │
│                         └────────┘  └──────────┘ └──────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Database Connector                       │   │
│  │  PostgreSQL · SQLite · MySQL · Supabase · PlanetScale │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Cloud Sync (Optional)                    │   │
│  │  Cloudflare D1 (events) · R2 (session snapshots)     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Layer 1: Runtime Probe (Browser/Server SDK)

A lightweight TypeScript module injected into the running app during development. Monkey-patches core APIs to intercept runtime data and streams it over WebSocket to the collector.

**Data Captured:**

| Category | Method | What It Captures |
|----------|--------|------------------|
| Network (REST) | Patch `fetch` and `XMLHttpRequest` | URL, method, status, headers, request/response body (with size), timing (TTFB, total duration), content-type detection, auth pattern detection |
| Network (GraphQL) | Detect GraphQL payloads in fetch | Operation name, type (query/mutation/subscription), fields, depth, complexity score |
| Renders | React Profiler API + `__REACT_DEVTOOLS_GLOBAL_HOOK__` | Component name, render duration, render reason (props/state/context/parent), render count, props diff |
| State | Subscribe to Zustand/Redux stores | Store name, state diff (old → new), mutation frequency, subscriber count |
| Console | Patch `console.*` methods | Level (log/warn/error/debug), message, stack trace, source file, timestamp |
| Performance | `PerformanceObserver` API | Long tasks (>50ms), layout shifts (CLS), LCP, FID, resource timing |
| DOM | `MutationObserver` (optional) | Large DOM mutations, element count over time |
| Database (server-side) | ORM instrumentation hooks | SQL query text, params (redacted), duration, rows returned, table(s) touched |
| GTM/GA4 | Patch `dataLayer.push()` and `gtag()` | Event name, parameters, conversion tracking, UTM validation |

**SDK API:**

```typescript
import { RuntimeScope } from '@runtimescope/sdk';

RuntimeScope.connect({
  enabled: process.env.NODE_ENV === 'development',
  serverUrl: 'ws://localhost:9090',
  appName: 'adspec',

  // Optional: pass store references for state tracking
  stores: {
    campaign: useCampaignStore,
    ui: useUIStore,
  },

  // Feature toggles
  captureNetwork: true,
  captureRenders: true,
  captureConsole: true,
  capturePerformance: true,
  captureDatabase: true,      // Requires server-side SDK
  captureTracking: true,      // GTM/GA4 interception

  // Build metadata (for session diffing)
  buildMeta: {
    gitCommit: process.env.NEXT_PUBLIC_GIT_SHA,
    gitBranch: process.env.NEXT_PUBLIC_GIT_BRANCH,
    buildTime: process.env.NEXT_PUBLIC_BUILD_TIME,
    deployId: process.env.VERCEL_DEPLOYMENT_ID,
  },

  // Privacy controls
  redactHeaders: ['authorization', 'cookie', 'x-api-key'],
  redactBodyPaths: ['password', 'token', 'secret'],
  redactQueryParams: true,    // Redact SQL bind params by default
});
```

**Server-Side SDK (for database query capture):**

```typescript
// Next.js: instrument in middleware or API routes
import { RuntimeScope } from '@runtimescope/server-sdk';

// Prisma integration
const prisma = RuntimeScope.instrumentPrisma(new PrismaClient());

// Drizzle integration
const db = RuntimeScope.instrumentDrizzle(drizzle(pool));

// Generic SQL wrapper
const result = await RuntimeScope.captureQuery(
  () => pool.query('SELECT * FROM campaigns WHERE user_id = $1', [userId]),
  { label: 'getCampaigns' }
);
```

### Layer 2: Collector Server

Receives the WebSocket stream from SDKs, stores events in a ring buffer (10K in memory) with SQLite persistence. Runs all analysis engines: issue detection, API discovery, query monitoring, and process tracking.

**Storage:**

- In-memory ring buffer for real-time queries (last 10K events per project)
- SQLite database per project for session persistence and historical comparison
- Events indexed by type, timestamp, project, session, and component/store/endpoint name

**Core Engines:**

```typescript
interface CollectorAPI {
  // === Original runtime queries ===
  getEvents(filter: EventFilter): RuntimeEvent[];
  getNetworkRequests(since?: number): NetworkEvent[];
  getRenderEvents(component?: string, since?: number): RenderEvent[];
  getStateChanges(store?: string, since?: number): StateChangeEvent[];
  getConsoleMessages(level?: string, since?: number): ConsoleEvent[];
  getPerformanceMetrics(since?: number): PerformanceEvent[];
  getRenderSummary(since?: number): ComponentRenderSummary[];
  getNetworkSummary(since?: number): NetworkSummary;
  getStateMutationFrequency(since?: number): StoreMutationSummary[];
  detectIssues(): DetectedIssue[];
  getActiveSessions(): Session[];
  clearEvents(): void;

  // === API Discovery Engine (NEW) ===
  getAPICatalog(): APIEndpoint[];
  getAPIHealth(endpoint?: string): APIHealthReport;
  getAPIDocumentation(): GeneratedAPIDocs;
  getServiceMap(): ServiceTopology;

  // === Database Engine (NEW) ===
  getQueryLog(since?: number): DatabaseQuery[];
  getQueryPerformance(): QueryPerformanceReport;
  getSchemaMap(connectionId: string): DatabaseSchema;
  getTableData(table: string, options?: PaginationOptions): TableData;
  getDatabaseConnections(): DatabaseConnection[];

  // === Process Monitor (NEW) ===
  getDevProcesses(): DevProcess[];
  getProcessesByProject(project: string): DevProcess[];
  killProcess(pid: number): boolean;

  // === Infrastructure Connector (NEW) ===
  getDeployLogs(project: string): DeployLog[];
  getRuntimeLogs(project: string): RuntimeLog[];
  getBuildStatus(project: string): BuildStatus;
}
```

**Issue Detection Patterns:**

| Pattern | Detection Logic | Severity |
|---------|----------------|----------|
| Store thrashing | >10 state updates/sec for same store | HIGH |
| Unnecessary renders | Re-renders with identical props | MEDIUM |
| Render cascade | Single state change → >20 component re-renders | HIGH |
| N+1 network requests | Same endpoint called >5 times within 2 seconds | MEDIUM |
| N+1 database queries | Same table queried >5 times within 2 seconds (should be batch) | HIGH |
| Slow requests | Network request duration >3 seconds | MEDIUM |
| Slow queries | Database query duration >500ms | MEDIUM |
| Failed requests | HTTP 4xx/5xx responses | HIGH (5xx) / MEDIUM (4xx) |
| Unindexed query pattern | Sequential scan detected on large table | HIGH |
| Console error spam | Same error repeated >5 times in 10 seconds | MEDIUM |
| Long tasks | Main thread blocked >100ms | HIGH |
| Large DOM mutations | >500 DOM nodes added in single mutation | MEDIUM |
| Orphan process | Dev server running with no associated project activity >30min | LOW |
| API inconsistency | Same endpoint returns different response shapes | MEDIUM |
| Missing error handling | API calls with no `.catch()` or try/catch | MEDIUM |
| Unused API endpoint | Endpoint defined in code but never called in session | LOW |
| Auth pattern mismatch | Some calls to same service authenticated, some not | MEDIUM |

### Layer 3: MCP Server

A stdio-transport MCP server that exposes all collector data as tools queryable by Claude Code.

**Core Runtime Tools:**

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `detect_issues` | Run all pattern detectors, return prioritized issues with evidence | `since_seconds`, `severity_filter`, `category` |
| `get_event_timeline` | Chronological view of all events for causal chain analysis | `since_seconds`, `event_types`, `limit` |
| `get_render_summary` | Component render counts, durations, and render reasons | `since_seconds`, `component`, `min_count` |
| `get_render_details` | Detailed render events for a specific component | `component`, `since_seconds`, `include_props_diff` |
| `get_state_changes` | State store mutations with diffs | `store`, `since_seconds`, `include_diff` |
| `get_state_mutation_frequency` | Store update frequency (thrashing detection) | `since_seconds` |
| `get_network_requests` | All captured fetch requests with timing | `since_seconds`, `url_pattern`, `status`, `method` |
| `get_network_issues` | Slow, failed, or duplicate requests | `since_seconds`, `min_duration_ms` |
| `get_console_messages` | Console output with stack traces | `level`, `since_seconds`, `search` |
| `get_performance_metrics` | Web Vitals and long task data | `since_seconds`, `metric_type` |
| `get_session_info` | Connected apps and event statistics | — |
| `clear_events` | Reset event buffer for fresh capture | — |

**API Discovery Tools (NEW):**

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `get_api_catalog` | Auto-discovered map of every API endpoint the app communicates with, grouped by service | `service`, `min_calls` |
| `get_api_health` | Per-endpoint health: success rate, avg latency, error patterns, last seen | `endpoint`, `since_seconds` |
| `get_api_documentation` | Auto-generated REST/GraphQL docs from captured traffic (method, URL pattern, request/response shape, auth, status codes) | `service`, `format` |
| `get_service_map` | Topology of all external services the app talks to with connection health | — |
| `get_api_changes` | Detect response shape changes or new/removed endpoints between sessions | `session_a`, `session_b` |

**Database Tools (NEW):**

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `get_query_log` | All captured database queries with SQL, timing, rows returned | `since_seconds`, `table`, `min_duration_ms`, `search` |
| `get_query_performance` | Aggregated query stats: slowest queries, most frequent, N+1 detection | `since_seconds` |
| `get_schema_map` | Full database schema: tables, columns, types, foreign keys, indexes | `connection_id`, `table` |
| `get_table_data` | Read rows from a connected database table | `table`, `limit`, `offset`, `where` |
| `modify_table_data` | Insert, update, or delete rows in local dev database | `table`, `operation`, `data`, `where` |
| `get_database_connections` | List all connected databases with status | — |
| `suggest_indexes` | Analyze query patterns and suggest missing indexes | `since_seconds` |

**Process Monitor Tools (NEW):**

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `get_dev_processes` | All running dev servers, background processes, and build watchers on the machine | `project`, `type` |
| `kill_process` | Terminate a dev server or background process by PID | `pid`, `signal` |
| `get_port_usage` | Show which processes are bound to which ports | `port` |

**Infrastructure Connector Tools (NEW):**

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `get_deploy_logs` | Build/deploy logs from Vercel, Cloudflare, or Railway for a project | `project`, `platform`, `deploy_id` |
| `get_runtime_logs` | Production runtime logs scoped to a project | `project`, `platform`, `since`, `level` |
| `get_build_status` | Current deploy status and recent deployment history | `project` |
| `get_infra_overview` | Which platforms/services a project uses, detected from traffic + config | `project` |

**Session & Project Tools:**

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `compare_sessions` | Diff two capture sessions — render counts, API latency, error rates, query performance | `session_a`, `session_b` |
| `get_session_history` | List past sessions for a project with build metadata | `project`, `limit` |
| `get_project_context` | Project-specific instructions, architecture notes, known patterns (from claude-instructions.md) | `project` |

**Tool Response Format (all tools):**

```json
{
  "summary": "Human-readable summary of results",
  "data": [ /* structured data */ ],
  "issues": [ /* any detected anti-patterns, empty if none */ ],
  "metadata": {
    "project": "adspec",
    "timeRange": { "from": 1234567890, "to": 1234567920 },
    "eventCount": 847,
    "sessionId": "abc-123"
  }
}
```

---

## Feature Specifications

### Feature 1: API Discovery & Health Map

**Problem:** "I don't know which APIs my app talks to, whether they're working, or what the contract looks like — and neither does Claude."

**How it works:**

The SDK's fetch interceptor already captures every outbound HTTP request. The API Discovery Engine in the collector takes that raw traffic and builds a structured catalog automatically:

1. **Endpoint grouping**: Collapses `/api/campaigns/123` and `/api/campaigns/456` into `/api/campaigns/:id` by detecting dynamic path segments (UUIDs, numeric IDs, slugs)
2. **Service detection**: Groups endpoints by base URL into services — your Vercel API routes, Cloudflare Workers, Supabase, Google APIs, Stripe, etc.
3. **Contract inference**: Analyzes request/response payloads to derive the typical shape (field names, types, nullable fields, array vs object)
4. **Health tracking**: Per-endpoint success rate, average/p50/p95 latency, error rate, last successful call
5. **Auth pattern detection**: Identifies which endpoints use Bearer tokens, API keys, cookies, or no auth
6. **Change detection**: Compares API contracts across sessions — flags new endpoints, removed endpoints, and response shape changes

**Dashboard: API Tab**

```
┌────────────────────────────────────────────────────────────┐
│  API Map                                          [filter] │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                  SERVICE MAP                         │  │
│  │                                                      │  │
│  │              ┌──────────┐                            │  │
│  │    ┌────────▸│ Vercel   │ 12 endpoints  ● healthy   │  │
│  │    │         │ API      │ avg 145ms                  │  │
│  │    │         └──────────┘                            │  │
│  │    │                                                 │  │
│  │  ┌─┴────┐   ┌──────────┐                            │  │
│  │  │ Your │──▸│ Supabase │ 8 endpoints   ● healthy    │  │
│  │  │ App  │   │ PostgREST│ avg 89ms                   │  │
│  │  └─┬────┘   └──────────┘                            │  │
│  │    │                                                 │  │
│  │    │         ┌──────────┐                            │  │
│  │    ├────────▸│ Stripe   │ 3 endpoints   ● healthy   │  │
│  │    │         │ API      │ avg 420ms                  │  │
│  │    │         └──────────┘                            │  │
│  │    │                                                 │  │
│  │    │         ┌──────────┐                            │  │
│  │    └────────▸│ GA4      │ 1 endpoint    ● warning   │  │
│  │              │ Measure  │ 12% error rate             │  │
│  │              └──────────┘                            │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
│  ENDPOINT CATALOG                                          │
│  ┌──────────┬───────────────────────┬────┬──────┬───────┐ │
│  │ Method   │ Endpoint              │ ⌀  │ Succ │ Calls │ │
│  ├──────────┼───────────────────────┼────┼──────┼───────┤ │
│  │ GET      │ /api/campaigns        │85ms│ 100% │  47   │ │
│  │ GET      │ /api/campaigns/:id    │62ms│  98% │ 124   │ │
│  │ POST     │ /api/campaigns        │210ms│ 95% │  12   │ │
│  │ DELETE   │ /api/campaigns/:id    │95ms│ 100% │   3   │ │
│  │ POST     │ /rest/v1/analytics    │89ms│ 100% │  31   │ │
│  │ GET      │ /v1/charges           │420ms│100% │   8   │ │
│  │ POST     │ /mp/collect ⚠️        │1.2s│  88% │  15   │ │
│  └──────────┴───────────────────────┴────┴──────┴───────┘ │
│                                                            │
│  ▸ Click endpoint for: request/response shape,             │
│    auth pattern, error samples, auto-generated docs        │
└────────────────────────────────────────────────────────────┘
```

**Endpoint Detail Panel (on click):**

- Request: method, URL pattern, typical headers, typical body shape (inferred JSON schema)
- Response: typical status, typical body shape, field names and types
- Auth: detected pattern (Bearer, API key, cookie, none)
- Errors: recent 4xx/5xx with response bodies
- Timeline: latency chart over the session
- "Generate Docs" button → exports markdown API docs for this endpoint
- "Copy cURL" button → generates a cURL command from a captured request

**MCP Integration Example:**

```
You: "What APIs does adspec use and are they all healthy?"

Claude calls: get_service_map()
Claude calls: get_api_health()

Claude responds:
"adspec communicates with 4 services:

1. Vercel API Routes (12 endpoints) — all healthy, avg 145ms
2. Supabase PostgREST (8 endpoints) — all healthy, avg 89ms
3. Stripe API (3 endpoints) — healthy, but avg 420ms on /v1/charges
4. GA4 Measurement Protocol (1 endpoint) — ⚠️ 12% error rate,
   POST /mp/collect returning 403 on some requests. Likely a
   measurement_id mismatch. Check your GA4 stream configuration."
```

### Feature 2: Database Visualization & Query Monitoring

**Problem:** "I can't see my database schema, I don't know which queries are slow, and I have to open pgAdmin or Supabase dashboard just to check if data exists."

**Two components:**

**A) Query Monitoring (from runtime)**

Captures every database query the app executes, with SQL text, duration, rows returned, and the table(s) involved. Works by instrumenting the ORM/database client at the server-side SDK level.

**Supported ORMs/clients:**

| ORM / Client | Integration Method |
|-------------|-------------------|
| Prisma | `prisma.$on('query', ...)` event listener |
| Drizzle | Wrap the query executor |
| Knex | `.on('query', ...)` and `.on('query-response', ...)` events |
| pg (node-postgres) | Wrap `pool.query()` and `client.query()` |
| Supabase JS | Already captured by fetch interceptor (PostgREST calls) — collector parses the PostgREST URL syntax back into readable SQL |
| mysql2 | Wrap `connection.query()` |
| better-sqlite3 | Wrap `.prepare().all()` / `.run()` / `.get()` |

**Query Catalog (auto-generated):**

Like the API catalog but for SQL. Groups queries by normalized form (stripping literal values), tracks frequency, average duration, rows returned, and detects patterns:

- **N+1 queries**: Same table queried >5 times in 2 seconds with different WHERE values
- **Slow queries**: Duration >500ms
- **Missing index hints**: Queries that could benefit from an index (based on WHERE/ORDER BY columns + row count)
- **Overfetching**: SELECT * on tables with >20 columns when only a few are used in the response
- **Write amplification**: Multiple UPDATEs to the same row in quick succession

**B) Schema Visualization & Data Browser**

Connects directly to the project's local development database and provides:

1. **Entity-Relationship Diagram**: Interactive visual map (built with React Flow) showing tables as nodes, foreign keys as edges, with column details visible on hover/click
2. **Table Inspector**: Click any table to see columns, types, constraints, indexes, and row count
3. **Data Browser**: Paginated table view (TanStack Table) with inline editing, row creation, and deletion — works against the local dev database only
4. **Data Search**: Quick search across table contents

**Dashboard: Database Tab**

```
┌────────────────────────────────────────────────────────────┐
│  Database: adspec_dev (PostgreSQL)              [connected] │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                  SCHEMA MAP (React Flow)              │  │
│  │                                                       │  │
│  │  ┌──────────┐    1:N    ┌──────────────┐             │  │
│  │  │ users    │──────────▸│ campaigns    │             │  │
│  │  │ (1,247)  │           │ (8,432)      │             │  │
│  │  └──────────┘           └──────┬───────┘             │  │
│  │                                │ 1:N                  │  │
│  │                                ▼                      │  │
│  │                         ┌──────────────┐             │  │
│  │                         │ ad_groups    │             │  │
│  │                         │ (24,891)     │             │  │
│  │                         └──────┬───────┘             │  │
│  │                                │ 1:N                  │  │
│  │                                ▼                      │  │
│  │                         ┌──────────────┐             │  │
│  │                         │ ads          │             │  │
│  │                         │ (142,567)    │             │  │
│  │                         └──────────────┘             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  QUERY PERFORMANCE (last 60s)                              │
│  ┌──────┬──────────────────────────────┬─────┬─────┬────┐ │
│  │ ⌀ ms │ Query                        │ Rows│Count│ ⚠️ │ │
│  ├──────┼──────────────────────────────┼─────┼─────┼────┤ │
│  │ 847  │ SELECT * FROM ads WHERE      │ 500 │  1  │ 🐌 │ │
│  │      │ campaign_id = $1             │     │     │    │ │
│  │  12  │ SELECT id, name FROM         │  50 │ 50  │ N+1│ │
│  │      │ campaigns WHERE user_id = $1 │     │     │    │ │
│  │   3  │ SELECT * FROM users          │   1 │ 200 │    │ │
│  │      │ WHERE id = $1                │     │     │    │ │
│  └──────┴──────────────────────────────┴─────┴─────┴────┘ │
│                                                            │
│  TABLE BROWSER: campaigns                                  │
│  ┌────┬────────────┬───────────┬─────────┬──────────────┐ │
│  │ id │ name       │ status    │ budget  │ created_at   │ │
│  ├────┼────────────┼───────────┼─────────┼──────────────┤ │
│  │ 1  │ Spring Q2  │ active    │ 5000.00 │ 2026-01-15   │ │
│  │ 2  │ Summer     │ draft     │ 3200.00 │ 2026-02-01   │ │
│  │ 3  │ Product... │ paused    │ 8500.00 │ 2026-02-08   │ │
│  └────┴────────────┴───────────┴─────────┴──────────────┘ │
│  [+ Add Row]  [Edit]  [Delete]              Page 1 of 169  │
└────────────────────────────────────────────────────────────┘
```

**Database connection config (per project):**

```yaml
# ~/.runtimescope/projects/adspec/infrastructure.yaml
databases:
  primary:
    type: postgresql
    connection_string: postgresql://localhost:5432/adspec_dev
    label: "Local Dev DB"
  supabase:
    type: supabase
    project_ref: abcdefghijkl
    service_key: ${SUPABASE_SERVICE_KEY}   # Read from .env
    label: "Supabase (Dev)"
```

**MCP Integration Example:**

```
You: "My campaign list page is slow. Check if there are any
     database query issues."

Claude calls: get_query_performance(since_seconds: 30)
Claude calls: get_schema_map(connection_id: "primary")

Claude responds:
"Found 2 database performance issues:

1. N+1 QUERY (HIGH): The campaigns list page is running
   SELECT * FROM campaigns WHERE user_id = $1 once for each
   of the 50 campaign cards instead of a single batch query.
   Fix: use WHERE user_id = $1 with a single query and
   distribute results in the component.

2. SLOW QUERY (MEDIUM): SELECT * FROM ads WHERE campaign_id = $1
   is taking 847ms and returning 500 rows. The ads table has
   142K rows but no index on campaign_id. Fix:
   CREATE INDEX idx_ads_campaign_id ON ads(campaign_id);

Also noting: you're using SELECT * on the ads table which has
23 columns, but the campaign card only displays name, status,
and impression count. Consider selecting only needed columns."
```

### Feature 3: Dev Process Monitor

**Problem:** "I have 6 Next.js dev servers running and I didn't even realize it. Something is eating 4GB of RAM and I don't know which project it belongs to."

**How it works:**

The Process Monitor scans for common development processes on the machine using system APIs. On Mac/Linux it reads from `ps` and `/proc`. On Windows it uses `wmic` or `tasklist`. It identifies dev-related processes by matching against known patterns.

**Detected process types:**

| Process Pattern | Type | Label |
|----------------|------|-------|
| `next dev`, `next start` | Frontend | Next.js Dev Server |
| `vite`, `vite dev` | Frontend | Vite Dev Server |
| `webpack serve`, `webpack-dev-server` | Frontend | Webpack Dev Server |
| `expo start` | Frontend | Expo Dev Server |
| `node server.js`, `ts-node`, `tsx` | Backend | Node.js Server |
| `uvicorn`, `gunicorn`, `flask run` | Backend | Python Server |
| `cargo watch`, `cargo run` | Backend | Rust Server |
| `wrangler dev` | Backend | Cloudflare Worker (local) |
| `prisma studio` | Database | Prisma Studio |
| `docker compose`, `docker run` | Container | Docker Container |
| `postgres`, `mysqld`, `mongod`, `redis-server` | Database | Database Server |
| `ngrok`, `cloudflared tunnel` | Tunnel | Dev Tunnel |
| `turbo dev`, `turbo run dev` | Build | Turborepo Dev |
| `tsc --watch`, `tsup --watch` | Build | TypeScript Watcher |

**Project association:**

The monitor inspects each process's working directory (`cwd`) and matches it against known RuntimeScope projects. If a Next.js dev server is running from `~/projects/adspec/`, it gets tagged as belonging to the "adspec" project. Unassociated processes are shown separately with their directory path so you can identify and clean them up.

**Dashboard: Process Monitor (persistent sidebar widget or popover)**

```
┌────────────────────────────────────────────┐
│  Dev Processes (7 running)         [↻] [▾] │
│                                            │
│  adspec                                    │
│  ├─ ● Next.js Dev     :3000   84MB  [↗][✕]│
│  ├─ ● Prisma Studio   :5555   45MB  [↗][✕]│
│  └─ ● TSC Watch              12MB     [✕] │
│                                            │
│  imageforge                                │
│  └─ ● Vite Dev        :5173   67MB  [↗][✕]│
│                                            │
│  campaign-dashboard                        │
│  └─ ● Next.js Dev     :3001   92MB  [↗][✕]│
│                                            │
│  ⚠️  Unassociated                          │
│  ├─ ● Node.js         :4000   38MB  [↗][✕]│
│  │   ~/scratch/test-api                    │
│  └─ ● Docker: postgres :5432  210MB    [✕] │
│                                            │
│  Total: 548MB RAM across 7 processes       │
│                                            │
│  [↗] = Open in browser  [✕] = Terminate    │
└────────────────────────────────────────────┘
```

**Key interactions:**

- **[↗] Open in browser**: For frontend servers, opens `localhost:{port}` in default browser
- **[✕] Terminate**: Sends SIGTERM to kill the process (with confirmation prompt)
- **Open project folder**: Click the project name to open it in Finder/Explorer
- **Launch in Claude Code**: Right-click → "Open in Claude Code" to start a coding session for that project
- **Auto-detection**: Processes are scanned every 10 seconds. New processes appear with a subtle animation. Crashed processes show a red dot
- **Memory warning**: Highlights processes using >500MB in yellow, >1GB in red
- **Stale process detection**: Processes with no network activity or file changes for >30 minutes get flagged as potentially orphaned

**MCP Integration:**

```
You: "What dev servers do I have running right now?"

Claude calls: get_dev_processes()

Claude responds:
"You have 7 dev processes running using 548MB total:

- adspec: Next.js on :3000 (84MB), Prisma Studio on :5555 (45MB),
  TypeScript watcher (12MB)
- imageforge: Vite on :5173 (67MB)
- campaign-dashboard: Next.js on :3001 (92MB)
- Unassociated: Node server on :4000 from ~/scratch/test-api (38MB),
  Docker postgres on :5432 (210MB)

The Node server on :4000 and the Docker postgres are using 248MB
combined and aren't linked to any active project. Want me to shut
those down?"
```

### Feature 4: Infrastructure Connector (MCP Hub)

**Problem:** "Claude can't see my Vercel deploy logs, Cloudflare worker logs, or Railway service status without me copy-pasting from 3 different dashboards."

**How it works:**

RuntimeScope maintains a per-project infrastructure config that maps the project to its deployment platforms. The Infrastructure Connector acts as a project-aware dispatcher — it routes queries to the right platform API (or MCP server if installed) and returns results scoped to the project.

**Project infrastructure config:**

```yaml
# ~/.runtimescope/projects/adspec/infrastructure.yaml
project: adspec

deployments:
  frontend:
    platform: vercel
    project_id: prj_abc123
    team_id: team_xyz
  api:
    platform: cloudflare
    worker_name: adspec-api
    account_id: cf_12345
  background:
    platform: railway
    project_id: rail_789

databases:
  primary:
    type: postgresql
    connection_string: postgresql://localhost:5432/adspec_dev

services:
  auth: supabase
  payments: stripe
  analytics: ga4
  email: resend
```

**Platform integration priority:**

| Platform | If MCP installed | If MCP not installed |
|----------|-----------------|---------------------|
| Vercel | Route through Vercel MCP | Call Vercel REST API directly |
| Cloudflare | Route through CF MCP | Call CF REST API directly |
| Railway | Route through Railway MCP | Call Railway GraphQL API |
| Supabase | Route through Supabase MCP | Call Supabase Management API |

The connector checks if platform MCPs are available and uses them when present. Otherwise it falls back to direct API calls. The user provides API tokens once in the infrastructure config, and RuntimeScope handles the routing.

**Auto-detection from traffic:**

When the SDK captures network requests, the collector recognizes platform-specific URL patterns:

| URL Pattern | Detected Service |
|------------|-----------------|
| `*.supabase.co` | Supabase |
| `*.workers.dev` | Cloudflare Workers |
| `*.vercel.app` | Vercel |
| `api.stripe.com` | Stripe |
| `*.railway.app` | Railway |
| `api.openai.com` | OpenAI |
| `api.resend.com` | Resend |
| `www.google-analytics.com`, `*.google-analytics.com` | GA4 |

When a new service is detected, the dashboard prompts: "Detected Supabase usage in adspec. Add connection details to enable deploy logs and schema inspection?"

**Dashboard: Infrastructure Tab**

```
┌────────────────────────────────────────────────────────────┐
│  Infrastructure: adspec                                    │
│                                                            │
│  DEPLOYMENTS                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Vercel (frontend)                         ● Live     │  │
│  │ Last deploy: 12 min ago · abc1234 · main             │  │
│  │ Build: 38s · Status: Ready                           │  │
│  │ [View Build Log]  [View Runtime Log]  [Redeploy]     │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │ Cloudflare Worker (api)                   ● Live     │  │
│  │ Last deploy: 2 hours ago · def5678 · main            │  │
│  │ Requests: 1,247/hr · Errors: 0.3%                   │  │
│  │ [View Logs]  [View Analytics]                        │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │ Railway (background)                      ● Live     │  │
│  │ Last deploy: 1 day ago · Memory: 256MB               │  │
│  │ [View Logs]  [View Metrics]                          │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  SERVICES DETECTED                                         │
│  Supabase · Stripe · GA4 · Resend                         │
│  [Auto-detected from API traffic]                          │
│                                                            │
│  RECENT DEPLOY LOG (Vercel)                                │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 14:23:01  Cloning repo...                            │  │
│  │ 14:23:03  Installing dependencies...                 │  │
│  │ 14:23:18  Building...                                │  │
│  │ 14:23:41  ✓ Compiled successfully                    │  │
│  │ 14:23:42  Deploying to production...                 │  │
│  │ 14:23:45  ✓ Ready: https://adspec.vercel.app         │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**MCP Integration Example:**

```
You: "Did the latest deploy of adspec cause any issues?"

Claude calls: get_build_status(project: "adspec")
Claude calls: get_deploy_logs(project: "adspec", deploy_id: "latest")
Claude calls: get_runtime_logs(project: "adspec", since: "1h", level: "error")
Claude calls: compare_sessions(session_a: "pre-deploy", session_b: "post-deploy")

Claude responds:
"The latest Vercel deploy (abc1234, 12 min ago) built successfully
in 38s with no warnings. However, comparing runtime data:

- API error rate went from 0.1% to 2.3% after deploy
- GET /api/campaigns/:id is now returning 500 errors intermittently
- Runtime logs show: 'TypeError: Cannot read property "status" of undefined'
  in /api/campaigns/[id]/route.ts line 47

Looks like a null check is missing on the campaign status field.
The Supabase query returns campaigns without a status field when
they're in draft state. Want me to fix it?"
```

### Feature 5: Session Diffing & Build Regression Detection

**Problem:** "I shipped a change and now things feel slower but I can't tell what actually regressed."

Each capture session is tagged with build metadata (git commit, branch, deploy ID). The collector stores session snapshots in SQLite. The diff engine compares any two sessions across all metrics.

**Diff dimensions:**

| Metric | Comparison |
|--------|-----------|
| Render counts | Per-component render count delta |
| Render duration | Per-component avg render time delta |
| API latency | Per-endpoint avg/p95 latency delta |
| API error rate | Per-endpoint error rate delta |
| Query performance | Per-query avg duration delta |
| Query count | Per-query call frequency delta |
| Web Vitals | LCP, FID, CLS delta |
| Bundle size | If captured from resource timing |
| New issues | Issues present in B but not in A |
| Resolved issues | Issues present in A but not in B |

**Dashboard: Session Diff View**

```
┌────────────────────────────────────────────────────────────┐
│  Session Diff: Build A vs Build B                          │
│  A: commit abc123 (main, Feb 10 14:30)                     │
│  B: commit def456 (main, Feb 11 09:15)  ← current         │
│                                                            │
│  REGRESSIONS (3)                                    🔴     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ CampaignCard renders:   47 → 312  (+565%)  🔴       │  │
│  │ GET /api/campaigns:     85ms → 340ms (+300%) 🔴      │  │
│  │ DB: SELECT ads:         120ms → 847ms (+606%) 🔴     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  IMPROVEMENTS (1)                                   🟢     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Console errors:         23 → 2  (-91%)  🟢           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  UNCHANGED                                          ⚪     │
│  LCP: 1.2s → 1.3s · CLS: 0.02 → 0.02 · FID: 12ms → 14ms │
│                                                            │
│  [View commit diff: abc123..def456]                        │
└────────────────────────────────────────────────────────────┘
```

### Feature 6: Marketing Extensions (GTM/GA4)

Intercepts `dataLayer.push()` and `gtag()` calls from the browser SDK.

**Dashboard: Tracking Tab**

- Live stream of all dataLayer pushes with event name, parameters, timestamp
- Conversion event validation: checks required parameters are present
- UTM parameter audit: flags outbound links with missing/malformed UTMs
- Tracking spec comparison: if a spec document is provided, validates captured events against it
- GA4 debug view: shows which events would fire in GA4, with parameter mapping

**MCP tools:** `get_tracking_events`, `validate_gtm_config`, `audit_utm_params`, `compare_tracking_spec`

---

## Project Structure (Updated)

```
runtimescope/
├── packages/
│   ├── sdk/                          # Browser SDK (Layer 1)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── interceptors/
│   │   │   │   ├── fetch.ts          # Fetch/XHR interception
│   │   │   │   ├── console.ts        # Console patching
│   │   │   │   ├── react-renders.ts  # React Profiler integration
│   │   │   │   ├── state-stores.ts   # Zustand/Redux subscription
│   │   │   │   ├── performance.ts    # PerformanceObserver
│   │   │   │   └── tracking.ts       # dataLayer/gtag interception
│   │   │   ├── transport.ts
│   │   │   ├── redaction.ts
│   │   │   ├── utils/
│   │   │   └── types.ts
│   │   └── package.json
│   │
│   ├── server-sdk/                   # Server-side SDK (NEW)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── integrations/
│   │   │   │   ├── prisma.ts         # Prisma query capture
│   │   │   │   ├── drizzle.ts        # Drizzle query capture
│   │   │   │   ├── knex.ts           # Knex query capture
│   │   │   │   ├── pg.ts             # node-postgres wrapper
│   │   │   │   └── supabase.ts       # Supabase client wrapper
│   │   │   ├── transport.ts          # WebSocket client (server→collector)
│   │   │   └── types.ts
│   │   └── package.json
│   │
│   ├── collector/                    # Collector Server (Layer 2)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── store.ts              # Ring buffer + SQLite
│   │   │   ├── query.ts              # Query API
│   │   │   ├── engines/
│   │   │   │   ├── issue-detector.ts       # Pattern matching
│   │   │   │   ├── api-discovery.ts        # API catalog builder (NEW)
│   │   │   │   ├── query-monitor.ts        # DB query analysis (NEW)
│   │   │   │   ├── process-monitor.ts      # Dev process scanner (NEW)
│   │   │   │   └── infra-connector.ts      # Platform API dispatcher (NEW)
│   │   │   ├── db/
│   │   │   │   ├── schema-introspector.ts  # DB schema reader (NEW)
│   │   │   │   ├── data-browser.ts         # Table CRUD (NEW)
│   │   │   │   └── connections.ts          # DB connection manager (NEW)
│   │   │   ├── aggregators.ts
│   │   │   └── types.ts
│   │   └── package.json
│   │
│   ├── mcp-server/                   # MCP Server (Layer 3)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── tools/
│   │   │   │   ├── renders.ts
│   │   │   │   ├── state.ts
│   │   │   │   ├── network.ts
│   │   │   │   ├── console.ts
│   │   │   │   ├── performance.ts
│   │   │   │   ├── issues.ts
│   │   │   │   ├── session.ts
│   │   │   │   ├── api-discovery.ts        # NEW
│   │   │   │   ├── database.ts             # NEW
│   │   │   │   ├── processes.ts            # NEW
│   │   │   │   ├── infrastructure.ts       # NEW
│   │   │   │   └── tracking.ts             # NEW
│   │   │   └── types.ts
│   │   └── package.json
│   │
│   └── dashboard/                    # Dashboard UI (NEW)
│       ├── src/
│       │   ├── App.tsx
│       │   ├── components/
│       │   │   ├── layout/
│       │   │   │   ├── Sidebar.tsx
│       │   │   │   ├── Header.tsx
│       │   │   │   ├── ProjectSwitcher.tsx
│       │   │   │   ├── CommandPalette.tsx
│       │   │   │   └── ProcessPopover.tsx     # NEW
│       │   │   ├── tabs/
│       │   │   │   ├── OverviewTab.tsx
│       │   │   │   ├── NetworkTab.tsx
│       │   │   │   ├── RendersTab.tsx
│       │   │   │   ├── StateTab.tsx
│       │   │   │   ├── ConsoleTab.tsx
│       │   │   │   ├── PerformanceTab.tsx
│       │   │   │   ├── APITab.tsx             # NEW
│       │   │   │   ├── DatabaseTab.tsx        # NEW
│       │   │   │   ├── InfrastructureTab.tsx  # NEW
│       │   │   │   ├── IssuesTab.tsx
│       │   │   │   ├── TrackingTab.tsx
│       │   │   │   └── SessionsTab.tsx
│       │   │   ├── shared/
│       │   │   │   ├── EventTable.tsx
│       │   │   │   ├── JSONViewer.tsx
│       │   │   │   ├── ServiceMap.tsx         # NEW
│       │   │   │   ├── SchemaMap.tsx           # NEW
│       │   │   │   ├── DiffViewer.tsx
│       │   │   │   └── TimelineChart.tsx
│       │   ├── hooks/
│       │   │   ├── useWebSocket.ts
│       │   │   ├── useEvents.ts
│       │   │   └── useProject.ts
│       │   ├── stores/
│       │   │   ├── eventStore.ts
│       │   │   └── projectStore.ts
│       │   └── lib/
│       │       ├── api-client.ts
│       │       └── db-client.ts
│       ├── index.html
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       └── package.json
│
├── apps/
│   └── desktop/                      # Tauri v2 shell (NEW)
│       ├── src-tauri/
│       │   ├── src/
│       │   │   ├── main.rs           # Tauri entry
│       │   │   ├── ws_server.rs      # WebSocket collector in Rust
│       │   │   ├── process_monitor.rs # System process scanner
│       │   │   └── db_connector.rs   # Direct DB connections
│       │   ├── Cargo.toml
│       │   └── tauri.conf.json
│       └── package.json
│
├── package.json                      # Monorepo root (npm workspaces)
├── tsconfig.base.json
└── README.md
```

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Desktop shell** | Tauri v2 | Cross-platform (Mac/Win/Linux), ~5MB, Rust backend |
| **Frontend** | React 19 + Vite + TypeScript | Same codebase for web and desktop |
| **Styling** | Tailwind CSS v4 + shadcn/ui | Dark-mode devtools aesthetic |
| **Data tables** | TanStack Table v8 | Virtualized, sortable, filterable — network, query, console views |
| **Charts** | Recharts | Render timelines, waterfall, sparklines, session diff charts |
| **Schema map** | React Flow | Interactive ER diagram for database visualization |
| **Service map** | React Flow or D3 | API topology visualization |
| **Command palette** | cmdk | Cmd+K for quick navigation |
| **JSON viewer** | react-json-view-lite | State inspection, request/response bodies |
| **Local DB** | SQLite (Tauri plugin / better-sqlite3) | Event storage, project scoping, session history |
| **Real-time** | WebSocket | SDK → Collector streaming |
| **MCP Server** | `@modelcontextprotocol/sdk` + zod | stdio transport for Claude Code |
| **DB introspection** | `information_schema` queries + ORM-specific APIs | Schema map generation |
| **Process monitor** | `ps` (Mac/Linux), `wmic`/`tasklist` (Windows) | Dev server detection |
| **Cloud (optional)** | Cloudflare Workers + D1 + R2 | Event sync, session sharing, prod telemetry |
| **Build/package** | Tauri CLI (desktop), Vite (web) | Single `tauri build` → Mac/Win/Linux installers |

---

## Data Privacy Model

**Principle: Everything is local by default. Nothing leaves the machine without explicit action.**

| Data | Storage | Privacy |
|------|---------|---------|
| Runtime events | SQLite in `~/.runtimescope/projects/{name}/events.db` | Local only |
| Database connections | `infrastructure.yaml` in project dir | Local only, credentials in env vars |
| API tokens (Vercel, CF, etc.) | OS keychain via Tauri plugin or `.env` file | Never written to SQLite |
| Session snapshots | SQLite files in project dir | Local only unless explicitly exported |
| Cloud sync | Opt-in per project, explicit push/pull or toggle | User-controlled, CF D1/R2 |
| Request/response bodies | Redacted by default in production mode | Configurable per project |
| SQL query params | Redacted by default (`$1`, `$2` placeholders shown) | Configurable |

---

## Project Scoping

```
~/.runtimescope/
├── config.json                         # Global settings
├── projects/
│   ├── adspec/
│   │   ├── config.json                 # Project settings
│   │   ├── infrastructure.yaml         # Platform connections + DB config
│   │   ├── claude-instructions.md      # AI agent context for this project
│   │   ├── events.db                   # Current session events
│   │   └── sessions/                   # Historical snapshots
│   │       ├── 2026-02-10_14-30_abc123.db
│   │       └── 2026-02-11_09-15_def456.db
│   ├── imageforge/
│   │   └── ...
│   └── campaign-dashboard/
│       └── ...
└── cloud/
    └── credentials.json                # Optional cloud sync tokens
```

---

## Milestones (Updated)

### M1: Core Pipeline (MVP) — MCP + Network + Console
- Browser SDK: fetch interception + console patching + WebSocket transport
- Collector: WebSocket server + in-memory ring buffer + basic query API
- MCP server: `get_network_requests`, `get_console_messages`, `get_session_info`, `clear_events`
- Test end-to-end: inject SDK into a sample React app, query via Claude Code

### M2: Dashboard MVP — Web UI + Network/Console Tabs
- React + Vite + Tailwind + shadcn/ui dashboard app
- Network tab: request table, detail panel, waterfall timing
- Console tab: log stream with level filtering and JSON viewer
- Overview tab: connection status, activity sparklines, quick stats
- Real-time updates via WebSocket from collector to dashboard

### M3: API Discovery
- API Discovery Engine in collector: endpoint grouping, service detection, health tracking, contract inference
- Dashboard: API tab with service map (React Flow), endpoint catalog, endpoint detail panel
- MCP tools: `get_api_catalog`, `get_api_health`, `get_api_documentation`, `get_service_map`
- Auto-detection of services from URL patterns

### M4: React Render Tracking
- SDK: React Profiler integration + render reason detection
- Collector: render aggregation + unnecessary render detection + cascade detection
- Dashboard: Renders tab with component table, render timeline, cascade visualization
- MCP tools: `get_render_summary`, `get_render_details`
- Issue detectors: unnecessary renders, render cascades

### M5: State Store Observability
- SDK: Zustand + Redux store subscription + state diffing
- Collector: mutation frequency tracking + thrashing detection
- Dashboard: State tab with store list, state tree viewer, mutation log
- MCP tools: `get_state_changes`, `get_state_mutation_frequency`

### M6: Database Visualization & Query Monitoring
- Server-side SDK: Prisma, Drizzle, pg, Supabase instrumentation
- Collector: query catalog, N+1 detection, slow query detection
- Database connector: schema introspection, data browser
- Dashboard: Database tab with schema map (React Flow), query performance table, table browser with inline editing
- MCP tools: `get_query_log`, `get_query_performance`, `get_schema_map`, `get_table_data`, `modify_table_data`, `suggest_indexes`

### M7: Dev Process Monitor
- Process scanner: detect dev servers, DB processes, build watchers, tunnels
- Project association: match process working directory to RuntimeScope projects
- Dashboard: Process Monitor popover/sidebar widget with status, memory, port, kill button
- MCP tools: `get_dev_processes`, `kill_process`, `get_port_usage`

### M8: Infrastructure Connector (MCP Hub)
- Platform connectors: Vercel, Cloudflare, Railway APIs
- MCP routing: proxy through installed MCPs or fall back to direct API calls
- Auto-detection of platforms from captured traffic
- Dashboard: Infrastructure tab with deploy status, build logs, runtime logs
- MCP tools: `get_deploy_logs`, `get_runtime_logs`, `get_build_status`, `get_infra_overview`

### M9: Session Diffing & Performance Regression
- Build metadata capture in SDK
- Session snapshot storage in SQLite
- Diff engine: compare render counts, API latency, query performance, error rates, Web Vitals
- Dashboard: Session Diff view with regression/improvement indicators
- MCP tools: `compare_sessions`, `get_session_history`
- SQLite persistence for all sessions

### M10: Tauri Desktop App
- Wrap dashboard in Tauri v2 shell
- Move collector WebSocket server to Rust backend
- Move process monitor to Rust (native system APIs)
- Build installers for Mac, Windows, Linux
- System tray icon with process monitor quick view

### M11: Performance + Web Vitals
- SDK: PerformanceObserver integration
- Dashboard: Performance tab with Core Web Vitals gauges, long task timeline
- MCP tools: `get_performance_metrics`

### M12: Cloud Sync + Production Telemetry
- Cloudflare Worker collector for deployed apps
- D1 storage for cloud events
- Dashboard: cloud/local data source toggle
- Production mode: sampling, full redaction, lightweight capture
- Session export/import

### M13: Marketing Extensions (GTM/GA4)
- SDK: `dataLayer.push()` and `gtag()` interception
- Dashboard: Tracking tab with event stream, conversion validation, UTM audit
- MCP tools: `get_tracking_events`, `validate_gtm_config`, `audit_utm_params`

---

## Claude Code Integration

### Installation

```bash
# Add MCP server
claude mcp add runtimescope node /path/to/runtimescope/packages/mcp-server/dist/index.js

# Optionally add per-project context
# Place claude-instructions.md in ~/.runtimescope/projects/{name}/
```

### Recommended Workflow

```
1. Check connection:     get_session_info()
2. Clear slate:          clear_events()
3. Reproduce the issue in the browser
4. Run diagnostics:      detect_issues()
5. Understand APIs:      get_api_catalog() + get_api_health()
6. Check queries:        get_query_performance()
7. Trace causality:      get_event_timeline()
8. Compare builds:       compare_sessions()
9. Check infra:          get_deploy_logs() + get_runtime_logs()
10. Clean up:            get_dev_processes() → kill_process()
```

### Full Example Interaction

```
You: "I just deployed adspec and users are reporting the campaign
     page is slow. Help me figure out what's going on."

Claude calls: get_session_info()
Claude calls: detect_issues(project: "adspec")
Claude calls: get_api_health(project: "adspec")
Claude calls: get_query_performance(since_seconds: 60)
Claude calls: get_build_status(project: "adspec")
Claude calls: compare_sessions(session_a: "latest-1", session_b: "latest")

Claude responds:
"I found the problem. After your latest deploy (commit def456, 20 min ago),
three things regressed:

1. DATABASE N+1 (HIGH): The campaign list is executing 50 individual
   SELECT queries (one per card) instead of a batch query. This started
   in the latest build — your commit changed CampaignCard to fetch its
   own metrics instead of receiving them as props.
   Fix: Lift the metrics query to the parent and use WHERE id IN (...).

2. API LATENCY (HIGH): GET /api/campaigns went from 85ms to 340ms.
   This is downstream of the N+1 issue — each API call triggers the
   individual DB queries. Fixing #1 will fix this.

3. RENDER CASCADE (MEDIUM): CampaignCard renders jumped from 47 to 312.
   Each of the 50 cards re-renders when any card's metrics query resolves,
   because they all subscribe to the same TanStack Query cache key.
   Fix: Use individual cache keys per campaign ID.

Also noting: you have 3 orphan dev processes using 285MB that aren't
linked to any active project. Want me to clean those up?"
```

---

## Success Criteria

| Metric | Target |
|--------|--------|
| SDK overhead per intercepted operation | <5ms |
| SDK bundle size (browser) | <15KB gzip |
| Collector throughput | 1,000 events/sec without drops |
| MCP tool response time | <500ms for queries over 10K events |
| API discovery accuracy | Correctly groups 95% of endpoints |
| Database query capture accuracy | Captures 100% of instrumented ORM queries |
| Process detection accuracy | Detects 95% of common dev server patterns |
| Schema introspection time | <2s for databases with <100 tables |
| Session diff computation | <3s for comparing two 10K-event sessions |
| Dashboard initial load | <1.5s |
| Desktop app installer size | <10MB (Tauri) |
| Desktop app idle memory | <50MB |

---

## Non-Goals (For Now)
- Production APM replacement (this is dev-focused, prod telemetry is opt-in lightweight)
- React Native support (web-first; Limelight owns that space)
- Multi-user collaboration / team features
- Custom alerting rules
- Integration with CI/CD pipelines (beyond reading deploy logs)
- Mobile app version of the dashboard
