import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerPerformanceTools } from '../tools/performance.js';
import { createMcpStub } from './tool-harness.js';

function makePerformanceEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'performance' as const,
    metricName: 'LCP',
    value: 2500,
    rating: 'good',
    ...overrides,
  };
}

describe('get_performance_metrics tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerPerformanceTools(server, store);
  });

  it('returns response envelope structure', async () => {
    const result = await callTool('get_performance_metrics', {});
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('metadata');
  });

  it('deduplicates to one value per metric', async () => {
    const now = Date.now();
    store.addEvent(makePerformanceEvent({ metricName: 'LCP', value: 2000, timestamp: now - 1000 }));
    store.addEvent(makePerformanceEvent({ metricName: 'LCP', value: 2800, timestamp: now }));
    store.addEvent(makePerformanceEvent({ metricName: 'FCP', value: 1200, timestamp: now }));
    const result = await callTool('get_performance_metrics', {});
    // data shows one entry per unique metric
    expect(result.data).toHaveLength(2); // LCP + FCP
    const metricNames = result.data.map((d: any) => d.metricName);
    expect(metricNames).toContain('LCP');
    expect(metricNames).toContain('FCP');
  });

  it('flags poor metrics in issues', async () => {
    store.addEvent(makePerformanceEvent({ metricName: 'LCP', value: 5000, rating: 'poor' }));
    const result = await callTool('get_performance_metrics', {});
    expect(result.issues.some((i: string) => i.includes('poor'))).toBe(true);
    expect(result.issues.some((i: string) => i.includes('LCP'))).toBe(true);
  });

  it('flags needs-improvement metrics in issues', async () => {
    store.addEvent(makePerformanceEvent({ metricName: 'TTFB', value: 1200, rating: 'needs-improvement' }));
    const result = await callTool('get_performance_metrics', {});
    expect(result.issues.some((i: string) => i.includes('need improvement'))).toBe(true);
  });

  it('reports correct unit for CLS vs time metrics', async () => {
    store.addEvent(makePerformanceEvent({ metricName: 'CLS', value: 0.15, rating: 'good' }));
    store.addEvent(makePerformanceEvent({ metricName: 'LCP', value: 2500, rating: 'good' }));
    const result = await callTool('get_performance_metrics', {});
    const cls = result.data.find((d: any) => d.metricName === 'CLS');
    const lcp = result.data.find((d: any) => d.metricName === 'LCP');
    expect(cls.unit).toBe('score');
    expect(lcp.unit).toBe('ms');
  });

  it('filters by metric_name', async () => {
    store.addEvent(makePerformanceEvent({ metricName: 'LCP', value: 2500 }));
    store.addEvent(makePerformanceEvent({ metricName: 'FCP', value: 1200 }));
    store.addEvent(makePerformanceEvent({ metricName: 'CLS', value: 0.1 }));
    const result = await callTool('get_performance_metrics', { metric_name: 'FCP' });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].metricName).toBe('FCP');
  });

  it('returns empty data when no events', async () => {
    const result = await callTool('get_performance_metrics', {});
    expect(result.data).toEqual([]);
    expect(result.metadata.eventCount).toBe(0);
  });

  it('includes allEvents array for full history', async () => {
    store.addEvent(makePerformanceEvent({ metricName: 'LCP', value: 2000 }));
    store.addEvent(makePerformanceEvent({ metricName: 'LCP', value: 2800 }));
    const result = await callTool('get_performance_metrics', {});
    expect(result.allEvents).toHaveLength(2); // both events
    expect(result.data).toHaveLength(1); // only latest per metric
  });
});
