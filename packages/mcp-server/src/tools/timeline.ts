import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import type {
  RuntimeEvent,
  NetworkEvent,
  ConsoleEvent,
  StateEvent,
  RenderEvent,
  PerformanceEvent,
  DomSnapshotEvent,
  DatabaseEvent,
} from '@runtimescope/collector';

export function registerTimelineTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_event_timeline',
    'Get a chronological view of ALL events (network requests, console messages) interleaved by timestamp. Essential for understanding causal chains — e.g. seeing that an API call failed, then an error was logged, then another retry fired. Events are in chronological order (oldest first).',
    {
      since_seconds: z
        .number()
        .optional()
        .describe('Only return events from the last N seconds (default: 60)'),
      event_types: z
        .array(z.enum(['network', 'console', 'session', 'state', 'render', 'performance', 'dom_snapshot', 'database']))
        .optional()
        .describe('Filter by event types (default: all)'),
      limit: z
        .number()
        .optional()
        .describe('Max events to return (default: 200, max: 1000)'),
    },
    async ({ since_seconds, event_types, limit }) => {
      const sinceSeconds = since_seconds ?? 60;
      const maxEvents = Math.min(limit ?? 200, 1000);

      const events = store.getEventTimeline({
        sinceSeconds,
        eventTypes: event_types as any,
      });

      // Take the most recent N events if over limit
      const trimmed = events.length > maxEvents
        ? events.slice(events.length - maxEvents)
        : events;

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      // Build summary stats
      const typeCounts: Record<string, number> = {};
      for (const e of trimmed) {
        typeCounts[e.eventType] = (typeCounts[e.eventType] || 0) + 1;
      }
      const typeBreakdown = Object.entries(typeCounts)
        .map(([t, c]) => `${c} ${t}`)
        .join(', ');

      const response = {
        summary: `Timeline: ${trimmed.length} event(s) in the last ${sinceSeconds}s${events.length > maxEvents ? ` (showing last ${maxEvents} of ${events.length})` : ''}. Breakdown: ${typeBreakdown || 'none'}.`,
        data: trimmed.map((e) => formatTimelineEvent(e)),
        issues: [],
        metadata: {
          timeRange: {
            from: trimmed.length > 0 ? trimmed[0].timestamp : 0,
            to: trimmed.length > 0 ? trimmed[trimmed.length - 1].timestamp : 0,
          },
          eventCount: trimmed.length,
          totalInWindow: events.length,
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}

function formatTimelineEvent(event: RuntimeEvent): Record<string, unknown> {
  const base = {
    type: event.eventType,
    timestamp: new Date(event.timestamp).toISOString(),
    relativeMs: 0, // will be set by caller if needed
  };

  switch (event.eventType) {
    case 'network': {
      const ne = event as NetworkEvent;
      return {
        ...base,
        method: ne.method,
        url: ne.url,
        status: ne.status,
        duration: `${ne.duration.toFixed(0)}ms`,
        graphql: ne.graphqlOperation
          ? `${ne.graphqlOperation.type} ${ne.graphqlOperation.name}`
          : null,
      };
    }
    case 'console': {
      const ce = event as ConsoleEvent;
      return {
        ...base,
        level: ce.level,
        message: ce.message.length > 200 ? ce.message.slice(0, 200) + '...' : ce.message,
        hasStack: !!ce.stackTrace,
      };
    }
    case 'session':
      return {
        ...base,
        note: 'SDK session connected',
      };
    case 'state': {
      const se = event as StateEvent;
      return {
        ...base,
        storeId: se.storeId,
        library: se.library,
        phase: se.phase,
        action: se.action?.type ?? null,
        changedKeys: se.diff ? Object.keys(se.diff).join(', ') : null,
      };
    }
    case 'render': {
      const re = event as RenderEvent;
      return {
        ...base,
        totalRenders: re.totalRenders,
        componentCount: re.profiles.length,
        suspicious: re.suspiciousComponents.length > 0
          ? re.suspiciousComponents.join(', ')
          : null,
      };
    }
    case 'performance': {
      const pe = event as PerformanceEvent;
      return {
        ...base,
        metric: pe.metricName,
        value: pe.value,
        rating: pe.rating,
        element: pe.element ?? null,
      };
    }
    case 'dom_snapshot': {
      const ds = event as DomSnapshotEvent;
      return {
        ...base,
        url: ds.url,
        elementCount: ds.elementCount,
        htmlSize: `${Math.round(ds.html.length / 1024)}KB`,
        truncated: ds.truncated,
      };
    }
    case 'database': {
      const de = event as DatabaseEvent;
      return {
        ...base,
        operation: de.operation,
        query: de.query.length > 150 ? de.query.slice(0, 150) + '...' : de.query,
        duration: `${de.duration.toFixed(0)}ms`,
        tables: de.tablesAccessed,
        source: de.source,
        error: de.error ?? null,
      };
    }
    default:
      return base;
  }
}
