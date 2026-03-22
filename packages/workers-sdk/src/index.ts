// ============================================================
// @runtimescope/workers-sdk
// Zero-dependency SDK for Cloudflare Workers.
// Captures requests, D1 queries, KV/R2 ops, console, errors.
// ============================================================

export { withRuntimeScope } from './handler.js';
export { getActiveContext } from './handler.js';
export type { WorkersFetchHandler, RuntimeScopeContext } from './handler.js';

export { instrumentD1 } from './bindings/d1.js';
export { instrumentKV } from './bindings/kv.js';
export { instrumentR2 } from './bindings/r2.js';

export { WorkersTransport } from './transport.js';
export { Sampler } from './sampler.js';
export { generateId, generateSessionId } from './utils.js';

export type {
  WorkersConfig,
  WorkersRuntimeEvent,
  ConsoleEvent,
  DatabaseEvent,
  NetworkEvent,
  CustomEvent,
  UIInteractionEvent,
  UserContext,
  ConsoleLevel,
  DatabaseOperation,
  DatabaseSource,
  D1DatabaseBinding,
  D1PreparedStatementBinding,
  D1Result,
  KVNamespaceBinding,
  R2BucketBinding,
  R2Object,
  R2ObjectBody,
  R2Objects,
} from './types.js';

// ============================================================
// Convenience: instrument bindings using the active request context
// These are shortcuts that automatically use the current request's
// transport and session ID — no manual wiring needed.
// ============================================================

import { getActiveContext } from './handler.js';
import { instrumentD1 as _instrumentD1 } from './bindings/d1.js';
import { instrumentKV as _instrumentKV } from './bindings/kv.js';
import { instrumentR2 as _instrumentR2 } from './bindings/r2.js';
import { generateId } from './utils.js';
import type {
  D1DatabaseBinding,
  KVNamespaceBinding,
  R2BucketBinding,
  CustomEvent,
  UIInteractionEvent,
} from './types.js';

/**
 * Instrument a D1 database using the active request context.
 * Must be called inside a withRuntimeScope handler.
 *
 * @example
 * ```ts
 * import { withRuntimeScope, scopeD1 } from '@runtimescope/workers-sdk';
 *
 * export default withRuntimeScope({
 *   async fetch(request, env, ctx) {
 *     const db = scopeD1(env.DB);
 *     const users = await db.prepare('SELECT * FROM users').all();
 *     return Response.json(users);
 *   },
 * }, { appName: 'my-worker' });
 * ```
 */
export function scopeD1<T extends D1DatabaseBinding>(db: T): T {
  const ctx = getActiveContext();
  if (!ctx) return db; // No active context — return unwrapped (safe for non-instrumented calls)
  return _instrumentD1(db, ctx.emit, { sessionId: ctx.sessionId }) as T;
}

/** Instrument a KV namespace using the active request context. */
export function scopeKV<T extends KVNamespaceBinding>(kv: T): T {
  const ctx = getActiveContext();
  if (!ctx) return kv;
  return _instrumentKV(kv, ctx.emit, { sessionId: ctx.sessionId }) as T;
}

/** Instrument an R2 bucket using the active request context. */
export function scopeR2<T extends R2BucketBinding>(bucket: T): T {
  const ctx = getActiveContext();
  if (!ctx) return bucket;
  return _instrumentR2(bucket, ctx.emit, { sessionId: ctx.sessionId }) as T;
}

// ============================================================
// Custom event tracking & breadcrumbs
// Must be called inside a withRuntimeScope handler.
// ============================================================

/**
 * Track a custom business event (e.g., user signup, payment processed).
 * Must be called inside a withRuntimeScope handler.
 *
 * @example
 * ```ts
 * import { withRuntimeScope, track } from '@runtimescope/workers-sdk';
 *
 * export default withRuntimeScope({
 *   async fetch(request, env, ctx) {
 *     track('payment.processed', { amount: 99.99, currency: 'USD' });
 *     return new Response('OK');
 *   },
 * }, { appName: 'payments-worker' });
 * ```
 */
export function track(name: string, properties?: Record<string, unknown>): void {
  const ctx = getActiveContext();
  if (!ctx) return;
  const event: CustomEvent = {
    eventId: generateId(),
    sessionId: ctx.sessionId,
    timestamp: Date.now(),
    eventType: 'custom',
    name,
    ...(properties && { properties }),
  };
  ctx.emit(event);
}

/**
 * Add a breadcrumb to the current request's event trail.
 * Useful for marking key points in request processing.
 *
 * @example
 * ```ts
 * import { withRuntimeScope, addBreadcrumb } from '@runtimescope/workers-sdk';
 *
 * export default withRuntimeScope({
 *   async fetch(request, env, ctx) {
 *     addBreadcrumb('auth check passed', { userId: '123' });
 *     // ... process request
 *     addBreadcrumb('cache miss, fetching from origin');
 *     return new Response('OK');
 *   },
 * }, { appName: 'api-worker' });
 * ```
 */
export function addBreadcrumb(message: string, data?: Record<string, unknown>): void {
  const ctx = getActiveContext();
  if (!ctx) return;
  const event: UIInteractionEvent = {
    eventId: generateId(),
    sessionId: ctx.sessionId,
    timestamp: Date.now(),
    eventType: 'ui',
    action: 'breadcrumb',
    target: 'manual',
    text: message,
    ...(data && { data }),
  };
  ctx.emit(event);
}
