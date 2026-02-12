import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerHarTools } from '../tools/har.js';
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

describe('capture_har tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerHarTools(server, store);
  });

  it('returns response envelope structure', async () => {
    const result = await callTool('capture_har', {});
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('metadata');
  });

  it('produces valid HAR 1.2 structure', async () => {
    store.addEvent(makeNetworkEvent());
    const result = await callTool('capture_har', {});
    const har = result.data;
    expect(har).toHaveProperty('log');
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('RuntimeScope');
    expect(har.log.entries).toHaveLength(1);
  });

  it('maps request fields correctly', async () => {
    store.addEvent(makeNetworkEvent({
      url: 'https://api.com/test?foo=bar',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: '{"name":"test"}',
      requestBodySize: 15,
    }));
    const result = await callTool('capture_har', {});
    const entry = result.data.log.entries[0];

    expect(entry.request.method).toBe('POST');
    expect(entry.request.url).toBe('https://api.com/test?foo=bar');
    expect(entry.request.headers).toEqual([{ name: 'content-type', value: 'application/json' }]);
    expect(entry.request.queryString).toEqual([{ name: 'foo', value: 'bar' }]);
    expect(entry.request.postData).toEqual({
      mimeType: 'application/json',
      text: '{"name":"test"}',
    });
  });

  it('maps response fields correctly', async () => {
    store.addEvent(makeNetworkEvent({
      status: 201,
      responseHeaders: { 'content-type': 'application/json' },
      responseBodySize: 250,
    }));
    const result = await callTool('capture_har', {});
    const entry = result.data.log.entries[0];

    expect(entry.response.status).toBe(201);
    expect(entry.response.statusText).toBe('Created');
    expect(entry.response.headers).toEqual([{ name: 'content-type', value: 'application/json' }]);
    expect(entry.response.content.size).toBe(250);
    expect(entry.response.content.mimeType).toBe('application/json');
  });

  it('includes response body when captured', async () => {
    store.addEvent(makeNetworkEvent({
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"id": 1}',
      responseBodySize: 9,
    }));
    const result = await callTool('capture_har', {});
    const entry = result.data.log.entries[0];
    expect(entry.response.content.text).toBe('{"id": 1}');
  });

  it('computes timing fields', async () => {
    store.addEvent(makeNetworkEvent({ duration: 300, ttfb: 100 }));
    const result = await callTool('capture_har', {});
    const entry = result.data.log.entries[0];

    expect(entry.time).toBe(300);
    expect(entry.timings.send).toBe(0);
    expect(entry.timings.wait).toBe(100);
    expect(entry.timings.receive).toBe(200); // 300 - 100
  });

  it('maps common status texts', async () => {
    store.addEvent(makeNetworkEvent({ status: 404 }));
    const result = await callTool('capture_har', {});
    expect(result.data.log.entries[0].response.statusText).toBe('Not Found');
  });

  it('returns empty entries when no events', async () => {
    const result = await callTool('capture_har', {});
    expect(result.data.log.entries).toEqual([]);
    expect(result.metadata.eventCount).toBe(0);
  });

  it('summary includes request count', async () => {
    store.addEvent(makeNetworkEvent());
    store.addEvent(makeNetworkEvent());
    const result = await callTool('capture_har', {});
    expect(result.summary).toContain('2 request(s)');
  });

  it('parses query string from URL', async () => {
    store.addEvent(makeNetworkEvent({
      url: 'https://api.com/search?q=hello&page=2&limit=10',
    }));
    const result = await callTool('capture_har', {});
    const qs = result.data.log.entries[0].request.queryString;
    expect(qs).toEqual([
      { name: 'q', value: 'hello' },
      { name: 'page', value: '2' },
      { name: 'limit', value: '10' },
    ]);
  });
});
