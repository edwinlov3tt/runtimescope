# RuntimeScope

Runtime profiling, website analysis, and design extraction for **any tech stack** — piped directly into Claude Code via MCP.

RuntimeScope gives Claude Code eyes into your running app and any website on the internet. It intercepts network requests, console output, state changes, component renders, Web Vitals, database queries, and server metrics from your running app — and can scan any URL to extract tech stack, design tokens, layout structure, fonts, accessibility, and assets. Everything is exposed as **44 MCP tools** so Claude Code can see exactly what's happening at runtime.

**Works with everything:** React, Vue, Angular, Svelte, Next.js, Nuxt, plain HTML, Flask, Django, Rails, PHP, WordPress, static sites — any tech stack that serves HTML.

```
Browser (SDK) ──WebSocket──┐
                           ├──> [Collector + MCP Server] ──stdio──> Claude Code
Server (SDK) ──WebSocket──┘
Any URL ──Playwright scan──┘
```

---

## Quick Start (Let Claude Do It)

### Any Tech Stack (2 minutes)

Paste this into Claude Code and it will handle the full setup — **works with any tech stack**:

> **Install RuntimeScope for my project.** Clone https://github.com/edwinlov3tt/runtimescope into a sibling directory, build it, and register the MCP server. Then use `get_sdk_snippet` to generate the right installation snippet for my tech stack and add it to my app.
>
> Steps:
> 1. `git clone https://github.com/edwinlov3tt/runtimescope ../runtimescope && cd ../runtimescope && npm install && npm run build`
> 2. `claude mcp add runtimescope node ../runtimescope/packages/mcp-server/dist/index.js`
> 3. Restart Claude Code so the MCP server loads
> 4. Use `get_sdk_snippet` — it auto-detects my framework and gives me the exact code + where to paste it
> 5. Verify with `get_session_info`

The `get_sdk_snippet` tool supports: React, Vue, Angular, Svelte, Next.js, Nuxt, plain HTML, Flask, Django, Rails, PHP, WordPress, and any other tech stack that serves HTML. **No npm or Node.js required** — it generates a `<script>` tag that works in any HTML page.

### Backend (Node.js Server SDK)

For Node.js backends, also paste this:

> **Add RuntimeScope server-side monitoring to my backend.**
>
> Before starting, ask me:
> 1. Which events to track: console output, errors, outgoing HTTP requests, server performance metrics (memory, CPU, event loop lag, GC pauses), and/or database queries?
> 2. Which ORM/database driver I'm using: Prisma, Drizzle, Knex, pg, MySQL2, or better-sqlite3?
> 3. Whether I want sampling/rate limiting for high-throughput services?
>
> Steps:
> 1. `npm install ../runtimescope/packages/server-sdk` (skip `git clone` and `claude mcp add` if already done above)
> 2. Add the SDK initialization to my server's entry point, enabling only the features I selected, and instrument my ORM.
> 3. If I'm using Express/Connect, add the middleware for per-request context tracking.
> 4. Verify with `get_session_info`.

### Full-Stack (Both SDKs)

For full-stack apps (e.g. Next.js with API routes, Express + React), install both SDKs. They share the same collector — both browser and server events appear in the same MCP tools.

### Website Analysis (No SDK Required)

RuntimeScope can also analyze **any website** without installing anything. Just ask Claude:

> "Scan https://stripe.com and show me their design tokens, tech stack, and layout structure"

This uses the `scan_website` tool — a headless browser visits the URL and extracts everything. See [Use Cases & Scenarios](#use-cases--scenarios) below.

---

## Manual Installation

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

### 3a. Add the Browser SDK (Frontend)

**Works with ANY tech stack** — React, Vue, Angular, Svelte, plain HTML, Flask/Django templates, Rails ERB, PHP, WordPress, etc.

**Option A — Script tag (universal, no build system required)**

Add this to any HTML page before `</body>`. The SDK is served automatically by the RuntimeScope collector:

```html
<script src="http://localhost:9091/runtimescope.js"></script>
<script>
  RuntimeScope.init({
    appName: 'my-app',
    endpoint: 'ws://localhost:9090',
    captureNetwork: true,
    captureConsole: true,
  });
</script>
```

This works with Flask (`templates/base.html`), Django, Rails (`application.html.erb`), PHP, WordPress (`footer.php`), static HTML — anything that serves HTML.

**Option B — npm install (for JS build systems)**

```bash
npm install ../runtime-profiler/packages/sdk
```

```typescript
import { RuntimeScope } from '@runtimescope/sdk';

RuntimeScope.connect({
  appName: 'my-app',
  captureNetwork: true,
  captureConsole: true,
  captureXhr: true,
  capturePerformance: true,    // Web Vitals (LCP, FCP, CLS, TTFB, FID, INP)
  captureRenders: true,        // React component render profiling
});
```

> **Tip:** Ask Claude `get_sdk_snippet` and it will generate the right snippet for your specific tech stack.

### 3b. Add the Server SDK (Backend)

```bash
# From your app's directory
npm install ../runtime-profiler/packages/server-sdk
```

Then add to your server's entry point (e.g. `server.ts`, `app.ts`, `index.ts`):

```typescript
import { RuntimeScope } from '@runtimescope/server-sdk';

RuntimeScope.connect({
  appName: 'my-api',
  captureConsole: true,          // Intercept console.log/warn/error (default: true)
  captureHttp: true,             // Intercept outgoing HTTP requests
  capturePerformance: true,      // Memory, CPU, event loop lag, GC pauses
});
```

**Instrument your ORM** (call after `connect()`):

```typescript
// Pick the one matching your setup:
RuntimeScope.instrumentPrisma(prisma);
RuntimeScope.instrumentDrizzle(db);
RuntimeScope.instrumentPg(pool);
RuntimeScope.instrumentKnex(knex);
RuntimeScope.instrumentMysql2(pool);
RuntimeScope.instrumentBetterSqlite3(db);
```

**Add Express/Connect middleware** for per-request context tracking:

```typescript
app.use(RuntimeScope.middleware());
```

### 4. Verify Connection

Start your app, then ask Claude Code:

> "Use get_session_info to check if the SDK is connected."

---

## Browser SDK Configuration

```typescript
RuntimeScope.connect({
  // Connection
  serverUrl: 'ws://localhost:9090',  // Collector WebSocket URL (default)
  appName: 'my-app',                // Identifies this app in session info
  enabled: true,                     // Set to false to disable entirely

  // Capture toggles — enable what you need
  captureNetwork: true,              // Intercept fetch (default: true)
  captureXhr: true,                  // Intercept XMLHttpRequest (default: true)
  captureConsole: true,              // Intercept console.* (default: true)
  captureBody: false,                // Capture request/response bodies (default: false)
  maxBodySize: 65536,                // Max body size in bytes (default: 64KB)
  capturePerformance: false,         // Web Vitals: LCP, FCP, CLS, TTFB, FID, INP (default: false)
  captureRenders: false,             // React render tracking (default: false)

  // State tracking — pass your Zustand/Redux store refs
  stores: {
    // myStore: useMyStore,
  },

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

  // Capture toggles — enable what you need
  captureConsole: true,              // Intercept console.log/warn/error (default: true)
  captureErrors: true,               // Capture uncaught exceptions and unhandled rejections (default: true)
  captureHttp: false,                // Intercept outgoing http/https requests (default: false)
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

The middleware provides per-request context propagation via `AsyncLocalStorage`. All events emitted during a request (database queries, console logs, errors) automatically inherit the request's session ID.

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

### Framework-Specific Setup

**Next.js (App Router) — Browser SDK**

```typescript
// app/providers.tsx
'use client';
import { useEffect } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      import('@runtimescope/sdk').then(({ RuntimeScope }) => {
        RuntimeScope.connect({
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

**Next.js (API Routes / Server Actions) — Server SDK**

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

**Express**

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
app.use(RuntimeScope.middleware()); // Per-request context tracking
```

**Vite / Create React App — Browser SDK**

```typescript
// src/main.tsx
import { RuntimeScope } from '@runtimescope/sdk';

if (import.meta.env.DEV) {
  RuntimeScope.connect({
    appName: 'my-vite-app',
    captureNetwork: true,
    captureConsole: true,
  });
}
```

---

## Claude Prompt

Copy this into your project's `CLAUDE.md` or paste it directly to give Claude full context on how to use RuntimeScope's tools.

### Installation Prompt (For Any Tech Stack)

> You have access to RuntimeScope, a runtime profiling MCP server with 44 tools. **RuntimeScope works with ANY tech stack** — not just JavaScript/Node.js.
>
> **When a user wants to install RuntimeScope:**
> 1. Use `get_sdk_snippet` to generate the correct installation code for their framework. It supports: React, Vue, Angular, Svelte, Next.js, Nuxt, plain HTML, Flask, Django, Rails, PHP, WordPress, and more.
> 2. For non-npm tech stacks (Flask, Django, Rails, PHP, WordPress, static HTML), the SDK is a simple `<script>` tag — no npm or build system required. The SDK bundle is served by the RuntimeScope collector at `http://localhost:9091/runtimescope.js`.
> 3. `get_sdk_snippet` returns framework-specific placement hints (e.g., "paste in templates/base.html before </body>" for Flask).
> 4. **Never tell users RuntimeScope is incompatible with their tech stack.** If it serves HTML, RuntimeScope works with it.

### Website Analysis Prompt (No SDK Required)

> You have access to RuntimeScope's website scanner and recon tools. These work on **any URL** without installing anything.
>
> **When a user wants to analyze a website:**
> 1. `scan_website({ url })` — visits the page with a headless browser, detects tech stack from 7,221 technologies, extracts design tokens, layout, fonts, accessibility, and assets. Stores everything for follow-up queries.
> 2. After scanning, use recon tools to drill into specifics:
>    - `get_design_tokens()` — CSS custom properties, color palette, typography, spacing, shadows
>    - `get_layout_tree({ selector: ".hero" })` — DOM structure with flex/grid layout info
>    - `get_font_info()` — font faces, families used, icon fonts, loading strategy
>    - `get_accessibility_tree()` — heading hierarchy, landmarks, form labels, alt text
>    - `get_asset_inventory()` — images, SVGs, sprites, icon fonts
>    - `get_computed_styles({ selector: ".btn" })` — exact CSS values for any element
>    - `get_element_snapshot({ selector: ".card" })` — deep snapshot for component recreation
>    - `get_page_metadata()` — tech stack, meta tags, external resources
>    - `get_style_diff({ source_selector, target_selector })` — compare two elements' styles
>
> **Common workflows:**
> - **Brand extraction:** `scan_website` → `get_design_tokens` → `get_font_info`
> - **UI recreation:** `scan_website` → `get_element_snapshot` → `get_computed_styles` → build → `get_style_diff` to verify
> - **Tech stack discovery:** `scan_website` → `get_page_metadata`
> - **Accessibility audit:** `scan_website` → `get_accessibility_tree`
> - **Competitor analysis:** `scan_website` → `get_design_tokens` + `get_layout_tree` + `get_font_info` + `get_asset_inventory`

### Frontend Prompt

> You have access to RuntimeScope, a runtime profiling MCP server with 44 tools. The browser SDK is installed and captures events from the running app.
>
> **Before debugging, always check what's enabled:** Start with `get_session_info` to verify the SDK is connected and see which capture features are active.
>
> **Workflow:**
> 1. Start with `get_session_info` to verify the SDK is connected
> 2. Use `clear_events` before reproducing an issue for a clean capture
> 3. After the user reproduces the issue, run `detect_issues` to get prioritized problems with evidence and fix suggestions
> 4. Use `get_event_timeline` to trace the causal chain in chronological order
> 5. Drill into specifics with targeted tools: `get_network_requests` (filter by URL/status/method), `get_console_messages` (filter by level/search), `get_errors_with_source_context` (errors with source code), `get_state_snapshots` (state mutations), `get_render_profile` (component re-renders), `get_performance_metrics` (Web Vitals)
> 6. For API analysis: `get_api_catalog` discovers endpoints, `get_api_health` shows latency/error rates, `get_service_map` maps external service topology
> 7. Capture snapshots: `get_dom_snapshot` for current page HTML, `capture_har` for network export
> 8. Compare sessions: `compare_sessions` to detect regressions between test runs
> 9. For design analysis: `scan_website` to scan any URL, then `get_design_tokens`, `get_layout_tree`, `get_computed_styles` for detailed design data
>
> **Important:** Some capture features are opt-in and may not be enabled. If a tool returns empty results, check whether the corresponding SDK feature is enabled (e.g., `capturePerformance` for Web Vitals, `captureRenders` for render profiling, `stores` for state tracking). Suggest the user enable the feature if needed.
>
> All tools return a consistent JSON envelope with `summary`, `data`, `issues`, and `metadata` fields. Use the `since_seconds` parameter on most tools to scope queries to a time window.

### Backend Prompt

> You have access to RuntimeScope, a runtime profiling MCP server with 44 tools. The server SDK is installed and captures events from the Node.js backend.
>
> **Before debugging, always check what's enabled:** Start with `get_session_info` to verify the SDK is connected. Not all features are enabled by default — `captureHttp` and `capturePerformance` are opt-in.
>
> **Workflow:**
> 1. Start with `get_session_info` to verify the SDK is connected
> 2. Use `clear_events` before reproducing an issue for a clean capture
> 3. Run `detect_issues` for automated problem detection
> 4. For database analysis: `get_query_log` shows captured queries, `get_query_performance` detects N+1 and slow queries, `suggest_indexes` recommends indexes, `get_schema_map` shows the database schema
> 5. For server health: `get_performance_metrics` with `source: 'server'` shows memory, CPU, event loop lag, and GC pauses
> 6. For outgoing HTTP: `get_network_requests` shows requests made by the server (requires `captureHttp: true`)
> 7. For console/errors: `get_console_messages` and `get_errors_with_source_context`
> 8. DevOps: `get_dev_processes` for running processes, `get_port_usage` for port conflicts
>
> **Important:** Some capture features are opt-in. If a tool returns empty results, check whether the corresponding SDK feature is enabled:
> - Database queries require an ORM instrumentation call (e.g., `RuntimeScope.instrumentPrisma(prisma)`)
> - Server metrics require `capturePerformance: true`
> - Outgoing HTTP requires `captureHttp: true`
> - Console/errors are enabled by default
>
> All tools return a consistent JSON envelope with `summary`, `data`, `issues`, and `metadata` fields.

### Full-Stack Prompt

> You have access to RuntimeScope, a runtime profiling MCP server with 44 tools that captures events from both the browser and the Node.js server. Both SDKs feed into the same collector — browser and server events appear in the same tools.
>
> **Before debugging, always check what's enabled:** Start with `get_session_info` to verify both SDKs are connected. Ask the user which events they want to track if you're not sure what's configured. Not all features are enabled by default.
>
> **Capture features and their defaults:**
> - Browser: `captureNetwork` (on), `captureConsole` (on), `captureXhr` (on), `captureBody` (off), `capturePerformance` (off), `captureRenders` (off), `stores` (off)
> - Server: `captureConsole` (on), `captureErrors` (on), `captureHttp` (off), `capturePerformance` (off), database instrumentation (manual)
>
> **Workflow:**
> 1. Start with `get_session_info` to verify both SDKs are connected
> 2. Use `clear_events` before reproducing an issue for a clean capture
> 3. Run `detect_issues` for automated problem detection across the full stack
> 4. Use `get_event_timeline` to trace causal chains across browser and server
> 5. Drill into specifics: network (`get_network_requests`), console (`get_console_messages`), errors (`get_errors_with_source_context`), state (`get_state_snapshots`), renders (`get_render_profile`), performance (`get_performance_metrics` — use `source: 'browser'` or `source: 'server'` to filter)
> 6. For API analysis: `get_api_catalog`, `get_api_health`, `get_service_map`
> 7. For database analysis: `get_query_log`, `get_query_performance`, `suggest_indexes`, `get_schema_map`
> 8. Capture snapshots: `get_dom_snapshot`, `capture_har`
> 9. Compare sessions: `compare_sessions` to detect regressions
> 10. DevOps: `get_dev_processes`, `get_port_usage`, `get_deploy_logs`
> 11. Website analysis: `scan_website` any URL, then use recon tools (`get_design_tokens`, `get_layout_tree`, `get_font_info`, etc.)
>
> **If a tool returns empty results**, the corresponding capture feature may not be enabled. Suggest the user enable it in their SDK config.
>
> **For SDK installation on any tech stack**, use `get_sdk_snippet` — it generates the right code for any framework including non-JS stacks (Flask, Django, Rails, PHP, WordPress).
>
> All tools return a consistent JSON envelope with `summary`, `data`, `issues`, and `metadata` fields. Use the `since_seconds` parameter on most tools to scope queries to a time window.

---

## MCP Tools (44)

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

### Process Monitor (5 tools)

| Tool | Description |
|------|-------------|
| `get_dev_processes` | List running dev processes (Next.js, Vite, Docker, etc.) with PID, port, memory, CPU. Filter by `type`, `project` |
| `kill_process` | Terminate a dev process by PID (SIGTERM or SIGKILL). Safety-guarded against system PIDs |
| `get_port_usage` | Show which processes are bound to which ports. Filter by `port` |
| `purge_caches` | Delete build/dev cache directories (.next/cache, node_modules/.cache, .vite, .turbo, etc.). Supports dry run |
| `restart_dev_server` | Kill process + purge caches + restart with inferred or custom command. One-step dev server reset |

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

### Website Scanner (2 tools)

| Tool | Description |
|------|-------------|
| `scan_website` | Visit any URL with a headless browser and extract comprehensive data: tech stack (7,221 technologies), design tokens, layout tree, accessibility structure, fonts, and asset inventory. After scanning, all recon tools return data from the scanned page. **No SDK installation required** |
| `get_sdk_snippet` | Generate a ready-to-paste code snippet to connect any web application to RuntimeScope. Works with **any tech stack** — React, Vue, Angular, Svelte, plain HTML, Flask, Django, Rails, PHP, WordPress, etc. Returns the appropriate installation method with framework-specific placement hints |

### Recon & Design Extraction (9 tools)

These tools return data from pages connected via the SDK **or** from pages scanned with `scan_website`. Use them after `scan_website` to drill into specific aspects of a page's design and structure.

| Tool | Description |
|------|-------------|
| `get_page_metadata` | Tech stack detection and page metadata: URL, viewport, meta tags, detected framework/UI library/build tool/hosting, external stylesheets and scripts |
| `get_design_tokens` | CSS custom properties (--variables), color palette, typography scale, spacing scale, border radii, box shadows, and CSS architecture detection. Essential for matching a site's visual style |
| `get_layout_tree` | DOM structure with layout information: element tags, classes, bounding rects, display mode (flex/grid/block), flex/grid properties, position, z-index. Optionally scoped to a CSS selector |
| `get_font_info` | @font-face declarations, font families used in computed styles, icon fonts with glyph usage, and font loading strategy |
| `get_accessibility_tree` | Heading hierarchy (h1-h6), ARIA landmarks, form fields with labels, buttons, links, images with alt text status |
| `get_asset_inventory` | Images, inline SVGs, SVG sprite sheets, CSS background sprites (with crop coordinates), CSS mask sprites, and icon fonts |
| `get_computed_styles` | Computed CSS styles for any selector. Filter by property group (colors, typography, spacing, layout, borders, visual) or specific properties |
| `get_element_snapshot` | Deep snapshot of a specific element and children: structure, attributes, text, bounding rects, computed styles. The "zoom in" tool for recreating a component |
| `get_style_diff` | Compare computed styles between two selectors. Reports property-by-property differences with match percentage. Use to verify UI recreation fidelity |

---

## Detected Patterns

`detect_issues` runs these pattern detectors automatically:

| Pattern | Trigger | Severity | Source |
|---------|---------|----------|--------|
| Failed requests | HTTP 4xx/5xx | HIGH (5xx) / MEDIUM (4xx) | Browser + Server |
| Slow requests | Duration > 3s | MEDIUM | Browser + Server |
| N+1 requests | Same endpoint > 5x in 2s | MEDIUM | Browser + Server |
| N+1 queries | Same query pattern > 5x in quick succession | MEDIUM | Server |
| Slow queries | Query duration > 500ms | MEDIUM | Server |
| Console error spam | Same error > 5x in 10s | MEDIUM | Browser + Server |
| High error rate | > 30% of console messages are errors | HIGH | Browser + Server |
| Excessive re-renders | Component render velocity > 4/sec | MEDIUM | Browser |
| Large state updates | State snapshot > 100KB | MEDIUM | Browser |
| Poor Web Vitals | Any metric rated "poor" | HIGH (LCP/CLS) / MEDIUM (others) | Browser |
| High heap usage | Heap used > 500MB | HIGH | Server |
| Event loop lag | p99 lag > 100ms | HIGH | Server |

---

## Use Cases & Scenarios

### Competitor Analysis & Brand Extraction

Scan any website to extract its complete design system — no access to their source code needed.

> "Scan https://linear.app and pull their brand colors, typography, and spacing system"

Claude will:
1. `scan_website({ url: "https://linear.app" })` — visits the page, detects 7,221+ technologies, extracts everything
2. `get_design_tokens()` — returns CSS custom properties, color palette, typography scale, spacing values
3. `get_font_info()` — returns exact font families, weights, and loading strategy
4. `get_layout_tree({ selector: ".hero" })` — returns DOM structure with flex/grid layout details

**Result:** Complete design spec — exact hex colors, font stacks, spacing scale, CSS variables — ready to use as reference for your own design system.

### UI Recreation & Pixel-Perfect Matching

Rebuild a specific component from any website with exact fidelity.

> "I need to recreate the pricing card from stripe.com/pricing. Scan the page and get me the exact styles."

Claude will:
1. `scan_website({ url: "https://stripe.com/pricing" })` — full page scan
2. `get_element_snapshot({ selector: ".pricing-card" })` — deep snapshot of the card: every child element, computed styles, bounding rects
3. `get_computed_styles({ selector: ".pricing-card .btn", properties: "visual" })` — exact button styles
4. `get_asset_inventory()` — images, SVGs, and icons used on the page

After building your version, use `get_style_diff` to compare your recreation against the original.

### Debugging a Flask / Django / Rails App

RuntimeScope works with **any** backend that serves HTML — not just JavaScript frameworks.

> "I'm building a Flask app and my AJAX requests are failing. Help me debug."

Claude will:
1. `get_sdk_snippet({ framework: "flask" })` — generates a `<script>` tag to paste in `templates/base.html`
2. After you add the snippet and reload: `get_session_info()` — confirms SDK is connected
3. `get_network_requests({ status: 500 })` — shows failed requests with timing and response details
4. `get_console_messages({ level: "error" })` — shows JavaScript errors
5. `detect_issues()` — automated pattern detection across all captured events

**The `<script>` tag approach works everywhere** — no npm, no build system, no Node.js required. Just paste two lines of HTML.

### Full-Stack Performance Debugging

Trace a slow user interaction across browser and server.

> "The checkout flow is slow. Help me figure out where the bottleneck is."

Claude will:
1. `clear_events()` — clean slate
2. (User reproduces the slow checkout)
3. `detect_issues()` — finds slow requests, N+1 queries, poor Web Vitals
4. `get_event_timeline({ since_seconds: 30 })` — chronological trace of what happened: button click → API call → database queries → response
5. `get_query_performance()` — detects N+1 patterns, shows p95 latencies
6. `get_api_health({ endpoint: "/api/checkout" })` — success rate and latency percentiles
7. `get_performance_metrics({ source: "server" })` — memory, CPU, event loop lag during the checkout

### Accessibility Audit of Any Website

Scan a website and get an instant accessibility report.

> "Audit the accessibility of our staging site at https://staging.myapp.com"

Claude will:
1. `scan_website({ url: "https://staging.myapp.com" })` — full page scan
2. `get_accessibility_tree()` — heading hierarchy, ARIA landmarks, form labels, image alt text status
3. Report issues: missing alt text, broken heading hierarchy, unlabeled form fields, missing landmarks

### Tech Stack Discovery

Find out what any website is built with — framework, hosting, analytics, CDN, and more.

> "What tech stack does vercel.com use?"

Claude will:
1. `scan_website({ url: "https://vercel.com" })` — detects from a database of 7,221 technologies
2. `get_page_metadata()` — framework, UI library, build tool, hosting platform, external scripts/stylesheets

Returns categorized results: Next.js (framework), React (UI library), Vercel (hosting), webpack (build tool), plus analytics, CDNs, fonts, and more.

---

## Project Structure

```
packages/
  sdk/           # Browser SDK (zero deps, ~3KB gzipped) — also served as IIFE via <script> tag
  server-sdk/    # Node.js server SDK (Prisma, Drizzle, pg, Knex, MySQL2, better-sqlite3)
  collector/     # WebSocket receiver + ring buffer + issue detection + HTTP API
  mcp-server/    # MCP stdio server with 44 tools + Playwright scanner
  extension/     # Technology detection engine (7,221 technologies from webappanalyzer)
  dashboard/     # Web dashboard for event visualization
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIMESCOPE_PORT` | `9090` | WebSocket collector port |
| `RUNTIMESCOPE_HTTP_PORT` | `9091` | HTTP API port |
| `RUNTIMESCOPE_BUFFER_SIZE` | `10000` | Max events in ring buffer |

## License

MIT
