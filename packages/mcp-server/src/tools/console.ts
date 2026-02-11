import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';

export function registerConsoleTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_console_messages',
    'Get captured console messages (log, warn, error, info, debug, trace) from the running web app. Includes message text, args, and stack traces for errors.',
    {
      level: z
        .enum(['log', 'warn', 'error', 'info', 'debug', 'trace'])
        .optional()
        .describe('Filter by console level'),
      since_seconds: z.number().optional().describe('Only return messages from the last N seconds'),
      search: z
        .string()
        .optional()
        .describe('Search message text (case-insensitive substring match)'),
    },
    async ({ level, since_seconds, search }) => {
      const events = store.getConsoleMessages({
        level,
        sinceSeconds: since_seconds,
        search,
      });

      const timeRange =
        events.length > 0
          ? { from: events[events.length - 1].timestamp, to: events[0].timestamp }
          : { from: 0, to: 0 };

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      // Group by level for summary
      const levelCounts: Record<string, number> = {};
      for (const e of events) {
        levelCounts[e.level] = (levelCounts[e.level] || 0) + 1;
      }
      const levelSummary = Object.entries(levelCounts)
        .map(([l, c]) => `${c} ${l}`)
        .join(', ');

      // Detect error spam: same error message repeated >5 times in 10 seconds
      const issues: string[] = [];
      const errorMessages = new Map<string, { count: number; first: number; last: number }>();
      for (const e of events) {
        if (e.level === 'error') {
          const existing = errorMessages.get(e.message);
          if (existing) {
            existing.count++;
            existing.last = Math.max(existing.last, e.timestamp);
            existing.first = Math.min(existing.first, e.timestamp);
          } else {
            errorMessages.set(e.message, { count: 1, first: e.timestamp, last: e.timestamp });
          }
        }
      }
      for (const [msg, info] of errorMessages) {
        if (info.count > 5 && info.last - info.first < 10_000) {
          const truncated = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
          issues.push(`Error spam: "${truncated}" repeated ${info.count} times in ${((info.last - info.first) / 1000).toFixed(1)}s`);
        }
      }

      const response = {
        summary: `Found ${events.length} console message(s)${since_seconds ? ` in the last ${since_seconds}s` : ''}${levelSummary ? `. Breakdown: ${levelSummary}` : ''}.`,
        data: events.map((e) => ({
          level: e.level,
          message: e.message,
          args: e.args,
          stackTrace: e.stackTrace ?? null,
          sourceFile: e.sourceFile ?? null,
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
