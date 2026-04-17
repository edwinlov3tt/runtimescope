import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkersTransport } from '../transport.js';

// Mock global fetch
const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockClear();
  mockFetch.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-uuid-1234',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkersTransport', () => {
  it('should generate a session ID on construction', () => {
    const transport = new WorkersTransport({ appName: 'test-app' });
    expect(transport.sessionId).toMatch(/^wk-/);
  });

  it('should queue events and flush via fetch POST', async () => {
    const transport = new WorkersTransport({
      appName: 'test-app',
      httpEndpoint: 'https://collector.example.com/api/events',
    });

    transport.queue({
      eventId: 'evt-1',
      sessionId: transport.sessionId,
      timestamp: Date.now(),
      eventType: 'console',
      level: 'log',
      message: 'hello',
      args: ['hello'],
    });

    await transport.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://collector.example.com/api/events');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sessionId).toBe(transport.sessionId);
    expect(body.appName).toBe('test-app');
    expect(body.sdkVersion).toBeDefined();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('console');
  });

  it('should not send appName after first successful flush', async () => {
    const transport = new WorkersTransport({
      appName: 'test-app',
      httpEndpoint: 'https://collector.example.com/api/events',
    });

    transport.queue({
      eventId: 'evt-1',
      sessionId: transport.sessionId,
      timestamp: Date.now(),
      eventType: 'console',
      level: 'log',
      message: 'first',
      args: [],
    });
    await transport.flush();

    transport.queue({
      eventId: 'evt-2',
      sessionId: transport.sessionId,
      timestamp: Date.now(),
      eventType: 'console',
      level: 'log',
      message: 'second',
      args: [],
    });
    await transport.flush();

    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(secondBody.appName).toBeUndefined();
  });

  it('should not flush when buffer is empty', async () => {
    const transport = new WorkersTransport({ appName: 'test-app' });
    await transport.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should drop oldest events when queue exceeds maxQueueSize', () => {
    const transport = new WorkersTransport({
      appName: 'test-app',
      maxQueueSize: 3,
    });

    for (let i = 0; i < 5; i++) {
      transport.queue({
        eventId: `evt-${i}`,
        sessionId: transport.sessionId,
        timestamp: Date.now(),
        eventType: 'console',
        level: 'log',
        message: `msg-${i}`,
        args: [],
      });
    }

    expect(transport.droppedCount).toBe(2);
  });

  it('should use default endpoint when none provided', async () => {
    const transport = new WorkersTransport({ appName: 'test-app' });

    transport.queue({
      eventId: 'evt-1',
      sessionId: transport.sessionId,
      timestamp: Date.now(),
      eventType: 'console',
      level: 'log',
      message: 'test',
      args: [],
    });
    await transport.flush();

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:6768/api/events');
  });

  it('should include auth token header when configured', async () => {
    const transport = new WorkersTransport({
      appName: 'test-app',
      authToken: 'my-secret-token',
    });

    transport.queue({
      eventId: 'evt-1',
      sessionId: transport.sessionId,
      timestamp: Date.now(),
      eventType: 'console',
      level: 'log',
      message: 'test',
      args: [],
    });
    await transport.flush();

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer my-secret-token');
  });

  it('should swallow fetch errors silently after retry', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const transport = new WorkersTransport({ appName: 'test-app' });
    transport.queue({
      eventId: 'evt-1',
      sessionId: transport.sessionId,
      timestamp: Date.now(),
      eventType: 'console',
      level: 'log',
      message: 'test',
      args: [],
    });

    // Should not throw — retries once then gives up
    await expect(transport.flush()).resolves.toBeUndefined();
    // Two attempts: initial + one retry
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should retry once on 500 error then succeed', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true });

    const transport = new WorkersTransport({ appName: 'test-app' });
    transport.queue({
      eventId: 'evt-1',
      sessionId: transport.sessionId,
      timestamp: Date.now(),
      eventType: 'console',
      level: 'log',
      message: 'test',
      args: [],
    });

    await transport.flush();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should not retry on 4xx errors', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });

    const transport = new WorkersTransport({ appName: 'test-app' });
    transport.queue({
      eventId: 'evt-1',
      sessionId: transport.sessionId,
      timestamp: Date.now(),
      eventType: 'console',
      level: 'log',
      message: 'test',
      args: [],
    });

    await transport.flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
