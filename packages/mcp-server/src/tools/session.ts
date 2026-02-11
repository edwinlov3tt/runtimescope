import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';

export function registerSessionTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_session_info',
    'Get information about connected browser sessions and overall event statistics. Use this to check if the SDK is connected.',
    {},
    async () => {
      const sessions = store.getSessionInfo();

      const response = {
        summary:
          sessions.length > 0
            ? `${sessions.length} session(s) connected. Total events captured: ${store.eventCount}.`
            : 'No active sessions. Make sure the RuntimeScope SDK is injected in your app and connected to ws://localhost:9090.',
        data: sessions.map((s) => ({
          sessionId: s.sessionId,
          appName: s.appName,
          sdkVersion: s.sdkVersion,
          connectedAt: new Date(s.connectedAt).toISOString(),
          eventCount: s.eventCount,
          isConnected: s.isConnected,
        })),
        issues: sessions.length === 0 ? ['No SDK connections detected'] : [],
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: store.eventCount,
          sessionId: sessions[0]?.sessionId ?? null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  server.tool(
    'clear_events',
    'Clear all captured events from the buffer. Use this to start a fresh capture session.',
    {},
    async () => {
      const { clearedCount } = store.clear();

      const response = {
        summary: `Cleared ${clearedCount} events. Buffer is now empty.`,
        data: null,
        issues: [],
        metadata: {
          timeRange: { from: 0, to: 0 },
          eventCount: 0,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
