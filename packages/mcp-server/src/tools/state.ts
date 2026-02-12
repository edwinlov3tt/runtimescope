import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';

export function registerStateTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_state_snapshots',
    'Get state store snapshots and diffs from Zustand or Redux stores. Shows state changes over time with action history, mutation frequency, and shallow diffs showing which keys changed.',
    {
      store_name: z
        .string()
        .optional()
        .describe('Filter by store name/ID'),
      since_seconds: z
        .number()
        .optional()
        .describe('Only return events from the last N seconds'),
    },
    async ({ store_name, since_seconds }) => {
      const events = store.getStateEvents({
        storeId: store_name,
        sinceSeconds: since_seconds,
      });

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;
      const issues: string[] = [];

      // Detect store thrashing (>10 updates/sec in any 1-second window)
      const storeUpdates = new Map<string, number[]>();
      for (const e of events) {
        if (e.phase !== 'update') continue;
        const timestamps = storeUpdates.get(e.storeId) ?? [];
        timestamps.push(e.timestamp);
        storeUpdates.set(e.storeId, timestamps);
      }

      for (const [storeId, timestamps] of storeUpdates) {
        if (timestamps.length < 10) continue;
        // Check 1-second sliding windows
        for (let i = 0; i <= timestamps.length - 10; i++) {
          if (timestamps[i + 9] - timestamps[i] < 1000) {
            issues.push(`Store thrashing: "${storeId}" had ${timestamps.length} updates, 10+ in a 1-second window`);
            break;
          }
        }
      }

      const response = {
        summary: `Found ${events.length} state event(s)${since_seconds ? ` in the last ${since_seconds}s` : ''}${store_name ? ` for store "${store_name}"` : ''}.`,
        data: events.map((e) => ({
          storeId: e.storeId,
          library: e.library,
          phase: e.phase,
          state: e.state,
          previousState: e.previousState ?? null,
          diff: e.diff ?? null,
          action: e.action ?? null,
          timestamp: new Date(e.timestamp).toISOString(),
        })),
        issues,
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
