import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  sessionId: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a function within a request context.
 * All async operations within `fn` will inherit this context.
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Get the current request context, if any.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Get the sessionId from the current request context,
 * falling back to the global sessionId.
 */
export function getSessionId(fallback: string): string {
  return storage.getStore()?.sessionId ?? fallback;
}
