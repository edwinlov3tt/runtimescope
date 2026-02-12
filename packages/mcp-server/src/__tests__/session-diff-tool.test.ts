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
} = {}) {
  return {
    getSessionHistory: vi.fn(() => options.history ?? []),
    createSnapshot: vi.fn(),
    compareSessions: vi.fn(),
  } as any;
}

describe('session diff MCP tools', () => {
  describe('compare_sessions', () => {
    it('returns response envelope structure', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({
        history: [
          { sessionId: 'sess-a', project: 'default', createdAt: Date.now() - 60000, metrics: makeSessionMetrics({ sessionId: 'sess-a' }), buildMeta: null },
          { sessionId: 'sess-b', project: 'default', createdAt: Date.now(), metrics: makeSessionMetrics({ sessionId: 'sess-b' }), buildMeta: null },
        ],
      }));
      const result = await callTool('compare_sessions', { session_a: 'sess-a', session_b: 'sess-b' });
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('metadata');
    });

    it('returns error when session not found', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({ history: [] }));
      const result = await callTool('compare_sessions', { session_a: 'nonexistent-a', session_b: 'nonexistent-b' });
      expect(result.summary).toContain('Could not find');
      expect(result.data).toBeNull();
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('detects regressions and reports them in issues', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({
        history: [
          {
            sessionId: 'sess-a',
            project: 'default',
            createdAt: Date.now() - 60000,
            metrics: makeSessionMetrics({
              sessionId: 'sess-a',
              endpoints: { 'GET /api/users': { avgLatency: 100, errorRate: 0, callCount: 10 } },
            }),
          },
          {
            sessionId: 'sess-b',
            project: 'default',
            createdAt: Date.now(),
            metrics: makeSessionMetrics({
              sessionId: 'sess-b',
              endpoints: { 'GET /api/users': { avgLatency: 250, errorRate: 0, callCount: 10 } },
            }),
          },
        ],
      }));
      const result = await callTool('compare_sessions', { session_a: 'sess-a', session_b: 'sess-b' });
      expect(result.summary).toContain('regression');
      expect(result.issues.some((i: string) => i.includes('Regression'))).toBe(true);
    });

    it('includes delta data for endpoints, components, vitals, queries', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({
        history: [
          { sessionId: 'sess-a', project: 'default', createdAt: Date.now() - 60000, metrics: makeSessionMetrics({ sessionId: 'sess-a' }) },
          { sessionId: 'sess-b', project: 'default', createdAt: Date.now(), metrics: makeSessionMetrics({ sessionId: 'sess-b' }) },
        ],
      }));
      const result = await callTool('compare_sessions', { session_a: 'sess-a', session_b: 'sess-b' });
      expect(result.data).toHaveProperty('endpointDeltas');
      expect(result.data).toHaveProperty('componentDeltas');
      expect(result.data).toHaveProperty('webVitalDeltas');
      expect(result.data).toHaveProperty('queryDeltas');
      expect(result.data).toHaveProperty('overallDelta');
    });

    it('summary includes error delta', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({
        history: [
          { sessionId: 'sess-a', project: 'default', createdAt: Date.now() - 60000, metrics: makeSessionMetrics({ sessionId: 'sess-a', errorCount: 2 }) },
          { sessionId: 'sess-b', project: 'default', createdAt: Date.now(), metrics: makeSessionMetrics({ sessionId: 'sess-b', errorCount: 8 }) },
        ],
      }));
      const result = await callTool('compare_sessions', { session_a: 'sess-a', session_b: 'sess-b' });
      expect(result.summary).toContain('Error delta');
    });
  });

  describe('get_session_history', () => {
    it('returns response envelope', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager());
      const result = await callTool('get_session_history', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('metadata');
    });

    it('returns empty when no history', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager());
      const result = await callTool('get_session_history', {});
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
      }));
      const result = await callTool('get_session_history', {});
      expect(result.data).toHaveLength(1);
      const s = result.data[0];
      expect(s.sessionId).toBe('sess-abc');
      expect(s.project).toBe('myapp');
      expect(s.totalEvents).toBe(500);
      expect(s.errorCount).toBe(10);
      expect(s.endpointCount).toBe(1);
      expect(s.componentCount).toBe(1);
      expect(s.buildMeta).toEqual({ gitCommit: 'abc123', gitBranch: 'main' });
    });

    it('summary includes project name', async () => {
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, stubSessionManager({
        history: [{ sessionId: 's1', project: 'coolapp', createdAt: Date.now(), metrics: makeSessionMetrics(), buildMeta: null }],
      }));
      const result = await callTool('get_session_history', { project: 'coolapp' });
      expect(result.summary).toContain('coolapp');
    });

    it('respects limit parameter', async () => {
      const sm = stubSessionManager({ history: [] });
      const { server, callTool } = createMcpStub();
      registerSessionDiffTools(server, sm);
      await callTool('get_session_history', { limit: 5 });
      expect(sm.getSessionHistory).toHaveBeenCalledWith('default', 5);
    });
  });
});
