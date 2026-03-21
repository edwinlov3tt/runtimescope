import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRuntimeScope } from '../handler.js';
import { track, addBreadcrumb } from '../index.js';

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

function makeRequest(url: string): Request {
  return new Request(url, { method: 'GET' });
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn((p: Promise<unknown>) => p),
    passThroughOnException: vi.fn(),
    props: {} as Record<string, unknown>,
    abort: vi.fn(),
  } as unknown as ExecutionContext;
}

async function getEvents(): Promise<Record<string, unknown>[]> {
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  return body.events;
}

describe('track()', () => {
  it('should emit a custom event inside a handler', async () => {
    const handler = {
      async fetch() {
        track('user.signup', { plan: 'pro', source: 'landing' });
        return new Response('OK');
      },
    };

    const wrapped = withRuntimeScope(handler, { appName: 'test', captureConsole: false });
    await wrapped.fetch(makeRequest('https://example.com/'), {}, makeCtx());

    const events = await getEvents();
    const custom = events.find((e) => e.eventType === 'custom');

    expect(custom).toBeDefined();
    expect(custom!.name).toBe('user.signup');
    expect(custom!.properties).toEqual({ plan: 'pro', source: 'landing' });
  });

  it('should work without properties', async () => {
    const handler = {
      async fetch() {
        track('cache.hit');
        return new Response('OK');
      },
    };

    const wrapped = withRuntimeScope(handler, { appName: 'test', captureConsole: false });
    await wrapped.fetch(makeRequest('https://example.com/'), {}, makeCtx());

    const events = await getEvents();
    const custom = events.find((e) => e.eventType === 'custom');

    expect(custom).toBeDefined();
    expect(custom!.name).toBe('cache.hit');
    expect(custom!.properties).toBeUndefined();
  });

  it('should be a no-op outside a handler', () => {
    // Should not throw when called outside withRuntimeScope
    expect(() => track('orphan.event')).not.toThrow();
  });

  it('should respect beforeSend filtering', async () => {
    const handler = {
      async fetch() {
        track('should.be.dropped');
        return new Response('OK');
      },
    };

    const wrapped = withRuntimeScope(handler, {
      appName: 'test',
      captureConsole: false,
      beforeSend: (event) => {
        if (event.eventType === 'custom') return null;
        return event;
      },
    });
    await wrapped.fetch(makeRequest('https://example.com/'), {}, makeCtx());

    const events = await getEvents();
    const customs = events.filter((e) => e.eventType === 'custom');
    expect(customs).toHaveLength(0);
  });
});

describe('addBreadcrumb()', () => {
  it('should emit a ui breadcrumb event inside a handler', async () => {
    const handler = {
      async fetch() {
        addBreadcrumb('auth check passed', { userId: '123' });
        return new Response('OK');
      },
    };

    const wrapped = withRuntimeScope(handler, { appName: 'test', captureConsole: false });
    await wrapped.fetch(makeRequest('https://example.com/'), {}, makeCtx());

    const events = await getEvents();
    const bc = events.find((e) => e.eventType === 'ui');

    expect(bc).toBeDefined();
    expect(bc!.action).toBe('breadcrumb');
    expect(bc!.target).toBe('manual');
    expect(bc!.text).toBe('auth check passed');
    expect(bc!.data).toEqual({ userId: '123' });
  });

  it('should work without data', async () => {
    const handler = {
      async fetch() {
        addBreadcrumb('request started');
        return new Response('OK');
      },
    };

    const wrapped = withRuntimeScope(handler, { appName: 'test', captureConsole: false });
    await wrapped.fetch(makeRequest('https://example.com/'), {}, makeCtx());

    const events = await getEvents();
    const bc = events.find((e) => e.eventType === 'ui');

    expect(bc).toBeDefined();
    expect(bc!.text).toBe('request started');
    expect(bc!.data).toBeUndefined();
  });

  it('should be a no-op outside a handler', () => {
    expect(() => addBreadcrumb('orphan')).not.toThrow();
  });

  it('should produce events in chronological order with other events', async () => {
    const handler = {
      async fetch() {
        addBreadcrumb('step 1');
        track('step.2', { seq: 2 });
        addBreadcrumb('step 3');
        return new Response('OK');
      },
    };

    const wrapped = withRuntimeScope(handler, { appName: 'test', captureConsole: false });
    await wrapped.fetch(makeRequest('https://example.com/'), {}, makeCtx());

    const events = await getEvents();
    // Should have: breadcrumb, custom, breadcrumb, network (4 events)
    const nonNetwork = events.filter((e) => e.eventType !== 'network');
    expect(nonNetwork).toHaveLength(3);
    expect(nonNetwork[0].eventType).toBe('ui');
    expect(nonNetwork[1].eventType).toBe('custom');
    expect(nonNetwork[2].eventType).toBe('ui');
  });
});
