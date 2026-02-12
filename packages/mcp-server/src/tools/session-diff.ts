import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager, SessionMetrics } from '@runtimescope/collector';
import { compareSessions } from '@runtimescope/collector';

export function registerSessionDiffTools(
  server: McpServer,
  sessionManager: SessionManager
): void {
  // --- compare_sessions ---
  server.tool(
    'compare_sessions',
    'Compare two sessions: render counts, API latency, errors, Web Vitals, and query performance. Shows regressions and improvements.',
    {
      session_a: z.string().describe('First session ID (baseline)'),
      session_b: z.string().describe('Second session ID (comparison)'),
      project: z.string().optional().describe('Project name'),
    },
    async ({ session_a, session_b, project }) => {
      const projectName = project ?? 'default';
      const history = sessionManager.getSessionHistory(projectName, 100);

      const snapshotA = history.find((s) => s.sessionId === session_a);
      const snapshotB = history.find((s) => s.sessionId === session_b);

      if (!snapshotA || !snapshotB) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: 'Could not find one or both sessions in history.',
            data: null,
            issues: [
              !snapshotA ? `Session ${session_a} not found` : null,
              !snapshotB ? `Session ${session_b} not found` : null,
            ].filter(Boolean),
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      const diff = compareSessions(snapshotA.metrics, snapshotB.metrics);

      const regressions = [
        ...diff.endpointDeltas.filter((d) => d.classification === 'regression'),
        ...diff.componentDeltas.filter((d) => d.classification === 'regression'),
        ...diff.webVitalDeltas.filter((d) => d.classification === 'regression'),
        ...diff.queryDeltas.filter((d) => d.classification === 'regression'),
      ];

      const improvements = [
        ...diff.endpointDeltas.filter((d) => d.classification === 'improvement'),
        ...diff.componentDeltas.filter((d) => d.classification === 'improvement'),
        ...diff.webVitalDeltas.filter((d) => d.classification === 'improvement'),
        ...diff.queryDeltas.filter((d) => d.classification === 'improvement'),
      ];

      const response = {
        summary: `Session comparison: ${regressions.length} regression(s), ${improvements.length} improvement(s). Error delta: ${diff.overallDelta.errorCountDelta >= 0 ? '+' : ''}${diff.overallDelta.errorCountDelta}.`,
        data: {
          endpointDeltas: diff.endpointDeltas.map((d) => ({
            ...d,
            before: `${d.before.toFixed(0)}ms`,
            after: `${d.after.toFixed(0)}ms`,
            percentChange: `${(d.percentChange * 100).toFixed(1)}%`,
          })),
          componentDeltas: diff.componentDeltas.map((d) => ({
            ...d,
            percentChange: `${(d.percentChange * 100).toFixed(1)}%`,
          })),
          webVitalDeltas: diff.webVitalDeltas.map((d) => ({
            ...d,
            percentChange: `${(d.percentChange * 100).toFixed(1)}%`,
          })),
          queryDeltas: diff.queryDeltas.map((d) => ({
            ...d,
            before: `${d.before.toFixed(0)}ms`,
            after: `${d.after.toFixed(0)}ms`,
            percentChange: `${(d.percentChange * 100).toFixed(1)}%`,
          })),
          overallDelta: diff.overallDelta,
        },
        issues: regressions.map((r) => `Regression: ${r.key} (${(r.percentChange * 100).toFixed(1)}% worse)`),
        metadata: {
          timeRange: { from: snapshotA.createdAt, to: snapshotB.createdAt },
          eventCount: 2,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_session_history ---
  server.tool(
    'get_session_history',
    'List past sessions with build metadata, event counts, and timestamps. Requires SQLite persistence.',
    {
      project: z.string().optional().describe('Project name'),
      limit: z.number().optional().describe('Max sessions to return (default 20)'),
    },
    async ({ project, limit }) => {
      const projectName = project ?? 'default';
      const history = sessionManager.getSessionHistory(projectName, limit ?? 20);

      const response = {
        summary: `${history.length} session(s) in history for project "${projectName}".`,
        data: history.map((s) => ({
          sessionId: s.sessionId,
          project: s.project,
          createdAt: new Date(s.createdAt).toISOString(),
          totalEvents: s.metrics.totalEvents,
          errorCount: s.metrics.errorCount,
          endpointCount: Object.keys(s.metrics.endpoints).length,
          componentCount: Object.keys(s.metrics.components).length,
          buildMeta: s.buildMeta ?? null,
        })),
        issues: [] as string[],
        metadata: {
          timeRange: history.length > 0
            ? { from: history[history.length - 1].createdAt, to: history[0].createdAt }
            : { from: 0, to: 0 },
          eventCount: history.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
