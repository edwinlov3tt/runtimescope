import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore, ApiDiscoveryEngine } from '@runtimescope/collector';
import { registerApiDiscoveryTools } from '../tools/api-discovery.js';
import { createMcpStub } from './tool-harness.js';

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

describe('API Discovery MCP tools', () => {
  let store: EventStore;
  let engine: ApiDiscoveryEngine;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(1000);
    engine = new ApiDiscoveryEngine(store);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerApiDiscoveryTools(server, store, engine);
  });

  describe('get_api_catalog', () => {
    it('returns response envelope structure', async () => {
      const result = await callTool('get_api_catalog', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('metadata');
    });

    it('returns discovered endpoints and services', async () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.example.com/users' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.stripe.com/v1/charges' }));
      engine.rebuild();
      const result = await callTool('get_api_catalog', {});
      expect(result.data.services.length).toBe(2);
      expect(result.data.endpoints.length).toBe(2);
    });

    it('endpoint data includes correct fields', async () => {
      store.addEvent(makeNetworkEvent({
        url: 'https://api.example.com/users/123',
        method: 'GET',
        requestHeaders: { Authorization: 'Bearer tok_123' },
      }));
      engine.rebuild();
      const result = await callTool('get_api_catalog', {});
      const ep = result.data.endpoints[0];
      expect(ep).toHaveProperty('method');
      expect(ep).toHaveProperty('path');
      expect(ep).toHaveProperty('service');
      expect(ep).toHaveProperty('callCount');
      expect(ep).toHaveProperty('auth');
      expect(ep).toHaveProperty('firstSeen');
      expect(ep).toHaveProperty('lastSeen');
    });

    it('service data includes correct fields', async () => {
      store.addEvent(makeNetworkEvent({ url: 'http://localhost:3000/api/data' }));
      engine.rebuild();
      const result = await callTool('get_api_catalog', {});
      const svc = result.data.services[0];
      expect(svc).toHaveProperty('name');
      expect(svc).toHaveProperty('baseUrl');
      expect(svc).toHaveProperty('endpointCount');
      expect(svc).toHaveProperty('totalCalls');
      expect(svc).toHaveProperty('avgLatency');
      expect(svc).toHaveProperty('errorRate');
      expect(svc).toHaveProperty('auth');
    });

    it('filters by min_calls', async () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/rare' }));
      for (let i = 0; i < 5; i++) {
        store.addEvent(makeNetworkEvent({ url: 'https://api.com/popular' }));
      }
      engine.rebuild();
      const result = await callTool('get_api_catalog', { min_calls: 5 });
      expect(result.data.endpoints).toHaveLength(1);
    });

    it('summary includes endpoint and service counts', async () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/a' }));
      store.addEvent(makeNetworkEvent({ url: 'http://localhost:3000/b' }));
      engine.rebuild();
      const result = await callTool('get_api_catalog', {});
      expect(result.summary).toContain('2 API endpoint(s)');
      expect(result.summary).toContain('2 service(s)');
    });
  });

  describe('get_api_health', () => {
    it('returns response envelope', async () => {
      const result = await callTool('get_api_health', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('issues');
    });

    it('reports health metrics per endpoint', async () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/data', status: 200, duration: 100 }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/data', status: 500, duration: 200 }));
      engine.rebuild();
      const result = await callTool('get_api_health', {});
      expect(result.data).toHaveLength(1);
      const ep = result.data[0];
      expect(ep).toHaveProperty('successRate');
      expect(ep).toHaveProperty('avgLatency');
      expect(ep).toHaveProperty('p50Latency');
      expect(ep).toHaveProperty('p95Latency');
      expect(ep).toHaveProperty('errorRate');
    });

    it('flags high error rate endpoints in issues', async () => {
      // 3 calls, 2 failures = 67% error rate
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/bad', status: 500 }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/bad', status: 500 }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/bad', status: 200 }));
      engine.rebuild();
      const result = await callTool('get_api_health', {});
      expect(result.issues.some((i: string) => i.includes('error rate'))).toBe(true);
    });
  });

  describe('get_service_map (MCP tool)', () => {
    it('returns services with platform detection', async () => {
      store.addEvent(makeNetworkEvent({ url: 'https://abc.supabase.co/rest/v1/users' }));
      engine.rebuild();
      const result = await callTool('get_service_map', {});
      expect(result.data).toHaveLength(1);
      const svc = result.data[0];
      expect(svc.name).toBe('Supabase');
      expect(svc.detectedPlatform).toBe('Supabase');
    });

    it('summary includes service count', async () => {
      store.addEvent(makeNetworkEvent({ url: 'http://localhost:3000/api' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.stripe.com/v1/charges' }));
      engine.rebuild();
      const result = await callTool('get_service_map', {});
      expect(result.summary).toContain('2 service(s)');
    });
  });

  describe('get_api_changes', () => {
    it('returns change summary between sessions', async () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/a', sessionId: 'sess-1' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/b', sessionId: 'sess-2' }));
      engine.rebuild();
      const result = await callTool('get_api_changes', { session_a: 'sess-1', session_b: 'sess-2' });
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result.summary).toContain('API change(s)');
    });
  });

  describe('get_api_documentation', () => {
    it('returns markdown documentation', async () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/users' }));
      engine.rebuild();
      // This tool returns raw markdown text, not JSON envelope.
      // Use getTools() to invoke the handler directly.
      const { server, getTools } = createMcpStub();
      registerApiDiscoveryTools(server, store, engine);
      const tool = getTools().get('get_api_documentation');
      expect(tool).toBeDefined();
      const result = await tool!.handler({});
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('# API Documentation');
    });
  });
});
