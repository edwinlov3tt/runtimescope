import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';

export function registerReconFontTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_font_info',
    'Get typography details for the current page: @font-face declarations, font families actually used in computed styles, icon fonts with glyph usage, and font loading strategy. Critical for matching typography when recreating UI.',
    {
      url: z
        .string()
        .optional()
        .describe('Filter by URL substring'),
    },
    async ({ url }) => {
      const event = store.getReconFonts({ url });
      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      if (!event) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: 'No font data captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.',
              data: null,
              issues: ['No recon_fonts events found in the event store'],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId },
            }, null, 2),
          }],
        };
      }

      const issues: string[] = [];

      // Identify potential problems
      const uniqueFamilies = new Set(event.fontsUsed.map((f) => f.family));
      if (uniqueFamilies.size > 5) {
        issues.push(`${uniqueFamilies.size} different font families in use — may impact page load performance.`);
      }

      // Check for font-display usage
      const missingDisplay = event.fontFaces.filter((f) => !f.display);
      if (missingDisplay.length > 0) {
        issues.push(`${missingDisplay.length} @font-face rule(s) without font-display — may cause FOIT (flash of invisible text).`);
      }

      const families = Array.from(uniqueFamilies).join(', ');

      const response = {
        summary: `${event.fontFaces.length} @font-face declarations, ${uniqueFamilies.size} font families in use (${families}), ${event.iconFonts.length} icon font(s). Loading: ${event.loadingStrategy}.`,
        data: {
          fontFaces: event.fontFaces,
          fontsUsed: event.fontsUsed,
          iconFonts: event.iconFonts,
          loadingStrategy: event.loadingStrategy,
        },
        issues,
        metadata: {
          timeRange: { from: event.timestamp, to: event.timestamp },
          eventCount: 1,
          sessionId: event.sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
