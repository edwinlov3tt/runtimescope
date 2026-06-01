/**
 * Conformance: the /api/pm/projects/{id}/dev-server surface (M5.5 Slice G,
 * steps 2-4) against Node, over the MCP server's EMBEDDED HTTP port. The
 * harness's temp HOME has an empty pm.db and NO discovered projects, so over
 * HTTP every route hits the no-project / no-managed-proc branch — that's the
 * deterministic surface pinned here:
 *
 *   - GET    → {data:{status:"stopped"}} 200   (no managed proc for any id)
 *   - POST   → 404 {error:"Project not found"} (project resolved first)
 *   - DELETE → 404 {error:"Project not found"} (project resolved first)
 *
 * The 400-no-path / 409-already-running / success paths need a real project the
 * harness can't seed, AND the full spawn→detect→group-kill lifecycle (the "no
 * gaps" proof) — both live in collector-core integration tests against real
 * processes, NOT here. The group-kill is an intended divergence from Node's
 * orphaning bug and is deliberately NOT conformance-gated.
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

describe('pm/ dev-server HTTP routes (Node)', () => {
  it('GET → {data:{status:"stopped"}} when no dev server is managed', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/projects/proj-x/dev-server`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { status: 'stopped' } });
  });

  it('POST → 404 "Project not found" for an unknown project', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/projects/proj-x/dev-server`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: 'dev' }),
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'Project not found' });
  });

  it('POST → 404 "Project not found" even with no body', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/projects/proj-x/dev-server`, { method: 'POST' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'Project not found' });
  });

  it('DELETE → 404 "Project not found" for an unknown project', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/projects/proj-x/dev-server`, { method: 'DELETE' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'Project not found' });
  });

  it('DELETE → 404 "Project not found" even with a SIGKILL body', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/projects/proj-x/dev-server`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signal: 'SIGKILL' }),
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'Project not found' });
  });
});
