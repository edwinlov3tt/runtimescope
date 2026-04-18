import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import { projectIdParam, resolveSessionContext } from './shared.js';

export function registerSessionTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_session_info',
    'Get information about connected SDK sessions and overall event statistics. Includes diagnostic context — "how long ago was the last event", "is the collector even listening" — so you can tell the difference between "SDK not installed", "SDK installed but app not running", and "connected but silent".',
    {
      project_id: projectIdParam,
    },
    async ({ project_id }) => {
      const { sessions, sessionId } = resolveSessionContext(store, project_id);
      const now = Date.now();

      // Find the most recent session regardless of filter, so we can tell Claude
      // "there's activity, but not on the project you asked about"
      const allSessions = store.getSessionInfo();
      const mostRecentAnyProject = allSessions.reduce<
        { sessionId: string; appName: string; projectId?: string; lastActivity: number } | null
      >((best, s) => {
        const activity = Math.max(s.connectedAt, 0);
        if (!best || activity > best.lastActivity) {
          return {
            sessionId: s.sessionId,
            appName: s.appName,
            projectId: s.projectId,
            lastActivity: activity,
          };
        }
        return best;
      }, null);

      // Craft a diagnostic that tells Claude WHY we have no data, if we don't
      const issues: string[] = [];
      let suggestion: string | null = null;
      if (sessions.length === 0) {
        if (allSessions.length === 0) {
          issues.push('No SDK connections detected on any project.');
          suggestion =
            'Either the collector has no sessions yet (app not started / no DSN), or the SDK failed silently. Start the app and reload the page, then call wait_for_session to block until an SDK connects.';
        } else if (project_id) {
          issues.push(
            `No sessions matched project_id=${project_id}. Other projects have sessions.`,
          );
          suggestion = `Try without the project_id filter — the most recent activity was on project ${mostRecentAnyProject?.projectId ?? '(none)'} / app ${mostRecentAnyProject?.appName ?? '(unknown)'}.`;
        }
      } else {
        const hasConnected = sessions.some((s) => s.isConnected);
        if (!hasConnected) {
          issues.push('Sessions exist but none are currently connected.');
          suggestion =
            'The SDK disconnected — reload the page to reconnect, or the app may not be running.';
        }
      }

      const response = {
        summary:
          sessions.length > 0
            ? `${sessions.length} session(s) for ${project_id ?? 'all projects'}. ${sessions.filter((s) => s.isConnected).length} currently connected. ${store.eventCount} total events.`
            : 'No matching sessions. See issues + suggestion for how to proceed.',
        data: sessions.map((s) => ({
          sessionId: s.sessionId,
          projectId: s.projectId ?? null,
          appName: s.appName,
          sdkVersion: s.sdkVersion,
          connectedAt: new Date(s.connectedAt).toISOString(),
          connectedAgoSeconds: Math.round((now - s.connectedAt) / 1000),
          eventCount: s.eventCount,
          isConnected: s.isConnected,
        })),
        suggestion,
        issues,
        metadata: {
          timeRange: { from: 0, to: now },
          eventCount: store.eventCount,
          sessionId,
          projectId: project_id ?? null,
          totalSessionsAcrossProjects: allSessions.length,
          mostRecentActivity: mostRecentAnyProject
            ? {
                appName: mostRecentAnyProject.appName,
                projectId: mostRecentAnyProject.projectId ?? null,
                agoSeconds: Math.round((now - mostRecentAnyProject.lastActivity) / 1000),
              }
            : null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'wait_for_session',
    'Block until at least one SDK session is connected for this project, or until the timeout elapses. Use this right after starting a dev server or telling the user to reload their app — it removes the "tried too early, got empty results" race. Polls every 500ms.',
    {
      project_id: projectIdParam,
      timeout_seconds: z
        .number()
        .min(1)
        .max(120)
        .optional()
        .default(30)
        .describe('How long to wait before giving up. Defaults to 30s, max 120s.'),
      min_events: z
        .number()
        .min(0)
        .optional()
        .default(0)
        .describe(
          'Also wait until at least N events have been captured for this session. Useful if you want to make sure the SDK had time to actually send something, not just handshake.',
        ),
    },
    async ({ project_id, timeout_seconds, min_events }) => {
      const startedAt = Date.now();
      const deadline = startedAt + timeout_seconds * 1000;

      let lastSnapshot: { sessions: number; connected: number; events: number } = {
        sessions: 0,
        connected: 0,
        events: 0,
      };

      while (Date.now() < deadline) {
        const { sessions } = resolveSessionContext(store, project_id);
        const connected = sessions.filter((s) => s.isConnected);
        const eventsFromProject =
          project_id != null
            ? store
                .getAllEvents(undefined, undefined, project_id)
                .length
            : store.eventCount;

        lastSnapshot = {
          sessions: sessions.length,
          connected: connected.length,
          events: eventsFromProject,
        };

        if (connected.length > 0 && eventsFromProject >= min_events) {
          const took = Math.round((Date.now() - startedAt) / 1000);
          const s = connected[0];
          const response = {
            summary: `✓ Connected in ${took}s — session ${s.sessionId.slice(0, 8)} (${s.appName}) is live with ${eventsFromProject} events.`,
            data: {
              waited_seconds: took,
              sessions: connected.length,
              total_events: eventsFromProject,
              first_session: {
                sessionId: s.sessionId,
                appName: s.appName,
                projectId: s.projectId ?? null,
                connectedAt: new Date(s.connectedAt).toISOString(),
              },
            },
            issues: [],
            metadata: {
              timeRange: { from: startedAt, to: Date.now() },
              eventCount: eventsFromProject,
              sessionId: s.sessionId,
              projectId: project_id ?? null,
            },
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
          };
        }

        await new Promise((r) => setTimeout(r, 500));
      }

      // Timed out — return structured info so Claude knows to suggest a fix
      const response = {
        summary: `Timed out after ${timeout_seconds}s waiting for a session${project_id ? ` on project ${project_id}` : ''}. Saw ${lastSnapshot.sessions} session(s), ${lastSnapshot.connected} connected, ${lastSnapshot.events} events.`,
        data: {
          waited_seconds: timeout_seconds,
          timed_out: true,
          ...lastSnapshot,
        },
        issues: [
          lastSnapshot.sessions === 0
            ? 'No SDK ever connected — check: (1) SDK installed? (2) DSN set? (3) app actually running?'
            : lastSnapshot.connected === 0
              ? 'Sessions exist but none are connected right now — reload the app.'
              : 'Session connected but no events yet — interact with the app to generate some.',
        ],
        metadata: {
          timeRange: { from: startedAt, to: Date.now() },
          eventCount: lastSnapshot.events,
          sessionId: null,
          projectId: project_id ?? null,
        },
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
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
    },
  );
}
