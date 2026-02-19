import http from 'node:http';
import https from 'node:https';
import { generateId } from '../utils/id.js';
import { getSessionId } from '../context.js';
import type { NetworkEvent, ServerRuntimeEvent } from '../types.js';

type EmitFn = (event: NetworkEvent) => void;

export interface HttpInterceptorOptions {
  captureBody?: boolean;
  maxBodySize?: number;
  redactHeaders?: string[];
  ignoreUrls?: (string | RegExp)[];
  beforeSend?: (event: ServerRuntimeEvent) => ServerRuntimeEvent | null;
}

const DEFAULT_REDACT_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];

export function interceptHttp(
  emit: EmitFn,
  sessionId: string,
  options?: HttpInterceptorOptions
): () => void {
  const maxBodySize = options?.maxBodySize ?? 65536;
  const redactSet = new Set(
    (options?.redactHeaders ?? DEFAULT_REDACT_HEADERS).map((h) => h.toLowerCase())
  );
  const ignorePatterns = options?.ignoreUrls ?? [];

  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;

  function shouldIgnore(url: string): boolean {
    for (const pattern of ignorePatterns) {
      if (typeof pattern === 'string') {
        if (url.includes(pattern)) return true;
      } else if (pattern.test(url)) {
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

  function buildUrl(
    input: string | URL | http.RequestOptions,
    protocol: 'http' | 'https'
  ): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    // RequestOptions
    const host = input.hostname ?? input.host ?? 'localhost';
    const port = input.port ? `:${input.port}` : '';
    const path = input.path ?? '/';
    return `${protocol}://${host}${port}${path}`;
  }

  function wrapRequest(
    original: typeof http.request,
    protocol: 'http' | 'https'
  ): typeof http.request {
    return function wrappedRequest(
      this: unknown,
      ...args: Parameters<typeof http.request>
    ): http.ClientRequest {
      const url = buildUrl(args[0], protocol);

      if (shouldIgnore(url)) {
        return original.apply(this, args as never) as http.ClientRequest;
      }

      const startTime = performance.now();

      // Extract method from args
      let method = 'GET';
      if (typeof args[0] !== 'string' && !(args[0] instanceof URL)) {
        method = (args[0] as http.RequestOptions).method?.toUpperCase() ?? 'GET';
      } else if (args[1] && typeof args[1] === 'object' && !('on' in args[1])) {
        method = (args[1] as http.RequestOptions).method?.toUpperCase() ?? 'GET';
      }

      // Extract request headers
      let reqHeaders: Record<string, string | string[] | number | undefined> = {};
      if (typeof args[0] !== 'string' && !(args[0] instanceof URL)) {
        reqHeaders = (args[0] as http.RequestOptions).headers ?? {};
      } else if (args[1] && typeof args[1] === 'object' && !('on' in args[1])) {
        reqHeaders = (args[1] as http.RequestOptions).headers ?? {};
      }

      const req = original.apply(this, args as never) as http.ClientRequest;

      // Track request body size
      let requestBodySize = 0;
      let requestBody: string | undefined;
      const requestChunks: Buffer[] = [];

      const origWrite = req.write;
      req.write = function (
        chunk: unknown,
        ...rest: unknown[]
      ): boolean {
        if (chunk) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          requestBodySize += buf.length;
          if (options?.captureBody) requestChunks.push(buf);
        }
        return origWrite.apply(req, [chunk, ...rest] as never);
      };

      const origEnd = req.end;
      req.end = function (
        chunk?: unknown,
        ...rest: unknown[]
      ): http.ClientRequest {
        if (chunk && typeof chunk !== 'function') {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          requestBodySize += buf.length;
          if (options?.captureBody) requestChunks.push(buf);
        }
        return origEnd.apply(req, [chunk, ...rest] as never) as http.ClientRequest;
      };

      // Listen for response
      req.on('response', (res: http.IncomingMessage) => {
        const responseChunks: Buffer[] = [];
        let responseBodySize = 0;

        if (options?.captureBody) {
          const origPush = res.push;
          res.push = function (chunk: Buffer | null, ...rest: unknown[]): boolean {
            if (chunk) {
              responseBodySize += chunk.length;
              if (responseBodySize <= maxBodySize) responseChunks.push(chunk);
            }
            return origPush.apply(res, [chunk, ...rest] as never);
          };
        }

        res.on('end', () => {
          const duration = performance.now() - startTime;

          if (options?.captureBody) {
            requestBody = joinChunks(requestChunks, maxBodySize);
          }

          const contentLength = parseInt(
            res.headers['content-length'] ?? '0',
            10
          );

          const event: NetworkEvent = {
            eventId: generateId(),
            sessionId: getSessionId(sessionId),
            timestamp: Date.now(),
            eventType: 'network',
            url,
            method,
            status: res.statusCode ?? 0,
            requestHeaders: redactHeaders(reqHeaders),
            responseHeaders: redactHeaders(
              res.headers as Record<string, string | string[] | undefined>
            ),
            requestBodySize,
            responseBodySize: contentLength || responseBodySize,
            duration: Math.round(duration * 100) / 100,
            ttfb: Math.round(duration * 100) / 100,
            requestBody,
            responseBody: options?.captureBody
              ? joinChunks(responseChunks, maxBodySize)
              : undefined,
            source: protocol === 'https' ? 'node-https' : 'node-http',
          };

          if (options?.beforeSend) {
            const filtered = options.beforeSend(event);
            if (filtered) emit(filtered as NetworkEvent);
          } else {
            emit(event);
          }
        });
      });

      // Handle request errors
      req.on('error', (err: Error) => {
        const duration = performance.now() - startTime;

        const event: NetworkEvent = {
          eventId: generateId(),
          sessionId: getSessionId(sessionId),
          timestamp: Date.now(),
          eventType: 'network',
          url,
          method,
          status: 0,
          requestHeaders: redactHeaders(reqHeaders),
          responseHeaders: {},
          requestBodySize,
          responseBodySize: 0,
          duration: Math.round(duration * 100) / 100,
          ttfb: 0,
          errorPhase: 'error',
          errorMessage: err.message,
          source: protocol === 'https' ? 'node-https' : 'node-http',
        };

        if (options?.beforeSend) {
          const filtered = options.beforeSend(event);
          if (filtered) emit(filtered as NetworkEvent);
        } else {
          emit(event);
        }
      });

      return req;
    } as typeof http.request;
  }

  http.request = wrapRequest(originalHttpRequest, 'http');
  https.request = wrapRequest(originalHttpsRequest, 'https');

  // http.get / https.get call through to http.request / https.request,
  // so they are automatically intercepted — no need to patch separately

  return () => {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
  };
}

function joinChunks(chunks: Buffer[], maxSize: number): string | undefined {
  if (chunks.length === 0) return undefined;
  const combined = Buffer.concat(chunks);
  if (combined.length === 0) return undefined;
  return combined.toString('utf8', 0, Math.min(combined.length, maxSize));
}
