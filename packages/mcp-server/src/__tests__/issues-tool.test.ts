import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerIssueTools } from '../tools/issues.js';
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

function makeDatabaseEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'database' as const,
    query: 'SELECT * FROM users WHERE id = 1',
    normalizedQuery: 'SELECT * FROM users WHERE id = ?',
    duration: 50,
    tablesAccessed: ['users'],
    operation: 'SELECT',
    source: 'prisma',
    ...overrides,
  };
}

describe('detect_issues tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    // Register without engines for basic tests
    registerIssueTools(server, store);
  });

  it('returns response envelope structure', async () => {
    const result = await callTool('detect_issues', {});
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('metadata');
  });

  it('returns "No issues detected." when no events', async () => {
    const result = await callTool('detect_issues', {});
    expect(result.summary).toContain('No issues detected');
  });

  it('detects failed requests and includes severity counts', async () => {
    store.addEvent(makeNetworkEvent({ status: 500 }));
    const result = await callTool('detect_issues', {});
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0].severity).toBe('HIGH');
  });

  it('data maps issue fields (severity uppercase, pattern, title, description, evidence, suggestion)', async () => {
    store.addEvent(makeNetworkEvent({ status: 500 }));
    const result = await callTool('detect_issues', {});
    const issue = result.data[0];
    expect(issue).toHaveProperty('severity');
    expect(issue).toHaveProperty('pattern');
    expect(issue).toHaveProperty('title');
    expect(issue).toHaveProperty('description');
    expect(issue).toHaveProperty('evidence');
    expect(issue).toHaveProperty('suggestion');
    expect(issue.severity).toMatch(/^(HIGH|MEDIUM|LOW)$/);
  });

  it('issues array contains formatted strings "[SEVERITY] title"', async () => {
    store.addEvent(makeNetworkEvent({ status: 500 }));
    const result = await callTool('detect_issues', {});
    expect(result.issues[0]).toMatch(/^\[(HIGH|MEDIUM|LOW)\] /);
  });

  it('filters by severity_filter', async () => {
    store.addEvent(makeNetworkEvent({ status: 500 }));     // high
    store.addEvent(makeNetworkEvent({ duration: 4000 }));   // medium (slow)
    const result = await callTool('detect_issues', { severity_filter: 'high' });
    // Only high severity issues
    for (const issue of result.data) {
      expect(issue.severity).toBe('HIGH');
    }
  });

  it('detects slow DB queries', async () => {
    store.addEvent(makeDatabaseEvent({ duration: 700 }));
    const result = await callTool('detect_issues', {});
    expect(result.data.some((i: any) => i.pattern === 'slow_db_queries')).toBe(true);
  });

  it('detects N+1 DB queries', async () => {
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      store.addEvent(makeDatabaseEvent({
        operation: 'SELECT',
        tablesAccessed: ['users'],
        timestamp: now + i * 100,
      }));
    }
    const result = await callTool('detect_issues', {});
    expect(result.data.some((i: any) => i.pattern === 'n1_db_queries')).toBe(true);
  });
});
