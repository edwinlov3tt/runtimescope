import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager, SessionMetrics, CollectorServer, ProjectManager } from '@runtimescope/collector';
import { compareSessions } from '@runtimescope/collector';
import { projectIdParam } from './shared.js';

export function registerSessionDiffTools(
  server: McpServer,
  sessionManager: SessionManager,
  collector: CollectorServer,
  projectManager?: ProjectManager,
): void {
  // --- create_session_snapshot ---
  server.tool(
    'create_session_snapshot',
    'Capture a point-in-time snapshot of a live or recent session. Use before/after code changes to compare how your app behaves at different moments. Each session can have multiple snapshots.',
    {
      session_id: z.string().optional().describe('Session ID (defaults to first active session)'),
      label: z.string().optional().describe('Label for this snapshot (e.g., "before-fix", "baseline", "after-deploy")'),
      project: z.string().optional().describe('Project name'),
      project_id: projectIdParam,
    },
    async ({ session_id, label, project, project_id }) => {
      const sessionId = session_id ?? collector.getFirstSessionId();
      if (!sessionId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: 'No active session found. Connect an SDK first.',
            data: null,
            issues: ['No active sessions — connect an SDK with RuntimeScope.init()'],
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      const projectName = project
        ?? (project_id && projectManager ? projectManager.getAppForProjectId(project_id) : undefined)
        ?? collector.getProjectForSession(sessionId) ?? 'default';
      const snapshot = sessionManager.createSnapshot(sessionId, projectName, label);

      const response = {
        summary: `Snapshot captured for session ${sessionId.slice(0, 8)}${label ? ` (label: "${label}")` : ''}. ${snapshot.metrics.totalEvents} events, ${snapshot.metrics.errorCount} errors.`,
        data: {
          sessionId: snapshot.sessionId,
          project: snapshot.project,
          label: snapshot.label ?? null,
          createdAt: new Date(snapshot.createdAt).toISOString(),
          metrics: {
            totalEvents: snapshot.metrics.totalEvents,
            errorCount: snapshot.metrics.errorCount,
            endpointCount: Object.keys(snapshot.metrics.endpoints).length,
            componentCount: Object.keys(snapshot.metrics.components).length,
            storeCount: Object.keys(snapshot.metrics.stores).length,
            webVitalCount: Object.keys(snapshot.metrics.webVitals).length,
            queryCount: Object.keys(snapshot.metrics.queries).length,
          },
        },
        issues: [] as string[],
        metadata: {
          timeRange: { from: snapshot.metrics.connectedAt, to: snapshot.metrics.disconnectedAt },
          eventCount: snapshot.metrics.totalEvents,
          sessionId: snapshot.sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_session_snapshots ---
  server.tool(
    'get_session_snapshots',
    'List all snapshots for a session. Use with compare_sessions to track how your app changed over time within a single session.',
    {
      session_id: z.string().describe('Session ID'),
      project: z.string().optional().describe('Project name'),
      project_id: projectIdParam,
    },
    async ({ session_id, project, project_id }) => {
      const projectName = project
        ?? (project_id && projectManager ? projectManager.getAppForProjectId(project_id) : undefined)
        ?? collector.getProjectForSession(session_id) ?? 'default';
      const snapshots = sessionManager.getSessionSnapshots(projectName, session_id);

      const response = {
        summary: `${snapshots.length} snapshot(s) for session ${session_id.slice(0, 8)}.`,
        data: snapshots.map((s) => ({
          id: s.id,
          sessionId: s.sessionId,
          label: s.label ?? null,
          createdAt: new Date(s.createdAt).toISOString(),
          totalEvents: s.metrics.totalEvents,
          errorCount: s.metrics.errorCount,
          endpointCount: Object.keys(s.metrics.endpoints).length,
          componentCount: Object.keys(s.metrics.components).length,
        })),
        issues: [] as string[],
        metadata: {
          timeRange: snapshots.length > 0
            ? { from: snapshots[0].createdAt, to: snapshots[snapshots.length - 1].createdAt }
            : { from: 0, to: 0 },
          eventCount: snapshots.length,
          sessionId: session_id,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- compare_sessions ---
  server.tool(
    'compare_sessions',
    'Compare two sessions or two snapshots: render counts, API latency, errors, Web Vitals, and query performance. Shows regressions and improvements. Use snapshot_a/snapshot_b to compare specific snapshots within or across sessions.',
    {
      session_a: z.string().optional().describe('First session ID (baseline) — used when comparing sessions'),
      session_b: z.string().optional().describe('Second session ID (comparison) — used when comparing sessions'),
      snapshot_a: z.number().optional().describe('First snapshot ID (baseline) — used when comparing snapshots'),
      snapshot_b: z.number().optional().describe('Second snapshot ID (comparison) — used when comparing snapshots'),
      project: z.string().optional().describe('Project name'),
      project_id: projectIdParam,
    },
    async ({ session_a, session_b, snapshot_a, snapshot_b, project, project_id }) => {
      const projectName = project
        ?? (project_id && projectManager ? projectManager.getAppForProjectId(project_id) : undefined)
        ?? 'default';

      let metricsA: SessionMetrics | null = null;
      let metricsB: SessionMetrics | null = null;
      let labelA = '';
      let labelB = '';

      if (snapshot_a != null && snapshot_b != null) {
        // Snapshot-based comparison
        const snapA = sessionManager.getSnapshotById(projectName, snapshot_a);
        const snapB = sessionManager.getSnapshotById(projectName, snapshot_b);

        if (!snapA || !snapB) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              summary: 'Could not find one or both snapshots.',
              data: null,
              issues: [
                !snapA ? `Snapshot ${snapshot_a} not found` : null,
                !snapB ? `Snapshot ${snapshot_b} not found` : null,
              ].filter(Boolean),
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
            }, null, 2) }],
          };
        }

        metricsA = snapA.metrics;
        metricsB = snapB.metrics;
        labelA = snapA.label ? ` (${snapA.label})` : ` (snapshot #${snapshot_a})`;
        labelB = snapB.label ? ` (${snapB.label})` : ` (snapshot #${snapshot_b})`;
      } else if (session_a && session_b) {
        // Session-based comparison (latest snapshot per session)
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

        metricsA = snapshotA.metrics;
        metricsB = snapshotB.metrics;
        labelA = ` (session ${session_a.slice(0, 8)})`;
        labelB = ` (session ${session_b.slice(0, 8)})`;
      } else {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: 'Provide either session_a + session_b or snapshot_a + snapshot_b.',
            data: null,
            issues: ['Must provide either two session IDs or two snapshot IDs to compare.'],
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      const diff = compareSessions(metricsA, metricsB);

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
        summary: `Comparison${labelA} vs${labelB}: ${regressions.length} regression(s), ${improvements.length} improvement(s). Error delta: ${diff.overallDelta.errorCountDelta >= 0 ? '+' : ''}${diff.overallDelta.errorCountDelta}.`,
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
          timeRange: { from: metricsA.connectedAt, to: metricsB.disconnectedAt },
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
