import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerHistoryTools } from '../tools/history.js';
import { createMcpStub } from './tool-harness.js';
import type { CollectorServer, ProjectManager } from '@runtimescope/collector';

// --- Mock factories ---

interface MockSqliteStore {
  getEvents: ReturnType<typeof vi.fn>;
  getEventCount: ReturnType<typeof vi.fn>;
  getSessions: ReturnType<typeof vi.fn>;
}

function createMockSqliteStore(overrides: Partial<MockSqliteStore> = {}): MockSqliteStore {
  return {
    getEvents: vi.fn().mockReturnValue([]),
    getEventCount: vi.fn().mockReturnValue(0),
    getSessions: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

function createMockCollector(
  sqliteStores: Record<string, MockSqliteStore> = {},
): CollectorServer {
  return {
    getSqliteStore: vi.fn((name: string) => sqliteStores[name] ?? undefined),
    getSqliteStores: vi.fn(() => new Map(Object.entries(sqliteStores))),
  } as unknown as CollectorServer;
}

function createMockProjectManager(projects: string[] = []): ProjectManager {
  return {
    listProjects: vi.fn(() => projects),
    getProjectDbPath: vi.fn((name: string) => `/mock/.runtimescope/projects/${name}/events.db`),
  } as unknown as ProjectManager;
}

// --- Helpers ---

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'sess-1',
    timestamp: Date.now(),
    eventType: 'network',
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    project: 'my-app',
    appName: 'my-app',
    connectedAt: Date.now() - 60_000,
    sdkVersion: '0.6.0',
    eventCount: 10,
    isConnected: false,
    ...overrides,
  };
}

// ==========================================
// get_historical_events
// ==========================================

describe('get_historical_events tool', () => {
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  describe('when project has no SQLite store', () => {
    beforeEach(() => {
      const collector = createMockCollector({});
      const pm = createMockProjectManager(['other-app']);
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerHistoryTools(server, collector, pm);
    });

    it('returns helpful error with available projects', async () => {
      const result = await callTool('get_historical_events', {
        project: 'nonexistent',
      });
      expect(result.summary).toContain('No historical data');
      expect(result.summary).toContain('other-app');
      expect(result.data).toBeNull();
    });

    it('returns hint when no projects exist', async () => {
      const collector = createMockCollector({});
      const pm = createMockProjectManager([]);
      const { server, callTool: ct } = createMcpStub();
      registerHistoryTools(server, collector, pm);

      const result = await ct('get_historical_events', { project: 'foo' });
      expect(result.summary).toContain('No projects have connected');
    });
  });

  describe('when project has events', () => {
    let mockStore: MockSqliteStore;

    beforeEach(() => {
      const events = [
        makeEvent({ eventType: 'network', timestamp: 1000 }),
        makeEvent({ eventType: 'network', timestamp: 2000 }),
        makeEvent({ eventType: 'console', timestamp: 3000 }),
      ];
      mockStore = createMockSqliteStore({
        getEvents: vi.fn().mockReturnValue(events),
        getEventCount: vi.fn().mockReturnValue(3),
      });
      const collector = createMockCollector({ 'my-app': mockStore });
      const pm = createMockProjectManager(['my-app']);
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerHistoryTools(server, collector, pm);
    });

    it('returns events with pagination info', async () => {
      const result = await callTool('get_historical_events', {
        project: 'my-app',
        limit: 200,
        offset: 0,
      });
      expect(result.data.events).toHaveLength(3);
      expect(result.data.pagination.returned).toBe(3);
      expect(result.data.pagination.total).toBe(3);
      expect(result.data.pagination.hasMore).toBe(false);
    });

    it('includes type breakdown in summary', async () => {
      const result = await callTool('get_historical_events', {
        project: 'my-app',
      });
      expect(result.summary).toContain('network: 2');
      expect(result.summary).toContain('console: 1');
    });

    it('passes event_types filter to store', async () => {
      await callTool('get_historical_events', {
        project: 'my-app',
        event_types: ['network'],
      });
      expect(mockStore.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({ eventTypes: ['network'] }),
      );
    });

    it('passes session_id filter to store', async () => {
      await callTool('get_historical_events', {
        project: 'my-app',
        session_id: 'sess-42',
      });
      expect(mockStore.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-42' }),
      );
    });

    it('caps limit at 1000', async () => {
      await callTool('get_historical_events', {
        project: 'my-app',
        limit: 5000,
        offset: 0,
      });
      expect(mockStore.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1000 }),
      );
    });

    it('indicates hasMore when total exceeds page', async () => {
      mockStore.getEventCount.mockReturnValue(500);
      const result = await callTool('get_historical_events', {
        project: 'my-app',
        limit: 200,
        offset: 0,
      });
      expect(result.data.pagination.hasMore).toBe(true);
      expect(result.summary).toContain('offset=200');
    });
  });

  describe('date parsing', () => {
    let mockStore: MockSqliteStore;

    beforeEach(() => {
      mockStore = createMockSqliteStore();
      const collector = createMockCollector({ 'my-app': mockStore });
      const pm = createMockProjectManager(['my-app']);
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerHistoryTools(server, collector, pm);
    });

    it('parses relative time "2h"', async () => {
      const before = Date.now();
      await callTool('get_historical_events', {
        project: 'my-app',
        since: '2h',
      });
      const call = mockStore.getEvents.mock.calls[0][0];
      // "2h" should be ~7,200,000ms ago
      const twoHoursMs = 2 * 60 * 60 * 1000;
      expect(call.since).toBeGreaterThan(before - twoHoursMs - 1000);
      expect(call.since).toBeLessThanOrEqual(before);
    });

    it('parses relative time "7d"', async () => {
      const before = Date.now();
      await callTool('get_historical_events', {
        project: 'my-app',
        since: '7d',
      });
      const call = mockStore.getEvents.mock.calls[0][0];
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(call.since).toBeGreaterThan(before - sevenDaysMs - 1000);
      expect(call.since).toBeLessThanOrEqual(before);
    });

    it('parses ISO date string', async () => {
      await callTool('get_historical_events', {
        project: 'my-app',
        since: '2025-06-15T00:00:00Z',
      });
      const call = mockStore.getEvents.mock.calls[0][0];
      expect(call.since).toBe(new Date('2025-06-15T00:00:00Z').getTime());
    });

    it('leaves undefined when no date params', async () => {
      await callTool('get_historical_events', {
        project: 'my-app',
      });
      const call = mockStore.getEvents.mock.calls[0][0];
      expect(call.since).toBeUndefined();
      expect(call.until).toBeUndefined();
    });
  });
});

// ==========================================
// list_projects
// ==========================================

describe('list_projects tool', () => {
  it('registers the tool', () => {
    const { server, getTools } = createMcpStub();
    const collector = createMockCollector();
    const pm = createMockProjectManager();
    registerHistoryTools(server, collector, pm);
    expect(getTools().has('list_projects')).toBe(true);
    expect(getTools().has('get_historical_events')).toBe(true);
  });

  it('returns empty list when no projects', async () => {
    const collector = createMockCollector();
    const pm = createMockProjectManager([]);
    const { server, callTool } = createMcpStub();
    registerHistoryTools(server, collector, pm);

    const result = await callTool('list_projects');
    expect(result.data).toEqual([]);
    expect(result.summary).toContain('0 project(s)');
  });

  it('returns project stats with active SQLite store', async () => {
    const sessions = [
      makeSession({ sessionId: 'sess-1', connectedAt: 1000, isConnected: true }),
      makeSession({ sessionId: 'sess-2', connectedAt: 500, isConnected: false }),
    ];
    const mockStore = createMockSqliteStore({
      getEvents: vi.fn().mockReturnValue([]),
      getEventCount: vi.fn().mockReturnValue(42),
      getSessions: vi.fn().mockReturnValue(sessions),
    });
    const collector = createMockCollector({ 'my-app': mockStore });
    const pm = createMockProjectManager(['my-app']);
    const { server, callTool } = createMcpStub();
    registerHistoryTools(server, collector, pm);

    const result = await callTool('list_projects');
    expect(result.data).toHaveLength(1);

    const project = result.data[0];
    expect(project.name).toBe('my-app');
    expect(project.eventCount).toBe(42);
    expect(project.sessionCount).toBe(2);
    expect(project.activeSessions).toBe(1);
    expect(project.isConnected).toBe(true);
  });

  it('handles project with no active store', async () => {
    const collector = createMockCollector({});
    const pm = createMockProjectManager(['stale-app']);
    const { server, callTool } = createMcpStub();
    registerHistoryTools(server, collector, pm);

    const result = await callTool('list_projects');
    const project = result.data[0];
    expect(project.name).toBe('stale-app');
    expect(project.eventCount).toBe(0);
    expect(project.isConnected).toBe(false);
    expect(project.note).toContain('no active SQLite store');
  });

  it('reports total events and connected count in summary', async () => {
    const store1 = createMockSqliteStore({
      getEventCount: vi.fn().mockReturnValue(100),
      getSessions: vi.fn().mockReturnValue([makeSession({ isConnected: true })]),
    });
    const store2 = createMockSqliteStore({
      getEventCount: vi.fn().mockReturnValue(200),
      getSessions: vi.fn().mockReturnValue([makeSession({ isConnected: false })]),
    });
    const collector = createMockCollector({ app1: store1, app2: store2 });
    const pm = createMockProjectManager(['app1', 'app2']);
    const { server, callTool } = createMcpStub();
    registerHistoryTools(server, collector, pm);

    const result = await callTool('list_projects');
    expect(result.summary).toContain('2 project(s)');
    expect(result.summary).toContain('300 total events');
    expect(result.summary).toContain('1 currently connected');
  });
});
