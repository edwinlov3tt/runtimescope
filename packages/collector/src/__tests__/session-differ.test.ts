import { describe, it, expect } from 'vitest';
import { compareSessions } from '../session-differ.js';
import { makeSessionMetrics } from './factories.js';

describe('compareSessions', () => {
  it('returns correct sessionA and sessionB IDs', () => {
    const a = makeSessionMetrics({ sessionId: 'aaa' });
    const b = makeSessionMetrics({ sessionId: 'bbb' });
    const result = compareSessions(a, b);
    expect(result.sessionA).toBe('aaa');
    expect(result.sessionB).toBe('bbb');
  });

  it('detects endpoint latency regression (>10% increase)', () => {
    const a = makeSessionMetrics({
      endpoints: { 'GET /api/users': { avgLatency: 100, errorRate: 0, callCount: 10 } },
    });
    const b = makeSessionMetrics({
      endpoints: { 'GET /api/users': { avgLatency: 150, errorRate: 0, callCount: 10 } },
    });
    const result = compareSessions(a, b);
    const delta = result.endpointDeltas.find((d) => d.key.includes('/api/users'));
    expect(delta).toBeDefined();
    expect(delta!.classification).toBe('regression');
    expect(delta!.percentChange).toBe(0.5); // 50% increase
  });

  it('detects endpoint latency improvement (>10% decrease)', () => {
    const a = makeSessionMetrics({
      endpoints: { 'GET /api/users': { avgLatency: 200, errorRate: 0, callCount: 10 } },
    });
    const b = makeSessionMetrics({
      endpoints: { 'GET /api/users': { avgLatency: 100, errorRate: 0, callCount: 10 } },
    });
    const result = compareSessions(a, b);
    const delta = result.endpointDeltas.find((d) => d.key.includes('/api/users'));
    expect(delta).toBeDefined();
    expect(delta!.classification).toBe('improvement');
  });

  it('filters out unchanged (<=10% delta)', () => {
    const a = makeSessionMetrics({
      endpoints: { 'GET /api/users': { avgLatency: 100, errorRate: 0, callCount: 10 } },
    });
    const b = makeSessionMetrics({
      endpoints: { 'GET /api/users': { avgLatency: 105, errorRate: 0, callCount: 10 } },
    });
    const result = compareSessions(a, b);
    // 5% change is below threshold — should be filtered out
    expect(result.endpointDeltas).toHaveLength(0);
  });

  it('handles new endpoints in session B', () => {
    const a = makeSessionMetrics({ endpoints: {} });
    const b = makeSessionMetrics({
      endpoints: { 'GET /api/new': { avgLatency: 100, errorRate: 0, callCount: 5 } },
    });
    const result = compareSessions(a, b);
    // before=0, after=100 → percentChange=1 → regression
    const delta = result.endpointDeltas.find((d) => d.key.includes('/api/new'));
    expect(delta).toBeDefined();
    expect(delta!.before).toBe(0);
    expect(delta!.classification).toBe('regression');
  });

  it('computes component render count deltas', () => {
    const a = makeSessionMetrics({
      components: { Header: { renderCount: 10, avgDuration: 5 } },
    });
    const b = makeSessionMetrics({
      components: { Header: { renderCount: 25, avgDuration: 5 } },
    });
    const result = compareSessions(a, b);
    const delta = result.componentDeltas.find((d) => d.key.includes('Header'));
    expect(delta).toBeDefined();
    expect(delta!.classification).toBe('regression');
  });

  it('computes store update count deltas', () => {
    const a = makeSessionMetrics({
      stores: { auth: { updateCount: 5 } },
    });
    const b = makeSessionMetrics({
      stores: { auth: { updateCount: 2 } },
    });
    const result = compareSessions(a, b);
    const delta = result.storeDeltas.find((d) => d.key.includes('auth'));
    expect(delta).toBeDefined();
    expect(delta!.classification).toBe('improvement');
  });

  it('computes web vital deltas', () => {
    const a = makeSessionMetrics({
      webVitals: { LCP: { value: 2500, rating: 'good' } },
    });
    const b = makeSessionMetrics({
      webVitals: { LCP: { value: 5000, rating: 'poor' } },
    });
    const result = compareSessions(a, b);
    const delta = result.webVitalDeltas.find((d) => d.key.includes('LCP'));
    expect(delta).toBeDefined();
    expect(delta!.classification).toBe('regression');
  });

  it('computes query duration deltas', () => {
    const a = makeSessionMetrics({
      queries: { 'SELECT * FROM users': { avgDuration: 50, callCount: 10 } },
    });
    const b = makeSessionMetrics({
      queries: { 'SELECT * FROM users': { avgDuration: 200, callCount: 10 } },
    });
    const result = compareSessions(a, b);
    expect(result.queryDeltas.length).toBeGreaterThan(0);
  });

  it('computes overallDelta correctly', () => {
    const a = makeSessionMetrics({ errorCount: 5, totalEvents: 100 });
    const b = makeSessionMetrics({ errorCount: 15, totalEvents: 200 });
    const result = compareSessions(a, b);
    expect(result.overallDelta.errorCountDelta).toBe(10);
    expect(result.overallDelta.totalEventsDelta).toBe(100);
  });

  it('handles both sessions with empty metrics', () => {
    const a = makeSessionMetrics();
    const b = makeSessionMetrics();
    const result = compareSessions(a, b);
    expect(result.endpointDeltas).toEqual([]);
    expect(result.componentDeltas).toEqual([]);
    expect(result.storeDeltas).toEqual([]);
    expect(result.webVitalDeltas).toEqual([]);
    expect(result.queryDeltas).toEqual([]);
  });

  it('handles before=0 after>0 as regression (percentChange=1)', () => {
    const a = makeSessionMetrics({
      endpoints: {},
    });
    const b = makeSessionMetrics({
      endpoints: { 'GET /new': { avgLatency: 500, errorRate: 0, callCount: 1 } },
    });
    const result = compareSessions(a, b);
    const delta = result.endpointDeltas.find((d) => d.key.includes('/new'));
    expect(delta).toBeDefined();
    expect(delta!.percentChange).toBe(1);
  });
});
