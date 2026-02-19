import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore, CollectorServer } from '@runtimescope/collector';
import type { LayoutNode } from '@runtimescope/collector';

export function registerReconLayoutTools(
  server: McpServer,
  store: EventStore,
  collector: CollectorServer,
): void {
  server.tool(
    'get_layout_tree',
    'Get the DOM structure with layout information: element tags, classes, bounding rects, display mode (flex/grid/block), flex/grid properties (direction, justify, align, gap, template columns/rows), position, and z-index. Optionally scoped to a CSS selector. Essential for understanding page structure when recreating UI.',
    {
      selector: z
        .string()
        .optional()
        .describe('CSS selector to scope the tree (e.g., "nav", ".hero", "main"). Omit for full page.'),
      max_depth: z
        .number()
        .optional()
        .default(10)
        .describe('Maximum depth of the tree to return (default 10)'),
      url: z
        .string()
        .optional()
        .describe('Filter by URL substring'),
      force_refresh: z
        .boolean()
        .optional()
        .default(false)
        .describe('Request fresh capture from extension'),
    },
    async ({ selector, max_depth, url, force_refresh }) => {
      if (force_refresh) {
        const sessions = store.getSessionInfo();
        const activeSession = sessions.find((s) => s.isConnected);
        if (activeSession) {
          try {
            await collector.sendCommand(activeSession.sessionId, {
              command: 'recon_layout_tree',
              requestId: crypto.randomUUID(),
              params: { selector, maxDepth: max_depth },
            });
          } catch {
            // Fall through to stored data
          }
        }
      }

      const event = store.getReconLayoutTree({ url });
      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      if (!event) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: 'No layout tree captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.',
              data: null,
              issues: ['No recon_layout_tree events found in the event store'],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId },
            }, null, 2),
          }],
        };
      }

      // If a selector was requested, find the matching subtree
      let tree = event.tree;
      let totalElements = event.totalElements;
      if (selector && !event.rootSelector) {
        const found = findNode(tree, selector);
        if (found) {
          tree = found;
          totalElements = countNodes(found);
        }
      }

      // Prune to max_depth
      const pruned = pruneTree(tree, max_depth ?? 10);

      // Analyze layout patterns
      const issues: string[] = [];
      const flexCount = countByDisplay(tree, 'flex');
      const gridCount = countByDisplay(tree, 'grid');

      const response = {
        summary: `Layout tree: ${totalElements} elements, max depth ${event.maxDepth}. ${flexCount} flex containers, ${gridCount} grid containers. Viewport: ${event.viewport.width}x${event.viewport.height}.${selector ? ` Scoped to: ${selector}.` : ''}`,
        data: {
          viewport: event.viewport,
          scrollHeight: event.scrollHeight,
          rootSelector: selector ?? event.rootSelector ?? null,
          tree: pruned,
          totalElements,
          maxDepth: event.maxDepth,
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

function findNode(node: LayoutNode, selector: string): LayoutNode | null {
  // Simple matching: check tag, id, class
  if (matchesSelector(node, selector)) return node;
  for (const child of node.children) {
    const found = findNode(child, selector);
    if (found) return found;
  }
  return null;
}

function matchesSelector(node: LayoutNode, selector: string): boolean {
  // Basic selector matching for common patterns
  if (selector.startsWith('#') && node.id === selector.slice(1)) return true;
  if (selector.startsWith('.') && node.classList.includes(selector.slice(1))) return true;
  if (node.tag === selector.toLowerCase()) return true;
  // Check role
  if (selector.startsWith('[role=') && node.role === selector.slice(6, -1).replace(/"/g, '')) return true;
  return false;
}

function countNodes(node: LayoutNode): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}

function countByDisplay(node: LayoutNode, displayType: string): number {
  let count = node.display?.includes(displayType) ? 1 : 0;
  for (const child of node.children) {
    count += countByDisplay(child, displayType);
  }
  return count;
}

function pruneTree(node: LayoutNode, maxDepth: number, currentDepth = 0): LayoutNode {
  if (currentDepth >= maxDepth) {
    return {
      ...node,
      children: [],
      childCount: node.childCount,
    };
  }
  return {
    ...node,
    children: node.children.map((c) => pruneTree(c, maxDepth, currentDepth + 1)),
  };
}
