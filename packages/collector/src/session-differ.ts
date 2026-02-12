import type { SessionMetrics, MetricDelta, SessionDiffResult } from './types.js';

// ============================================================
// Session Differ
// Compares two session metrics across all dimensions
// ============================================================

const CHANGE_THRESHOLD = 0.10; // 10% change threshold

function classifyDelta(percentChange: number): MetricDelta['classification'] {
  if (percentChange > CHANGE_THRESHOLD) return 'regression';
  if (percentChange < -CHANGE_THRESHOLD) return 'improvement';
  return 'unchanged';
}

function computeDeltas(
  before: Record<string, number>,
  after: Record<string, number>,
  keyPrefix = ''
): MetricDelta[] {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const deltas: MetricDelta[] = [];

  for (const key of allKeys) {
    const bVal = before[key] ?? 0;
    const aVal = after[key] ?? 0;
    const delta = aVal - bVal;
    const percentChange = bVal !== 0 ? delta / bVal : aVal !== 0 ? 1 : 0;

    deltas.push({
      key: keyPrefix ? `${keyPrefix}:${key}` : key,
      before: bVal,
      after: aVal,
      delta,
      percentChange,
      classification: classifyDelta(percentChange),
    });
  }

  return deltas.filter((d) => d.classification !== 'unchanged');
}

export function compareSessions(
  metricsA: SessionMetrics,
  metricsB: SessionMetrics
): SessionDiffResult {
  // Endpoint deltas (comparing avg latency)
  const endpointLatencyA: Record<string, number> = {};
  const endpointLatencyB: Record<string, number> = {};
  for (const [key, data] of Object.entries(metricsA.endpoints)) {
    endpointLatencyA[key] = data.avgLatency;
  }
  for (const [key, data] of Object.entries(metricsB.endpoints)) {
    endpointLatencyB[key] = data.avgLatency;
  }

  // Component deltas (comparing render counts)
  const componentRendersA: Record<string, number> = {};
  const componentRendersB: Record<string, number> = {};
  for (const [key, data] of Object.entries(metricsA.components)) {
    componentRendersA[key] = data.renderCount;
  }
  for (const [key, data] of Object.entries(metricsB.components)) {
    componentRendersB[key] = data.renderCount;
  }

  // Store deltas
  const storeUpdatesA: Record<string, number> = {};
  const storeUpdatesB: Record<string, number> = {};
  for (const [key, data] of Object.entries(metricsA.stores)) {
    storeUpdatesA[key] = data.updateCount;
  }
  for (const [key, data] of Object.entries(metricsB.stores)) {
    storeUpdatesB[key] = data.updateCount;
  }

  // Web Vital deltas
  const vitalsA: Record<string, number> = {};
  const vitalsB: Record<string, number> = {};
  for (const [key, data] of Object.entries(metricsA.webVitals)) {
    vitalsA[key] = data.value;
  }
  for (const [key, data] of Object.entries(metricsB.webVitals)) {
    vitalsB[key] = data.value;
  }

  // Query deltas
  const queryDurA: Record<string, number> = {};
  const queryDurB: Record<string, number> = {};
  for (const [key, data] of Object.entries(metricsA.queries)) {
    queryDurA[key] = data.avgDuration;
  }
  for (const [key, data] of Object.entries(metricsB.queries)) {
    queryDurB[key] = data.avgDuration;
  }

  return {
    sessionA: metricsA.sessionId,
    sessionB: metricsB.sessionId,
    endpointDeltas: computeDeltas(endpointLatencyA, endpointLatencyB, 'endpoint'),
    componentDeltas: computeDeltas(componentRendersA, componentRendersB, 'component'),
    storeDeltas: computeDeltas(storeUpdatesA, storeUpdatesB, 'store'),
    webVitalDeltas: computeDeltas(vitalsA, vitalsB, 'vital'),
    queryDeltas: computeDeltas(queryDurA, queryDurB, 'query'),
    overallDelta: {
      errorCountDelta: metricsB.errorCount - metricsA.errorCount,
      totalEventsDelta: metricsB.totalEvents - metricsA.totalEvents,
    },
  };
}
