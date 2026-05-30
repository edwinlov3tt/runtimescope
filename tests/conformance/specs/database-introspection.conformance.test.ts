/**
 * Conformance: the DATABASE introspection + index-suggestion family against Node.
 *
 * Two distinct contracts here (audit 0002 / M4):
 *  1. suggest_indexes is a REAL store-read — it parses WHERE/ORDER-BY columns out
 *     of captured slow `database` events and proposes indexes. Ported from
 *     query-monitor.ts `suggestIndexes`. We pin the reshaped output: sorted
 *     columns, suggestedSQL, estimatedImpact buckets, high-impact issues.
 *  2. The connection-based tools (get_database_connections / get_schema_map /
 *     get_table_data) mirror Node, whose ConnectionManager is NEVER fed
 *     (addConnection is dead) — so the only reachable response is "no connections
 *     configured" / an empty list. Live driver introspection is unbuilt in BOTH
 *     Node and Rust (a shared latent gap), so matching that response IS parity.
 *
 * Separate `it` blocks so one failure can't mask another. Green vs Node first;
 * RUNTIMESCOPE_MCP_CMD swaps the Rust binary.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver, SdkDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const PROJECT = 'proj_db_introspect';
const APP = 'db-introspect';

function dbEvent(
  sessionId: string,
  i: number,
  opts: { query: string; normalizedQuery: string; duration: number; tables: string[] },
): object {
  return {
    eventId: `evt-db-${i}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'database',
    query: opts.query,
    normalizedQuery: opts.normalizedQuery,
    duration: opts.duration,
    operation: 'SELECT',
    tablesAccessed: opts.tables,
    source: 'prisma',
  };
}

describe('MCP database introspection + suggestions (Node)', () => {
  it('suggest_indexes parses WHERE/ORDER columns from slow queries and reshapes output', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const d = new SdkDriver({ wsPort: mcp.wsPort, appName: APP, projectId: PROJECT });
    await d.connect();
    await new Promise((r) => setTimeout(r, 150));

    d.sendBatch([
      // 1200ms (>1000) → HIGH; WHERE email + ORDER BY created_at → cols sorted to
      // [created_at, email].
      dbEvent(d.sessionId, 1, {
        query: "SELECT * FROM users WHERE email = 'a@b.c' ORDER BY created_at",
        normalizedQuery: 'SELECT * FROM users WHERE email = ? ORDER BY created_at',
        duration: 1200, tables: ['users'],
      }),
      // 400ms (>300) → MEDIUM; WHERE status → [status].
      dbEvent(d.sessionId, 2, {
        query: "SELECT id FROM orders WHERE status = 'paid'",
        normalizedQuery: 'SELECT id FROM orders WHERE status = ?',
        duration: 400, tables: ['orders'],
      }),
      // 50ms (<100) → ignored entirely by suggestIndexes.
      dbEvent(d.sessionId, 3, {
        query: "SELECT id FROM carts WHERE user_id = 1",
        normalizedQuery: 'SELECT id FROM carts WHERE user_id = ?',
        duration: 50, tables: ['carts'],
      }),
    ]);
    await d.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp.callTool('suggest_indexes', { project_id: PROJECT });
    const env = envelope as {
      summary: string;
      data: Array<{ table: string; columns: string[]; estimatedImpact: string; queryPattern: string; suggestedSQL: string; reason: string }>;
      issues: string[];
      metadata: { eventCount: number };
    };

    // The <100ms query produces no suggestion → 2 suggestions, over 3 captured queries.
    expect(env.data.length).toBe(2);
    expect(env.metadata.eventCount).toBe(3);

    const users = env.data.find((s) => s.table === 'users');
    expect(users).toBeTruthy();
    // Columns are SORTED (Node sorts in place before storing).
    expect(users!.columns).toEqual(['created_at', 'email']);
    expect(users!.estimatedImpact).toBe('high');
    expect(users!.suggestedSQL).toBe('CREATE INDEX idx_users_created_at_email ON users(created_at, email);');
    expect(typeof users!.reason).toBe('string');
    expect(typeof users!.queryPattern).toBe('string');

    const orders = env.data.find((s) => s.table === 'orders');
    expect(orders).toBeTruthy();
    expect(orders!.columns).toEqual(['status']);
    expect(orders!.estimatedImpact).toBe('medium');
    expect(orders!.suggestedSQL).toBe('CREATE INDEX idx_orders_status ON orders(status);');

    // Only the high-impact suggestion surfaces an issue.
    expect(env.issues).toContain('High-impact index missing on users(created_at, email)');
    expect(env.issues.length).toBe(1);
  });

  it('get_database_connections returns an empty list (Node ConnectionManager is never fed)', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const { envelope } = await mcp.callTool('get_database_connections', {});
    const env = envelope as { summary: string; data: unknown[]; metadata: { eventCount: number } };
    expect(Array.isArray(env.data)).toBe(true);
    expect(env.data.length).toBe(0);
    expect(env.summary).toBe('0 database connection(s) configured.');
    expect(env.metadata.eventCount).toBe(0);
  });

  it('get_schema_map reports "no connections configured" (data:null) with its guidance issue', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const { envelope } = await mcp.callTool('get_schema_map', {});
    const env = envelope as { summary: string; data: unknown; issues: string[] };
    expect(env.data).toBeNull();
    expect(env.summary).toBe('No database connections configured.');
    expect(env.issues).toContain("Configure a database connection in your project's infrastructure config.");
  });

  it('get_table_data reports "no connections configured" (data:null) with its own issue text', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const { envelope } = await mcp.callTool('get_table_data', { table: 'users' });
    const env = envelope as { summary: string; data: unknown; issues: string[] };
    expect(env.data).toBeNull();
    expect(env.summary).toBe('No database connections configured.');
    // Note: get_table_data's issue text differs from get_schema_map's.
    expect(env.issues).toContain('Configure a database connection.');
  });
});
