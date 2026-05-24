# User Identity — Design Doc (v0.11 proposal)

**Status**: Draft
**Author**: Edwin + Claude
**Created**: 2026-04-18
**Target release**: v0.11.0 (after v0.10.1 security patches)

## Goal

Let developers attach a stable user identity to every event captured by RuntimeScope, and filter sessions / events / errors / performance metrics by that identity from MCP tools, HTTP API, and the dashboard.

## Non-goals

- Durable user profiles with mutable attributes over time (no "user CRM"). Identity is a tag on events, not a first-class PII store.
- Identity resolution / deduplication across devices (no merge-anonymous-to-signed-in flows in v1 — just overwrite the current user).
- Authentication. `userId` is just an opaque string the app provides.

## Data model

### `UserContext` (shared type, mirrored across all 4 SDKs)

```ts
interface UserContext {
  id: string;                              // required — opaque, ≤256 chars
  email?: string;                          // optional — hashed before sending if `hashPii` is true
  name?: string;                           // optional — same treatment
  segments?: string[];                     // ["pro-tier", "beta-cohort-3"]
  attrs?: Record<string, string | number | boolean>;  // free-form, bounded
}
```

The `id` is the only required field; everything else is diagnostic. Max payload size per user object: 1KB (enforced SDK-side).

### Where it attaches

1. **Handshake** — initial user context for the session (existing, keep).
2. **Every event** — events gain an optional `userId?: string` field. If `userId` is absent on the event, the collector falls back to the session's current user. This lets a single SDK instance serve many users (server-side / workers) without re-handshaking.

## SDK surface (all four SDKs, same shape)

```ts
// Browser (@runtimescope/sdk)
RuntimeScope.setUser({ id: 'u_123', email: 'a@b.com' });
RuntimeScope.setUser(null);  // clear (e.g. on logout)

// Server (@runtimescope/server-sdk) — per-request context via AsyncLocalStorage
import { withUser, setUser } from '@runtimescope/server-sdk';

app.use((req, res, next) => {
  withUser({ id: req.auth.userId }, () => next());
});

// Workers (@runtimescope/workers-sdk) — per-request context via the existing
// requestContext AsyncLocalStorage already in handler.ts
withRuntimeScope(handler, { ..., resolveUser: (req) => ({ id: req.auth.sub }) });

// Python (runtimescope) — ContextVar for thread/async safety
import runtimescope
runtimescope.set_user({"id": "u_123"})
# Framework integrations auto-scope per-request
```

### Server-side propagation (critical)

- **Node**: `AsyncLocalStorage` — same pattern already used in workers-sdk. Middleware sets the user; all events emitted inside the request inherit it.
- **Python**: `contextvars.ContextVar` — preserves identity across `async`/thread boundaries.
- **Browser**: single global, no context needed (one user per tab at a time).

Without this, a busy Node server can't reliably tag events by user — you'd get last-write-wins races.

## Collector changes

### Ring buffer

Events gain an indexed `userId?: string` field. New in-memory map: `userIndex: Map<string, RingBufferCursor[]>` so `matchesUser()` is O(1) amortised. Eviction follows the ring buffer's FIFO — no separate lifecycle.

### Session storage

`ClientInfo` gains `currentUser?: UserContext` — mutated by a new `user_update` wire message (SDK → collector) when the app calls `setUser`. Last-write-wins per session.

### No SQLite table for v1

Users exist only as event tags. If durability is needed later, add `pm_users` as an append-only log of `(projectId, userId, firstSeen, lastSeen, attrs)` — but not in v1.

## Query API

### MCP tools

Add `user_id?: string` to every read tool that already accepts `session_id` / `project_id`:

- `get_network_requests`, `get_console_messages`, `get_errors_with_source_context`, `get_performance_metrics`, `get_render_profile`, `get_event_timeline`, `get_breadcrumbs`, `get_custom_events`, `get_query_log`, `get_historical_events`, `detect_issues`
- New tool: `list_users({ project_id, limit, since })` — returns distinct `userId`s in the buffer with event counts + first/last seen. Useful for "who's hitting this?"

### HTTP

`GET /api/events/*?user_id=u_123` — same filter, same semantics.

## Dashboard (v1 minimum)

- User filter control next to the existing project/session filters.
- Session list shows the session's current user (avatar from `name`/`email` initial, ID as tooltip).
- "Affected users" count on the Issues and Errors pages.
- No dedicated user detail view yet — defer to v11.1.

## Privacy / PII

- `hashPii?: boolean` SDK config option (default `false`). When `true`, `email` and `name` are SHA-256'd client-side before transport; `id` is passed through as-is (it's opaque).
- Dashboard displays email/name only if they arrive unhashed.
- `userId` should never be logged to `console._log` — audit the 4 SDK transports.

## Authorization (intersection with workspace model)

- `userId` is free-text, unauthenticated metadata. The SDK can claim any user. That's fine — it's the app's responsibility to supply a trustworthy ID.
- Workspace isolation still governs: a workspace A token can query its workspace's events filtered by any user, but can't reach into workspace B. (Once the v0.10.0 isolation bugs are fixed.)

## Migration / backwards compat

- Old events with no `userId` → filter returns them only when `user_id` is unset.
- Old SDKs → unchanged behavior; no user fields in events, handshake user only.
- No breaking changes to existing MCP tools — `user_id` is additive.

## Open questions

1. **Anonymous users**: do we auto-assign `anon_<random>` IDs when the app hasn't called `setUser`, or leave events un-tagged? (Recommend: un-tagged. Opt-in makes the data cleaner.)
2. **Retention**: do we promise "last 10K events" per user, or global? (Recommend: global — simpler, same ring buffer.)
3. **Cardinality cap**: do we bound `userIndex.size` to protect memory on a server with millions of users? (Recommend: LRU cap at ~10K distinct users in memory; events past that still tagged but not indexed for lookup.)
4. **Upgrade flow**: once we add `setUser`, should we auto-emit an `identify` event when it's called? (Recommend: yes — a dedicated event type makes "user signed in" queryable.)

## Rough effort

- SDK surface + AsyncLocalStorage wiring (4 SDKs + tests): ~6 hrs
- Collector ring-buffer index + ClientInfo field + wire message: ~3 hrs
- MCP tool param additions (15 tools): ~2 hrs
- `list_users` tool + HTTP route: ~1 hr
- Dashboard filter + session-list attribution: ~3 hrs
- Privacy hashing + audit: ~1 hr
- **Total**: ~16 hrs of focused work, probably 2 days.

## Dependencies

- Requires v0.10.1 to land first (workspace isolation bugs must be fixed before we promise per-user filtering inside a workspace boundary).
- Framework packages ([@runtimescope/nextjs](../../packages/nextjs/), [remix](../../packages/remix/), [sveltekit](../../packages/sveltekit/), [vite](../../packages/vite/)) need a `resolveUser` config pass-through once the server-sdk `withUser`/`setUser` API is stable.
