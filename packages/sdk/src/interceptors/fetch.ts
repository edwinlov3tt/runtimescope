import { generateId } from '../utils/id.js';
import type { NetworkEvent, GraphQLOperation, RuntimeEvent } from '../types.js';

type EmitFn = (event: NetworkEvent) => void;

export interface FetchInterceptorOptions {
  captureBody?: boolean;
  maxBodySize?: number;
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null;
}

// Track URLs intercepted by fetch to prevent XHR double-counting (fetch polyfill case).
// Uses a Set of request identifiers instead of a custom HTTP header to avoid triggering CORS.
export const fetchInterceptedRequests = new Set<string>();

export function interceptFetch(
  emit: EmitFn,
  sessionId: string,
  redactHeaders: string[],
  options?: FetchInterceptorOptions
): () => void {
  const originalFetch = window.fetch;
  const redactSet = new Set(redactHeaders.map((h) => h.toLowerCase()));
  const captureBody = options?.captureBody ?? false;
  const maxBodySize = options?.maxBodySize ?? 65536;

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

    // Capture request body if enabled
    let requestBody: string | undefined;
    if (captureBody && init?.body) {
      requestBody = serializeBody(init.body, maxBodySize);
    }

    // Mark request to prevent XHR interceptor double-counting (fetch polyfill case)
    const requestKey = `${method}:${url}:${startTime}`;
    fetchInterceptedRequests.add(requestKey);
    // Clean up after a short delay to prevent memory leaks
    setTimeout(() => fetchInterceptedRequests.delete(requestKey), 5000);

    try {
      const response = await originalFetch.call(window, input, init);
      const duration = performance.now() - startTime;

      const responseBodySize = parseInt(
        response.headers.get('content-length') || '0',
        10
      );
      const responseHeaders = extractResponseHeaders(response.headers, redactSet);

      // Capture response body if enabled
      let responseBody: string | undefined;
      if (captureBody) {
        try {
          const clone = response.clone();
          const text = await clone.text();
          responseBody = text.length > maxBodySize ? text.slice(0, maxBodySize) : text;
        } catch {
          // CORS or stream-locked — skip body capture
        }
      }

      const event: NetworkEvent = {
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
        ttfb: duration,
        graphqlOperation,
        requestBody,
        responseBody,
        source: 'fetch',
      };

      if (options?.beforeSend) {
        const filtered = options.beforeSend(event);
        if (filtered) emit(filtered as NetworkEvent);
      } else {
        emit(event);
      }

      return response;
    } catch (error) {
      const duration = performance.now() - startTime;

      let errorPhase: 'error' | 'abort' | 'timeout' = 'error';
      let errorMessage = '';

      if (error instanceof DOMException && error.name === 'AbortError') {
        errorPhase = 'abort';
        errorMessage = 'Request aborted';
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      const event: NetworkEvent = {
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
        requestBody,
        errorPhase,
        errorMessage,
        source: 'fetch',
      };

      if (options?.beforeSend) {
        const filtered = options.beforeSend(event);
        if (filtered) emit(filtered as NetworkEvent);
      } else {
        emit(event);
      }

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
  if (body instanceof FormData) return 0;
  if (body instanceof URLSearchParams) return new Blob([body.toString()]).size;
  return 0;
}

function serializeBody(body: BodyInit | null | undefined, maxSize: number): string | undefined {
  if (!body) return undefined;
  if (typeof body === 'string') return body.length > maxSize ? body.slice(0, maxSize) : body;
  if (body instanceof URLSearchParams) {
    const s = body.toString();
    return s.length > maxSize ? s.slice(0, maxSize) : s;
  }
  if (body instanceof FormData) return '[FormData]';
  if (body instanceof Blob) return `[Blob ${body.size} bytes]`;
  if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) return `[TypedArray ${body.byteLength} bytes]`;
  return undefined;
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
  const match = query.match(/^(?:query|mutation|subscription)\s+(\w+)/);
  return match?.[1];
}
