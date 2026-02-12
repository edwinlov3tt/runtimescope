import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerDatabaseTools } from '../tools/database.js';
import { createMcpStub } from './tool-harness.js';

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

// Minimal stubs for ConnectionManager, SchemaIntrospector, DataBrowser
// These tools need them but most tests focus on query log/performance/suggest_indexes
// which only use EventStore
function stubConnectionManager() {
  return {
    listConnections: () => [],
    getConnection: () => null,
    closeAll: async () => {},
  } as any;
}

function stubSchemaIntrospector() {
  return { introspect: async () => ({ connectionId: 'test', tables: [], fetchedAt: Date.now() }) } as any;
}

function stubDataBrowser() {
  return {
    read: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }),
    write: async () => ({ success: true, affectedRows: 0 }),
  } as any;
}

describe('database tools', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerDatabaseTools(server, store, stubConnectionManager(), stubSchemaIntrospector(), stubDataBrowser());
  });

  describe('get_query_log', () => {
    it('returns response envelope structure', async () => {
      const result = await callTool('get_query_log', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('metadata');
    });

    it('returns empty data when no events', async () => {
      const result = await callTool('get_query_log', {});
      expect(result.data).toEqual([]);
      expect(result.metadata.eventCount).toBe(0);
    });

    it('maps fields correctly', async () => {
      store.addEvent(makeDatabaseEvent({
        query: 'INSERT INTO posts (title) VALUES ($1)',
        normalizedQuery: 'INSERT INTO posts (title) VALUES (?)',
        duration: 30,
        operation: 'INSERT',
        tablesAccessed: ['posts'],
        source: 'drizzle',
      }));
      const result = await callTool('get_query_log', {});
      const item = result.data[0];
      expect(item.query).toContain('INSERT INTO posts');
      expect(item.normalizedQuery).toContain('INSERT INTO posts');
      expect(item.duration).toBe('30ms');
      expect(item.operation).toBe('INSERT');
      expect(item.tables).toEqual(['posts']);
      expect(item.source).toBe('drizzle');
    });

    it('flags slow queries in issues', async () => {
      store.addEvent(makeDatabaseEvent({ duration: 700 }));
      const result = await callTool('get_query_log', {});
      expect(result.issues.some((i: string) => i.includes('slow query'))).toBe(true);
    });

    it('flags query errors in issues', async () => {
      store.addEvent(makeDatabaseEvent({ error: 'relation "foo" does not exist' }));
      const result = await callTool('get_query_log', {});
      expect(result.issues.some((i: string) => i.includes('query error'))).toBe(true);
    });

    it('filters by table', async () => {
      store.addEvent(makeDatabaseEvent({ tablesAccessed: ['users'] }));
      store.addEvent(makeDatabaseEvent({ tablesAccessed: ['posts'] }));
      const result = await callTool('get_query_log', { table: 'posts' });
      expect(result.data).toHaveLength(1);
    });

    it('filters by min_duration_ms', async () => {
      store.addEvent(makeDatabaseEvent({ duration: 10 }));
      store.addEvent(makeDatabaseEvent({ duration: 200 }));
      const result = await callTool('get_query_log', { min_duration_ms: 100 });
      expect(result.data).toHaveLength(1);
    });

    it('filters by search', async () => {
      store.addEvent(makeDatabaseEvent({ query: 'SELECT * FROM users' }));
      store.addEvent(makeDatabaseEvent({ query: 'DELETE FROM posts WHERE id = 1' }));
      const result = await callTool('get_query_log', { search: 'DELETE' });
      expect(result.data).toHaveLength(1);
    });
  });

  describe('get_query_performance', () => {
    it('returns response envelope structure', async () => {
      const result = await callTool('get_query_performance', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('metadata');
    });

    it('aggregates query stats', async () => {
      store.addEvent(makeDatabaseEvent({ normalizedQuery: 'SELECT * FROM users WHERE id = ?', duration: 100 }));
      store.addEvent(makeDatabaseEvent({ normalizedQuery: 'SELECT * FROM users WHERE id = ?', duration: 200 }));
      const result = await callTool('get_query_performance', {});
      expect(result.data.queryStats).toHaveLength(1);
      expect(result.data.queryStats[0].callCount).toBe(2);
      expect(result.data.queryStats[0].avgDuration).toBe('150ms');
    });

    it('detects N+1 queries', async () => {
      const now = Date.now();
      for (let i = 0; i < 8; i++) {
        store.addEvent(makeDatabaseEvent({
          operation: 'SELECT',
          tablesAccessed: ['users'],
          timestamp: now + i * 100,
        }));
      }
      const result = await callTool('get_query_performance', {});
      expect(result.issues.length).toBeGreaterThan(0);
    });
  });

  describe('suggest_indexes', () => {
    it('returns response envelope', async () => {
      const result = await callTool('suggest_indexes', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
    });

    it('includes suggestedSQL in output', async () => {
      // Add queries with WHERE clauses that suggest index needs
      for (let i = 0; i < 5; i++) {
        store.addEvent(makeDatabaseEvent({
          query: `SELECT * FROM orders WHERE customer_id = ${i}`,
          normalizedQuery: 'SELECT * FROM orders WHERE customer_id = ?',
          tablesAccessed: ['orders'],
        }));
      }
      const result = await callTool('suggest_indexes', {});
      for (const s of result.data) {
        expect(s).toHaveProperty('suggestedSQL');
        expect(s.suggestedSQL).toContain('CREATE INDEX');
      }
    });
  });

  describe('get_database_connections', () => {
    it('returns empty connections', async () => {
      const result = await callTool('get_database_connections', {});
      expect(result.data).toEqual([]);
      expect(result.summary).toContain('0 database connection(s)');
    });
  });
});
