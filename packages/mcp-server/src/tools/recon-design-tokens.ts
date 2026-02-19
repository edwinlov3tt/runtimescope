import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import type { CollectorServer } from '@runtimescope/collector';

export function registerReconDesignTokenTools(
  server: McpServer,
  store: EventStore,
  collector: CollectorServer,
): void {
  server.tool(
    'get_design_tokens',
    'Extract the design system from the current page: CSS custom properties (--variables), color palette, typography scale, spacing scale, border radii, box shadows, and CSS architecture detection. Essential for matching a site\'s visual style when recreating UI.',
    {
      url: z
        .string()
        .optional()
        .describe('Filter by URL substring'),
      category: z
        .enum(['all', 'colors', 'typography', 'spacing', 'custom_properties', 'shadows'])
        .optional()
        .default('all')
        .describe('Return only a specific token category'),
      force_refresh: z
        .boolean()
        .optional()
        .default(false)
        .describe('Send a recon_scan command to capture fresh data'),
    },
    async ({ url, category, force_refresh }) => {
      if (force_refresh) {
        const sessions = store.getSessionInfo();
        const activeSession = sessions.find((s) => s.isConnected);
        if (activeSession) {
          try {
            await collector.sendCommand(activeSession.sessionId, {
              command: 'recon_scan',
              requestId: crypto.randomUUID(),
              params: { categories: ['recon_design_tokens'] },
            });
          } catch {
            // Fall through to stored data
          }
        }
      }

      const event = store.getReconDesignTokens({ url });
      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      if (!event) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: 'No design tokens captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.',
              data: null,
              issues: ['No recon_design_tokens events found in the event store'],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId },
            }, null, 2),
          }],
        };
      }

      const issues: string[] = [];

      // Analyze token quality
      if (event.customProperties.length === 0) {
        issues.push('No CSS custom properties (--variables) found. The site may use hardcoded values instead of design tokens.');
      }
      if (event.colors.length > 30) {
        issues.push(`${event.colors.length} unique colors found — this may indicate an inconsistent color system.`);
      }
      if (event.typography.length > 15) {
        issues.push(`${event.typography.length} unique typography combos found — may indicate inconsistent type scale.`);
      }

      // Build category-filtered response
      const data: Record<string, unknown> = {};

      if (category === 'all' || category === 'custom_properties') {
        data.customProperties = event.customProperties;
      }
      if (category === 'all' || category === 'colors') {
        data.colors = event.colors;
      }
      if (category === 'all' || category === 'typography') {
        data.typography = event.typography;
      }
      if (category === 'all' || category === 'spacing') {
        data.spacing = event.spacing;
      }
      if (category === 'all' || category === 'shadows') {
        data.borderRadii = event.borderRadii;
        data.boxShadows = event.boxShadows;
      }

      if (category === 'all') {
        data.cssArchitecture = event.cssArchitecture;
        data.classNamingPatterns = event.classNamingPatterns;
        data.sampleClassNames = event.sampleClassNames;
      }

      const summaryParts = [
        `${event.customProperties.length} CSS variables`,
        `${event.colors.length} colors`,
        `${event.typography.length} type combos`,
        `${event.spacing.length} spacing values`,
        `CSS architecture: ${event.cssArchitecture}`,
      ];

      const response = {
        summary: summaryParts.join(', ') + '.',
        data,
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
