/**
 * Conformance: MCP tool OUTPUT SHAPES + FILTERS (get_network_requests).
 *
 * The legacy gate asserted tool COUNTS and field EXISTENCE — it never pinned the
 * reshaping the MCP layer applies on top of the raw event store, nor that the
 * tool-level filters actually filter. So a port could return raw rows (numeric
 * `duration`, epoch `timestamp`), drop the derived `issues`, or ignore the
 * `method`/`status` arguments and still pass. This spec locks the REAL contract
 * of get_network_requests as implemented by Node.
 *
 * Source of truth: packages/mcp-server/src/tools/network.ts
 *   - filters: method (case-insensitive) + status (exact) applied via the store
 *   - data[]: duration -> "<n>ms" string, ttfb -> "<n>ms" string,
 *             timestamp -> ISO-8601 string (new Date(ts).toISOString())
 *   - issues[]: "<k> failed request(s) (4xx/5xx)" when any status >= 400,
 *               "<k> slow request(s) (>3s)" when any duration > 3000
 *   - metadata.timeRange: { from, to } derived from the filtered set
 *
 * Drives the real mcp-server over stdio (RUNTIMESCOPE_MCP_CMD swaps the Rust bin
 * later). Events are fed through the embedded collector via an SdkDriver on the
 * MCP server's WS port — the exact path Claude Code uses.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver, SdkDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const PROJECT = 'proj_conf_tool_shapes';

/** A network event with explicit method/status/duration so we can target filters. */
function netEvent(
  sessionId: string,
  i: number,
  opts: { method: string; status: number; duration: number; ttfb: number; url: string },
): object {
  return {
    eventId: `evt-shape-${i}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'network',
    url: opts.url,
    method: opts.method,
    status: opts.status,
    requestHeaders: {},
    responseHeaders: { 'content-type': 'application/json' },
    requestBodySize: 0,
    responseBodySize: 256,
    duration: opts.duration,
    ttfb: opts.ttfb,
    source: 'conformance',
  };
}

describe('MCP tool output shapes + filters (get_network_requests)', () => {
  it('filters by method+status, reshapes rows, and derives issues + timeRange', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();

    const driver = new SdkDriver({ wsPort: mcp.wsPort, appName: 'conf-shapes', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 150));

    // Four distinct rows. Only the POST/500 row matches { method:'POST', status:500 }.
    // That matching row is ALSO slow (duration > 3000) so the filtered set must
    // produce BOTH a failed-request and a slow-request issue. The non-matching
    // rows (GET/200, POST/200, GET/500) must be excluded by the filter.
    driver.sendBatch([
      netEvent(driver.sessionId, 1, { method: 'GET',  status: 200, duration: 42,   ttfb: 7,   url: 'https://example.com/api/users' }),
      netEvent(driver.sessionId, 2, { method: 'POST', status: 200, duration: 88,   ttfb: 12,  url: 'https://example.com/api/login' }),
      netEvent(driver.sessionId, 3, { method: 'GET',  status: 500, duration: 30,   ttfb: 5,   url: 'https://example.com/api/boom' }),
      netEvent(driver.sessionId, 4, { method: 'POST', status: 500, duration: 4200, ttfb: 1500, url: 'https://example.com/api/orders' }),
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp.callTool('get_network_requests', {
      project_id: PROJECT,
      method: 'POST',
      status: 500,
    });

    const env = envelope as {
      summary: string;
      data: Array<{
        url: string;
        method: string;
        status: number;
        duration: unknown;
        ttfb: unknown;
        timestamp: unknown;
        responseBodySize: number;
        graphqlOperation: unknown;
      }>;
      issues: string[];
      metadata: { timeRange: { from: number; to: number }; eventCount: number; totalCount: number };
    };

    // --- FILTER: only the matching row is returned, others excluded ---
    expect(env.data.length).toBe(1);
    const row = env.data[0];
    expect(row.method).toBe('POST');
    expect(row.status).toBe(500);
    expect(row.url).toBe('https://example.com/api/orders');
    // Non-matching rows must NOT leak through.
    expect(env.data.some((d) => d.status === 200)).toBe(false);
    expect(env.data.some((d) => d.method === 'GET')).toBe(false);
    expect(env.metadata.eventCount).toBe(1);

    // --- RESHAPING (per network.ts) ---
    // duration -> "<n>ms" string (n = duration.toFixed(0))
    expect(typeof row.duration).toBe('string');
    expect(row.duration).toBe('4200ms');
    // ttfb -> "<n>ms" string
    expect(typeof row.ttfb).toBe('string');
    expect(row.ttfb).toBe('1500ms');
    // timestamp -> ISO-8601 string (round-trips to a valid Date)
    expect(typeof row.timestamp).toBe('string');
    expect(row.timestamp as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(row.timestamp as string))).toBe(false);
    // graphqlOperation defaults to null (not undefined) for a plain REST call.
    expect(row.graphqlOperation).toBeNull();

    // --- ISSUES: derived, not raw ---
    expect(Array.isArray(env.issues)).toBe(true);
    // Exactly one row in the filtered set is 4xx/5xx -> "1 failed request(s) (4xx/5xx)".
    expect(env.issues).toContain('1 failed request(s) (4xx/5xx)');
    // That same row is > 3000ms -> "1 slow request(s) (>3s)".
    expect(env.issues).toContain('1 slow request(s) (>3s)');

    // --- METADATA.timeRange present and derived from the filtered set ---
    expect(env.metadata.timeRange).toBeTruthy();
    expect(typeof env.metadata.timeRange.from).toBe('number');
    expect(typeof env.metadata.timeRange.to).toBe('number');
    // Single matching row => from === to === that row's epoch ms.
    expect(env.metadata.timeRange.from).toBe(env.metadata.timeRange.to);
    expect(env.metadata.timeRange.from).toBe(Date.parse(row.timestamp as string));

    await driver.close();
  });
});
