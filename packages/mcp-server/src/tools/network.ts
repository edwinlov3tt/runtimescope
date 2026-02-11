import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';

export function registerNetworkTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_network_requests',
    'Get captured network (fetch) requests from the running web app. Returns URL, method, status, timing, and optional GraphQL operation info.',
    {
      since_seconds: z.number().optional().describe('Only return requests from the last N seconds'),
      url_pattern: z.string().optional().describe('Filter by URL substring match'),
      status: z.number().optional().describe('Filter by HTTP status code'),
      method: z.string().optional().describe('Filter by HTTP method (GET, POST, etc.)'),
    },
    async ({ since_seconds, url_pattern, status, method }) => {
      const events = store.getNetworkRequests({
        sinceSeconds: since_seconds,
        urlPattern: url_pattern,
        status,
        method,
      });

      const timeRange =
        events.length > 0
          ? { from: events[events.length - 1].timestamp, to: events[0].timestamp }
          : { from: 0, to: 0 };

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      const failedCount = events.filter((e) => e.status >= 400).length;
      const avgDuration =
        events.length > 0
          ? (events.reduce((s, e) => s + e.duration, 0) / events.length).toFixed(0)
          : '0';

      const issues: string[] = [];
      if (failedCount > 0) issues.push(`${failedCount} failed request(s) (4xx/5xx)`);
      const slowRequests = events.filter((e) => e.duration > 3000);
      if (slowRequests.length > 0) issues.push(`${slowRequests.length} slow request(s) (>3s)`);

      // Detect N+1 pattern: same endpoint called >5 times within 2 seconds
      const urlCounts = new Map<string, { count: number; first: number; last: number }>();
      for (const e of events) {
        const key = `${e.method} ${e.url}`;
        const existing = urlCounts.get(key);
        if (existing) {
          existing.count++;
          existing.last = Math.max(existing.last, e.timestamp);
          existing.first = Math.min(existing.first, e.timestamp);
        } else {
          urlCounts.set(key, { count: 1, first: e.timestamp, last: e.timestamp });
        }
      }
      for (const [key, info] of urlCounts) {
        if (info.count > 5 && info.last - info.first < 2000) {
          issues.push(`Possible N+1: ${key} called ${info.count} times in ${((info.last - info.first) / 1000).toFixed(1)}s`);
        }
      }

      const response = {
        summary: `Found ${events.length} network request(s)${since_seconds ? ` in the last ${since_seconds}s` : ''}. Average duration: ${avgDuration}ms.`,
        data: events.map((e) => ({
          url: e.url,
          method: e.method,
          status: e.status,
          duration: `${e.duration.toFixed(0)}ms`,
          ttfb: `${e.ttfb.toFixed(0)}ms`,
          requestBodySize: e.requestBodySize,
          responseBodySize: e.responseBodySize,
          graphqlOperation: e.graphqlOperation ?? null,
          timestamp: new Date(e.timestamp).toISOString(),
        })),
        issues,
        metadata: { timeRange, eventCount: events.length, sessionId },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
