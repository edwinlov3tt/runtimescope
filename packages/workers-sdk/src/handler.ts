import type {
  WorkersConfig,
  WorkersRuntimeEvent,
  NetworkEvent,
  ConsoleEvent,
  UserContext,
} from './types.js';
import { WorkersTransport } from './transport.js';
import { Sampler } from './sampler.js';
import { interceptConsole } from './interceptors/console.js';
import { generateId } from './utils.js';
import { parseDsn } from './dsn.js';

// ============================================================
// withRuntimeScope — wraps a Workers fetch handler
// Captures request/response metrics, errors, console output.
// Flushes all events via ctx.waitUntil() at end of request.
// ============================================================

/** Internal context exposed to binding wrappers */
export interface RuntimeScopeContext {
  transport: WorkersTransport;
  sessionId: string;
  config: WorkersConfig;
  emit: (event: WorkersRuntimeEvent) => void;
}

// Per-request context — AsyncLocalStorage for isolation under concurrent requests.
// Lazy-loaded to avoid crashing in environments where node:async_hooks isn't available.
let _contextStorage: { run: <T>(ctx: RuntimeScopeContext, fn: () => T) => T; getStore: () => RuntimeScopeContext | undefined } | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const req: (id: string) => unknown = (globalThis as Record<string, unknown>).require as never
    ?? (Function('m', 'return require(m)') as (id: string) => unknown);
  const { AsyncLocalStorage } = req('node:async_hooks') as { AsyncLocalStorage: new <T>() => { run: <R>(ctx: T, fn: () => R) => R; getStore: () => T | undefined } };
  _contextStorage = new AsyncLocalStorage<RuntimeScopeContext>();
} catch {
  // Fallback: simple global context (safe for single-request-at-a-time dev mode)
  let _currentContext: RuntimeScopeContext | undefined;
  _contextStorage = {
    run<T>(ctx: RuntimeScopeContext, fn: () => T): T {
      const prev = _currentContext;
      _currentContext = ctx;
      try { return fn(); } finally { _currentContext = prev; }
    },
    getStore() { return _currentContext; },
  };
}

/** Get the active RuntimeScope context (used by binding wrappers) */
export function getActiveContext(): RuntimeScopeContext | null {
  return _contextStorage?.getStore() ?? null;
}

const DEFAULT_REDACT_HEADERS = ['authorization', 'cookie', 'set-cookie'];

export interface WorkersFetchHandler {
  fetch(
    request: Request,
    env: unknown,
    ctx: ExecutionContext,
  ): Response | Promise<Response>;
}

/**
 * Wrap a Workers fetch handler to capture request/response metrics,
 * errors, and console output. Events are flushed via ctx.waitUntil().
 *
 * @example
 * ```ts
 * import { withRuntimeScope } from '@runtimescope/workers-sdk';
 *
 * export default withRuntimeScope({
 *   async fetch(request, env, ctx) {
 *     return new Response('Hello!');
 *   },
 * }, { appName: 'my-worker' });
 * ```
 */
export function withRuntimeScope(
  handler: WorkersFetchHandler,
  config: WorkersConfig,
): WorkersFetchHandler {
  // Never crash the app — if SDK init fails, pass through to the original handler
  try {
    return _withRuntimeScope(handler, config);
  } catch (err) {
    console.warn('[RuntimeScope] SDK init failed, running without instrumentation:', (err as Error).message);
    return handler;
  }
}

function _withRuntimeScope(
  handler: WorkersFetchHandler,
  config: WorkersConfig,
): WorkersFetchHandler {
  // DSN resolution
  if (config.dsn) {
    try {
      const parsed = parseDsn(config.dsn);
      config = {
        ...config,
        // Use the canonical `endpoint` field, matching the browser and
        // server SDK config surface. The transport falls back to
        // `httpEndpoint` for v0.10.x callers.
        endpoint: parsed.httpEndpoint + '/api/events',
        projectId: parsed.projectId,
        ...(parsed.authToken ? { authToken: parsed.authToken } : {}),
        ...(parsed.appName && !config.appName ? { appName: parsed.appName } : {}),
      };
    } catch {
      // Invalid DSN — continue with individual fields
    }
  }

  const transport = new WorkersTransport(config);
  const sampler = config.sampleRate !== undefined && config.sampleRate < 1
    ? new Sampler({ sampleRate: config.sampleRate })
    : null;

  const redactHeaders = config.redactHeaders ?? DEFAULT_REDACT_HEADERS;
  const redactSet = new Set(redactHeaders.map((h) => h.toLowerCase()));

  function emit(event: WorkersRuntimeEvent): void {
    if (sampler && !sampler.shouldSample(event)) return;
    if (config.beforeSend) {
      const filtered = config.beforeSend(event);
      if (!filtered) return;
      transport.queue(filtered);
    } else {
      transport.queue(event);
    }
  }

  // Set up console interceptor (persistent across requests)
  let restoreConsole: (() => void) | null = null;
  if (config.captureConsole !== false) {
    restoreConsole = interceptConsole(emit, {
      sessionId: transport.sessionId,
    });
  }

  function extractHeaders(headers: Headers): Record<string, string> {
    if (!config.captureHeaders) return {};
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = redactSet.has(key.toLowerCase()) ? '[REDACTED]' : value;
    });
    return result;
  }

  return {
    async fetch(
      request: Request,
      env: unknown,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const start = Date.now();
      const url = new URL(request.url);

      // Run handler inside AsyncLocalStorage so binding wrappers
      // get the correct per-request context even under concurrency
      const rsContext: RuntimeScopeContext = {
        transport,
        sessionId: transport.sessionId,
        config,
        emit,
      };

      return _contextStorage!.run(rsContext, async () => {
        try {
          const response = await handler.fetch(request, env, ctx);
          const duration = Date.now() - start;

          const networkEvent: NetworkEvent = {
            eventId: generateId(),
            sessionId: transport.sessionId,
            timestamp: start,
            eventType: 'network',
            url: url.pathname + url.search,
            method: request.method,
            status: response.status,
            duration,
            requestHeaders: extractHeaders(request.headers),
            responseHeaders: extractHeaders(response.headers),
            requestBodySize: 0,
            responseBodySize: 0,
            ttfb: duration,
            source: 'workers',
            direction: 'incoming',
            cfProperties: extractCfProperties(request),
          };

          emit(networkEvent);
          ctx.waitUntil(transport.flush());
          return response;
        } catch (error) {
          const duration = Date.now() - start;

          // Capture the error as a console error event
          const errorEvent: ConsoleEvent = {
            eventId: generateId(),
            sessionId: transport.sessionId,
            timestamp: Date.now(),
            eventType: 'console',
            level: 'error',
            message: error instanceof Error ? error.message : String(error),
            args: [error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)],
            stackTrace: error instanceof Error ? error.stack : undefined,
          };

          emit(errorEvent);

          // Also capture the failed request
          const networkEvent: NetworkEvent = {
            eventId: generateId(),
            sessionId: transport.sessionId,
            timestamp: start,
            eventType: 'network',
            url: url.pathname + url.search,
            method: request.method,
            status: 500,
            duration,
            requestHeaders: extractHeaders(request.headers),
            responseHeaders: {},
            requestBodySize: 0,
            responseBodySize: 0,
            ttfb: duration,
            source: 'workers',
            direction: 'incoming',
            cfProperties: extractCfProperties(request),
            errorMessage: error instanceof Error ? error.message : String(error),
          };

          emit(networkEvent);
          ctx.waitUntil(transport.flush());
          throw error;
        }
      });
    },
  };
}

function extractCfProperties(request: Request): NetworkEvent['cfProperties'] | undefined {
  // request.cf is Cloudflare-specific — may not exist in non-CF environments
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf;
  if (!cf) return undefined;

  return {
    colo: cf.colo as string | undefined,
    country: cf.country as string | undefined,
    city: cf.city as string | undefined,
    region: cf.region as string | undefined,
    asn: cf.asn as number | undefined,
    httpProtocol: cf.httpProtocol as string | undefined,
    tlsVersion: cf.tlsVersion as string | undefined,
  };
}
