import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  EventStore,
  SessionManager,
  CollectorServer,
  ApiDiscoveryEngine,
  DetectedIssue,
} from '@runtimescope/collector';
import { detectIssues } from '@runtimescope/collector';
import { projectIdParam, resolveSessionContext } from './shared.js';

export function registerQaCheckTools(
  server: McpServer,
  store: EventStore,
  sessionManager: SessionManager,
  collector: CollectorServer,
  apiDiscovery?: ApiDiscoveryEngine,
): void {
  server.tool(
    'runtime_qa_check',
    'Quick health check — snapshots the current session state and runs all issue detectors in one call. Use after making code changes to verify nothing is broken. Returns a snapshot (for later comparison) plus any detected issues. Combines create_session_snapshot + detect_issues into a single action.',
    {
      project_id: projectIdParam,
      label: z
        .string()
        .optional()
        .describe('Label for the snapshot (e.g., "after-fix", "pre-deploy", "baseline")'),
      since_seconds: z
        .number()
        .optional()
        .describe('Only detect issues from events in the last N seconds (default: all)'),
    },
    async ({ project_id, label, since_seconds }) => {
      const { sessionId } = resolveSessionContext(store, project_id);

      if (!sessionId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: 'No active session found. Connect an SDK first.',
              data: null,
              issues: ['No active sessions — connect an SDK with RuntimeScope.init()'],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null, projectId: project_id ?? null },
            }, null, 2),
          }],
        };
      }

      // 1. Create snapshot
      const projectName = collector.getProjectForSession(sessionId) ?? 'default';
      const snapshot = sessionManager.createSnapshot(sessionId, projectName, label ?? 'qa-check');

      // 2. Detect issues
      const events = store.getAllEvents(since_seconds, undefined, project_id);
      const allIssues: DetectedIssue[] = [...detectIssues(events)];

      if (apiDiscovery) {
        try {
          allIssues.push(...apiDiscovery.detectIssues());
        } catch { /* non-fatal */ }
      }

      // Sort by severity
      const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
      allIssues.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));

      // 3. Build summary
      const highCount = allIssues.filter((i) => i.severity === 'high').length;
      const medCount = allIssues.filter((i) => i.severity === 'medium').length;
      const lowCount = allIssues.filter((i) => i.severity === 'low').length;

      const issuesSummary = allIssues.length === 0
        ? 'No issues detected.'
        : `${allIssues.length} issue(s): ${highCount} high, ${medCount} medium, ${lowCount} low.`;

      const metricsSummary = [
        `${snapshot.metrics.totalEvents} events`,
        `${snapshot.metrics.errorCount} errors`,
        `${Object.keys(snapshot.metrics.endpoints).length} endpoints`,
        `${Object.keys(snapshot.metrics.components).length} components`,
      ].join(', ');

      const webVitalsSummary = Object.entries(snapshot.metrics.webVitals)
        .map(([name, v]) => `${name}: ${typeof v.value === 'number' ? v.value.toFixed(1) : v.value} (${v.rating})`)
        .join(', ');

      const response = {
        summary: `QA Check complete. Snapshot saved${label ? ` as "${label}"` : ''}. ${metricsSummary}. ${issuesSummary}`,
        data: {
          snapshot: {
            id: snapshot.id,
            sessionId: snapshot.sessionId,
            project: snapshot.project,
            label: snapshot.label ?? null,
            createdAt: new Date(snapshot.createdAt).toISOString(),
            metrics: {
              totalEvents: snapshot.metrics.totalEvents,
              errorCount: snapshot.metrics.errorCount,
              endpointCount: Object.keys(snapshot.metrics.endpoints).length,
              componentCount: Object.keys(snapshot.metrics.components).length,
              webVitals: snapshot.metrics.webVitals,
              queryCount: Object.keys(snapshot.metrics.queries).length,
            },
          },
          issues: allIssues.map((i) => ({
            severity: i.severity,
            pattern: i.pattern,
            title: i.title,
            description: i.description,
            evidence: i.evidence,
            suggestion: i.suggestion,
          })),
          nextSteps: allIssues.length > 0
            ? 'Fix the issues above, then run runtime_qa_check again to compare. Use compare_sessions with the snapshot ID to see what changed.'
            : 'All clear! Use compare_sessions later to track regressions.',
        },
        issues: allIssues.map((i) => `[${i.severity.toUpperCase()}] ${i.title}`),
        metadata: {
          timeRange: {
            from: snapshot.metrics.connectedAt,
            to: snapshot.metrics.disconnectedAt || Date.now(),
          },
          eventCount: snapshot.metrics.totalEvents,
          sessionId,
          projectId: project_id ?? null,
          webVitals: webVitalsSummary || null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
