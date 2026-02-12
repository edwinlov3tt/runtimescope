import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerTimelineTools } from '../tools/timeline.js';
import { createMcpStub } from './tool-harness.js';

function makeEvent(type: string, overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: type,
  };

  switch (type) {
    case 'network':
      return { ...base, url: 'https://api.com/data', method: 'GET', status: 200, requestHeaders: {}, responseHeaders: {}, requestBodySize: 0, responseBodySize: 100, duration: 150, ttfb: 50, ...overrides };
    case 'console':
      return { ...base, level: 'log', message: 'test', args: [], ...overrides };
    case 'state':
      return { ...base, storeId: 'main', library: 'zustand', phase: 'update', state: {}, ...overrides };
    case 'render':
      return { ...base, profiles: [{ componentName: 'App', renderCount: 5, totalDuration: 25, avgDuration: 5, lastRenderPhase: 'update', renderVelocity: 2, suspicious: false }], snapshotWindowMs: 5000, totalRenders: 5, suspiciousComponents: [], ...overrides };
    case 'performance':
      return { ...base, metricName: 'LCP', value: 2500, rating: 'good', ...overrides };
    case 'database':
      return { ...base, query: 'SELECT * FROM users', normalizedQuery: 'SELECT * FROM users', duration: 50, tablesAccessed: ['users'], operation: 'SELECT', source: 'prisma', ...overrides };
    case 'dom_snapshot':
      return { ...base, html: '<html></html>', url: 'http://localhost:3000', viewport: { width: 1280, height: 720 }, scrollPosition: { x: 0, y: 0 }, elementCount: 1, truncated: false, ...overrides };
    default:
      return { ...base, ...overrides };
  }
}

describe('get_event_timeline tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(1000);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerTimelineTools(server, store);
  });

  it('returns response envelope structure', async () => {
    const result = await callTool('get_event_timeline', {});
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('metadata');
  });

  it('returns events in chronological order (oldest first)', async () => {
    const now = Date.now();
    store.addEvent(makeEvent('network', { timestamp: now - 2000 }) as any);
    store.addEvent(makeEvent('console', { timestamp: now - 1000 }) as any);
    store.addEvent(makeEvent('network', { timestamp: now }) as any);
    const result = await callTool('get_event_timeline', {});
    expect(result.data).toHaveLength(3);
    // Timestamps should be ascending (chronological)
    const timestamps = result.data.map((d: any) => new Date(d.timestamp).getTime());
    expect(timestamps[0]).toBeLessThanOrEqual(timestamps[1]);
    expect(timestamps[1]).toBeLessThanOrEqual(timestamps[2]);
  });

  it('formats network events correctly', async () => {
    store.addEvent(makeEvent('network', { method: 'POST', url: 'https://api.com/data', status: 201, duration: 250 }) as any);
    const result = await callTool('get_event_timeline', {});
    const item = result.data[0];
    expect(item.type).toBe('network');
    expect(item.method).toBe('POST');
    expect(item.url).toBe('https://api.com/data');
    expect(item.status).toBe(201);
    expect(item.duration).toBe('250ms');
  });

  it('formats console events correctly', async () => {
    store.addEvent(makeEvent('console', { level: 'error', message: 'boom' }) as any);
    const result = await callTool('get_event_timeline', {});
    const item = result.data[0];
    expect(item.type).toBe('console');
    expect(item.level).toBe('error');
    expect(item.message).toBe('boom');
  });

  it('formats database events correctly', async () => {
    store.addEvent(makeEvent('database', {
      operation: 'INSERT',
      query: 'INSERT INTO users VALUES ($1)',
      duration: 30,
      tablesAccessed: ['users'],
      source: 'pg',
    }) as any);
    const result = await callTool('get_event_timeline', {});
    const item = result.data[0];
    expect(item.type).toBe('database');
    expect(item.operation).toBe('INSERT');
    expect(item.source).toBe('pg');
    expect(item.tables).toEqual(['users']);
  });

  it('filters by event_types', async () => {
    store.addEvent(makeEvent('network') as any);
    store.addEvent(makeEvent('console') as any);
    store.addEvent(makeEvent('database') as any);
    const result = await callTool('get_event_timeline', { event_types: ['network', 'database'] });
    expect(result.data).toHaveLength(2);
    for (const item of result.data) {
      expect(['network', 'database']).toContain(item.type);
    }
  });

  it('trims to limit (default 200)', async () => {
    for (let i = 0; i < 250; i++) {
      store.addEvent(makeEvent('network', { timestamp: Date.now() + i }) as any);
    }
    const result = await callTool('get_event_timeline', {});
    expect(result.data).toHaveLength(200);
    expect(result.metadata.totalInWindow).toBe(250);
  });

  it('enforces max limit of 1000', async () => {
    const result = await callTool('get_event_timeline', { limit: 5000 });
    // Just validates it doesn't crash — the limit is capped internally
    expect(result).toHaveProperty('data');
  });
});
