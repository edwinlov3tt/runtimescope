import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventStore } from '../store.js';
import {
  makeNetworkEvent,
  makeConsoleEvent,
  makeSessionEvent,
  makeStateEvent,
  makeRenderEvent,
  makeRenderProfile,
  makePerformanceEvent,
  makeDatabaseEvent,
} from './factories.js';

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore(100);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
  });

  describe('addEvent', () => {
    it('increments eventCount', () => {
      expect(store.eventCount).toBe(0);
      store.addEvent(makeNetworkEvent());
      expect(store.eventCount).toBe(1);
    });

    it('registers session info on session event', () => {
      store.addEvent(makeSessionEvent({ sessionId: 'sess-1', appName: 'my-app' }));
      const sessions = store.getSessionInfo();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('sess-1');
      expect(sessions[0].appName).toBe('my-app');
      expect(sessions[0].isConnected).toBe(true);
    });

    it('increments session eventCount on subsequent events', () => {
      store.addEvent(makeSessionEvent({ sessionId: 'sess-1' }));
      store.addEvent(makeNetworkEvent({ sessionId: 'sess-1' }));
      store.addEvent(makeNetworkEvent({ sessionId: 'sess-1' }));
      const sessions = store.getSessionInfo();
      // session event itself counts as 1, plus 2 network = 3
      expect(sessions[0].eventCount).toBe(3);
    });

    it('notifies onEvent callbacks', () => {
      const callback = vi.fn();
      store.onEvent(callback);
      const event = makeNetworkEvent();
      store.addEvent(event);
      expect(callback).toHaveBeenCalledWith(event);
    });

    it('does not break on callback errors', () => {
      store.onEvent(() => { throw new Error('boom'); });
      const callback2 = vi.fn();
      store.onEvent(callback2);
      store.addEvent(makeNetworkEvent());
      // Second callback still called despite first throwing
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe('getNetworkRequests', () => {
    it('returns only network events', () => {
      store.addEvent(makeNetworkEvent());
      store.addEvent(makeConsoleEvent());
      const results = store.getNetworkRequests();
      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe('network');
    });

    it('filters by sinceSeconds', () => {
      const now = Date.now();
      store.addEvent(makeNetworkEvent({ timestamp: now - 120_000 })); // 2 min ago
      store.addEvent(makeNetworkEvent({ timestamp: now - 30_000 }));  // 30s ago
      const results = store.getNetworkRequests({ sinceSeconds: 60 });
      expect(results).toHaveLength(1);
    });

    it('filters by urlPattern substring', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.example.com/users' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.example.com/posts' }));
      const results = store.getNetworkRequests({ urlPattern: 'users' });
      expect(results).toHaveLength(1);
    });

    it('filters by status', () => {
      store.addEvent(makeNetworkEvent({ status: 200 }));
      store.addEvent(makeNetworkEvent({ status: 404 }));
      const results = store.getNetworkRequests({ status: 404 });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe(404);
    });

    it('filters by method (case-insensitive)', () => {
      store.addEvent(makeNetworkEvent({ method: 'GET' }));
      store.addEvent(makeNetworkEvent({ method: 'POST' }));
      const results = store.getNetworkRequests({ method: 'post' });
      expect(results).toHaveLength(1);
      expect(results[0].method).toBe('POST');
    });
  });

  describe('getConsoleMessages', () => {
    it('returns only console events', () => {
      store.addEvent(makeConsoleEvent());
      store.addEvent(makeNetworkEvent());
      const results = store.getConsoleMessages();
      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe('console');
    });

    it('filters by level', () => {
      store.addEvent(makeConsoleEvent({ level: 'error' }));
      store.addEvent(makeConsoleEvent({ level: 'log' }));
      const results = store.getConsoleMessages({ level: 'error' });
      expect(results).toHaveLength(1);
    });

    it('filters by search (case-insensitive)', () => {
      store.addEvent(makeConsoleEvent({ message: 'User logged in' }));
      store.addEvent(makeConsoleEvent({ message: 'Database error' }));
      const results = store.getConsoleMessages({ search: 'database' });
      expect(results).toHaveLength(1);
    });
  });

  describe('getStateEvents', () => {
    it('returns only state events', () => {
      store.addEvent(makeStateEvent());
      store.addEvent(makeNetworkEvent());
      expect(store.getStateEvents()).toHaveLength(1);
    });

    it('filters by storeId', () => {
      store.addEvent(makeStateEvent({ storeId: 'auth' }));
      store.addEvent(makeStateEvent({ storeId: 'cart' }));
      const results = store.getStateEvents({ storeId: 'auth' });
      expect(results).toHaveLength(1);
    });
  });

  describe('getRenderEvents', () => {
    it('returns only render events', () => {
      store.addEvent(makeRenderEvent());
      store.addEvent(makeNetworkEvent());
      expect(store.getRenderEvents()).toHaveLength(1);
    });

    it('filters by componentName (case-insensitive)', () => {
      store.addEvent(makeRenderEvent({
        profiles: [makeRenderProfile({ componentName: 'Header' })],
      }));
      store.addEvent(makeRenderEvent({
        profiles: [makeRenderProfile({ componentName: 'Footer' })],
      }));
      const results = store.getRenderEvents({ componentName: 'header' });
      expect(results).toHaveLength(1);
    });
  });

  describe('getPerformanceMetrics', () => {
    it('returns only performance events', () => {
      store.addEvent(makePerformanceEvent());
      store.addEvent(makeNetworkEvent());
      expect(store.getPerformanceMetrics()).toHaveLength(1);
    });

    it('filters by metricName', () => {
      store.addEvent(makePerformanceEvent({ metricName: 'LCP' }));
      store.addEvent(makePerformanceEvent({ metricName: 'CLS' }));
      const results = store.getPerformanceMetrics({ metricName: 'CLS' });
      expect(results).toHaveLength(1);
    });
  });

  describe('getDatabaseEvents', () => {
    it('returns only database events', () => {
      store.addEvent(makeDatabaseEvent());
      store.addEvent(makeNetworkEvent());
      expect(store.getDatabaseEvents()).toHaveLength(1);
    });

    it('filters by table (case-insensitive)', () => {
      store.addEvent(makeDatabaseEvent({ tablesAccessed: ['users'] }));
      store.addEvent(makeDatabaseEvent({ tablesAccessed: ['posts'] }));
      const results = store.getDatabaseEvents({ table: 'Users' });
      expect(results).toHaveLength(1);
    });

    it('filters by minDurationMs', () => {
      store.addEvent(makeDatabaseEvent({ duration: 100 }));
      store.addEvent(makeDatabaseEvent({ duration: 600 }));
      const results = store.getDatabaseEvents({ minDurationMs: 500 });
      expect(results).toHaveLength(1);
    });

    it('filters by search (case-insensitive)', () => {
      store.addEvent(makeDatabaseEvent({ query: 'SELECT * FROM users' }));
      store.addEvent(makeDatabaseEvent({ query: 'INSERT INTO posts' }));
      const results = store.getDatabaseEvents({ search: 'users' });
      expect(results).toHaveLength(1);
    });

    it('filters by operation', () => {
      store.addEvent(makeDatabaseEvent({ operation: 'SELECT' }));
      store.addEvent(makeDatabaseEvent({ operation: 'INSERT' }));
      const results = store.getDatabaseEvents({ operation: 'INSERT' });
      expect(results).toHaveLength(1);
    });

    it('filters by source', () => {
      store.addEvent(makeDatabaseEvent({ source: 'prisma' }));
      store.addEvent(makeDatabaseEvent({ source: 'pg' }));
      const results = store.getDatabaseEvents({ source: 'pg' });
      expect(results).toHaveLength(1);
    });
  });

  describe('getEventTimeline', () => {
    it('returns all events in chronological order (oldest first)', () => {
      const now = Date.now();
      store.addEvent(makeNetworkEvent({ timestamp: now - 2000 }));
      store.addEvent(makeConsoleEvent({ timestamp: now - 1000 }));
      store.addEvent(makeNetworkEvent({ timestamp: now }));
      const timeline = store.getEventTimeline();
      expect(timeline).toHaveLength(3);
      expect(timeline[0].timestamp).toBeLessThan(timeline[1].timestamp);
      expect(timeline[1].timestamp).toBeLessThan(timeline[2].timestamp);
    });

    it('filters by eventTypes', () => {
      store.addEvent(makeNetworkEvent());
      store.addEvent(makeConsoleEvent());
      store.addEvent(makeDatabaseEvent());
      const timeline = store.getEventTimeline({ eventTypes: ['network', 'database'] });
      expect(timeline).toHaveLength(2);
    });
  });

  describe('getSessionInfo', () => {
    it('returns empty array initially', () => {
      expect(store.getSessionInfo()).toEqual([]);
    });

    it('tracks isConnected via markDisconnected', () => {
      store.addEvent(makeSessionEvent({ sessionId: 'sess-1' }));
      store.markDisconnected('sess-1');
      expect(store.getSessionInfo()[0].isConnected).toBe(false);
    });
  });

  describe('clear', () => {
    it('resets eventCount to 0', () => {
      store.addEvent(makeNetworkEvent());
      store.addEvent(makeNetworkEvent());
      store.clear();
      expect(store.eventCount).toBe(0);
    });

    it('returns clearedCount', () => {
      store.addEvent(makeNetworkEvent());
      store.addEvent(makeNetworkEvent());
      const result = store.clear();
      expect(result).toEqual({ clearedCount: 2 });
    });
  });

  describe('onEvent / removeEventListener', () => {
    it('removing callback stops notifications', () => {
      const callback = vi.fn();
      store.onEvent(callback);
      store.addEvent(makeNetworkEvent());
      expect(callback).toHaveBeenCalledTimes(1);

      store.removeEventListener(callback);
      store.addEvent(makeNetworkEvent());
      expect(callback).toHaveBeenCalledTimes(1); // still 1
    });
  });
});
