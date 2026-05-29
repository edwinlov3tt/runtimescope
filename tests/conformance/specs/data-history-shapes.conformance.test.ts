/**
 * Conformance: OUTPUT SHAPE of the DATA + HISTORY tool family against Node.
 *
 * Audit 0002 #2: ~57 MCP tools were ported and compiled but never behavior-
 * verified. The legacy gate asserted tool COUNTS / field EXISTENCE — it never
 * pinned the reshaping the MCP layer applies on top of the raw store, nor that
 * the derived fields (issues, per-type counts, HAR structure, time ranges) are
 * actually computed. A port could return raw rows (numeric `duration`, epoch
 * `timestamp`), drop the HAR envelope, or skip issue derivation and still pass.
 *
 * This spec locks the REAL contract of seven tools as implemented by Node:
 *   - get_query_log            packages/mcp-server/src/tools/database.ts
 *   - get_query_performance    packages/mcp-server/src/tools/database.ts
 *   - capture_har              packages/mcp-server/src/tools/har.ts
 *   - runtime_qa_check         packages/mcp-server/src/tools/qa-check.ts
 *   - get_historical_events    packages/mcp-server/src/tools/history.ts
 *   - list_projects            packages/mcp-server/src/tools/history.ts
 *   - get_session_history      packages/mcp-server/src/tools/session-diff.ts
 *
 * Drives the real mcp-server over stdio (RUNTIMESCOPE_MCP_CMD swaps the Rust bin
 * later). Events are fed through the embedded collector via an SdkDriver on the
 * MCP server's WS port — the exact path Claude Code uses. The embedded collector
 * opens a per-project (= appName) SQLite store + persists events on connect, so
 * the history/session tools read back through real persistence.
 *
 * NOTE on ordering: get_session_history (and get_historical_events for the
 * session metrics path) only surface a session once it has a persisted
 * snapshot. runtime_qa_check creates that snapshot, so we call it BEFORE the
 * history tools — mirroring the real flow.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver, SdkDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const PROJECT = 'proj_conf_data_history';
const APP = 'conf-data-history';

/** A database event matching DatabaseEvent in collector/src/types.ts. */
function dbEvent(
  sessionId: string,
  i: number,
  opts: {
    query: string;
    normalizedQuery: string;
    duration: number;
    operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';
    tablesAccessed: string[];
    source: string;
    rowsReturned?: number;
    error?: string;
  },
): object {
  return {
    eventId: `evt-db-${i}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'database',
    query: opts.query,
    normalizedQuery: opts.normalizedQuery,
    duration: opts.duration,
    operation: opts.operation,
    tablesAccessed: opts.tablesAccessed,
    source: opts.source,
    ...(opts.rowsReturned != null ? { rowsReturned: opts.rowsReturned } : {}),
    ...(opts.error ? { error: opts.error } : {}),
  };
}

function netEvent(
  sessionId: string,
  i: number,
  opts: { method: string; status: number; duration: number; ttfb: number; url: string },
): object {
  return {
    eventId: `evt-net-${i}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'network',
    url: opts.url,
    method: opts.method,
    status: opts.status,
    requestHeaders: { 'x-test': 'rs' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBodySize: 0,
    responseBodySize: 256,
    duration: opts.duration,
    ttfb: opts.ttfb,
    source: 'conformance',
  };
}

function consoleEvent(sessionId: string, i: number, level: string, message: string): object {
  return {
    eventId: `evt-con-${i}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'console',
    level,
    message,
    args: [],
  };
}

describe('MCP data + history tool output shapes (Node)', () => {
  it('reshapes DB events, builds HAR 1.2, aggregates QA counts, and reads back history', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();

    const driver = new SdkDriver({ wsPort: mcp.wsPort, appName: APP, projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 150));

    // 3 DB events: one slow (>500ms) on users, one error on orders, one fast.
    // 2 network events: a 200 GET and a 500 POST.
    // 2 console events: one log, one error.
    driver.sendBatch([
      dbEvent(driver.sessionId, 1, {
        query: 'SELECT * FROM users WHERE id = 1',
        normalizedQuery: 'SELECT * FROM users WHERE id = ?',
        duration: 750, operation: 'SELECT', tablesAccessed: ['users'], source: 'prisma',
        rowsReturned: 1,
      }),
      dbEvent(driver.sessionId, 2, {
        query: 'INSERT INTO orders (total) VALUES (10)',
        normalizedQuery: 'INSERT INTO orders (total) VALUES (?)',
        duration: 12, operation: 'INSERT', tablesAccessed: ['orders'], source: 'pg',
        error: 'duplicate key value violates unique constraint',
      }),
      dbEvent(driver.sessionId, 3, {
        query: 'SELECT name FROM products LIMIT 10',
        normalizedQuery: 'SELECT name FROM products LIMIT ?',
        duration: 8, operation: 'SELECT', tablesAccessed: ['products'], source: 'drizzle',
        rowsReturned: 10,
      }),
      netEvent(driver.sessionId, 4, { method: 'GET',  status: 200, duration: 42,  ttfb: 7,  url: 'https://example.com/api/users?page=2' }),
      netEvent(driver.sessionId, 5, { method: 'POST', status: 500, duration: 130, ttfb: 30, url: 'https://example.com/api/orders' }),
      consoleEvent(driver.sessionId, 6, 'log', 'rendered'),
      consoleEvent(driver.sessionId, 7, 'error', 'boom'),
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    // ---------------------------------------------------------------------
    // get_query_log — reshapes DatabaseEvent rows + derives issues.
    // ---------------------------------------------------------------------
    {
      const { envelope } = await mcp.callTool('get_query_log', { project_id: PROJECT });
      const env = envelope as {
        summary: string;
        data: Array<{
          query: string; normalizedQuery: string; duration: unknown; operation: string;
          tables: unknown; source: string; rowsReturned: unknown; rowsAffected: unknown;
          error: unknown; label: unknown; timestamp: unknown;
        }>;
        issues: string[];
        metadata: { eventCount: number; timeRange: { from: number; to: number }; projectId: unknown };
      };

      expect(env.data.length).toBe(3);
      expect(env.metadata.eventCount).toBe(3);
      expect(env.metadata.projectId).toBe(PROJECT);

      // Reshaping: duration -> "<n>ms" string (NOT raw number).
      const usersRow = env.data.find((d) => Array.isArray(d.tables) && (d.tables as string[]).includes('users'));
      expect(usersRow).toBeTruthy();
      expect(typeof usersRow!.duration).toBe('string');
      expect(usersRow!.duration).toBe('750ms');
      // tables is the renamed projection of tablesAccessed.
      expect(usersRow!.tables).toEqual(['users']);
      expect(usersRow!.source).toBe('prisma');
      expect(usersRow!.operation).toBe('SELECT');
      expect(usersRow!.rowsReturned).toBe(1);
      // rowsAffected absent on the event -> null (not undefined).
      expect(usersRow!.rowsAffected).toBeNull();
      // label absent -> null.
      expect(usersRow!.label).toBeNull();
      // timestamp -> ISO-8601 string.
      expect(typeof usersRow!.timestamp).toBe('string');
      expect(usersRow!.timestamp as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // The error row keeps its error string; non-error rows are null.
      const ordersRow = env.data.find((d) => Array.isArray(d.tables) && (d.tables as string[]).includes('orders'));
      expect(ordersRow!.error).toBe('duplicate key value violates unique constraint');
      expect(usersRow!.error).toBeNull();

      // Derived issues: 1 error + 1 slow (>500ms, only the 750ms row qualifies).
      expect(env.issues).toContain('1 query error(s)');
      expect(env.issues).toContain('1 slow query/queries (>500ms)');
    }

    // ---------------------------------------------------------------------
    // get_query_performance — aggregates per normalized pattern.
    // ---------------------------------------------------------------------
    {
      const { envelope } = await mcp.callTool('get_query_performance', { project_id: PROJECT });
      const env = envelope as {
        summary: string;
        data: {
          queryStats: Array<{
            pattern: string; tables: unknown; operation: string; callCount: number;
            avgDuration: unknown; maxDuration: unknown; p95Duration: unknown;
            totalDuration: unknown; avgRows: unknown;
          }>;
          detectedIssues: unknown[];
        };
        issues: string[];
        metadata: { eventCount: number };
      };

      // 3 events -> 3 distinct normalized patterns.
      expect(env.metadata.eventCount).toBe(3);
      expect(Array.isArray(env.data.queryStats)).toBe(true);
      expect(env.data.queryStats.length).toBe(3);

      const usersStat = env.data.queryStats.find((s) => s.pattern.includes('users'));
      expect(usersStat).toBeTruthy();
      expect(usersStat!.callCount).toBe(1);
      expect(usersStat!.operation).toBe('SELECT');
      // Aggregates reshaped to "<n>ms" strings.
      expect(typeof usersStat!.avgDuration).toBe('string');
      expect(usersStat!.avgDuration).toBe('750ms');
      expect(usersStat!.maxDuration).toBe('750ms');
      expect(typeof usersStat!.p95Duration).toBe('string');
      expect(typeof usersStat!.totalDuration).toBe('string');
      // avgRows is a (string) numeric for the SELECT that returned 1 row.
      expect(usersStat!.avgRows).toBe('1');

      expect(Array.isArray(env.data.detectedIssues)).toBe(true);
      expect(Array.isArray(env.issues)).toBe(true);
    }

    // ---------------------------------------------------------------------
    // capture_har — HAR 1.2 archive built from network events.
    // ---------------------------------------------------------------------
    {
      const { envelope } = await mcp.callTool('capture_har', { project_id: PROJECT });
      const env = envelope as {
        summary: string;
        data: {
          log: {
            version: string;
            creator: { name: string; version: string };
            entries: Array<{
              startedDateTime: unknown;
              time: unknown;
              request: {
                method: string; url: string; httpVersion: string;
                headers: Array<{ name: string; value: string }>;
                queryString: Array<{ name: string; value: string }>;
                headersSize: number; bodySize: number;
              };
              response: {
                status: number; statusText: string; httpVersion: string;
                headers: Array<{ name: string; value: string }>;
                content: { size: number; mimeType: string };
                headersSize: number; bodySize: number;
              };
              timings: { send: number; wait: number; receive: number };
            }>;
          };
        };
        metadata: { eventCount: number; totalCount: number };
      };

      // HAR envelope shape.
      expect(env.data.log.version).toBe('1.2');
      expect(env.data.log.creator.name).toBe('RuntimeScope');
      expect(typeof env.data.log.creator.version).toBe('string');

      // 2 network events -> 2 HAR entries.
      expect(env.data.log.entries.length).toBe(2);
      expect(env.metadata.eventCount).toBe(2);

      // The 500 POST entry — fully reshaped into HAR fields.
      const post = env.data.log.entries.find((e) => e.request.method === 'POST');
      expect(post).toBeTruthy();
      expect(post!.request.url).toBe('https://example.com/api/orders');
      expect(post!.request.httpVersion).toBe('HTTP/1.1');
      expect(post!.request.headersSize).toBe(-1);
      // Request headers projected to {name,value} pairs.
      expect(post!.request.headers).toContainEqual({ name: 'x-test', value: 'rs' });
      expect(post!.response.status).toBe(500);
      // statusText derived from the status code.
      expect(post!.response.statusText).toBe('Internal Server Error');
      expect(post!.response.content.mimeType).toBe('application/json');
      expect(post!.response.content.size).toBe(256);
      // timings derived: wait = round(ttfb), receive = round(duration - ttfb).
      expect(post!.timings.wait).toBe(30);
      expect(post!.timings.receive).toBe(100);
      expect(typeof post!.time).toBe('number');
      // startedDateTime is an ISO-8601 string.
      expect(post!.startedDateTime as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // The GET entry parses queryString from the URL (?page=2).
      const get = env.data.log.entries.find((e) => e.request.method === 'GET');
      expect(get!.request.queryString).toContainEqual({ name: 'page', value: '2' });
      expect(get!.response.statusText).toBe('OK');
    }

    // ---------------------------------------------------------------------
    // runtime_qa_check — snapshots the session + aggregates per-type counts.
    // MUST run before history tools so the session gets a persisted snapshot.
    // ---------------------------------------------------------------------
    {
      const { envelope } = await mcp.callTool('runtime_qa_check', { project_id: PROJECT, label: 'conf-baseline' });
      const env = envelope as {
        summary: string;
        data: {
          snapshot: {
            id: unknown; sessionId: string; project: string; label: unknown;
            createdAt: unknown;
            metrics: {
              totalEvents: number; errorCount: number; endpointCount: number;
              componentCount: number; webVitals: unknown; queryCount: number;
            };
          };
          issues: Array<{ severity: string; title: string }>;
          nextSteps: string;
        };
        issues: string[];
        metadata: { eventCount: number; sessionId: string; projectId: unknown };
      };

      expect(env.data.snapshot).toBeTruthy();
      expect(env.data.snapshot.sessionId).toBe(driver.sessionId);
      expect(env.data.snapshot.label).toBe('conf-baseline');
      expect(env.data.snapshot.createdAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const m = env.data.snapshot.metrics;
      // Aggregated count of ALL events for this session: the 7 injected events
      // PLUS the synthetic `session` connect event the collector records on
      // handshake = 8. (errorCount/queryCount below pin the per-type derivation
      // independently of the connect event.)
      expect(m.totalEvents).toBe(8);
      // errorCount = console errors (1) + network status>=400 (1) = 2.
      expect(m.errorCount).toBe(2);
      // queryCount = distinct normalized DB query patterns (3).
      expect(m.queryCount).toBe(3);
      // No render events -> 0 components; no Web Vitals object entries.
      expect(m.componentCount).toBe(0);
      expect(typeof m.webVitals).toBe('object');

      expect(env.metadata.eventCount).toBe(8);
      expect(env.metadata.sessionId).toBe(driver.sessionId);
      expect(env.metadata.projectId).toBe(PROJECT);
      expect(Array.isArray(env.data.issues)).toBe(true);
      expect(typeof env.data.nextSteps).toBe('string');
    }

    // ---------------------------------------------------------------------
    // get_historical_events — reads persisted events back from SQLite.
    // History tools key off the appName ("project"), not project_id.
    // ---------------------------------------------------------------------
    {
      const { envelope } = await mcp.callTool('get_historical_events', { project: APP });
      const env = envelope as {
        summary: string;
        data: {
          events: Array<{ eventType: string; sessionId: string; timestamp: number }>;
          pagination: { returned: number; total: number; limit: number; offset: number; hasMore: boolean };
        };
        issues: string[];
        metadata: { eventCount: number; timeRange: { from: number; to: number } };
      } | { data: null };

      // Persistence is enabled in the embedded collector -> data is present.
      expect(env.data, 'historical events present (SQLite persisted on connect)').toBeTruthy();
      const d = (env as { data: { events: Array<{ eventType: string }>; pagination: { returned: number; total: number; limit: number; offset: number; hasMore: boolean } } }).data;
      expect(Array.isArray(d.events)).toBe(true);
      // All 7 injected events PLUS the synthetic `session` connect event the
      // collector persists on handshake = 8.
      expect(d.events.length).toBe(8);
      expect(d.pagination.returned).toBe(8);
      expect(d.pagination.total).toBe(8);
      expect(d.pagination.hasMore).toBe(false);
      // Pagination defaults applied by the tool.
      expect(d.pagination.limit).toBe(200);
      expect(d.pagination.offset).toBe(0);
      // Persisted events carry the canonical eventType set.
      const types = new Set(d.events.map((e) => e.eventType));
      expect(types.has('database')).toBe(true);
      expect(types.has('network')).toBe(true);
      expect(types.has('console')).toBe(true);

      // event_types filter is honoured by the SQLite query.
      const { envelope: dbOnly } = await mcp.callTool('get_historical_events', {
        project: APP, event_types: ['database'],
      });
      const dbEnv = dbOnly as { data: { events: Array<{ eventType: string }>; pagination: { total: number } } };
      expect(dbEnv.data.events.length).toBe(3);
      expect(dbEnv.data.pagination.total).toBe(3);
      expect(dbEnv.data.events.every((e) => e.eventType === 'database')).toBe(true);
    }

    // ---------------------------------------------------------------------
    // list_projects — derives the project list from persistence.
    // ---------------------------------------------------------------------
    {
      const { envelope } = await mcp.callTool('list_projects', {});
      const env = envelope as {
        summary: string;
        data: Array<{
          name: string; eventCount: number; sessionCount: number;
          isConnected: boolean; projectId?: unknown; activeSessions?: number;
        }>;
        metadata: { eventCount: number };
      };

      expect(Array.isArray(env.data)).toBe(true);
      const proj = env.data.find((p) => p.name === APP);
      expect(proj, `list_projects derives "${APP}" from SQLite`).toBeTruthy();
      // The project has persisted events (7 injected + 1 session connect)
      // + at least one (live) session.
      expect(proj!.eventCount).toBe(8);
      expect(proj!.sessionCount).toBeGreaterThanOrEqual(1);
      expect(proj!.isConnected).toBe(true);
      // metadata.eventCount counts PROJECTS, not events.
      expect(env.metadata.eventCount).toBe(env.data.length);
    }

    // ---------------------------------------------------------------------
    // get_session_history — lists sessions (with metrics) for the project.
    // The runtime_qa_check snapshot above gives the live session metrics,
    // which is what getSessionHistory surfaces.
    // ---------------------------------------------------------------------
    {
      const { envelope } = await mcp.callTool('get_session_history', { project: APP });
      const env = envelope as {
        summary: string;
        data: Array<{
          sessionId: string; project: string; createdAt: unknown;
          totalEvents: number; errorCount: number;
          endpointCount: number; componentCount: number; buildMeta: unknown;
        }>;
        issues: string[];
        metadata: { eventCount: number; timeRange: { from: number; to: number } };
      };

      expect(Array.isArray(env.data)).toBe(true);
      const sess = env.data.find((s) => s.sessionId === driver.sessionId);
      expect(sess, 'session surfaced once it has a persisted snapshot').toBeTruthy();
      expect(sess!.project).toBe(APP);
      expect(sess!.createdAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // Metrics from the qa-check snapshot: 8 events (7 injected + session
      // connect), 2 errors.
      expect(sess!.totalEvents).toBe(8);
      expect(sess!.errorCount).toBe(2);
      // buildMeta not supplied in handshake -> null.
      expect(sess!.buildMeta).toBeNull();
      expect(env.metadata.eventCount).toBe(env.data.length);
    }

    await driver.close();
  });
});
