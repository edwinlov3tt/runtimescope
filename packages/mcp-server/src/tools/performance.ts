import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';

const WEB_VITAL_METRICS = ['LCP', 'FCP', 'CLS', 'TTFB', 'FID', 'INP'] as const;
const SERVER_METRICS = [
  'memory.rss', 'memory.heapUsed', 'memory.heapTotal', 'memory.external',
  'eventloop.lag.mean', 'eventloop.lag.p99', 'eventloop.lag.max',
  'gc.pause.major', 'gc.pause.minor',
  'cpu.user', 'cpu.system',
  'handles.active', 'requests.active',
] as const;

const ALL_METRICS = [...WEB_VITAL_METRICS, ...SERVER_METRICS] as const;

function isWebVital(name: string): boolean {
  return (WEB_VITAL_METRICS as readonly string[]).includes(name);
}

export function registerPerformanceTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_performance_metrics',
    'Get performance metrics from browser (Web Vitals: LCP, FCP, CLS, TTFB, FID, INP) and/or server (memory, event loop lag, GC pauses, CPU usage). Browser metrics include quality ratings. Server metrics require capturePerformance: true in the server-SDK config.',
    {
      metric_name: z
        .enum(ALL_METRICS)
        .optional()
        .describe('Filter by specific metric name'),
      source: z
        .enum(['browser', 'server', 'all'])
        .optional()
        .default('all')
        .describe('Filter by metric source: browser (Web Vitals), server (Node.js runtime), or all'),
      since_seconds: z
        .number()
        .optional()
        .describe('Only return metrics from the last N seconds'),
    },
    async ({ metric_name, source, since_seconds }) => {
      let events = store.getPerformanceMetrics({
        metricName: metric_name,
        sinceSeconds: since_seconds,
      });

      // Filter by source
      if (source === 'browser') {
        events = events.filter((e) => isWebVital(e.metricName));
      } else if (source === 'server') {
        events = events.filter((e) => !isWebVital(e.metricName));
      }

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;
      const issues: string[] = [];

      // Flag poor Web Vitals
      const poor = events.filter((e) => e.rating === 'poor');
      const needsImprovement = events.filter((e) => e.rating === 'needs-improvement');
      if (poor.length > 0) {
        issues.push(`${poor.length} metric(s) rated "poor": ${poor.map((e) => e.metricName).join(', ')}`);
      }
      if (needsImprovement.length > 0) {
        issues.push(`${needsImprovement.length} metric(s) need improvement: ${needsImprovement.map((e) => e.metricName).join(', ')}`);
      }

      // Flag server-side concerns
      const highMemory = events.filter((e) => e.metricName === 'memory.heapUsed' && e.value > 500 * 1024 * 1024);
      if (highMemory.length > 0) {
        issues.push(`Heap usage exceeded 500MB in ${highMemory.length} sample(s)`);
      }
      const highEventLoop = events.filter((e) => e.metricName === 'eventloop.lag.p99' && e.value > 100);
      if (highEventLoop.length > 0) {
        issues.push(`Event loop p99 lag exceeded 100ms in ${highEventLoop.length} sample(s)`);
      }

      // Show latest value per metric
      const latest = new Map<string, typeof events[0]>();
      for (const e of events) {
        latest.set(e.metricName, e);
      }

      // Group by source for structured output
      const browserMetrics = Array.from(latest.values()).filter((e) => isWebVital(e.metricName));
      const serverMetrics = Array.from(latest.values()).filter((e) => !isWebVital(e.metricName));

      const formatMetric = (e: typeof events[0]) => ({
        metricName: e.metricName,
        value: e.value,
        unit: e.unit ?? (e.metricName === 'CLS' ? 'score' : 'ms'),
        rating: e.rating ?? null,
        element: e.element ?? null,
        timestamp: new Date(e.timestamp).toISOString(),
      });

      const response = {
        summary: `${latest.size} unique metric(s) captured (${browserMetrics.length} browser, ${serverMetrics.length} server). ${poor.length} poor, ${needsImprovement.length} needs improvement.`,
        data: {
          browser: browserMetrics.map(formatMetric),
          server: serverMetrics.map(formatMetric),
        },
        allEvents: events.map((e) => ({
          metricName: e.metricName,
          value: e.value,
          unit: e.unit ?? (e.metricName === 'CLS' ? 'score' : 'ms'),
          rating: e.rating ?? null,
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
