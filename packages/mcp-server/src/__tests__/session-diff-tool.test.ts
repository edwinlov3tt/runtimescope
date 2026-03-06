import { describe, it, expect, vi } from 'vitest';
import { registerSessionDiffTools } from '../tools/session-diff.js';
import { createMcpStub } from './tool-harness.js';
import type { SessionMetrics } from '@runtimescope/collector';

function makeSessionMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    sessionId: 'session-1',
    project: 'default',
    connectedAt: Date.now() - 60000,
    disconnectedAt: Date.now(),
    totalEvents: 100,
    errorCount: 5,
    endpoints: {},
    components: {},
    stores: {},
    webVitals: {},
    queries: {},
    ...overrides,
  };
}

function stubSessionManager(options: {
  history?: any[];
  snapshots?: any[];
  snapshotById?: any;
  createdSnapshot?: any;
} = {}) {
  return {
    getSessionHistory: vi.fn(() => options.history ?? []),
    createSnapshot: vi.fn(() => options.createdSnapshot ?? {
      sessionId: 'session-1',
      project: 'default',
      label: undefined,
      metrics: makeSessionMetrics(),
      createdAt: Date.now(),
    }),
    getSessionSnapshots: vi.fn(() => options.snapshots ?? []),
    getSnapshotById: vi.fn(() => options.snapshotById ?? null),
  } as any;
}

function stubCollector(options: {
  firstSessionId?: string;
  projectForSession?: string;
} = {}) {
  return {
    getFirstSessionId: vi.fn(() => options.firstSessionId ?? undefined),
    getProjectForSession: vi.fn(() => options.projectForSession ?? 'default'),
  } as any;
}

describe('session diff MCP tools', () => {
  describe('create_session_snapshot', () => {
    it('captures snapshot for active session', async () => {
      const metrics = makeSessionMetrics({ totalEvents: 42, errorCount: 3 });
      const sm = stubSessionManager({
        createdSnapshot: {
          sessionId: 'sess-abc',
          project: 'myapp',
          label: 'before-fix',
          metrics,
          createdAt: Date.now(),
        },
      });
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, sm, stubCollector({ firstSessionId: 'sess-abc', projectForSession: 'myapp' }));

      const result = await callTool('create_session_snapshot', { label: 'before-fix' }) as any;
      expect(result.summary).toContain('Snapshot captured');
      expect(result.summary).toContain('before-fix');
      expect(result.data.label).toBe('before-fix');
      expect(result.data.metrics.totalEvents).toBe(42);
      expect(sm.createSnapshot).toHaveBeenCalledWith('sess-abc', 'myapp', 'before-fix');
    });

    it('returns error when no active session', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager(), stubCollector());

      const result = await callTool('create_session_snapshot', {}) as any;
      expect(result.summary).toContain('No active session');
      expect(result.data).toBeNull();
    });

    it('uses explicit session_id when provided', async () => {
      const sm = stubSessionManager();
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, sm, stubCollector({ projectForSession: 'myapp' }));

      await callTool('create_session_snapshot', { session_id: 'explicit-id', project: 'myapp' });
      expect(sm.createSnapshot).toHaveBeenCalledWith('explicit-id', 'myapp', undefined);
    });
  });

  describe('get_session_snapshots', () => {
    it('returns snapshots for a session', async () => {
      const metrics = makeSessionMetrics();
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({
        snapshots: [
          { id: 1, sessionId: 'sess-a', project: 'default', label: 'baseline', metrics, createdAt: Date.now() - 5000 },
          { id: 2, sessionId: 'sess-a', project: 'default', label: 'after-fix', metrics, createdAt: Date.now() },
        ],
      }), stubCollector());

      const result = await callTool('get_session_snapshots', { session_id: 'sess-a' }) as any;
      expect(result.summary).toContain('2 snapshot(s)');
      expect(result.data).toHaveLength(2);
      expect(result.data[0].label).toBe('baseline');
      expect(result.data[1].label).toBe('after-fix');
    });

    it('returns empty when no snapshots', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager(), stubCollector());

      const result = await callTool('get_session_snapshots', { session_id: 'nonexistent' }) as any;
      expect(result.data).toEqual([]);
    });
  });

  describe('compare_sessions', () => {
    it('compares by session IDs (backward compat)', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({
        history: [
          { sessionId: 'sess-a', project: 'default', createdAt: Date.now() - 60000, metrics: makeSessionMetrics({ sessionId: 'sess-a' }), buildMeta: null },
          { sessionId: 'sess-b', project: 'default', createdAt: Date.now(), metrics: makeSessionMetrics({ sessionId: 'sess-b' }), buildMeta: null },
        ],
      }), stubCollector());

      const result = await callTool('compare_sessions', { session_a: 'sess-a', session_b: 'sess-b' }) as any;
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result.data).toHaveProperty('endpointDeltas');
      expect(result.data).toHaveProperty('overallDelta');
    });

    it('compares by snapshot IDs', async () => {
      const metricsA = makeSessionMetrics({
        sessionId: 'sess-a',
        endpoints: { 'GET /api/users': { avgLatency: 100, errorRate: 0, callCount: 10 } },
      });
      const metricsB = makeSessionMetrics({
        sessionId: 'sess-a',
        endpoints: { 'GET /api/users': { avgLatency: 250, errorRate: 0, callCount: 10 } },
      });

      const sm = stubSessionManager();
      sm.getSnapshotById = vi.fn((_project: string, id: number) => {
        if (id === 1) return { id: 1, sessionId: 'sess-a', project: 'default', label: 'before', metrics: metricsA, createdAt: Date.now() - 5000 };
        if (id === 2) return { id: 2, sessionId: 'sess-a', project: 'default', label: 'after', metrics: metricsB, createdAt: Date.now() };
        return null;
      });

      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, sm, stubCollector());

      const result = await callTool('compare_sessions', { snapshot_a: 1, snapshot_b: 2 }) as any;
      expect(result.summary).toContain('(before)');
      expect(result.summary).toContain('(after)');
      expect(result.summary).toContain('regression');
    });

    it('returns error when session not found', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({ history: [] }), stubCollector());

      const result = await callTool('compare_sessions', { session_a: 'nonexistent-a', session_b: 'nonexistent-b' }) as any;
      expect(result.summary).toContain('Could not find');
      expect(result.data).toBeNull();
    });

    it('returns error when snapshot not found', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager(), stubCollector());

      const result = await callTool('compare_sessions', { snapshot_a: 999, snapshot_b: 998 }) as any;
      expect(result.summary).toContain('Could not find');
      expect(result.issues).toContain('Snapshot 999 not found');
    });

    it('returns error when neither session nor snapshot IDs provided', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager(), stubCollector());

      const result = await callTool('compare_sessions', {}) as any;
      expect(result.summary).toContain('Provide either');
    });

    it('detects regressions and reports them in issues', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({
        history: [
          {
            sessionId: 'sess-a', project: 'default', createdAt: Date.now() - 60000,
            metrics: makeSessionMetrics({
              sessionId: 'sess-a',
              endpoints: { 'GET /api/users': { avgLatency: 100, errorRate: 0, callCount: 10 } },
            }),
          },
          {
            sessionId: 'sess-b', project: 'default', createdAt: Date.now(),
            metrics: makeSessionMetrics({
              sessionId: 'sess-b',
              endpoints: { 'GET /api/users': { avgLatency: 250, errorRate: 0, callCount: 10 } },
            }),
          },
        ],
      }), stubCollector());

      const result = await callTool('compare_sessions', { session_a: 'sess-a', session_b: 'sess-b' }) as any;
      expect(result.summary).toContain('regression');
      expect(result.issues.some((i: string) => i.includes('Regression'))).toBe(true);
    });

    it('summary includes error delta', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({
        history: [
          { sessionId: 'sess-a', project: 'default', createdAt: Date.now() - 60000, metrics: makeSessionMetrics({ sessionId: 'sess-a', errorCount: 2 }) },
          { sessionId: 'sess-b', project: 'default', createdAt: Date.now(), metrics: makeSessionMetrics({ sessionId: 'sess-b', errorCount: 8 }) },
        ],
      }), stubCollector());

      const result = await callTool('compare_sessions', { session_a: 'sess-a', session_b: 'sess-b' }) as any;
      expect(result.summary).toContain('Error delta');
    });
  });

  describe('get_session_history', () => {
    it('returns response envelope', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager(), stubCollector());
      const result = await callTool('get_session_history', {}) as any;
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('metadata');
    });

    it('returns empty when no history', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager(), stubCollector());
      const result = await callTool('get_session_history', {}) as any;
      expect(result.data).toEqual([]);
      expect(result.summary).toContain('0 session(s)');
    });

    it('maps session history fields correctly', async () => {
      const now = Date.now();
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({
        history: [{
          sessionId: 'sess-abc',
          project: 'myapp',
          createdAt: now,
          metrics: makeSessionMetrics({
            sessionId: 'sess-abc',
            totalEvents: 500,
            errorCount: 10,
            endpoints: { 'GET /api/users': { avgLatency: 100, errorRate: 0, callCount: 5 } },
            components: { 'Header': { renderCount: 20, avgDuration: 5 } },
          }),
          buildMeta: { gitCommit: 'abc123', gitBranch: 'main' },
        }],
      }), stubCollector());

      const result = await callTool('get_session_history', {}) as any;
      expect(result.data).toHaveLength(1);
      const s = result.data[0];
      expect(s.sessionId).toBe('sess-abc');
      expect(s.totalEvents).toBe(500);
      expect(s.buildMeta).toEqual({ gitCommit: 'abc123', gitBranch: 'main' });
    });

    it('respects limit parameter', async () => {
      const sm = stubSessionManager({ history: [] });
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, sm, stubCollector());
      await callTool('get_session_history', { limit: 5 });
      expect(sm.getSessionHistory).toHaveBeenCalledWith('default', 5);
    });
  });
});
