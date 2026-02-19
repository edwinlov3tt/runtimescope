import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore, CollectorServer } from '@runtimescope/collector';
import type { PlaywrightScanner } from '../scanner/index.js';

// Common CSS property groups for the `properties` filter
const PROPERTY_GROUPS: Record<string, string[]> = {
  colors: [
    'color', 'background-color', 'border-color', 'border-top-color', 'border-right-color',
    'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color',
    'box-shadow', 'text-shadow',
  ],
  typography: [
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'letter-spacing', 'text-align', 'text-transform', 'text-decoration',
    'word-spacing', 'white-space', 'text-overflow',
  ],
  spacing: [
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap',
  ],
  layout: [
    'display', 'position', 'top', 'right', 'bottom', 'left',
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'flex-direction', 'justify-content', 'align-items', 'flex-wrap', 'flex-grow', 'flex-shrink',
    'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
    'overflow', 'z-index',
  ],
  borders: [
    'border-width', 'border-style', 'border-color', 'border-radius',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
    'outline-width', 'outline-style', 'outline-color', 'outline-offset',
  ],
  visual: [
    'opacity', 'background-color', 'background-image', 'background-size', 'background-position',
    'box-shadow', 'text-shadow', 'filter', 'backdrop-filter',
    'transform', 'transition', 'animation',
  ],
};

export function registerReconComputedStyleTools(
  server: McpServer,
  store: EventStore,
  collector: CollectorServer,
  scanner: PlaywrightScanner,
): void {
  server.tool(
    'get_computed_styles',
    'Get computed CSS styles for elements matching a selector. Returns the actual resolved values the browser uses to render each element. Can filter by property group (colors, typography, spacing, layout, borders, visual) or specific property names. When multiple elements match, highlights variations between them.',
    {
      selector: z
        .string()
        .describe('CSS selector to query (e.g., ".btn-primary", "nav > ul > li", "[data-testid=hero]")'),
      properties: z
        .enum(['all', 'colors', 'typography', 'spacing', 'layout', 'borders', 'visual'])
        .optional()
        .default('all')
        .describe('Property group to return, or "all" for everything'),
      specific_properties: z
        .array(z.string())
        .optional()
        .describe('Specific CSS property names to return (overrides the properties group)'),
      force_refresh: z
        .boolean()
        .optional()
        .default(false)
        .describe('Request fresh capture from extension or scanner for this selector'),
    },
    async ({ selector, properties, specific_properties, force_refresh }) => {
      // Determine property filter for on-demand collection
      const propFilter = specific_properties ??
        (properties !== 'all' ? PROPERTY_GROUPS[properties] : undefined);

      // If force_refresh, try to get fresh data from extension
      if (force_refresh) {
        const sessions = store.getSessionInfo();
        const activeSession = sessions.find((s) => s.isConnected);
        if (activeSession) {
          try {
            await collector.sendCommand(activeSession.sessionId, {
              command: 'recon_computed_styles',
              requestId: crypto.randomUUID(),
              params: { selector, properties: propFilter },
            });
          } catch {
            // Fall through to stored data or scanner fallback
          }
        }
      }

      // Check for pre-captured events first
      const events = store.getReconComputedStyles();
      let event = events.find((e) => e.selector === selector) ?? events[0];

      // Fallback: if no pre-captured data, use the scanner to query live
      if ((!event || event.entries.length === 0) && scanner.getLastScannedUrl()) {
        const url = scanner.getLastScannedUrl()!;
        try {
          const raw = await scanner.queryComputedStyles(url, selector, propFilter);
          if (raw.entries.length > 0) {
            // Build a synthetic event and store it for caching
            const syntheticEvent = {
              eventId: `evt-scan-cs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              sessionId: `scan-${Date.now()}`,
              timestamp: Date.now(),
              eventType: 'recon_computed_styles' as const,
              url,
              selector: raw.selector,
              propertyFilter: raw.propertyFilter,
              entries: raw.entries,
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

      if (!event || event.entries.length === 0) {
        const hint = scanner.getLastScannedUrl()
          ? `No elements matched "${selector}" on the scanned page. Check the selector and try again.`
          : `No computed styles captured for "${selector}". Run scan_website first to scan a page, then query selectors on it.`;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: hint,
              data: null,
              issues: ['No computed style data available for this selector'],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId },
            }, null, 2),
          }],
        };
      }

      const issues: string[] = [];

      // Filter properties if a group or specific list is requested
      const entries = event.entries.map((entry) => {
        let styles = entry.styles;

        if (specific_properties && specific_properties.length > 0) {
          const filtered: Record<string, string> = {};
          for (const prop of specific_properties) {
            if (styles[prop] !== undefined) filtered[prop] = styles[prop];
          }
          styles = filtered;
        } else if (properties !== 'all' && PROPERTY_GROUPS[properties]) {
          const group = PROPERTY_GROUPS[properties];
          const filtered: Record<string, string> = {};
          for (const prop of group) {
            if (styles[prop] !== undefined) filtered[prop] = styles[prop];
          }
          styles = filtered;
        }

        return {
          selector: entry.selector,
          matchCount: entry.matchCount,
          styles,
          variations: entry.variations ?? [],
        };
      });

      // Flag variations
      for (const entry of entries) {
        if (entry.variations.length > 0) {
          issues.push(
            `${entry.variations.length} property variation(s) across ${entry.matchCount} matching elements for "${entry.selector}".`,
          );
        }
      }

      const totalProps = entries.reduce((sum, e) => sum + Object.keys(e.styles).length, 0);

      const response = {
        summary: `${entries.length} element(s) matched "${selector}". ${totalProps} CSS properties returned${properties !== 'all' ? ` (${properties} group)` : ''}.`,
        data: {
          selector,
          propertyFilter: specific_properties ?? properties,
          entries,
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
