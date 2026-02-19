import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore, CollectorServer } from '@runtimescope/collector';
import type { PlaywrightScanner } from '../scanner/index.js';

export function registerReconElementSnapshotTools(
  server: McpServer,
  store: EventStore,
  collector: CollectorServer,
  scanner: PlaywrightScanner,
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
        .describe('Request fresh capture from extension or scanner for this element'),
    },
    async ({ selector, depth, force_refresh }) => {
      // If force_refresh, try to get fresh data from extension
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
            // Fall through to stored data or scanner fallback
          }
        }
      }

      // Check for pre-captured events first
      const events = store.getReconElementSnapshots();
      let event = events.find((e) => e.selector === selector) ?? events[0];

      // Fallback: if no pre-captured data, use the scanner to query live
      if (!event && scanner.getLastScannedUrl()) {
        const url = scanner.getLastScannedUrl()!;
        try {
          const raw = await scanner.queryElementSnapshot(url, selector, depth);
          if (raw) {
            // Build a synthetic event and store it for caching
            const syntheticEvent = {
              eventId: `evt-scan-es-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              sessionId: `scan-${Date.now()}`,
              timestamp: Date.now(),
              eventType: 'recon_element_snapshot' as const,
              url,
              selector: raw.selector,
              depth: raw.depth,
              totalNodes: raw.totalNodes,
              root: raw.root,
            };
            store.addEvent(syntheticEvent);
            event = syntheticEvent;
          }
        } catch {
          // Scanner query failed, fall through to error message
        }
      }

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      if (!event) {
        const hint = scanner.getLastScannedUrl()
          ? `No element found matching "${selector}" on the scanned page. Check the selector and try again.`
          : `No element snapshot captured for "${selector}". Run scan_website first to scan a page, then query selectors on it.`;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: hint,
              data: null,
              issues: ['No element snapshot data available for this selector'],
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
