# Server-side SDKs — Node and Python

RuntimeScope ships **framework-specific packages** for Next.js, Remix, SvelteKit, and Vite-based apps, plus a generic `@runtimescope/server-sdk` for raw Node and a Python SDK on PyPI. Always pick the most specific package — the framework ones handle client + server + edge in one install and manage the subpath imports correctly.

## Pick the right package

| Stack | Package |
|---|---|
| Next.js (any runtime) | `@runtimescope/nextjs` |
| Remix | `@runtimescope/remix` |
| SvelteKit | `@runtimescope/sveltekit` |
| Vite-based (React, Vue, Solid, vanilla) | `@runtimescope/vite` (plugin) |
| Raw Node / Express / Koa / Fastify / NestJS | `@runtimescope/server-sdk` |
| Python (Django, Flask, FastAPI, …) | `runtimescope` (PyPI) |
| Ruby / PHP / WordPress / generic HTTP | Use `get_sdk_snippet` — generated install code |

Each framework package auto-reads `.runtimescope/config.json`, so `projectId` can be omitted in dev.

## Next.js — `@runtimescope/nextjs`

Next apps span three runtimes; use subpath imports, not the root export:

```typescript
// app/runtimescope-client.tsx (Client Component, rendered in root layout)
'use client';
import { init } from '@runtimescope/nextjs/client';
init({ appName: 'my-web' });
export default function RS() { return null; }

// instrumentation.ts (project root)
export { register } from '@runtimescope/nextjs/server';

// middleware.ts or edge route
import { withRuntimeScope } from '@runtimescope/nextjs/edge';
export default withRuntimeScope(handler, { appName: 'my-edge' });
```

Never import SDK classes from `@runtimescope/nextjs` (the root) — that bundles all three runtimes into every runtime and breaks the build.

## Remix — `@runtimescope/remix`

```typescript
// app/entry.client.tsx
import { init } from '@runtimescope/remix/client';
init({ appName: 'my-web' });

// app/entry.server.tsx
import { register } from '@runtimescope/remix/server';
await register({ appName: 'my-api' });
```

## SvelteKit — `@runtimescope/sveltekit`

```typescript
// src/hooks.client.ts
import { init } from '@runtimescope/sveltekit/client';
init({ appName: 'my-web' });

// src/hooks.server.ts
import { register } from '@runtimescope/sveltekit/server';
await register({ appName: 'my-api' });
```

## Vite-based apps — `@runtimescope/vite`

A Vite plugin that auto-injects the browser SDK via `transformIndexHtml` and prints a collector-readiness warning on `vite dev`. No source changes needed.

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { runtimescope } from '@runtimescope/vite';

export default defineConfig({
  plugins: [runtimescope()], // reads DSN from RUNTIMESCOPE_DSN env var
});
```

The plugin skips injection on production builds unless a DSN is present, so it's safe to leave enabled.

## Raw Node — `@runtimescope/server-sdk`

When no framework package fits (Express, Koa, Fastify, NestJS, raw `http`):

```typescript
import RuntimeScope from '@runtimescope/server-sdk';

await RuntimeScope.connect({
  appName: 'my-api',
  // projectId optional — read from .runtimescope/config.json
});
```

Auto-patches on import when detected: **Prisma, node-postgres, Knex, Drizzle, mysql2, better-sqlite3**. Also captures `console.*`, uncaught errors, outbound HTTP, and (with `middleware()`) per-request spans.

## Python — `runtimescope` on PyPI

```bash
pip install runtimescope
```

```python
import runtimescope
runtimescope.init(app_name="my-api")  # reads .runtimescope/config.json
```

Django/Flask/FastAPI integrations live in `runtimescope.integrations.*`. Call `get_sdk_snippet({ framework: "django" | "flask" | "fastapi", ... })` for the exact init snippet.

## Placement

Initialize as early as possible — **before** any DB client is constructed. Late init means the first requests escape instrumentation.

- Next.js: `instrumentation.ts` at project root with `export { register }`
- Remix: top of `entry.server.tsx`
- SvelteKit: top of `hooks.server.ts`
- Express/raw Node: top of the entrypoint (`server.ts` / `index.ts`)
- NestJS: before `NestFactory.create()`

## What gets captured

| Source | Event type |
|---|---|
| Prisma / pg / Knex / Drizzle / mysql2 / sqlite | `database` |
| `console.*` | `console` |
| `uncaughtException`, `unhandledRejection` | `error` |
| Outbound `http` / `https` / `fetch` | `network` |
| Middleware request spans | `performance` |
| Sampled metrics (event loop lag, RSS) | `performance` |

## DSN form (production / hosted)

```typescript
await RuntimeScope.connect({
  dsn: process.env.RUNTIMESCOPE_DSN,
  // e.g. https://proj_abc123:wsk_secret@collector.example.com/1
});
```

The **password component is the workspace API key** (bearer token) — required for hosted/multi-tenant collectors. See [workspaces.md](workspaces.md).

## Verify

1. `wait_for_session` — block until the app connects (better than polling).
2. `get_session_info` — server app listed with `connected: true` and the right projectId.
3. `get_query_log` — recent queries appear as traffic flows.
4. `runtime_qa_check` — holistic sanity check.

## Non-Node / non-Python servers

If the stack is Ruby, PHP, WordPress, or anything else, don't bail out:

```
get_sdk_snippet({ app_name: "my-api", framework: "rails", project_id: "proj_abc123" })
```

Supported frameworks include: `rails`, `sinatra`, `laravel`, `symfony`, `wordpress`, `php-generic`.
