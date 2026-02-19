import { generateId } from '../utils/id.js';
import { runWithContext } from '../context.js';
import type { NetworkEvent, ServerRuntimeEvent } from '../types.js';

type EmitFn = (event: NetworkEvent) => void;

export interface MiddlewareOptions {
  captureBody?: boolean;
  maxBodySize?: number;
  redactHeaders?: string[];
  ignoreRoutes?: (string | RegExp)[];
  beforeSend?: (event: ServerRuntimeEvent) => ServerRuntimeEvent | null;
}

const DEFAULT_REDACT_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];

/**
 * Express/Connect-compatible middleware that captures incoming HTTP requests.
 * Complements the HTTP interceptor (which captures outgoing requests).
 *
 * Usage:
 *   app.use(RuntimeScope.middleware());
 */
export function runtimeScopeMiddleware(
  emit: EmitFn,
  sessionId: string,
  options?: MiddlewareOptions
): (req: any, res: any, next: any) => void {
  const maxBodySize = options?.maxBodySize ?? 65536;
  const redactSet = new Set(
    (options?.redactHeaders ?? DEFAULT_REDACT_HEADERS).map((h) => h.toLowerCase())
  );
  const ignorePatterns = options?.ignoreRoutes ?? [];

  function shouldIgnore(path: string): boolean {
    for (const pattern of ignorePatterns) {
      if (typeof pattern === 'string') {
        if (path === pattern || path.startsWith(pattern)) return true;
      } else if (pattern.test(path)) {
        return true;
      }
    }
    return false;
  }

  function redactHeaders(
    headers: Record<string, string | string[] | number | undefined>
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, val] of Object.entries(headers)) {
      if (val === undefined) continue;
      const lk = key.toLowerCase();
      result[lk] = redactSet.has(lk) ? '[REDACTED]' : String(val);
    }
    return result;
  }

  return (req: any, res: any, next: any) => {
    const path: string = req.originalUrl ?? req.url ?? '/';

    if (shouldIgnore(path)) {
      return next();
    }

    const startTime = performance.now();

    // Wrap res.end to capture response timing and status
    const originalEnd = res.end.bind(res);
    let responseBody: string | undefined;

    res.end = function (chunk?: unknown, ...rest: unknown[]) {
      const duration = performance.now() - startTime;

      if (options?.captureBody && chunk) {
        if (Buffer.isBuffer(chunk)) {
          responseBody = chunk.toString('utf8', 0, Math.min(chunk.length, maxBodySize));
        } else if (typeof chunk === 'string') {
          responseBody = chunk.slice(0, maxBodySize);
        }
      }

      const proto = req.protocol ?? (req.socket?.encrypted ? 'https' : 'http');
      const host = req.get?.('host') ?? req.headers?.host ?? 'localhost';
      const url = `${proto}://${host}${path}`;

      const event: NetworkEvent = {
        eventId: generateId(),
        sessionId,
        timestamp: Date.now(),
        eventType: 'network',
        url,
        method: (req.method ?? 'GET').toUpperCase(),
        status: res.statusCode ?? 200,
        requestHeaders: redactHeaders(req.headers ?? {}),
        responseHeaders: redactHeaders(
          typeof res.getHeaders === 'function' ? res.getHeaders() : {}
        ),
        requestBodySize: parseInt(req.headers?.['content-length'] ?? '0', 10),
        responseBodySize: parseInt(
          (typeof res.getHeader === 'function'
            ? res.getHeader('content-length')
            : undefined
          )?.toString() ?? '0',
          10
        ),
        duration: Math.round(duration * 100) / 100,
        ttfb: Math.round(duration * 100) / 100,
        responseBody,
        source: 'node-http',
      };

      if (options?.beforeSend) {
        const filtered = options.beforeSend(event);
        if (filtered) emit(filtered as NetworkEvent);
      } else {
        emit(event);
      }

      return originalEnd(chunk, ...rest);
    };

    // Wrap next() in request context so downstream code
    // (database queries, console logs, HTTP calls) inherits per-request sessionId
    const requestId = generateId();
    runWithContext({ sessionId, requestId }, () => next());
  };
}
