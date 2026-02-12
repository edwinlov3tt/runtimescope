import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import type { CollectorServer } from '@runtimescope/collector';

function generateRequestId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function registerDomSnapshotTools(
  server: McpServer,
  store: EventStore,
  collector: CollectorServer
): void {
  server.tool(
    'get_dom_snapshot',
    'Capture a live DOM snapshot from the running web app. Sends a command to the SDK which serializes document.documentElement.outerHTML and returns it along with the current URL, viewport dimensions, scroll position, and element count. Useful for understanding what the user sees.',
    {
      max_size: z
        .number()
        .optional()
        .describe('Maximum HTML size in bytes (default: 500000). Larger pages will be truncated.'),
    },
    async ({ max_size }) => {
      const sessions = store.getSessionInfo();
      const sessionId = collector.getFirstSessionId();
      const activeSession = sessions[0] ?? null;

      if (!sessionId || !activeSession?.isConnected) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: 'No active SDK session connected. Ensure the SDK is running in the browser.',
              data: null,
              issues: ['No active session'],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
            }, null, 2),
          }],
        };
      }

      try {
        const requestId = generateRequestId();
        const result = await collector.sendCommand(sessionId, {
          command: 'capture_dom_snapshot',
          requestId,
          params: { maxSize: max_size ?? 500_000 },
        }, 10_000) as {
          html: string;
          url: string;
          viewport: { width: number; height: number };
          scrollPosition: { x: number; y: number };
          elementCount: number;
          truncated: boolean;
        };

        const response = {
          summary: `DOM snapshot captured from ${result.url}. ${result.elementCount} elements, ${Math.round(result.html.length / 1024)}KB HTML${result.truncated ? ' (truncated)' : ''}.`,
          data: {
            html: result.html,
            url: result.url,
            viewport: result.viewport,
            scrollPosition: result.scrollPosition,
            elementCount: result.elementCount,
            truncated: result.truncated,
          },
          issues: result.truncated ? ['HTML was truncated due to size limit'] : [],
          metadata: {
            timeRange: { from: Date.now(), to: Date.now() },
            eventCount: 1,
            sessionId,
          },
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: `Failed to capture DOM snapshot: ${errorMsg}`,
              data: null,
              issues: [errorMsg],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId },
            }, null, 2),
          }],
        };
      }
    }
  );
}
