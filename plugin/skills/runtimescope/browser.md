# Browser SDK — `@runtimescope/sdk`

Zero-dependency browser SDK. Captures fetch/XHR, console, errors, React renders, state stores (Redux/Zustand/Pinia), Web Vitals, clicks, and navigation. Ships ESM + IIFE builds.

## When to use

Any browser-side app — React, Vue, Svelte, SolidJS, vanilla JS, plain HTML. Works with Next.js / Remix / SvelteKit client bundles (pair with the server SDK for the server half).

## Install

```bash
npm install @runtimescope/sdk
```

Script-tag install (no bundler):

```html
<script src="https://unpkg.com/@runtimescope/sdk/dist/index.global.js"></script>
<script>RuntimeScope.init({ appName: 'my-app', projectId: 'proj_abc123' });</script>
```

## Init

```typescript
import RuntimeScope from '@runtimescope/sdk';

RuntimeScope.init({
  appName: 'my-web',
  projectId: 'proj_abc123def456',   // REQUIRED — browsers can't read .runtimescope/config.json
  endpoint: 'ws://localhost:6767',  // default
});
```

### Required fields for the browser

- `appName` — unique per app within the project (e.g. `my-web`, `admin`, `marketing-site`)
- `projectId` — **always inline**. Read it from `.runtimescope/config.json` at snippet-generation time and inline the value. The browser has no filesystem.

### Common mistakes

- Omitting `projectId`: events arrive but don't unify with server/worker events.
- Copy-pasting a project's `projectId` into a second project: collides in the dashboard.
- Initialising twice (e.g. under HMR): the SDK is idempotent — a second `init()` with the **same** DSN/appName silently no-ops. A second `init()` with a **different** DSN logs a `console.warn` explaining the mismatch (common footgun: `@runtimescope/vite` injects an init AND your `main.tsx` calls `RuntimeScope.init()` separately — drop the manual call).

### Useful options

- `verbose: true` — print SDK lifecycle messages (connect, disconnect, reconnect) to `console.debug`. Off by default to keep DevTools clean. Same as setting `localStorage.RUNTIMESCOPE_DEBUG = '1'`.
- `dedupeConsole: true` — collapse identical `console.*` output to DevTools. First 3 occurrences print, rest are suppressed for a 5s window, then a single summary line shows. The collector still receives every event for the dashboard — only the visible browser output is collapsed. Useful for noisy production apps.
- `dedupeConsole: { windowMs, maxBurst, summaryIntervalMs }` — fine-grained control.

## Placement

Init in the app entrypoint **before** any other code runs:
- Vite/CRA React: top of `src/main.tsx` or `src/index.tsx`
- Next.js: in a `ClientBootstrap` client component rendered in the root layout
- Vue: top of `src/main.ts` before `createApp`
- Svelte: top of `src/main.ts` before `new App()`

Initialising late means fetch/XHR calls made before `init()` are not captured.

## What gets captured

| Source | Event type |
|---|---|
| `fetch` + `XMLHttpRequest` | `network` |
| `console.*` | `console` |
| `window.onerror`, `unhandledrejection` | `error` |
| React render commits (via DevTools global hook) | `render` |
| Redux / Zustand / Pinia store updates | `state` |
| `PerformanceObserver` (LCP, CLS, INP, FCP, TTFB) | `performance` |
| Clicks on interactive elements | `ui-interaction` |
| `pushState` / `popstate` / `hashchange` | `navigation` |

## DSN form

For hosted collectors (or when you prefer a single URL over separate fields):

```typescript
RuntimeScope.init({ dsn: 'https://proj_abc123@collector.example.com/1' });
```

The DSN encodes `projectId`, `endpoint`, and (optionally) a bearer token — see the server-SDK docs for the full format.

## Verify

After loading the page:
1. `mcp__runtimescope__get_session_info` should show the app with `connected: true`.
2. `mcp__runtimescope__get_network_requests` should return the page's initial fetches.
3. `mcp__runtimescope__runtime_qa_check` for a one-call sanity pass.
