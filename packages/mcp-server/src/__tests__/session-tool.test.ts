import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerSessionTools } from '../tools/session.js';
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

describe('session tools', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerSessionTools(server, store);
  });

  describe('get_session_info', () => {
    it('returns session data when sessions exist', async () => {
      store.addEvent(makeSessionEvent({ sessionId: 'sess-1', appName: 'my-app' }));
      const result = await callTool('get_session_info', {});
      expect(result.data).toHaveLength(1);
      expect(result.data[0].sessionId).toBe('sess-1');
      expect(result.data[0].appName).toBe('my-app');
      expect(result.data[0].isConnected).toBe(true);
    });

    it('issues contains "No SDK connections detected" when empty', async () => {
      const result = await callTool('get_session_info', {});
      expect(result.issues).toContain('No SDK connections detected');
    });

    it('summary includes connection info', async () => {
      store.addEvent(makeSessionEvent());
      const result = await callTool('get_session_info', {});
      expect(result.summary).toContain('1 session(s) connected');
    });
  });

  describe('clear_events', () => {
    it('returns clearedCount in summary', async () => {
      store.addEvent(makeSessionEvent());
      const result = await callTool('clear_events', {});
      expect(result.summary).toContain('Cleared 1 events');
    });

    it('empties the event store', async () => {
      store.addEvent(makeSessionEvent());
      await callTool('clear_events', {});
      expect(store.eventCount).toBe(0);
    });
  });
});
