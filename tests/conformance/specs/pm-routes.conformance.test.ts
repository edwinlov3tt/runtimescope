/**
 * Conformance: the /api/pm/* HTTP surface of the pm/ subsystem against Node.
 *
 * M5. Driven over the MCP server's EMBEDDED HTTP port (both Node and Rust wire
 * pmStore there). The harness's temp HOME has no ~/.claude/projects + a fresh
 * pm.db, so discovery is a no-op and these shapes are deterministic:
 *   - GET  /api/pm/workspaces → { data: [Personal] }
 *   - GET  /api/pm/projects   → { data: [], count: 0 }
 *   - GET  /api/pm/sessions   → { data: [], count: 0, total: 0 }
 *   - POST /api/pm/discover   → DiscoveryResult, all zero
 *   - GET  /api/pm/{projects,sessions}/<unknown> → 404 with the right error.
 *
 * The over-discovery FILTER itself can't be gated here (it diverges from Node +
 * needs a populated ~/.claude/projects) — it's covered by the pm_discovery Rust
 * unit tests. This locks the route shapes (where Node and Rust agree on empty HOME).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

/** Wait for the embedded HTTP server to answer /readyz, then return the base URL. */
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

describe('pm/ HTTP routes (Node)', () => {
  it('GET /api/pm/workspaces returns the Personal workspace', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);
    const res = await fetch(`${base}/api/pm/workspaces`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ name: string; slug: string; isDefault: boolean; createdAt: number }> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('Personal');
    expect(body.data[0].slug).toBe('personal');
    expect(body.data[0].isDefault).toBe(true);
    expect(typeof body.data[0].createdAt).toBe('number');
  });

  it('GET /api/pm/projects is empty on a fresh install', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);
    const res = await fetch(`${base}/api/pm/projects`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; count: number };
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('GET /api/pm/sessions is empty on a fresh install', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);
    const res = await fetch(`${base}/api/pm/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; count: number; total: number };
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.total).toBe(0);
  });

  it('POST /api/pm/discover returns an all-zero result on an empty HOME', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);
    const res = await fetch(`${base}/api/pm/discover`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      projectsDiscovered: number; projectsUpdated: number;
      sessionsDiscovered: number; sessionsUpdated: number; errors: string[];
    };
    expect(body.projectsDiscovered).toBe(0);
    expect(body.projectsUpdated).toBe(0);
    expect(body.sessionsDiscovered).toBe(0);
    expect(body.sessionsUpdated).toBe(0);
    expect(body.errors).toEqual([]);
  });

  it('GET /api/pm/projects/<unknown> → 404', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);
    const res = await fetch(`${base}/api/pm/projects/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Project not found');
  });

  it('GET /api/pm/sessions/<unknown> → 404', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);
    const res = await fetch(`${base}/api/pm/sessions/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Session not found');
  });
});
