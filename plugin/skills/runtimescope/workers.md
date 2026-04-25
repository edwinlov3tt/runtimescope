# Workers SDK — `@runtimescope/workers-sdk`

Zero-dependency SDK for Cloudflare Workers. Sends events via HTTP POST (not WebSocket — Workers can't hold persistent connections) to the collector's `/api/events` endpoint. Auto-flushes via `ctx.waitUntil()` at the end of each request.

## When to use

Any Cloudflare Worker: plain fetch handlers, Hono, itty-router, Remix-on-Workers, Next-on-Workers, Pages Functions. Also Durable Objects (wrap the `fetch` on the DO class the same way).

## Install

```bash
npm install @runtimescope/workers-sdk
```

## Init

Wrap the fetch handler. There is no long-lived `connect()` — the Worker boots per request.

```typescript
import { withRuntimeScope } from '@runtimescope/workers-sdk';

export default withRuntimeScope(
  {
    async fetch(request, env, ctx) {
      return new Response('hello');
    },
  },
  {
    appName: 'my-worker',
    projectId: 'proj_abc123def456',  // REQUIRED — Workers have no filesystem
    endpoint: 'http://localhost:6768/api/events',  // HTTP, not ws://
  }
);
```

### Required fields for Workers

- `appName`
- `projectId` — **always inline**. Workers have no filesystem and can't read `.runtimescope/config.json`. Either hardcode (local dev only) or source from a `wrangler.toml` var.
- `endpoint` — HTTP URL to the collector's `/api/events` route. Default port `6768`.

> **Note**: in v0.10.x the option was named `httpEndpoint`; both work for backwards compatibility, but `endpoint` is the canonical name (matches the browser and server SDKs). If both are passed, `endpoint` wins.

Use secrets or `vars` in `wrangler.toml`:

```toml
[vars]
RUNTIMESCOPE_PROJECT_ID = "proj_abc123def456"
RUNTIMESCOPE_ENDPOINT = "https://collector.example.com/api/events"
```

Then:

```typescript
withRuntimeScope(handler, {
  appName: 'my-worker',
  projectId: env.RUNTIMESCOPE_PROJECT_ID,
  endpoint: env.RUNTIMESCOPE_ENDPOINT,
});
```

## Binding instrumentation

Wrap Cloudflare bindings to capture D1 queries, KV reads/writes, and R2 operations. Two forms:

**Manual** — explicit transport wiring:

```typescript
import { instrumentD1 } from '@runtimescope/workers-sdk';

const db = instrumentD1(env.DB, transport, sessionId);
```

**Auto-wired** (preferred) — uses the active request context set up by `withRuntimeScope`:

```typescript
import { scopeD1, scopeKV, scopeR2 } from '@runtimescope/workers-sdk';

export default withRuntimeScope({
  async fetch(request, env, ctx) {
    const db = scopeD1(env.DB);       // auto-attaches to the current request
    const cache = scopeKV(env.CACHE);
    const bucket = scopeR2(env.UPLOADS);
    // ... use as normal
  },
}, { appName: 'my-worker', projectId: env.RUNTIMESCOPE_PROJECT_ID });
```

## What gets captured

| Source | Event type |
|---|---|
| Request/response (method, URL, status, duration) | `network` |
| D1 prepared statements + batches | `database` |
| KV `get` / `put` / `delete` / `list` | `database` |
| R2 `get` / `put` / `delete` / `list` / `head` | `database` |
| `console.*` | `console` |
| Uncaught exceptions | `error` |

## Flush behavior

Events are queued in-memory per request and flushed via `ctx.waitUntil(transport.flush())` at the end of the request. No timer, no background work — Workers don't permit it. If the collector is unreachable, events are dropped (logged to `_log`).

## Hosted / production

For hosted collectors, pass the DSN instead of `projectId` + `endpoint`:

```typescript
withRuntimeScope(handler, {
  appName: 'my-worker',
  dsn: env.RUNTIMESCOPE_DSN, // https://proj_abc123:token@collector.example.com/1
});
```

## Verify

Workers don't maintain a persistent session, so `get_session_info` is less useful. Instead:

1. Hit a worker route that emits events.
2. `mcp__runtimescope__get_network_requests` — should show the Worker's outbound calls.
3. `mcp__runtimescope__get_query_log` — should show D1/KV/R2 ops if any were made.
