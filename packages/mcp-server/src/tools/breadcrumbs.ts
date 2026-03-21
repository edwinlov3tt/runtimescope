import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  EventStore,
  RuntimeEvent,
  NetworkEvent,
  ConsoleEvent,
  NavigationEvent,
  CustomEvent,
  StateEvent,
  UIInteractionEvent,
} from '@runtimescope/collector';

/**
 * A single breadcrumb entry — a lightweight, human-readable record
 * of something that happened in the app.
 */
interface Breadcrumb {
  timestamp: string;
  relativeMs: number;
  category: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Convert a RuntimeEvent into a breadcrumb entry.
 * Returns null for event types we don't want in the trail.
 */
function eventToBreadcrumb(event: RuntimeEvent, anchorTs: number): Breadcrumb | null {
  const base = {
    timestamp: new Date(event.timestamp).toISOString(),
    relativeMs: event.timestamp - anchorTs,
  };

  switch (event.eventType) {
    case 'navigation': {
      const nav = event as NavigationEvent;
      return {
        ...base,
        category: 'navigation',
        level: 'info',
        message: `${nav.trigger}: ${nav.to}`,
        data: { from: nav.from },
      };
    }

    case 'ui': {
      const ui = event as UIInteractionEvent;
      if (ui.action === 'click') {
        return {
          ...base,
          category: 'ui.click',
          level: 'info',
          message: ui.text ? `Click: ${ui.text}` : `Click: ${ui.target}`,
          data: { target: ui.target },
        };
      }
      // Manual breadcrumb
      return {
        ...base,
        category: 'breadcrumb',
        level: 'info',
        message: ui.text ?? ui.target,
        ...(ui.data && { data: ui.data }),
      };
    }

    case 'console': {
      const con = event as ConsoleEvent;
      const level = con.level === 'error' ? 'error'
        : con.level === 'warn' ? 'warning'
        : con.level === 'debug' || con.level === 'trace' ? 'debug'
        : 'info';
      return {
        ...base,
        category: `console.${con.level}`,
        level,
        message: con.message.slice(0, 200),
        ...(con.stackTrace && { data: { hasStack: true } }),
      };
    }

    case 'network': {
      const net = event as NetworkEvent;
      const level = net.errorPhase ? 'error'
        : net.status >= 400 ? 'warning'
        : 'info';
      const url = new URL(net.url, 'http://localhost').pathname;
      return {
        ...base,
        category: 'http',
        level,
        message: `${net.method} ${url} → ${net.status || net.errorPhase || 'pending'}`,
        data: { duration: net.duration, status: net.status },
      };
    }

    case 'state': {
      const st = event as StateEvent;
      if (st.phase === 'init') return null; // Skip initial store hydration
      const changedKeys = st.diff ? Object.keys(st.diff).join(', ') : 'unknown';
      return {
        ...base,
        category: 'state',
        level: 'debug',
        message: `${st.storeId}: ${changedKeys}`,
        data: { library: st.library },
      };
    }

    case 'custom': {
      const cust = event as CustomEvent;
      return {
        ...base,
        category: `custom.${cust.name}`,
        level: 'info',
        message: cust.name,
        ...(cust.properties && { data: cust.properties }),
      };
    }

    default:
      return null;
  }
}

const MAX_BREADCRUMBS = 200;

export function registerBreadcrumbTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_breadcrumbs',
    'Get the chronological trail of user actions, navigation, clicks, console logs, network requests, and state changes leading up to a point in time (or an error). This is the primary debugging context tool — use it when investigating errors, unexpected behavior, or user-reported issues.',
    {
      since_seconds: z
        .number()
        .optional()
        .describe('How far back to look (default: 60 seconds)'),
      session_id: z
        .string()
        .optional()
        .describe('Filter to a specific session'),
      before_timestamp: z
        .number()
        .optional()
        .describe('Only show breadcrumbs before this Unix ms timestamp (useful for "what happened before this error")'),
      categories: z
        .array(z.string())
        .optional()
        .describe('Filter to specific categories: navigation, ui.click, breadcrumb, console.error, console.warn, console.log, http, state, custom.*'),
      level: z
        .enum(['debug', 'info', 'warning', 'error'])
        .optional()
        .describe('Minimum breadcrumb level to include (default: debug = show all)'),
      limit: z
        .number()
        .optional()
        .describe(`Max breadcrumbs to return (default/max: ${MAX_BREADCRUMBS})`),
    },
    async ({ since_seconds, session_id, before_timestamp, categories, level, limit }) => {
      const sinceSeconds = since_seconds ?? 60;
      const maxItems = Math.min(limit ?? MAX_BREADCRUMBS, MAX_BREADCRUMBS);

      // Get all events in the time window (chronological order)
      const allEvents = store.getEventTimeline({
        sinceSeconds,
        sessionId: session_id,
        eventTypes: ['navigation', 'ui', 'console', 'network', 'state', 'custom'],
      });

      // Determine the anchor timestamp for relative timing
      const anchor = before_timestamp ?? (allEvents.length > 0 ? allEvents[allEvents.length - 1].timestamp : Date.now());

      // Filter events before the anchor timestamp
      const filtered = before_timestamp
        ? allEvents.filter((e) => e.timestamp <= before_timestamp)
        : allEvents;

      // Convert to breadcrumbs
      let breadcrumbs: Breadcrumb[] = [];
      for (const event of filtered) {
        const bc = eventToBreadcrumb(event, anchor);
        if (bc) breadcrumbs.push(bc);
      }

      // Apply category filter
      if (categories && categories.length > 0) {
        const catSet = new Set(categories);
        breadcrumbs = breadcrumbs.filter((bc) => {
          // Exact match or prefix match (e.g., "console" matches "console.error")
          return catSet.has(bc.category) ||
            Array.from(catSet).some((cat) => bc.category.startsWith(cat + '.'));
        });
      }

      // Apply level filter
      if (level) {
        const levelOrder = { debug: 0, info: 1, warning: 2, error: 3 };
        const minLevel = levelOrder[level];
        breadcrumbs = breadcrumbs.filter((bc) => levelOrder[bc.level] >= minLevel);
      }

      // Take the most recent N breadcrumbs
      if (breadcrumbs.length > maxItems) {
        breadcrumbs = breadcrumbs.slice(-maxItems);
      }

      // Find the most recent error for context
      const lastError = breadcrumbs.findLast((bc) => bc.level === 'error');

      const sessions = store.getSessionInfo();
      const sessionId = session_id ?? sessions[0]?.sessionId ?? null;

      const response = {
        summary: `${breadcrumbs.length} breadcrumbs over the last ${sinceSeconds}s${lastError ? ` — last error: "${lastError.message.slice(0, 80)}"` : ''}`,
        data: breadcrumbs,
        metadata: {
          timeRange: {
            from: breadcrumbs.length > 0 ? breadcrumbs[0].relativeMs : 0,
            to: breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].relativeMs : 0,
          },
          eventCount: breadcrumbs.length,
          sessionId,
          anchor: new Date(anchor).toISOString(),
          categoryCounts: countCategories(breadcrumbs),
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}

/** Count breadcrumbs per category for the summary */
function countCategories(breadcrumbs: Breadcrumb[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bc of breadcrumbs) {
    counts[bc.category] = (counts[bc.category] ?? 0) + 1;
  }
  return counts;
}
