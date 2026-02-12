import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerDomSnapshotTools } from '../tools/dom-snapshot.js';
import { createMcpStub } from './tool-harness.js';

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

function stubCollector(options: {
  firstSessionId?: string | null;
  sendCommandResult?: Record<string, unknown>;
  sendCommandError?: Error;
} = {}) {
  return {
    getFirstSessionId: () => options.firstSessionId ?? null,
    sendCommand: async () => {
      if (options.sendCommandError) throw options.sendCommandError;
      return options.sendCommandResult ?? {
        html: '<html><body>Hello</body></html>',
        url: 'http://localhost:3000',
        viewport: { width: 1280, height: 720 },
        scrollPosition: { x: 0, y: 0 },
        elementCount: 5,
        truncated: false,
      };
    },
  } as any;
}

describe('get_dom_snapshot tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  describe('when no session is connected', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
      store = new EventStore(100);
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerDomSnapshotTools(server, store, stubCollector({ firstSessionId: null }));
    });

    it('returns "No active SDK session" when no session connected', async () => {
      const result = await callTool('get_dom_snapshot', {});
      expect(result.summary).toContain('No active SDK session');
      expect(result.data).toBeNull();
    });
  });

  describe('when session is connected', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
      store = new EventStore(100);
      store.addEvent(makeSessionEvent({ sessionId: 'sess-1' }));
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerDomSnapshotTools(server, store, stubCollector({
        firstSessionId: 'sess-1',
        sendCommandResult: {
          html: '<html><body><h1>Test</h1></body></html>',
          url: 'http://localhost:3000/page',
          viewport: { width: 1920, height: 1080 },
          scrollPosition: { x: 0, y: 100 },
          elementCount: 42,
          truncated: false,
        },
      }));
    });

    it('returns response envelope structure', async () => {
      const result = await callTool('get_dom_snapshot', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('metadata');
    });

    it('captures DOM snapshot with correct fields', async () => {
      const result = await callTool('get_dom_snapshot', {});
      expect(result.data.html).toContain('<h1>Test</h1>');
      expect(result.data.url).toBe('http://localhost:3000/page');
      expect(result.data.viewport).toEqual({ width: 1920, height: 1080 });
      expect(result.data.scrollPosition).toEqual({ x: 0, y: 100 });
      expect(result.data.elementCount).toBe(42);
      expect(result.data.truncated).toBe(false);
    });

    it('summary includes element count and URL', async () => {
      const result = await callTool('get_dom_snapshot', {});
      expect(result.summary).toContain('42 elements');
      expect(result.summary).toContain('localhost:3000');
    });

    it('issues is empty when not truncated', async () => {
      const result = await callTool('get_dom_snapshot', {});
      expect(result.issues).toHaveLength(0);
    });
  });

  describe('when snapshot is truncated', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
      store = new EventStore(100);
      store.addEvent(makeSessionEvent({ sessionId: 'sess-1' }));
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerDomSnapshotTools(server, store, stubCollector({
        firstSessionId: 'sess-1',
        sendCommandResult: {
          html: '<html>...</html>',
          url: 'http://localhost:3000',
          viewport: { width: 1280, height: 720 },
          scrollPosition: { x: 0, y: 0 },
          elementCount: 5000,
          truncated: true,
        },
      }));
    });

    it('includes truncation warning in issues', async () => {
      const result = await callTool('get_dom_snapshot', {});
      expect(result.issues.some((i: string) => i.includes('truncated'))).toBe(true);
    });
  });

  describe('when command fails', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
      store = new EventStore(100);
      store.addEvent(makeSessionEvent({ sessionId: 'sess-1' }));
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerDomSnapshotTools(server, store, stubCollector({
        firstSessionId: 'sess-1',
        sendCommandError: new Error('Command timed out'),
      }));
    });

    it('returns error in summary', async () => {
      const result = await callTool('get_dom_snapshot', {});
      expect(result.summary).toContain('Failed to capture');
      expect(result.summary).toContain('timed out');
      expect(result.data).toBeNull();
    });
  });
});
