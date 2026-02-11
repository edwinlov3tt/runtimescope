import { generateId } from '../utils/id.js';
import type { NetworkEvent, GraphQLOperation } from '../types.js';

type EmitFn = (event: NetworkEvent) => void;

export function interceptFetch(
  emit: EmitFn,
  sessionId: string,
  redactHeaders: string[]
): () => void {
  const originalFetch = window.fetch;
  const redactSet = new Set(redactHeaders.map((h) => h.toLowerCase()));

  window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const startTime = performance.now();
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();

    const requestHeaders = extractHeaders(init?.headers, redactSet);
    const requestBodySize = estimateBodySize(init?.body);
    const graphqlOperation = detectGraphQL(init?.body);

    try {
      const response = await originalFetch.call(window, input, init);
      const duration = performance.now() - startTime;

      const responseBodySize = parseInt(
        response.headers.get('content-length') || '0',
        10
      );
      const responseHeaders = extractResponseHeaders(response.headers, redactSet);

      emit({
        eventId: generateId(),
        sessionId,
        timestamp: Date.now(),
        eventType: 'network',
        url,
        method,
        status: response.status,
        requestHeaders,
        responseHeaders,
        requestBodySize,
        responseBodySize,
        duration,
        ttfb: duration, // M1 approximation; real TTFB in M4 via PerformanceObserver
        graphqlOperation,
      });

      return response;
    } catch (error) {
      const duration = performance.now() - startTime;

      emit({
        eventId: generateId(),
        sessionId,
        timestamp: Date.now(),
        eventType: 'network',
        url,
        method,
        status: 0,
        requestHeaders,
        responseHeaders: {},
        requestBodySize,
        responseBodySize: 0,
        duration,
        ttfb: 0,
        graphqlOperation,
      });

      throw error;
    }
  };

  return () => {
    window.fetch = originalFetch;
  };
}

function extractHeaders(
  headers: HeadersInit | undefined,
  redactSet: Set<string>
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = redactSet.has(key.toLowerCase()) ? '[REDACTED]' : value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = redactSet.has(key.toLowerCase()) ? '[REDACTED]' : value;
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      result[key] = redactSet.has(key.toLowerCase()) ? '[REDACTED]' : value;
    }
  }

  return result;
}

function extractResponseHeaders(
  headers: Headers,
  redactSet: Set<string>
): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = redactSet.has(key.toLowerCase()) ? '[REDACTED]' : value;
  });
  return result;
}

function estimateBodySize(body: BodyInit | null | undefined): number {
  if (!body) return 0;
  if (typeof body === 'string') return new Blob([body]).size;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof FormData) return 0; // Cannot easily estimate
  if (body instanceof URLSearchParams) return new Blob([body.toString()]).size;
  return 0;
}

function detectGraphQL(body: BodyInit | null | undefined): GraphQLOperation | undefined {
  if (!body || typeof body !== 'string') return undefined;

  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.query === 'string') {
      const trimmed = parsed.query.trim();
      let type: GraphQLOperation['type'] = 'query';
      if (trimmed.startsWith('mutation')) type = 'mutation';
      else if (trimmed.startsWith('subscription')) type = 'subscription';

      const name = parsed.operationName || extractOperationName(trimmed) || 'anonymous';
      return { type, name };
    }
  } catch {
    // Not GraphQL
  }

  return undefined;
}

function extractOperationName(query: string): string | undefined {
  // Match: query OperationName or mutation OperationName
  const match = query.match(/^(?:query|mutation|subscription)\s+(\w+)/);
  return match?.[1];
}
