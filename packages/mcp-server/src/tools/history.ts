import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CollectorServer, ProjectManager } from '@runtimescope/collector';

const EVENT_TYPES = [
  'network', 'console', 'session', 'state', 'render',
  'dom_snapshot', 'performance', 'database',
  'recon_metadata', 'recon_design_tokens', 'recon_fonts',
  'recon_layout_tree', 'recon_accessibility', 'recon_computed_styles',
  'recon_element_snapshot', 'recon_asset_inventory',
] as const;

/**
 * Parse a date parameter: supports ISO strings, relative strings ("2h", "7d", "30m"), or epoch ms.
 */
function parseDateParam(value: string | undefined): number | undefined {
  if (!value) return undefined;

  // Relative time: "2h", "7d", "30m", "1w"
  const relMatch = value.match(/^(\d+)(m|h|d|w)$/);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit]!;
    return Date.now() - amount * ms;
  }

  // Epoch milliseconds
  const num = Number(value);
  if (!isNaN(num) && num > 1_000_000_000_000) return num;

  // ISO date string
  const date = new Date(value);
  if (!isNaN(date.getTime())) return date.getTime();

  return undefined;
}

export function registerHistoryTools(
  server: McpServer,
  collector: CollectorServer,
  projectManager: ProjectManager,
): void {
  // ---------- get_historical_events ----------
  server.tool(
    'get_historical_events',
    'Query past events from persistent SQLite storage. Use this to access events beyond the in-memory buffer (last 10K events). Events persist across Claude Code restarts. Filter by project, event type, time range, and session.',
    {
      project: z
        .string()
        .describe('Project/app name (the appName used in SDK init)'),
      event_types: z
        .array(z.enum(EVENT_TYPES))
        .optional()
        .describe('Filter by event types (e.g., ["network", "console"])'),
      since: z
        .string()
        .optional()
        .describe('Start time — relative ("2h", "7d", "30m") or ISO date string'),
      until: z
        .string()
        .optional()
        .describe('End time — relative or ISO date string'),
      session_id: z
        .string()
        .optional()
        .describe('Filter by specific session ID'),
      limit: z
        .number()
        .optional()
        .default(200)
        .describe('Max events to return (default 200, max 1000)'),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe('Pagination offset'),
    },
    async ({ project, event_types, since, until, session_id, limit, offset }) => {
      const sqliteStore = collector.getSqliteStore(project);
      if (!sqliteStore) {
        // Check if the project directory exists at all
        const projects = projectManager.listProjects();
        const hint = projects.length > 0
          ? ` Available projects: ${projects.join(', ')}`
          : ' No projects have connected yet.';

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: `No historical data for project "${project}".${hint}`,
            data: null,
            issues: [`Project "${project}" has no SQLite store. Connect an SDK with appName: "${project}" first.`],
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      const sinceMs = parseDateParam(since);
      const untilMs = parseDateParam(until);
      const cappedLimit = Math.min(limit, 1000);

      const events = sqliteStore.getEvents({
        project,
        sessionId: session_id,
        eventTypes: event_types as string[] | undefined,
        since: sinceMs,
        until: untilMs,
        limit: cappedLimit,
        offset,
      });

      const totalCount = sqliteStore.getEventCount({
        project,
        sessionId: session_id,
        eventTypes: event_types as string[] | undefined,
        since: sinceMs,
        until: untilMs,
      });

      const timeRange = events.length > 0
        ? { from: events[0].timestamp, to: events[events.length - 1].timestamp }
        : { from: 0, to: 0 };

      // Group by event type for summary
      const typeCounts: Record<string, number> = {};
      for (const e of events) {
        typeCounts[e.eventType] = (typeCounts[e.eventType] || 0) + 1;
      }

      const typeBreakdown = Object.entries(typeCounts)
        .map(([type, count]) => `${type}: ${count}`)
        .join(', ');

      const response = {
        summary: `${events.length} events returned (${totalCount} total matching). ${typeBreakdown || 'No events.'}${totalCount > cappedLimit + offset ? ` Use offset=${offset + cappedLimit} for next page.` : ''}`,
        data: {
          events,
          pagination: {
            returned: events.length,
            total: totalCount,
            limit: cappedLimit,
            offset,
            hasMore: offset + cappedLimit < totalCount,
          },
        },
        issues: [] as string[],
        metadata: {
          timeRange,
          eventCount: events.length,
          sessionId: session_id ?? null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  // ---------- list_projects ----------
  server.tool(
    'list_projects',
    'List all projects with stored historical data. Shows project names, event counts, session counts, and date ranges from SQLite persistence.',
    {},
    async () => {
      const projectNames = projectManager.listProjects();

      const projects = projectNames.map((name) => {
        const sqliteStore = collector.getSqliteStore(name);
        if (!sqliteStore) {
          return {
            name,
            eventCount: 0,
            sessionCount: 0,
            isConnected: false,
            note: 'Project directory exists but no active SQLite store (SDK has not connected this session)',
          };
        }

        const eventCount = sqliteStore.getEventCount({ project: name });
        const sessions = sqliteStore.getSessions(name, 100);
        const connectedSessions = sessions.filter((s) => s.isConnected);

        return {
          name,
          eventCount,
          sessionCount: sessions.length,
          activeSessions: connectedSessions.length,
          isConnected: connectedSessions.length > 0,
          oldestSession: sessions.length > 0
            ? new Date(sessions[sessions.length - 1].connectedAt).toISOString()
            : null,
          newestSession: sessions.length > 0
            ? new Date(sessions[0].connectedAt).toISOString()
            : null,
        };
      });

      const totalEvents = projects.reduce((s, p) => s + p.eventCount, 0);
      const connectedCount = projects.filter((p) => p.isConnected).length;

      const response = {
        summary: `${projects.length} project(s), ${totalEvents} total events, ${connectedCount} currently connected.`,
        data: projects,
        issues: [] as string[],
        metadata: {
          timeRange: { from: 0, to: 0 },
          eventCount: projects.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
