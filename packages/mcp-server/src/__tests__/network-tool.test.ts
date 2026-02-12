import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerNetworkTools } from '../tools/network.js';
import { createMcpStub } from './tool-harness.js';

// Factories inline (avoid cross-package import of test util)
function makeNetworkEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'network' as const,
    url: 'https://api.example.com/users',
    method: 'GET',
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    requestBodySize: 0,
    responseBodySize: 100,
    duration: 150,
    ttfb: 50,
    ...overrides,
  };
}

function makeSessionEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'session' as const,
    appName: 'test-app',
    connectedAt: Date.now(),
    sdkVersion: '0.1.0',
    ...overrides,
  };
}

describe('get_network_requests tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerNetworkTools(server, store);
  });

  it('returns response envelope with summary, data, issues, metadata', async () => {
    store.addEvent(makeNetworkEvent());
    const result = await callTool('get_network_requests', {});
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('metadata');
    expect(result.metadata).toHaveProperty('timeRange');
    expect(result.metadata).toHaveProperty('eventCount');
    expect(result.metadata).toHaveProperty('sessionId');
  });

  it('summary includes event count and avg duration', async () => {
    store.addEvent(makeNetworkEvent({ duration: 100 }));
    store.addEvent(makeNetworkEvent({ duration: 200 }));
    const result = await callTool('get_network_requests', {});
    expect(result.summary).toContain('2 network request(s)');
    expect(result.summary).toContain('150ms');
  });

  it('data maps fields correctly', async () => {
    store.addEvent(makeNetworkEvent({
      url: 'https://api.com/test',
      method: 'POST',
      status: 201,
      duration: 250,
      ttfb: 100,
    }));
    const result = await callTool('get_network_requests', {});
    expect(result.data[0].url).toBe('https://api.com/test');
    expect(result.data[0].method).toBe('POST');
    expect(result.data[0].status).toBe(201);
    expect(result.data[0].duration).toBe('250ms');
    expect(result.data[0].ttfb).toBe('100ms');
  });

  it('graphqlOperation is null when absent', async () => {
    store.addEvent(makeNetworkEvent());
    const result = await callTool('get_network_requests', {});
    expect(result.data[0].graphqlOperation).toBeNull();
  });

  it('issues includes "failed request(s)" when 4xx/5xx present', async () => {
    store.addEvent(makeNetworkEvent({ status: 500 }));
    const result = await callTool('get_network_requests', {});
    expect(result.issues.some((i: string) => i.includes('failed request'))).toBe(true);
  });

  it('issues includes "slow request(s)" when >3s present', async () => {
    store.addEvent(makeNetworkEvent({ duration: 4000 }));
    const result = await callTool('get_network_requests', {});
    expect(result.issues.some((i: string) => i.includes('slow request'))).toBe(true);
  });

  it('metadata.sessionId is null when no sessions', async () => {
    store.addEvent(makeNetworkEvent());
    const result = await callTool('get_network_requests', {});
    expect(result.metadata.sessionId).toBeNull();
  });

  it('metadata.sessionId matches first session', async () => {
    store.addEvent(makeSessionEvent({ sessionId: 'sess-abc' }));
    store.addEvent(makeNetworkEvent({ sessionId: 'sess-abc' }));
    const result = await callTool('get_network_requests', {});
    expect(result.metadata.sessionId).toBe('sess-abc');
  });

  it('returns empty data when no events', async () => {
    const result = await callTool('get_network_requests', {});
    expect(result.data).toEqual([]);
    expect(result.metadata.eventCount).toBe(0);
  });

  it('filters by url_pattern', async () => {
    store.addEvent(makeNetworkEvent({ url: 'https://api.com/users' }));
    store.addEvent(makeNetworkEvent({ url: 'https://api.com/posts' }));
    const result = await callTool('get_network_requests', { url_pattern: 'users' });
    expect(result.data).toHaveLength(1);
  });

  it('filters by status', async () => {
    store.addEvent(makeNetworkEvent({ status: 200 }));
    store.addEvent(makeNetworkEvent({ status: 404 }));
    const result = await callTool('get_network_requests', { status: 404 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe(404);
  });

  it('filters by method', async () => {
    store.addEvent(makeNetworkEvent({ method: 'GET' }));
    store.addEvent(makeNetworkEvent({ method: 'POST' }));
    const result = await callTool('get_network_requests', { method: 'POST' });
    expect(result.data).toHaveLength(1);
  });
});
