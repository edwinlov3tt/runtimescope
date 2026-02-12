import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';

export function registerPerformanceTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_performance_metrics',
    'Get Web Vitals performance metrics (LCP, FCP, CLS, TTFB, FID, INP) captured from the running app. Each metric includes its value and a rating (good/needs-improvement/poor) based on web.dev thresholds. Requires capturePerformance: true in the SDK config.',
    {
      metric_name: z
        .enum(['LCP', 'FCP', 'CLS', 'TTFB', 'FID', 'INP'])
        .optional()
        .describe('Filter by specific metric'),
      since_seconds: z
        .number()
        .optional()
        .describe('Only return metrics from the last N seconds'),
    },
    async ({ metric_name, since_seconds }) => {
      const events = store.getPerformanceMetrics({
        metricName: metric_name,
        sinceSeconds: since_seconds,
      });

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;
      const issues: string[] = [];

      // Flag poor metrics
      const poor = events.filter((e) => e.rating === 'poor');
      const needsImprovement = events.filter((e) => e.rating === 'needs-improvement');
      if (poor.length > 0) {
        issues.push(`${poor.length} metric(s) rated "poor": ${poor.map((e) => e.metricName).join(', ')}`);
      }
      if (needsImprovement.length > 0) {
        issues.push(`${needsImprovement.length} metric(s) need improvement: ${needsImprovement.map((e) => e.metricName).join(', ')}`);
      }

      // Show latest value per metric
      const latest = new Map<string, typeof events[0]>();
      for (const e of events) {
        latest.set(e.metricName, e);
      }

      const response = {
        summary: `${latest.size} unique metric(s) captured. ${poor.length} poor, ${needsImprovement.length} needs improvement.`,
        data: Array.from(latest.values()).map((e) => ({
          metricName: e.metricName,
          value: e.value,
          unit: e.metricName === 'CLS' ? 'score' : 'ms',
          rating: e.rating,
          element: e.element ?? null,
          timestamp: new Date(e.timestamp).toISOString(),
        })),
        allEvents: events.map((e) => ({
          metricName: e.metricName,
          value: e.value,
          rating: e.rating,
          timestamp: new Date(e.timestamp).toISOString(),
        })),
        issues,
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
