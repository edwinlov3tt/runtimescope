import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore, DetectedIssue } from '@runtimescope/collector';
import { detectIssues } from '@runtimescope/collector';
import type { ApiDiscoveryEngine } from '@runtimescope/collector';
import type { ProcessMonitor } from '@runtimescope/collector';

export function registerIssueTools(
  server: McpServer,
  store: EventStore,
  apiDiscovery?: ApiDiscoveryEngine,
  processMonitor?: ProcessMonitor
): void {
  server.tool(
    'detect_issues',
    'Run all pattern detectors against captured runtime data and return prioritized issues. Detects: failed requests, slow requests (>3s), N+1 request patterns, console error spam, high error rates, slow DB queries (>500ms), N+1 DB queries, API degradation, high latency endpoints, orphaned processes, and more. Use this as the first tool when investigating performance problems.',
    {
      since_seconds: z
        .number()
        .optional()
        .describe('Analyze events from the last N seconds (default: all events)'),
      severity_filter: z
        .enum(['high', 'medium', 'low'])
        .optional()
        .describe('Only return issues at this severity or above'),
    },
    async ({ since_seconds, severity_filter }) => {
      const events = store.getAllEvents(since_seconds);
      const allIssues: DetectedIssue[] = [...detectIssues(events)];

      // Merge engine-contributed issues
      if (apiDiscovery) {
        try {
          allIssues.push(...apiDiscovery.detectIssues(events));
        } catch { /* engine may not have data yet */ }
      }
      if (processMonitor) {
        try {
          allIssues.push(...processMonitor.detectIssues());
        } catch { /* engine may not have scanned yet */ }
      }

      // Re-sort merged issues by severity
      const severityOrder = { high: 0, medium: 1, low: 2 };
      allIssues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

      const filterThreshold = severity_filter ? severityOrder[severity_filter] : 2;
      const issues = allIssues.filter(
        (i) => severityOrder[i.severity] <= filterThreshold
      );

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      const highCount = issues.filter((i) => i.severity === 'high').length;
      const mediumCount = issues.filter((i) => i.severity === 'medium').length;
      const lowCount = issues.filter((i) => i.severity === 'low').length;

      const summaryParts: string[] = [];
      if (issues.length === 0) {
        summaryParts.push('No issues detected.');
      } else {
        summaryParts.push(`Found ${issues.length} issue(s):`);
        if (highCount > 0) summaryParts.push(`${highCount} HIGH`);
        if (mediumCount > 0) summaryParts.push(`${mediumCount} MEDIUM`);
        if (lowCount > 0) summaryParts.push(`${lowCount} LOW`);
      }
      summaryParts.push(`Analyzed ${events.length} events${since_seconds ? ` from last ${since_seconds}s` : ''}.`);

      const response = {
        summary: summaryParts.join(' '),
        data: issues.map((i) => ({
          severity: i.severity.toUpperCase(),
          pattern: i.pattern,
          title: i.title,
          description: i.description,
          evidence: i.evidence,
          suggestion: i.suggestion ?? null,
        })),
        issues: issues.map((i) => `[${i.severity.toUpperCase()}] ${i.title}`),
        metadata: {
          timeRange: {
            from: events.length > 0 ? events[0].timestamp : 0,
            to: events.length > 0 ? events[events.length - 1].timestamp : 0,
          },
          eventCount: events.length,
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
