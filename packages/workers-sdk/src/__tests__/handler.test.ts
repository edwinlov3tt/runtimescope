import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRuntimeScope } from '../handler.js';

// Mock global fetch and crypto
const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockClear();
  mockFetch.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRequest(url: string, method = 'GET'): Request {
  return new Request(url, { method });
}

function makeCtx(): ExecutionContext {
  const waitUntilFns: Promise<unknown>[] = [];
  return {
    waitUntil: vi.fn((p: Promise<unknown>) => waitUntilFns.push(p)),
    passThroughOnException: vi.fn(),
    props: {} as Record<string, unknown>,
    abort: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('withRuntimeScope', () => {
  it('should wrap a handler and capture network events', async () => {
    const handler = {
      async fetch() {
        return new Response('OK', { status: 200 });
      },
    };

    const wrapped = withRuntimeScope(handler, {
      appName: 'test-worker',
      captureConsole: false,
    });

    const request = makeRequest('https://example.com/api/users?page=1');
    const ctx = makeCtx();

    const response = await wrapped.fetch(request, {}, ctx);

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalled();

    const flushPromise = (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await flushPromise;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('network');
    expect(body.events[0].method).toBe('GET');
    expect(body.events[0].url).toBe('/api/users?page=1');
    expect(body.events[0].status).toBe(200);
    expect(body.events[0].source).toBe('workers');
    expect(body.events[0].direction).toBe('incoming');
  });

  it('should capture errors and re-throw', async () => {
    const handler = {
      async fetch() {
        throw new Error('Something went wrong');
      },
    };

    const wrapped = withRuntimeScope(handler, {
      appName: 'test-worker',
      captureConsole: false,
    });

    const request = makeRequest('https://example.com/api/fail');
    const ctx = makeCtx();

    await expect(wrapped.fetch(request, {}, ctx)).rejects.toThrow('Something went wrong');

    // Should still flush events via waitUntil
    expect(ctx.waitUntil).toHaveBeenCalled();
    const flushPromise = (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await flushPromise;

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // Should have both an error event and a failed network event
    expect(body.events).toHaveLength(2);

    const errorEvent = body.events.find((e: { eventType: string }) => e.eventType === 'console');
    expect(errorEvent.level).toBe('error');
    expect(errorEvent.message).toBe('Something went wrong');

    const networkEvent = body.events.find((e: { eventType: string }) => e.eventType === 'network');
    expect(networkEvent.status).toBe(500);
    expect(networkEvent.errorMessage).toBe('Something went wrong');
  });

  it('should respect sampleRate', async () => {
    const handler = {
      async fetch() {
        return new Response('OK');
      },
    };

    const wrapped = withRuntimeScope(handler, {
      appName: 'test-worker',
      sampleRate: 0, // Drop everything
      captureConsole: false,
    });

    const request = makeRequest('https://example.com/api/test');
    const ctx = makeCtx();

    await wrapped.fetch(request, {}, ctx);
    const flushPromise = (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await flushPromise;

    // With sampleRate 0, no events should be queued
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should respect beforeSend filter', async () => {
    const handler = {
      async fetch() {
        return new Response('OK');
      },
    };

    const wrapped = withRuntimeScope(handler, {
      appName: 'test-worker',
      captureConsole: false,
      beforeSend: (event) => {
        // Drop all network events
        if (event.eventType === 'network') return null;
        return event;
      },
    });

    const request = makeRequest('https://example.com/api/test');
    const ctx = makeCtx();

    await wrapped.fetch(request, {}, ctx);
    const flushPromise = (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await flushPromise;

    // All events were filtered — nothing to flush
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should capture request duration', async () => {
    const handler = {
      async fetch() {
        await new Promise((r) => setTimeout(r, 50));
        return new Response('OK');
      },
    };

    const wrapped = withRuntimeScope(handler, {
      appName: 'test-worker',
      captureConsole: false,
    });

    const ctx = makeCtx();
    await wrapped.fetch(makeRequest('https://example.com/slow'), {}, ctx);
    const flushPromise = (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await flushPromise;

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].duration).toBeGreaterThanOrEqual(40);
  });
});
