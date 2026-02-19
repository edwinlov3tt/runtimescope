import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PerformanceObserver } from 'node:perf_hooks';
import { generateId } from '../utils/id.js';
import { getSessionId } from '../context.js';
import type { PerformanceEvent, ServerMetricName, MetricUnit } from '../types.js';

type EmitFn = (event: PerformanceEvent) => void;

export interface PerfMetricsOptions {
  /** Collection interval in ms (default: 5000) */
  intervalMs?: number;
  /** Which metrics to collect (default: all) */
  metrics?: ServerMetricName[];
}

const ALL_METRICS: ServerMetricName[] = [
  'memory.rss', 'memory.heapUsed', 'memory.heapTotal', 'memory.external',
  'eventloop.lag.mean', 'eventloop.lag.p99', 'eventloop.lag.max',
  'gc.pause.major', 'gc.pause.minor',
  'cpu.user', 'cpu.system',
  'handles.active', 'requests.active',
];

function shouldCollect(metric: ServerMetricName, enabled: ServerMetricName[]): boolean {
  return enabled.includes(metric);
}

function emitMetric(
  emit: EmitFn,
  sessionId: string,
  metricName: ServerMetricName,
  value: number,
  unit: MetricUnit
): void {
  emit({
    eventId: generateId(),
    sessionId: getSessionId(sessionId),
    timestamp: Date.now(),
    eventType: 'performance',
    metricName,
    value: Math.round(value * 100) / 100,
    unit,
  });
}

export function startPerfMetrics(
  emit: EmitFn,
  sessionId: string,
  options?: PerfMetricsOptions
): () => void {
  const intervalMs = options?.intervalMs ?? 5000;
  const enabled = options?.metrics ?? ALL_METRICS;

  // Track CPU usage delta between intervals
  let lastCpuUsage = process.cpuUsage();
  let lastCpuTime = Date.now();

  // Event loop delay histogram
  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  const needsEventLoop = enabled.some((m) => m.startsWith('eventloop.'));
  if (needsEventLoop) {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  }

  // GC observer
  let gcObserver: PerformanceObserver | null = null;
  let lastMajorGcMs = 0;
  let lastMinorGcMs = 0;
  const needsGc = enabled.some((m) => m.startsWith('gc.'));
  if (needsGc) {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const gcEntry = entry as PerformanceEntry & { detail?: { kind?: number } };
        const durationMs = entry.duration;
        // GC kind: 1=Scavenge(minor), 2=MarkSweepCompact(major), 4=IncrementalMarking, 8=WeakPhantom
        const kind = gcEntry.detail?.kind ?? 0;
        if (kind === 2) {
          lastMajorGcMs += durationMs;
        } else if (kind === 1 || kind === 4 || kind === 8) {
          lastMinorGcMs += durationMs;
        }
      }
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  }

  const timer = setInterval(() => {
    // Memory metrics
    if (enabled.some((m) => m.startsWith('memory.'))) {
      const mem = process.memoryUsage();
      if (shouldCollect('memory.rss', enabled)) emitMetric(emit, sessionId, 'memory.rss', mem.rss, 'bytes');
      if (shouldCollect('memory.heapUsed', enabled)) emitMetric(emit, sessionId, 'memory.heapUsed', mem.heapUsed, 'bytes');
      if (shouldCollect('memory.heapTotal', enabled)) emitMetric(emit, sessionId, 'memory.heapTotal', mem.heapTotal, 'bytes');
      if (shouldCollect('memory.external', enabled)) emitMetric(emit, sessionId, 'memory.external', mem.external, 'bytes');
    }

    // Event loop lag
    if (histogram) {
      if (shouldCollect('eventloop.lag.mean', enabled)) emitMetric(emit, sessionId, 'eventloop.lag.mean', histogram.mean / 1e6, 'ms');
      if (shouldCollect('eventloop.lag.p99', enabled)) emitMetric(emit, sessionId, 'eventloop.lag.p99', histogram.percentile(99) / 1e6, 'ms');
      if (shouldCollect('eventloop.lag.max', enabled)) emitMetric(emit, sessionId, 'eventloop.lag.max', histogram.max / 1e6, 'ms');
      histogram.reset();
    }

    // GC pauses (accumulated since last interval)
    if (needsGc) {
      if (shouldCollect('gc.pause.major', enabled)) emitMetric(emit, sessionId, 'gc.pause.major', lastMajorGcMs, 'ms');
      if (shouldCollect('gc.pause.minor', enabled)) emitMetric(emit, sessionId, 'gc.pause.minor', lastMinorGcMs, 'ms');
      lastMajorGcMs = 0;
      lastMinorGcMs = 0;
    }

    // CPU usage (percentage of interval)
    if (enabled.some((m) => m.startsWith('cpu.'))) {
      const now = Date.now();
      const elapsed = (now - lastCpuTime) * 1000; // Convert to microseconds
      const cpu = process.cpuUsage(lastCpuUsage);
      lastCpuUsage = process.cpuUsage();
      lastCpuTime = now;
      if (elapsed > 0) {
        if (shouldCollect('cpu.user', enabled)) emitMetric(emit, sessionId, 'cpu.user', (cpu.user / elapsed) * 100, 'percent');
        if (shouldCollect('cpu.system', enabled)) emitMetric(emit, sessionId, 'cpu.system', (cpu.system / elapsed) * 100, 'percent');
      }
    }

    // Active handles/requests
    if (shouldCollect('handles.active', enabled)) {
      const handles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles?.()?.length ?? 0;
      emitMetric(emit, sessionId, 'handles.active', handles, 'count');
    }
    if (shouldCollect('requests.active', enabled)) {
      const requests = (process as unknown as { _getActiveRequests: () => unknown[] })._getActiveRequests?.()?.length ?? 0;
      emitMetric(emit, sessionId, 'requests.active', requests, 'count');
    }
  }, intervalMs);

  // Don't keep the process alive just for metrics
  timer.unref();

  return () => {
    clearInterval(timer);
    if (histogram) {
      histogram.disable();
    }
    if (gcObserver) {
      gcObserver.disconnect();
    }
  };
}
