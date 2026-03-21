# Task: Build @runtimescope/workers-sdk

## Status: ⬜ Not Started

## Meta
- **Priority**: P1
- **Effort**: M (3-5 days)
- **Created**: 2026-03-20
- **Source**: Cloudflare compatibility audit
- **Branch**: `feature/workers-sdk`

## Goal
Create a purpose-built `@runtimescope/workers-sdk` package for Cloudflare Workers (and other edge runtimes). Not a port of the Node.js server SDK — a slim, edge-native wrapper that captures request/response metrics, errors, console output, and D1/KV/R2 binding activity. Uses the existing `HttpTransport` and `POST /api/events` collector endpoint.

## Requirements
- [ ] Zero Node.js dependencies — must pass `wrangler deploy` without errors
- [ ] Captures incoming request method, URL, status, duration, headers, CF properties
- [ ] Captures errors/exceptions with stack traces
- [ ] Captures console.log/warn/error
- [ ] Wraps D1 bindings to capture SQL queries (method, duration, rows)
- [ ] Wraps KV bindings to capture get/put/delete operations
- [ ] Wraps R2 bindings to capture object storage operations
- [ ] Flushes events via `ctx.waitUntil()` (not timers)
- [ ] Sampling support (`sampleRate: 0.0-1.0`)
- [ ] `beforeSend` hook for filtering/redaction
- [ ] Published as `@runtimescope/workers-sdk` on npm
- [ ] Works with both module and service worker syntax

---

## Dependencies

### Blocked By
None — the collector HTTP endpoint (`POST /api/events`) and `HttpTransport` class already exist.

### Blocks
| Task | Impact |
|------|--------|
| Cloudflare D1 query monitoring | Workers SDK provides the instrumentation layer |

### Parallel Safety
Safe to parallelize with any task — creates a new package with no shared files.

---

## Pre-Implementation Checklist

Before writing any code:

- [ ] Read these files for context:
  1. `packages/server-sdk/src/http-transport.ts` — reusable transport (uses only `fetch`)
  2. `packages/server-sdk/src/interceptors/console.ts` — console interception pattern
  3. `packages/collector/src/http-server.ts:282-362` — `POST /api/events` endpoint spec
  4. `packages/collector/src/types.ts` — canonical event types
- [ ] Branch created: `git checkout -b feature/workers-sdk`
- [ ] Understand the acceptance criteria below

### What Can Be Reused
- **HttpTransport** — copy and simplify (remove Node.js `setInterval`, use `waitUntil` instead)
- **Event types** — `NetworkEvent`, `ConsoleEvent`, `DatabaseEvent` from collector types
- **Session ID generation** — `crypto.randomUUID()` (available in Workers)
- **Console interceptor pattern** — monkey-patch + restore, no Node.js APIs

### What Must Be Written From Scratch
- Workers fetch handler wrapper (`withRuntimeScope()`)
- D1/KV/R2 binding wrappers
- `ctx.waitUntil()`-based flush mechanism
- Workers-specific error capture (no `process.on`)

---

## Implementation Steps

### Step 1: Package Scaffold
**Time**: ~30 min

**Files**:
- `packages/workers-sdk/package.json` — create
- `packages/workers-sdk/tsup.config.ts` — create
- `packages/workers-sdk/tsconfig.json` — create
- `packages/workers-sdk/src/index.ts` — create entry

**Do**:
```json
{
  "name": "@runtimescope/workers-sdk",
  "version": "0.7.2",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "files": ["dist"],
  "dependencies": {}
}
```
- Target `es2022` (Workers V8 isolate)
- Zero dependencies — everything inline
- Add to root `package.json` workspaces array

**Verify**:
- [ ] `npm run build -w packages/workers-sdk` produces `dist/index.js`

---

### Step 2: Transport Layer
**Time**: ~1 hour

**Files**:
- `packages/workers-sdk/src/transport.ts` — create

**Do**:
Simplified version of `HttpTransport` without timers:
- `queueEvent(event)` — adds to buffer
- `flush(ctx)` — POSTs buffered events via `ctx.waitUntil(fetch(...))`
- Auto-registers session on first flush (sends `appName`, `sdkVersion`)
- No `setInterval` — flush is called explicitly per-request
- Retry: single retry on network error (Workers have 30s CPU limit)
- Configurable endpoint: `httpEndpoint` or derive from `RUNTIMESCOPE_ENDPOINT` env

```typescript
export class WorkersTransport {
  private buffer: RuntimeEvent[] = [];
  private sessionId: string;
  private registered = false;

  constructor(private config: WorkersConfig) {
    this.sessionId = crypto.randomUUID();
  }

  queue(event: RuntimeEvent) {
    if (this.buffer.length < (this.config.maxQueueSize ?? 1000)) {
      this.buffer.push(event);
    }
  }

  flush(ctx: ExecutionContext) {
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0);
    ctx.waitUntil(this.send(events));
  }

  private async send(events: RuntimeEvent[]) {
    await fetch(this.config.httpEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: this.sessionId, appName: this.config.appName, events }),
    }).catch(() => {}); // Fire-and-forget in Workers
  }
}
```

**Verify**:
- [ ] Transport compiles with no Node.js types
- [ ] `ctx.waitUntil` typed correctly from `@cloudflare/workers-types`

---

### Step 3: Console Interceptor
**Time**: ~30 min

**Files**:
- `packages/workers-sdk/src/interceptors/console.ts` — create

**Do**:
Copy pattern from `server-sdk/src/interceptors/console.ts`, remove Node.js specifics:
- Patch `console.log`, `console.warn`, `console.error`, `console.info`, `console.debug`
- Capture message + args + level + timestamp
- Return restore function
- No `stack` capture (expensive in Workers, optional flag)

**Verify**:
- [ ] Console events emitted with correct level and message

---

### Step 4: Fetch Handler Wrapper
**Time**: ~1.5 hours

**Files**:
- `packages/workers-sdk/src/handler.ts` — create

**Do**:
The core API — wraps a Workers fetch handler to capture request/response metrics:

```typescript
export function withRuntimeScope(
  handler: ExportedHandler,
  config: WorkersConfig,
): ExportedHandler {
  const transport = new WorkersTransport(config);
  const restoreConsole = interceptConsole((event) => transport.queue(event));

  return {
    async fetch(request, env, ctx) {
      const start = Date.now();
      const method = request.method;
      const url = new URL(request.url);

      try {
        const response = await handler.fetch!(request, env, ctx);
        transport.queue({
          type: 'network',
          timestamp: start,
          data: {
            url: url.pathname,
            method,
            status: response.status,
            duration: Date.now() - start,
            source: 'server',
            direction: 'incoming',
            cfProperties: request.cf, // Ray ID, colo, country, etc.
          },
        });
        transport.flush(ctx);
        return response;
      } catch (error) {
        transport.queue({
          type: 'console',
          timestamp: Date.now(),
          data: {
            level: 'error',
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        });
        transport.flush(ctx);
        throw error;
      }
    },
  };
}
```

Key details:
- Captures `request.cf` properties (Cloudflare-specific: colo, country, rayId, etc.)
- Flushes at the end of every request via `ctx.waitUntil()`
- Propagates errors after capturing them
- Sampling: check `Math.random() < config.sampleRate` before capturing

**Verify**:
- [ ] Wrap a test handler, confirm network event emitted
- [ ] Error in handler is captured AND re-thrown

---

### Step 5: D1 Binding Wrapper
**Time**: ~1.5 hours

**Files**:
- `packages/workers-sdk/src/bindings/d1.ts` — create

**Do**:
Wrap a D1 database binding to capture queries:

```typescript
export function instrumentD1(db: D1Database, transport: WorkersTransport): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (query: string) => {
          const stmt = target.prepare(query);
          return instrumentD1Statement(stmt, query, transport);
        };
      }
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          const start = Date.now();
          const results = await target.batch(stmts);
          transport.queue({
            type: 'database',
            timestamp: start,
            data: { query: `BATCH (${stmts.length} statements)`, duration: Date.now() - start, source: 'd1' },
          });
          return results;
        };
      }
      return Reflect.get(target, prop);
    },
  });
}
```

Capture: query text, duration, rows affected/returned, errors.

**Verify**:
- [ ] D1 queries appear as `database` events with correct timing

---

### Step 6: KV and R2 Binding Wrappers
**Time**: ~1 hour

**Files**:
- `packages/workers-sdk/src/bindings/kv.ts` — create
- `packages/workers-sdk/src/bindings/r2.ts` — create

**Do**:
Proxy wrappers similar to D1:

**KV**: Wrap `get`, `put`, `delete`, `list` — capture key, operation, duration
**R2**: Wrap `get`, `put`, `delete`, `list`, `head` — capture key, operation, size, duration

Both emit events with `type: 'database'` and `source: 'kv'` / `source: 'r2'` for consistency with existing tools.

**Verify**:
- [ ] KV get/put operations emit events
- [ ] R2 operations emit events with size info

---

### Step 7: Configuration and Exports
**Time**: ~30 min

**Files**:
- `packages/workers-sdk/src/index.ts` — finalize exports
- `packages/workers-sdk/src/types.ts` — create

**Do**:
```typescript
export { withRuntimeScope } from './handler.js';
export { instrumentD1 } from './bindings/d1.js';
export { instrumentKV } from './bindings/kv.js';
export { instrumentR2 } from './bindings/r2.js';
export type { WorkersConfig } from './types.js';
```

Config type:
```typescript
export interface WorkersConfig {
  appName: string;
  httpEndpoint?: string;           // default: 'http://localhost:9091/api/events'
  authToken?: string;
  sampleRate?: number;             // 0.0-1.0, default 1.0
  maxQueueSize?: number;           // default 1000
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null;
  captureConsole?: boolean;        // default true
  captureHeaders?: boolean;        // default false
  redactHeaders?: string[];        // default ['authorization', 'cookie']
}
```

**Verify**:
- [ ] All exports resolve correctly
- [ ] Types are generated in dist/

---

### Step 8: Tests
**Time**: ~1.5 hours

**Files**:
- `packages/workers-sdk/src/__tests__/transport.test.ts`
- `packages/workers-sdk/src/__tests__/handler.test.ts`
- `packages/workers-sdk/src/__tests__/d1.test.ts`

**Do**:
- Mock `fetch` for transport tests (verify POST body shape matches collector API)
- Mock `ExecutionContext` with `waitUntil` spy
- Mock D1 database binding for query capture tests
- Test sampling: set `sampleRate: 0.5`, run 1000 requests, verify ~50% captured
- Test `beforeSend` filtering
- Test error propagation (errors are captured AND re-thrown)

**Verify**:
- [ ] `npx vitest run packages/workers-sdk` passes
- [ ] Coverage on transport, handler, D1 wrapper

---

### Step 9: Documentation and README
**Time**: ~30 min

**Files**:
- `packages/workers-sdk/README.md` — create
- Root `README.md` — add Workers SDK section

**Do**:
Quick-start README:
```typescript
import { withRuntimeScope, instrumentD1 } from '@runtimescope/workers-sdk';

export default withRuntimeScope({
  async fetch(request, env, ctx) {
    const db = instrumentD1(env.DB, ctx.__rs);
    const results = await db.prepare('SELECT * FROM users').all();
    return Response.json(results);
  },
}, {
  appName: 'my-worker',
  httpEndpoint: 'https://collector.example.com/api/events',
});
```

Add to root README under "Backend SDK" section.

**Verify**:
- [ ] README code example compiles
- [ ] Root README updated

---

### Step 10: Build and Publish Setup
**Time**: ~30 min

**Files**:
- `.github/workflows/publish.yml` — add workers-sdk to publish matrix
- Root `package.json` — verify workspace includes `packages/workers-sdk`

**Do**:
- Add `workers-sdk` to CI build and publish workflow
- Verify `npm run build` from root builds all packages including workers-sdk
- Test `npm pack -w packages/workers-sdk` produces correct tarball

**Verify**:
- [ ] `npm run build` succeeds with workers-sdk included
- [ ] `npm pack` includes only `dist/` and `package.json`

---

## Files to Modify

| File | Action | What Changes |
|------|--------|--------------|
| `packages/workers-sdk/` | Create | New package (all files) |
| `package.json` (root) | Modify | Add `packages/workers-sdk` to workspaces |
| `README.md` (root) | Modify | Add Workers SDK install/usage section |
| `.github/workflows/publish.yml` | Modify | Add workers-sdk to publish matrix |

---

## Verification

Before marking complete:
- [ ] All implementation steps done
- [ ] `npm run build` builds all packages including workers-sdk
- [ ] `npx vitest run packages/workers-sdk` passes
- [ ] Package has zero Node.js dependencies
- [ ] `wrangler deploy` succeeds with a test worker using the SDK
- [ ] Events appear in collector when test worker handles requests
- [ ] D1 queries captured correctly
- [ ] Sampling works (sampleRate < 1.0 reduces events proportionally)
- [ ] No Node.js built-in imports (`node:*`, `fs`, `path`, `child_process`, etc.)
- [ ] ESM with `.js` extensions in all imports (project convention)

---

## Completion

When done: `/task done workers-sdk`
