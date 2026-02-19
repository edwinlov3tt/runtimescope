import type {
  NetworkEvent,
  RenderEvent,
  DetectedIssue,
} from '@/mock/types';

export interface OverviewStats {
  requests: { value: number; change: number; label: string; sparkline: number[] };
  latency: { value: number; change: number; label: string; sparkline: number[] };
  renders: { value: number; change: number; label: string; sparkline: number[] };
  issues: { value: number; change: number; sparkline: number[] };
}

export function computeOverviewStats(
  network: NetworkEvent[],
  renders: RenderEvent[],
  issues: DetectedIssue[],
): OverviewStats {
  // Requests
  const requestCount = network.length;
  const durations = network.map((e) => e.duration);
  const avgLatency = durations.length > 0
    ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
    : 0;

  // Build sparkline: bucket events into 20 time slots
  const requestSparkline = buildSparkline(network.map((e) => e.timestamp), 20);
  const latencySparkline = buildLatencySparkline(network, 20);

  // Renders
  const totalRenders = renders.reduce((s, e) => s + e.totalRenders, 0);
  const renderSparkline = buildSparkline(renders.map((e) => e.timestamp), 20);

  // Issues sparkline (just constant since we have one snapshot)
  const issueSparkline = new Array(20).fill(issues.length);

  return {
    requests: { value: requestCount, change: 0, label: 'this session', sparkline: requestSparkline },
    latency: { value: avgLatency, change: 0, label: 'avg', sparkline: latencySparkline },
    renders: { value: totalRenders, change: 0, label: 'this session', sparkline: renderSparkline },
    issues: { value: issues.length, change: 0, sparkline: issueSparkline },
  };
}

function buildSparkline(timestamps: number[], buckets: number): number[] {
  if (timestamps.length === 0) return new Array(buckets).fill(0);
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  const range = max - min || 1;
  const counts = new Array(buckets).fill(0);
  for (const ts of timestamps) {
    const idx = Math.min(Math.floor(((ts - min) / range) * buckets), buckets - 1);
    counts[idx]++;
  }
  return counts;
}

function buildLatencySparkline(network: NetworkEvent[], buckets: number): number[] {
  if (network.length === 0) return new Array(buckets).fill(0);
  const timestamps = network.map((e) => e.timestamp);
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  const range = max - min || 1;
  const sums = new Array(buckets).fill(0);
  const counts = new Array(buckets).fill(0);
  for (const e of network) {
    const idx = Math.min(Math.floor(((e.timestamp - min) / range) * buckets), buckets - 1);
    sums[idx] += e.duration;
    counts[idx]++;
  }
  return sums.map((s, i) => (counts[i] > 0 ? Math.round(s / counts[i]) : 0));
}
