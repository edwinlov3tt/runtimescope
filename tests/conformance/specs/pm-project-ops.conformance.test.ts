/**
 * Conformance: the /api/pm/projects/summaries, /api/pm/projects/export-csv,
 * /api/pm/sessions/stats and /api/pm/sessions/{id}/refresh surface (M5.5 Slice E)
 * against Node, over the MCP server's EMBEDDED HTTP port. The harness's temp HOME
 * has no discovered projects/sessions, so these pin the empty-state shapes both
 * runtimes must agree on:
 *
 *   - GET  /api/pm/projects/summaries     → { data: [], count: 0 }
 *   - GET  /api/pm/sessions/stats         → zeroed stats incl. avgSessionMinutes + modelBreakdown:[]
 *   - GET  /api/pm/projects/export-csv    → 200 text/csv, the two-section header body, dated filename
 *   - POST /api/pm/sessions/{id}/refresh  → 404 "Session not found"
 *
 * The sessions/stats shape is the load-bearing one: it gates the SessionStats fix
 * (Node names the field `avgSessionMinutes`, NOT `avgActiveMinutes`, and includes
 * a `modelBreakdown` array — the M5 read port had both wrong, unnoticed because
 * the only stats path exercised then was a 404). Populated aggregation (real
 * summaries/CSV rows/model breakdown) is covered by pm_store unit tests.
 *
 * Authored green-vs-Node first; confirm vs Rust via RUNTIMESCOPE_*_CMD.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

async function pmBase(m: McpDriver): Promise<string> {
  const base = `http://127.0.0.1:${m.httpPort}`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/readyz`);
      if (r.ok) return base;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 50));
  }
  return base;
}
async function up(): Promise<string> {
  mcp = McpDriver.spawn();
  await mcp.ready();
  return pmBase(mcp);
}

describe('pm/ project + session ops HTTP routes (Node)', () => {
  it('GET /api/pm/projects/summaries → empty on a fresh db', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/projects/summaries`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: [], count: 0 });
  });

  it('GET /api/pm/sessions/stats → zeroed stats with avgSessionMinutes + modelBreakdown', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/sessions/stats`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      totalSessions: 0,
      totalActiveMinutes: 0,
      totalCostMicrodollars: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      avgSessionMinutes: 0,
      modelBreakdown: [],
    });
  });

  it('GET /api/pm/projects/export-csv → 200 text/csv, two-section header body, dated filename', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/projects/export-csv`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="runtimescope-export-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = await r.text();
    expect(text).toBe(
      '=== PROJECTS ===\n' +
      'Project,Category,Sessions,Messages,Cost ($),Active Time (min),Last Session\n' +
      '\n' +
      '=== SESSIONS ===\n' +
      'Project,Session ID,Slug,Model,Date,Messages,Tokens In,Tokens Out,Cost ($),Active Time (min),Branch',
    );
  });

  it('POST /api/pm/sessions/{id}/refresh → 404 for an unknown session', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/sessions/sess-nope/refresh`, { method: 'POST' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'Session not found' });
  });

  it('GET /api/pm/projects/{id}/scripts → 404 for an unknown project (M5.5 Slice G)', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/projects/proj-x/scripts`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'Project not found' });
  });
});
