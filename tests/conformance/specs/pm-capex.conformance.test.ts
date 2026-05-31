/**
 * Conformance: the /api/pm/capex* + /api/pm/categories surface (M5.5 Slice A)
 * against Node. Driven over the MCP server's EMBEDDED HTTP port; the harness's
 * temp HOME has a fresh pm.db with NO discovered projects/sessions/capex entries
 * (HOME → `<temp>/.claude` + `<temp>/.runtimescope` are both empty), so this file
 * pins the EMPTY-STATE + degenerate-write shapes that Node and Rust must agree on:
 *
 *   - GET  /api/pm/categories                       → { data: [] }
 *   - GET  /api/pm/capex/{id}                        → { data: [], count: 0 } (+ ?confirmed)
 *   - GET  /api/pm/capex/{id}/summary                → all-zero summary, period omitted
 *   - GET  /api/pm/capex/{id}/summary?start_date=    → period: { start, end:'' } present
 *   - GET  /api/pm/capex-all                         → zero summary, [] byProject/entries
 *   - GET  /api/pm/capex/{id}/export                 → 200 text/csv, header row, attachment
 *   - POST /api/pm/capex/{id}/{entry}/confirm        → { ok: true } (no-op on empty)
 *   - PUT  /api/pm/capex/{id}/{entry}  (no body)     → 400 "Body required"
 *   - PUT  /api/pm/capex/{id}/{entry}  (with body)   → { ok: true }
 *
 * The POPULATED aggregation (byProject math, summary sums, CSV rows, confirm/
 * update side-effects, confirmed-preservation) is gated by the collector-core
 * pm_store unit tests — it requires a seeded ~/.claude/projects the harness can't
 * provide over HTTP (same split the read/write specs already document).
 *
 * Authored green-vs-Node first (no RUNTIMESCOPE_*_CMD); confirm vs Rust by pointing
 * RUNTIMESCOPE_COLLECTOR_CMD / RUNTIMESCOPE_MCP_CMD at target/debug/*.
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

describe('pm/ capex + categories HTTP routes (Node)', () => {
  it('GET /api/pm/categories → { data: [] } on a fresh install', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/categories`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: [] });
  });

  it('GET /api/pm/capex/{id} → empty list+count, and respects ?confirmed', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/capex/proj-x`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: [], count: 0 });

    for (const c of ['1', '0', 'bogus']) {
      const rc = await fetch(`${base}/api/pm/capex/proj-x?confirmed=${c}`);
      expect(rc.status).toBe(200);
      expect(await rc.json()).toEqual({ data: [], count: 0 });
    }
  });

  it('GET /api/pm/capex/{id}/summary → zero summary, period omitted (no filter)', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/capex/proj-x/summary`);
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body).toEqual({
      projectId: 'proj-x',
      totalSessions: 0,
      totalActiveMinutes: 0,
      totalCostMicrodollars: 0,
      capitalizableCostMicrodollars: 0,
      expensedCostMicrodollars: 0,
      confirmedCount: 0,
      unconfirmedCount: 0,
      byMonth: [],
    });
    expect('period' in body).toBe(false); // undefined → omitted in JSON
  });

  it('GET /api/pm/capex/{id}/summary?start_date= → period { start, end:"" } present', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/capex/proj-x/summary?start_date=2020-01-01`);
    expect(r.status).toBe(200);
    const body = await r.json() as { period?: { start: string; end: string } };
    expect(body.period).toEqual({ start: '2020-01-01', end: '' });
  });

  it('GET /api/pm/capex-all → zero summary + empty byProject/entries', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/capex-all`);
    expect(r.status).toBe(200);
    const body = await r.json() as { data: { summary: Record<string, unknown>; byProject: unknown[]; entries: unknown[] } };
    expect(body.data.byProject).toEqual([]);
    expect(body.data.entries).toEqual([]);
    expect(body.data.summary).toEqual({
      totalCost: 0,
      capitalizable: 0,
      expensed: 0,
      activeMinutes: 0,
      activeHours: 0,
      confirmed: 0,
      unconfirmed: 0,
      projectCount: 0,
    });
  });

  it('GET /api/pm/capex/{id}/export → 200 text/csv with the header row + attachment', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/capex/proj-x/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="capex-proj-x.csv"');
    const text = await r.text();
    // Node quotes only data rows; the header row is unquoted (headers.join(',')).
    expect(text).toBe(
      'Period,Session ID,Session Slug,Date,Model,' +
      'Active Minutes,Active Hours,Cost (USD),Classification,Work Type,' +
      'Adjustment Factor,Adjusted Cost (USD),Confirmed,Confirmed By,Notes',
    );
  });

  it('POST /api/pm/capex/{id}/{entry}/confirm → { ok: true } (no-op on empty)', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/capex/proj-x/capex-nope/confirm`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('PUT /api/pm/capex/{id}/{entry} → 400 without a body, { ok: true } with one', async () => {
    const base = await up();

    const noBody = await fetch(`${base}/api/pm/capex/proj-x/capex-nope`, { method: 'PUT' });
    expect(noBody.status).toBe(400);
    expect((await noBody.json() as { error: string }).error).toBe('Body required');

    const withBody = await fetch(`${base}/api/pm/capex/proj-x/capex-nope`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classification: 'capitalizable', notes: 'x' }),
    });
    expect(withBody.status).toBe(200);
    expect(await withBody.json()).toEqual({ ok: true });
  });
});
