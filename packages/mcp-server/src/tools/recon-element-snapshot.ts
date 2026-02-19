import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore, CollectorServer } from '@runtimescope/collector';

export function registerReconElementSnapshotTools(
  server: McpServer,
  store: EventStore,
  collector: CollectorServer,
): void {
  server.tool(
    'get_element_snapshot',
    'Deep snapshot of a specific element and its children: structure, attributes, text content, bounding rects, and key computed styles for every node. This is the "zoom in" tool — use it when you need the full picture of a component (a card, a nav bar, a form) for recreation. More detailed than get_layout_tree, more targeted than get_computed_styles.',
    {
      selector: z
        .string()
        .describe('CSS selector for the root element (e.g., ".card", "#hero", "[data-testid=checkout-form]")'),
      depth: z
        .number()
        .optional()
        .default(5)
        .describe('How many levels deep to capture children (default 5)'),
      force_refresh: z
        .boolean()
        .optional()
        .default(false)
        .describe('Request fresh capture from extension for this element'),
    },
    async ({ selector, depth, force_refresh }) => {
      if (force_refresh) {
        const sessions = store.getSessionInfo();
        const activeSession = sessions.find((s) => s.isConnected);
        if (activeSession) {
          try {
            await collector.sendCommand(activeSession.sessionId, {
              command: 'recon_element_snapshot',
              requestId: crypto.randomUUID(),
              params: { selector, depth },
            });
          } catch {
            // Fall through to stored data
          }
        }
      }

      // Find matching snapshots — look for this selector
      const events = store.getReconElementSnapshots();
      const event = events.find((e) => e.selector === selector) ?? events[0];

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      if (!event) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: `No element snapshot captured for "${selector}". Use force_refresh=true to request a fresh capture from the extension.`,
              data: null,
              issues: ['No recon_element_snapshot events found for this selector'],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId },
            }, null, 2),
          }],
        };
      }

      const issues: string[] = [];

      // Analyze the snapshot
      const root = event.root;
      if (root.boundingRect.width === 0 || root.boundingRect.height === 0) {
        issues.push(`Root element "${selector}" has zero dimensions (${root.boundingRect.width}x${root.boundingRect.height}). It may be hidden.`);
      }

      const response = {
        summary: `Element snapshot for "${selector}": ${event.totalNodes} nodes captured to depth ${event.depth}. Root is <${root.tag}> at ${root.boundingRect.width}x${root.boundingRect.height}px.`,
        data: {
          selector: event.selector,
          depth: event.depth,
          totalNodes: event.totalNodes,
          root: event.root,
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
