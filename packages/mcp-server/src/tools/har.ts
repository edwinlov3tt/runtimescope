import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import type { NetworkEvent } from '@runtimescope/collector';

export function registerHarTools(server: McpServer, store: EventStore): void {
  server.tool(
    'capture_har',
    'Export captured network requests as a HAR (HTTP Archive) 1.2 JSON file. This is the standard format used by browser DevTools, Charles Proxy, and other tools. Includes request/response headers, body content (if captureBody was enabled in the SDK), and timing data.',
    {
      since_seconds: z
        .number()
        .optional()
        .describe('Only include requests from the last N seconds'),
    },
    async ({ since_seconds }) => {
      const events = store.getNetworkRequests({
        sinceSeconds: since_seconds,
      });

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      const har = buildHar(events);

      const response = {
        summary: `HAR export: ${events.length} request(s)${since_seconds ? ` from the last ${since_seconds}s` : ''}. Import into Chrome DevTools or any HAR viewer.`,
        data: har,
        issues: [],
        metadata: {
          timeRange: {
            from: events.length > 0 ? events[0].timestamp : 0,
            to: events.length > 0 ? events[events.length - 1].timestamp : 0,
          },
          eventCount: events.length,
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: { name: string; value: string }[];
    queryString: { name: string; value: string }[];
    postData?: { mimeType: string; text: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: { name: string; value: string }[];
    content: {
      size: number;
      mimeType: string;
      text?: string;
    };
    headersSize: number;
    bodySize: number;
  };
  timings: {
    send: number;
    wait: number;
    receive: number;
  };
}

function buildHar(events: NetworkEvent[]): Record<string, unknown> {
  const entries: HarEntry[] = events.map((e) => {
    const queryString = parseQueryString(e.url);
    const requestHeaders = Object.entries(e.requestHeaders).map(([name, value]) => ({
      name,
      value,
    }));
    const responseHeaders = Object.entries(e.responseHeaders).map(([name, value]) => ({
      name,
      value,
    }));

    const contentType =
      e.responseHeaders['content-type'] ?? 'application/octet-stream';

    const entry: HarEntry = {
      startedDateTime: new Date(e.timestamp).toISOString(),
      time: Math.round(e.duration),
      request: {
        method: e.method,
        url: e.url,
        httpVersion: 'HTTP/1.1',
        headers: requestHeaders,
        queryString,
        headersSize: -1,
        bodySize: e.requestBodySize,
      },
      response: {
        status: e.status,
        statusText: statusText(e.status),
        httpVersion: 'HTTP/1.1',
        headers: responseHeaders,
        content: {
          size: e.responseBodySize,
          mimeType: contentType,
          ...(e.responseBody ? { text: e.responseBody } : {}),
        },
        headersSize: -1,
        bodySize: e.responseBodySize,
      },
      timings: {
        send: 0,
        wait: Math.round(e.ttfb),
        receive: Math.max(0, Math.round(e.duration - e.ttfb)),
      },
    };

    if (e.requestBody) {
      const reqContentType =
        e.requestHeaders['content-type'] ?? 'application/octet-stream';
      entry.request.postData = {
        mimeType: reqContentType,
        text: e.requestBody,
      };
    }

    return entry;
  });

  return {
    log: {
      version: '1.2',
      creator: {
        name: 'RuntimeScope',
        version: '0.2.0',
      },
      entries,
    },
  };
}

function parseQueryString(url: string): { name: string; value: string }[] {
  try {
    const parsed = new URL(url);
    return Array.from(parsed.searchParams.entries()).map(([name, value]) => ({
      name,
      value,
    }));
  } catch {
    return [];
  }
}

function statusText(status: number): string {
  const texts: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return texts[status] ?? '';
}
