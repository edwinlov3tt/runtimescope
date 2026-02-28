# RuntimeScope

Runtime profiling, website analysis, and design extraction for **any tech stack** — piped directly into Claude Code via MCP.

RuntimeScope gives Claude Code eyes into your running app and any website on the internet. It intercepts network requests, console output, state changes, component renders, Web Vitals, database queries, and server metrics — and can scan any URL to extract tech stack, design tokens, layout structure, fonts, accessibility, and assets. All events are persisted to **SQLite** so Claude can access historical data across sessions. Everything is exposed as **46 MCP tools** so Claude Code can see exactly what's happening at runtime.

**Works with everything:** React, Vue, Angular, Svelte, Next.js, Nuxt, plain HTML, Flask, Django, Rails, PHP, WordPress, static sites — any tech stack that serves HTML.

```
Browser (SDK) ──WebSocket──┐
                           ├──> [Collector + MCP Server] ──stdio──> Claude Code
Server (SDK) ──WebSocket──┘
Any URL ──Playwright scan──┘
```

---

## Install the MCP Server

Register RuntimeScope as an MCP server so Claude Code can use all 46 tools:

```bash
claude mcp add runtimescope -s user -- npx -y @runtimescope/mcp-server
```

That's it. Restart Claude Code and the MCP server is available globally across all projects.

For Claude Desktop, add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "runtimescope": {
      "command": "npx",
      "args": ["-y", "@runtimescope/mcp-server"]
    }
  }
}
```

---

## Add the SDK to Your App

The MCP server gives Claude the tools. The SDK connects your running app so those tools have data to work with. Choose the method that fits your stack:

### Option A — Script Tag (Any HTML page, no build system required)

The MCP server serves the SDK bundle automatically. Add this before `</body>` in any HTML file:

```html
<script src="http://localhost:9091/runtimescope.js"></script>
<script>
  RuntimeScope.init({
    appName: 'my-app',
    endpoint: 'ws://localhost:9090',
  });
</script>
```

Works with Flask (`templates/base.html`), Django, Rails (`application.html.erb`), PHP, WordPress (`footer.php`), static HTML — anything that serves HTML. No npm or Node.js required.

### Option B — npm Install (JS/TS projects with a build system)

```bash
npm install @runtimescope/sdk
```

```typescript
import { RuntimeScope } from '@runtimescope/sdk';

RuntimeScope.init({
  appName: 'my-app',
  endpoint: 'ws://localhost:9090',
});
```

### Option C — Let Claude Do It

Ask Claude Code and it handles everything:

```
Install RuntimeScope SDK in my project. Use get_sdk_snippet to detect my framework and generate the right code.
```

The `get_sdk_snippet` tool auto-detects your framework and returns the exact snippet + where to paste it.

### Backend SDK (Node.js)

For server-side monitoring (database queries, HTTP requests, performance metrics):

```bash
npm install @runtimescope/server-sdk
```

```typescript
import { RuntimeScope } from '@runtimescope/server-sdk';

RuntimeScope.connect({
  appName: 'my-api',
  captureConsole: true,
  captureHttp: true,
  capturePerformance: true,
});

// Instrument your ORM (pick one):
RuntimeScope.instrumentPrisma(prisma);
RuntimeScope.instrumentDrizzle(db);
RuntimeScope.instrumentPg(pool);
RuntimeScope.instrumentKnex(knex);
RuntimeScope.instrumentMysql2(pool);
RuntimeScope.instrumentBetterSqlite3(db);

// Express/Connect middleware for per-request context
app.use(RuntimeScope.middleware());
```

### Full-Stack (Both SDKs)

For full-stack apps (e.g. Next.js with API routes, Express + React), install both SDKs. They share the same collector — both browser and server events appear in the same MCP tools.

### Website Analysis (No SDK Required)

RuntimeScope can analyze **any website** without installing anything:

```
Scan https://stripe.com and show me their design tokens, tech stack, and layout structure
```

This uses the `scan_website` tool — a headless browser visits the URL and extracts everything.

### Verify Connection

Start your app, then ask Claude Code:

```
Use get_session_info to check if the SDK is connected.
```

---

## Slash Commands (Optional)

RuntimeScope ships with **11 slash commands** for pre-built diagnostic workflows. Copy them into your project:

```bash
mkdir -p .claude/commands
curl -sL https://raw.githubusercontent.com/edwinlov3tt/runtimescope/main/.claude/commands/{diagnose,trace,renders,api,network,queries,recon,clone-ui,devops,history,setup}.md -o '.claude/commands/#1.md'
```

Or if you have the repo cloned:

```bash
mkdir -p .claude/commands
cp ../runtimescope/.claude/commands/{diagnose,trace,renders,api,network,queries,recon,clone-ui,devops,history,setup}.md .claude/commands/
```

| Command | What it does |
|---------|-------------|
| `/setup` | Install SDK — detects framework, generates snippet, verifies connection |
| `/diagnose` | Full-stack health check — issue detection, API health, query performance, Web Vitals |
| `/trace` | Trace a user flow — clears events, asks you to reproduce, analyzes the causal chain |
| `/renders` | Render audit — finds excessive re-renders, suggests memo/callback fixes |
| `/api` | API health — endpoints, latency, errors, service map |
| `/network` | Network analysis — failed requests, slow requests, N+1 patterns |
| `/queries` | Database audit — slow queries, N+1 patterns, missing indexes |
| `/recon` | Website recon — tech stack, design tokens, layout, fonts, accessibility, assets |
| `/clone-ui` | Clone a component — scans URL, extracts everything needed to recreate it |
| `/devops` | Dev status — running processes, port usage, build status, deploy logs |
| `/history` | Historical query — list projects, query past events from SQLite |

---

## Claude Prompts

Copy one of these into your project's `CLAUDE.md` to give Claude full context on how to use RuntimeScope.

### Installation Prompt (For Any Tech Stack)

```
You have access to RuntimeScope, a runtime profiling MCP server with 46 tools. RuntimeScope works with ANY tech stack — not just JavaScript/Node.js.

When a user wants to install RuntimeScope:
1. The MCP server should already be registered. If not: claude mcp add runtimescope -s user -- npx -y @runtimescope/mcp-server
2. Use get_sdk_snippet to generate the correct installation code for their framework. It supports: React, Vue, Angular, Svelte, Next.js, Nuxt, plain HTML, Flask, Django, Rails, PHP, WordPress, and more.
3. For npm-based projects (React, Vue, etc.): npm install @runtimescope/sdk
4. For non-npm tech stacks (Flask, Django, Rails, PHP, WordPress, static HTML): use the <script> tag — no npm or build system required. The SDK bundle is served by the MCP server at http://localhost:9091/runtimescope.js.
5. get_sdk_snippet returns framework-specific placement hints (e.g., "paste in templates/base.html before </body>" for Flask).
6. Never tell users RuntimeScope is incompatible with their tech stack. If it serves HTML, RuntimeScope works with it.
7. For Node.js backends: npm install @runtimescope/server-sdk

Data persistence: All events are automatically persisted to SQLite (per-project databases at ~/.runtimescope/projects/<appName>/events.db). Events survive Claude Code restarts. Historical data is retained for 30 days by default. Use list_projects to see all projects with stored data, and get_historical_events to query past events.
```

### Frontend Prompt

```
You have access to RuntimeScope, a runtime profiling MCP server with 46 tools. The browser SDK is installed and captures events from the running app.

Before debugging, always check what's enabled: Start with get_session_info to verify the SDK is connected and see which capture features are active.

Workflow:
1. Start with get_session_info to verify the SDK is connected
2. Use clear_events before reproducing an issue for a clean capture
3. After the user reproduces the issue, run detect_issues to get prioritized problems with evidence and fix suggestions
4. Use get_event_timeline to trace the causal chain in chronological order
5. Drill into specifics with targeted tools: get_network_requests (filter by URL/status/method), get_console_messages (filter by level/search), get_errors_with_source_context (errors with source code), get_state_snapshots (state mutations), get_render_profile (component re-renders), get_performance_metrics (Web Vitals)
6. For API analysis: get_api_catalog discovers endpoints, get_api_health shows latency/error rates, get_service_map maps external service topology
7. Capture snapshots: get_dom_snapshot for current page HTML, capture_har for network export
8. Compare sessions: compare_sessions to detect regressions between test runs
9. For design analysis: scan_website to scan any URL, then get_design_tokens, get_layout_tree, get_computed_styles for detailed design data
10. For historical analysis: list_projects to see all projects with stored data, get_historical_events to query past events from SQLite (supports time ranges like "2h", "7d", or ISO dates)

Important: Some capture features are opt-in and may not be enabled. If a tool returns empty results, check whether the corresponding SDK feature is enabled (e.g., capturePerformance for Web Vitals, captureRenders for render profiling, stores for state tracking). Suggest the user enable the feature if needed.

All tools return a consistent JSON envelope with summary, data, issues, and metadata fields. Use the since_seconds parameter on most tools to scope queries to a time window.
```

### Backend Prompt

```
You have access to RuntimeScope, a runtime profiling MCP server with 46 tools. The server SDK is installed and captures events from the Node.js backend.

Before debugging, always check what's enabled: Start with get_session_info to verify the SDK is connected. Not all features are enabled by default — captureHttp and capturePerformance are opt-in.

Workflow:
1. Start with get_session_info to verify the SDK is connected
2. Use clear_events before reproducing an issue for a clean capture
3. Run detect_issues for automated problem detection
4. For database analysis: get_query_log shows captured queries, get_query_performance detects N+1 and slow queries, suggest_indexes recommends indexes, get_schema_map shows the database schema
5. For server health: get_performance_metrics with source: 'server' shows memory, CPU, event loop lag, and GC pauses
6. For outgoing HTTP: get_network_requests shows requests made by the server (requires captureHttp: true)
7. For console/errors: get_console_messages and get_errors_with_source_context
8. DevOps: get_dev_processes for running processes, get_port_usage for port conflicts

Important: Some capture features are opt-in. If a tool returns empty results, check whether the corresponding SDK feature is enabled:
- Database queries require an ORM instrumentation call (e.g., RuntimeScope.instrumentPrisma(prisma))
- Server metrics require capturePerformance: true
- Outgoing HTTP requires captureHttp: true
- Console/errors are enabled by default

All tools return a consistent JSON envelope with summary, data, issues, and metadata fields.
```

### Full-Stack Prompt

```
You have access to RuntimeScope, a runtime profiling MCP server with 46 tools that captures events from both the browser and the Node.js server. Both SDKs feed into the same collector — browser and server events appear in the same tools.

Before debugging, always check what's enabled: Start with get_session_info to verify both SDKs are connected. Not all features are enabled by default.

Capture features and their defaults:
- Browser: captureNetwork (on), captureConsole (on), captureXhr (on), captureBody (off), capturePerformance (off), captureRenders (off), stores (off)
- Server: captureConsole (on), captureErrors (on), captureHttp (off), capturePerformance (off), database instrumentation (manual)

Workflow:
1. Start with get_session_info to verify both SDKs are connected
2. Use clear_events before reproducing an issue for a clean capture
3. Run detect_issues for automated problem detection across the full stack
4. Use get_event_timeline to trace causal chains across browser and server
5. Drill into specifics: network (get_network_requests), console (get_console_messages), errors (get_errors_with_source_context), state (get_state_snapshots), renders (get_render_profile), performance (get_performance_metrics — use source: 'browser' or source: 'server' to filter)
6. For API analysis: get_api_catalog, get_api_health, get_service_map
7. For database analysis: get_query_log, get_query_performance, suggest_indexes, get_schema_map
8. Capture snapshots: get_dom_snapshot, capture_har
9. Compare sessions: compare_sessions to detect regressions
10. DevOps: get_dev_processes, get_port_usage, get_deploy_logs
11. Website analysis: scan_website any URL, then use recon tools (get_design_tokens, get_layout_tree, get_font_info, etc.)
12. Historical analysis: list_projects to see all projects, get_historical_events to query past events from SQLite

If a tool returns empty results, the corresponding capture feature may not be enabled. Suggest the user enable it in their SDK config.

For SDK installation on any tech stack, use get_sdk_snippet — it generates the right code for any framework including non-JS stacks (Flask, Django, Rails, PHP, WordPress).

All tools return a consistent JSON envelope with summary, data, issues, and metadata fields. Use the since_seconds parameter on most tools to scope queries to a time window.
```

### Website Analysis Prompt (No SDK Required)

```
You have access to RuntimeScope's website scanner and recon tools. These work on any URL without installing anything.

When a user wants to analyze a website:
1. scan_website({ url }) — visits the page with a headless browser, detects tech stack from 7,221 technologies, extracts design tokens, layout, fonts, accessibility, and assets. Stores everything for follow-up queries.
2. After scanning, use recon tools to drill into specifics:
   - get_design_tokens() — CSS custom properties, color palette, typography, spacing, shadows
   - get_layout_tree({ selector: ".hero" }) — DOM structure with flex/grid layout info
   - get_font_info() — font faces, families used, icon fonts, loading strategy
   - get_accessibility_tree() — heading hierarchy, landmarks, form labels, alt text
   - get_asset_inventory() — images, SVGs, sprites, icon fonts
   - get_computed_styles({ selector: ".btn" }) — exact CSS values for any element
   - get_element_snapshot({ selector: ".card" }) — deep snapshot for component recreation
   - get_page_metadata() — tech stack, meta tags, external resources
   - get_style_diff({ source_selector, target_selector }) — compare two elements' styles

Common workflows:
- Brand extraction: scan_website → get_design_tokens → get_font_info
- UI recreation: scan_website → get_element_snapshot → get_computed_styles → build → get_style_diff to verify
- Tech stack discovery: scan_website → get_page_metadata
- Accessibility audit: scan_website → get_accessibility_tree
- Competitor analysis: scan_website → get_design_tokens + get_layout_tree + get_font_info + get_asset_inventory
```

---

## Browser SDK Configuration

```typescript
import { RuntimeScope } from '@runtimescope/sdk';

RuntimeScope.init({
  // Connection
  endpoint: 'ws://localhost:9090',   // Collector WebSocket URL (default)
  appName: 'my-app',                // Identifies this app in session info
  enabled: true,                     // Set to false to disable entirely
  authToken: undefined,              // API key for authenticated collectors

  // Capture toggles
  captureNetwork: true,              // Intercept fetch (default: true)
  captureXhr: true,                  // Intercept XMLHttpRequest (default: true)
  captureConsole: true,              // Intercept console.* (default: true)
  captureBody: false,                // Capture request/response bodies (default: false)
  maxBodySize: 65536,                // Max body size in bytes (default: 64KB)
  capturePerformance: false,         // Web Vitals: LCP, FCP, CLS, TTFB, FID, INP (default: false)
  captureRenders: false,             // React render tracking (default: false)

  // State tracking — pass your Zustand/Redux store refs
  stores: {},

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

## Server SDK Configuration

```typescript
import { RuntimeScope } from '@runtimescope/server-sdk';

RuntimeScope.connect({
  // Connection
  serverUrl: 'ws://localhost:9090',  // Collector WebSocket URL (default)
  appName: 'my-api',                // Identifies this app in session info
  authToken: undefined,              // API key for authenticated collectors

  // Capture toggles
  captureConsole: true,              // Intercept console.log/warn/error (default: true)
  captureErrors: true,               // Capture uncaught exceptions (default: true)
  captureHttp: false,                // Intercept outgoing HTTP requests (default: false)
  captureBody: false,                // Capture HTTP request/response bodies (default: false)
  maxBodySize: 65536,                // Max body size in bytes (default: 64KB)
  capturePerformance: false,         // Server metrics: memory, CPU, event loop, GC (default: false)
  performanceInterval: 5000,         // Metrics collection interval in ms (default: 5000)
  captureStackTraces: false,         // Add stack traces to database events (default: false)

  // Sampling & rate limiting (for high-throughput services)
  sampleRate: 1.0,                   // 0.0–1.0 probabilistic sampling (default: 1.0 = 100%)
  maxEventsPerSecond: undefined,     // Rate limit per second (default: unlimited)
  maxQueueSize: 10000,               // Transport queue cap — drops oldest (default: 10000)

  // Privacy
  redactHeaders: ['authorization', 'cookie', 'set-cookie'],
  redactParams: false,               // Redact SQL query parameters (default: false)
  beforeSend: (event) => event,      // Filter/modify events before sending
});
```

### ORM Integrations

| Method | Driver | Notes |
|--------|--------|-------|
| `RuntimeScope.instrumentPrisma(client)` | Prisma | Uses `$use` middleware |
| `RuntimeScope.instrumentDrizzle(db)` | Drizzle ORM | Wraps session execute |
| `RuntimeScope.instrumentPg(pool)` | node-postgres | Wraps `pool.query()` |
| `RuntimeScope.instrumentKnex(knex)` | Knex.js | Wraps query builder |
| `RuntimeScope.instrumentMysql2(pool)` | MySQL2 | Wraps `pool.query()` and `pool.execute()` |
| `RuntimeScope.instrumentBetterSqlite3(db)` | better-sqlite3 | Wraps `prepare()`, synchronous |
| `RuntimeScope.captureQuery(fn, opts)` | Any | Generic async query wrapper |

### Express/Connect Middleware

Per-request context propagation via `AsyncLocalStorage`. All events emitted during a request automatically inherit the request's session ID.

```typescript
app.use(RuntimeScope.middleware());
```

### Server Performance Metrics

When `capturePerformance: true` is set, the server SDK collects these Node.js runtime metrics at the configured interval:

| Metric | Unit | Description |
|--------|------|-------------|
| `memory.rss` | bytes | Resident set size |
| `memory.heapUsed` | bytes | V8 heap used |
| `memory.heapTotal` | bytes | V8 heap total |
| `memory.external` | bytes | V8 external memory (Buffers, etc.) |
| `eventloop.lag.mean` | ms | Event loop delay (mean) |
| `eventloop.lag.p99` | ms | Event loop delay (99th percentile) |
| `eventloop.lag.max` | ms | Event loop delay (max) |
| `gc.pause.major` | ms | Major GC pause time (per interval) |
| `gc.pause.minor` | ms | Minor GC pause time (per interval) |
| `cpu.user` | % | User CPU usage |
| `cpu.system` | % | System CPU usage |
| `handles.active` | count | Active libuv handles |
| `requests.active` | count | Active libuv requests |

---

## Framework Examples

### Next.js (App Router) — Browser SDK

```typescript
// app/providers.tsx
'use client';
import { useEffect } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      import('@runtimescope/sdk').then(({ RuntimeScope }) => {
        RuntimeScope.init({
          appName: 'my-nextjs-app',
          captureNetwork: true,
          captureConsole: true,
          capturePerformance: true,
        });
      });
    }
  }, []);

  return <>{children}</>;
}
```

### Next.js (API Routes / Server Actions) — Server SDK

```typescript
// instrumentation.ts (Next.js instrumentation hook)
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { RuntimeScope } = await import('@runtimescope/server-sdk');
    RuntimeScope.connect({
      appName: 'my-nextjs-api',
      captureConsole: true,
      captureHttp: true,
      capturePerformance: true,
    });
    // Instrument your ORM here
    // const { prisma } = await import('./lib/prisma');
    // RuntimeScope.instrumentPrisma(prisma);
  }
}
```

### Express

```typescript
// server.ts
import express from 'express';
import { RuntimeScope } from '@runtimescope/server-sdk';

RuntimeScope.connect({
  appName: 'my-express-api',
  captureConsole: true,
  captureHttp: true,
  capturePerformance: true,
});

const app = express();
app.use(RuntimeScope.middleware());
```

### Vite / Create React App

```typescript
// src/main.tsx
import { RuntimeScope } from '@runtimescope/sdk';

if (import.meta.env.DEV) {
  RuntimeScope.init({
    appName: 'my-vite-app',
    captureNetwork: true,
    captureConsole: true,
  });
}
```

### Flask / Django / Rails / PHP

No npm required. Add the script tag to your base template:

```html
<!-- Flask: templates/base.html -->
<!-- Django: templates/base.html -->
<!-- Rails: app/views/layouts/application.html.erb -->
<!-- PHP/WordPress: footer.php -->

<script src="http://localhost:9091/runtimescope.js"></script>
<script>
  RuntimeScope.init({
    appName: 'my-app',
    endpoint: 'ws://localhost:9090',
  });
</script>
```

---

## SQLite Persistence

RuntimeScope automatically persists all events to SQLite — no configuration required.

- When an SDK connects with `appName: 'my-app'`, a per-project database is created at `~/.runtimescope/projects/my-app/events.db`
- Every event is dual-written: in-memory ring buffer (fast, for real-time tools) + SQLite (persistent, for historical queries)
- Session metrics are auto-snapshotted on SDK disconnect
- Old events are auto-pruned on startup (default: 30 days, configurable via `RUNTIMESCOPE_RETENTION_DAYS`)

Query historical data:
```
Use list_projects to show me all projects with historical data
Use get_historical_events to show me network events from the last 2 hours for my-app
```

**Prerequisites:** `better-sqlite3` compiles a native module during install. If you encounter build errors:
- **macOS:** `xcode-select --install`
- **Linux:** `sudo apt install build-essential`
- **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

---

## MCP Tools (46)

### Core Runtime (12 tools)

| Tool | Description |
|------|-------------|
| `detect_issues` | **Start here.** Runs all pattern detectors — failed requests, slow requests, N+1, error spam, re-render storms, poor Web Vitals. Returns prioritized issues with evidence and fix suggestions |
| `get_event_timeline` | Chronological view of all events for tracing causal chains. Filter by `event_types` and `since_seconds` |
| `get_network_requests` | Fetch/XHR/server HTTP requests with URL, method, status, timing, headers, body sizes, GraphQL detection. Filter by `url_pattern`, `status`, `method` |
| `get_console_messages` | Console output (log/warn/error/info/debug/trace) with stack traces. Filter by `level`, `search` text |
| `get_state_snapshots` | Zustand/Redux state snapshots with diffs, action history, and thrashing detection. Filter by `store_name` |
| `get_render_profile` | React component render counts, velocity, durations, and causes. Flags suspicious components. Filter by `component_name` |
| `get_performance_metrics` | Browser Web Vitals (LCP, FCP, CLS, TTFB, FID, INP) and server metrics (memory, CPU, event loop, GC). Filter by `metric_name`, `source` (`browser`/`server`/`all`) |
| `get_dom_snapshot` | Live DOM capture from the running app. Returns HTML, URL, viewport, element count |
| `capture_har` | Export network requests as HAR 1.2 JSON (Chrome DevTools compatible) |
| `get_errors_with_source_context` | Console errors with parsed stack traces and source code context fetched from dev server |
| `get_session_info` | Check SDK connection status and event statistics |
| `clear_events` | Reset event buffer and session tracking for a clean capture |

### API Discovery (5 tools)

| Tool | Description |
|------|-------------|
| `get_api_catalog` | Discover all API endpoints, auto-grouped by service. Shows normalized paths, call counts, auth patterns |
| `get_api_health` | Health metrics per endpoint: success rate, p50/p95 latency, error codes |
| `get_api_documentation` | Generate markdown API docs from observed traffic |
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

### Process Monitor (5 tools)

| Tool | Description |
|------|-------------|
| `get_dev_processes` | List running dev processes (Next.js, Vite, Docker, etc.) with PID, port, memory, CPU |
| `kill_process` | Terminate a dev process by PID (SIGTERM or SIGKILL). Safety-guarded against system PIDs |
| `get_port_usage` | Show which processes are bound to which ports |
| `purge_caches` | Delete build/dev cache directories (.next/cache, node_modules/.cache, .vite, .turbo, etc.) |
| `restart_dev_server` | Kill process + purge caches + restart. One-step dev server reset |

### Infrastructure (4 tools)

| Tool | Description |
|------|-------------|
| `get_deploy_logs` | Deployment history from Vercel, Cloudflare, Railway |
| `get_runtime_logs` | Runtime logs from deployment platforms |
| `get_build_status` | Current deployment status per connected platform |
| `get_infra_overview` | Infrastructure overview combining config with auto-detection from network traffic |

### Session Comparison (2 tools)

| Tool | Description |
|------|-------------|
| `compare_sessions` | Compare two sessions: API latency, render counts, Web Vitals, query performance |
| `get_session_history` | List past sessions with build metadata and event counts |

### Historical Persistence (2 tools)

| Tool | Description |
|------|-------------|
| `get_historical_events` | Query past events from SQLite. Filter by `project`, `event_types`, `since`/`until`, `session_id` |
| `list_projects` | List all projects with stored historical data, event counts, session counts |

### Website Scanner (2 tools)

| Tool | Description |
|------|-------------|
| `scan_website` | Visit any URL with a headless browser. Extracts tech stack (7,221 technologies), design tokens, layout, accessibility, fonts, and assets. **No SDK required** |
| `get_sdk_snippet` | Generate a ready-to-paste code snippet for any tech stack — React, Vue, Flask, Django, Rails, PHP, WordPress, etc. |

### Recon & Design Extraction (9 tools)

| Tool | Description |
|------|-------------|
| `get_page_metadata` | Tech stack detection: framework, UI library, build tool, hosting, external resources |
| `get_design_tokens` | CSS custom properties, color palette, typography scale, spacing, shadows |
| `get_layout_tree` | DOM structure with bounding rects, flex/grid layout, position, z-index |
| `get_font_info` | @font-face declarations, font families, icon fonts, loading strategy |
| `get_accessibility_tree` | Heading hierarchy, ARIA landmarks, form labels, images with alt text |
| `get_asset_inventory` | Images, inline SVGs, sprite sheets, CSS backgrounds, icon fonts |
| `get_computed_styles` | Computed CSS values for any selector, filterable by property group |
| `get_element_snapshot` | Deep snapshot of an element + children: structure, styles, bounding rects |
| `get_style_diff` | Compare styles between two selectors with match percentage |

---

## Detected Patterns

`detect_issues` runs these pattern detectors automatically:

| Pattern | Trigger | Severity |
|---------|---------|----------|
| Failed requests | HTTP 4xx/5xx | HIGH (5xx) / MEDIUM (4xx) |
| Slow requests | Duration > 3s | MEDIUM |
| N+1 requests | Same endpoint > 5x in 2s | MEDIUM |
| N+1 queries | Same query pattern > 5x in quick succession | MEDIUM |
| Slow queries | Query duration > 500ms | MEDIUM |
| Console error spam | Same error > 5x in 10s | MEDIUM |
| High error rate | > 30% of console messages are errors | HIGH |
| Excessive re-renders | Component render velocity > 4/sec | MEDIUM |
| Large state updates | State snapshot > 100KB | MEDIUM |
| Poor Web Vitals | Any metric rated "poor" | HIGH (LCP/CLS) / MEDIUM |
| High heap usage | Heap used > 500MB | HIGH |
| Event loop lag | p99 lag > 100ms | HIGH |

---

## npm Packages

| Package | Install | Description |
|---------|---------|-------------|
| [`@runtimescope/sdk`](https://www.npmjs.com/package/@runtimescope/sdk) | `npm install @runtimescope/sdk` | Browser SDK (zero deps, ~3KB gzipped) |
| [`@runtimescope/server-sdk`](https://www.npmjs.com/package/@runtimescope/server-sdk) | `npm install @runtimescope/server-sdk` | Node.js server SDK |
| [`@runtimescope/mcp-server`](https://www.npmjs.com/package/@runtimescope/mcp-server) | `npx -y @runtimescope/mcp-server` | MCP server (46 tools) |
| [`@runtimescope/collector`](https://www.npmjs.com/package/@runtimescope/collector) | Internal dependency | Event collector (used by mcp-server) |

## Project Structure

```
packages/
  sdk/           # Browser SDK (zero deps, ~3KB gzipped) — ESM + IIFE via <script> tag
  server-sdk/    # Node.js server SDK (Prisma, Drizzle, pg, Knex, MySQL2, better-sqlite3)
  collector/     # WebSocket receiver + ring buffer + issue detection + HTTP API
  mcp-server/    # MCP stdio server with 46 tools + Playwright scanner
  extension/     # Technology detection engine (7,221 technologies from webappanalyzer)
  dashboard/     # Web dashboard for event visualization
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIMESCOPE_PORT` | `9090` | WebSocket collector port |
| `RUNTIMESCOPE_HTTP_PORT` | `9091` | HTTP API port |
| `RUNTIMESCOPE_BUFFER_SIZE` | `10000` | Max events in ring buffer |
| `RUNTIMESCOPE_RETENTION_DAYS` | `30` | Days to keep historical events in SQLite |

## License

MIT
