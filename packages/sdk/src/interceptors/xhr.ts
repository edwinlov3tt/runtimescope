import { generateId } from '../utils/id.js';
import type { NetworkEvent, GraphQLOperation, RuntimeEvent } from '../types.js';
import { fetchInterceptedRequests } from './fetch.js';

type EmitFn = (event: NetworkEvent) => void;

export interface XhrInterceptorOptions {
  captureBody?: boolean;
  maxBodySize?: number;
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null;
}

interface AugmentedXHR extends XMLHttpRequest {
  __rs_method?: string;
  __rs_url?: string;
  __rs_headers?: Record<string, string>;
  __rs_start?: number;
  __rs_body?: string;
  __rs_fetchIntercepted?: boolean;
}

export function interceptXhr(
  emit: EmitFn,
  sessionId: string,
  redactHeaders: string[],
  options?: XhrInterceptorOptions
): () => void {
  const redactSet = new Set(redactHeaders.map((h) => h.toLowerCase()));
  const captureBody = options?.captureBody ?? false;
  const maxBodySize = options?.maxBodySize ?? 65536;

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    this: AugmentedXHR,
    method: string,
    url: string | URL
  ) {
    this.__rs_method = method.toUpperCase();
    this.__rs_url = typeof url === 'string' ? url : url.href;
    this.__rs_headers = {};
    // eslint-disable-next-line prefer-rest-params
    return origOpen.apply(this, arguments as unknown as Parameters<typeof origOpen>);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (
    this: AugmentedXHR,
    name: string,
    value: string
  ) {
    if (this.__rs_headers) {
      this.__rs_headers[name.toLowerCase()] = redactSet.has(name.toLowerCase())
        ? '[REDACTED]'
        : value;
    }
    return origSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (
    this: AugmentedXHR,
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    // Skip if this request was already captured by the fetch interceptor
    const method = this.__rs_method ?? 'GET';
    const url = this.__rs_url ?? '';
    const requestKey = `${method}:${url}`;
    const alreadyIntercepted = Array.from(fetchInterceptedRequests).some((k) => k.startsWith(requestKey));
    if (alreadyIntercepted) {
      this.__rs_fetchIntercepted = true;
      return origSend.call(this, body);
    }

    const requestHeaders = { ...(this.__rs_headers ?? {}) };
    const startTime = performance.now();

    // Capture request body
    let requestBody: string | undefined;
    let requestBodySize = 0;
    if (body) {
      if (typeof body === 'string') {
        requestBodySize = new Blob([body]).size;
        if (captureBody) {
          requestBody = body.length > maxBodySize ? body.slice(0, maxBodySize) : body;
        }
      } else if (body instanceof Blob) {
        requestBodySize = body.size;
        if (captureBody) requestBody = `[Blob ${body.size} bytes]`;
      } else if (body instanceof ArrayBuffer) {
        requestBodySize = body.byteLength;
        if (captureBody) requestBody = `[ArrayBuffer ${body.byteLength} bytes]`;
      } else if (body instanceof FormData) {
        if (captureBody) requestBody = '[FormData]';
      } else if (body instanceof URLSearchParams) {
        const s = body.toString();
        requestBodySize = new Blob([s]).size;
        if (captureBody) requestBody = s.length > maxBodySize ? s.slice(0, maxBodySize) : s;
      }
    }

    // Detect GraphQL
    const graphqlOperation = detectGraphQL(body);

    const emitEvent = (overrides: Partial<NetworkEvent>) => {
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
        duration: 0,
        ttfb: 0,
        graphqlOperation,
        requestBody,
        source: 'xhr',
        ...overrides,
      };

      if (options?.beforeSend) {
        const filtered = options.beforeSend(event);
        if (filtered) emit(filtered as NetworkEvent);
      } else {
        emit(event);
      }
    };

    this.addEventListener('load', () => {
      const duration = performance.now() - startTime;
      const responseHeaders = parseResponseHeaders(this.getAllResponseHeaders(), redactSet);
      const responseBodySize = parseInt(
        this.getResponseHeader('content-length') || '0',
        10
      );

      let responseBody: string | undefined;
      if (captureBody && this.responseType === '' || this.responseType === 'text') {
        try {
          const text = this.responseText;
          responseBody = text.length > maxBodySize ? text.slice(0, maxBodySize) : text;
        } catch {
          // responseText not available for non-text types
        }
      }

      emitEvent({
        status: this.status,
        responseHeaders,
        responseBodySize,
        responseBody,
        duration,
        ttfb: duration,
      });
    });

    this.addEventListener('error', () => {
      const duration = performance.now() - startTime;
      emitEvent({
        duration,
        errorPhase: 'error',
        errorMessage: 'Network error',
      });
    });

    this.addEventListener('abort', () => {
      const duration = performance.now() - startTime;
      emitEvent({
        duration,
        errorPhase: 'abort',
        errorMessage: 'Request aborted',
      });
    });

    this.addEventListener('timeout', () => {
      const duration = performance.now() - startTime;
      emitEvent({
        duration,
        errorPhase: 'timeout',
        errorMessage: `Request timed out after ${this.timeout}ms`,
      });
    });

    return origSend.call(this, body);
  };

  return () => {
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.setRequestHeader = origSetRequestHeader;
    XMLHttpRequest.prototype.send = origSend;
  };
}

function parseResponseHeaders(
  raw: string,
  redactSet: Set<string>
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw) return result;

  for (const line of raw.trim().split(/[\r\n]+/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    result[key] = redactSet.has(key) ? '[REDACTED]' : value;
  }

  return result;
}

function detectGraphQL(
  body: Document | XMLHttpRequestBodyInit | null | undefined
): GraphQLOperation | undefined {
  if (!body || typeof body !== 'string') return undefined;

  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.query === 'string') {
      const trimmed = parsed.query.trim();
      let type: GraphQLOperation['type'] = 'query';
      if (trimmed.startsWith('mutation')) type = 'mutation';
      else if (trimmed.startsWith('subscription')) type = 'subscription';

      const name =
        parsed.operationName || extractOperationName(trimmed) || 'anonymous';
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
