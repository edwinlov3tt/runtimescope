/**
 * Conformance: the /api/pm/* WRITE surface of the pm/ subsystem against Node.
 *
 * M5 fast-follow (capex-and-write-crud). Driven over the MCP server's EMBEDDED
 * HTTP port (both Node and Rust wire pmStore there). The harness's temp HOME has
 * a fresh pm.db with only the auto-created "Personal" (default) workspace, and
 * auth is disabled — which Node treats as the admin/local-trust caller
 * (`isAdmin = !authEnabled`), so the admin-gated create/delete-workspace routes
 * pass exactly as in Rust's auth-disabled path.
 *
 * Deterministic cases (Node and Rust must agree):
 *   - POST   /api/pm/workspaces            → 201, slug derived, GET now shows 2
 *   - DELETE /api/pm/workspaces/{created}  → { ok: true }, GET back to 1
 *   - DELETE /api/pm/workspaces/{default}  → 400 "Cannot delete the default workspace"
 *   - POST   /api/pm/workspaces/{id}/api-keys → 201 with a tk_ secret (once)
 *
 * The capex-stub side of this work item is gated by the pm_store Rust unit test
 * (it requires a populated ~/.claude/projects to exercise over HTTP, which the
 * read-conformance file already documents as out-of-band).
 *
 * Authored green-vs-Node first (run with no RUNTIMESCOPE_*_CMD); confirm vs the
 * Rust binaries by pointing RUNTIMESCOPE_COLLECTOR_CMD/RUNTIMESCOPE_MCP_CMD at
 * target/debug/*.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const WS_ID = /^ws_[0-9a-f]{16}$/; // generateWorkspaceId(): ws_ + 8 bytes hex

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

interface Ws { id: string; name: string; slug: string; description?: string; isDefault: boolean; createdAt: number }

async function listWorkspaces(base: string): Promise<Ws[]> {
  const r = await fetch(`${base}/api/pm/workspaces`);
  expect(r.status).toBe(200);
  return (await r.json() as { data: Ws[] }).data;
}

describe('pm/ HTTP write routes (Node)', () => {
  it('POST /api/pm/workspaces creates one (slug derived) and GET shows 2', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);

    // Fresh install → only the default Personal workspace.
    const before = await listWorkspaces(base);
    expect(before.length).toBe(1);
    expect(before[0].slug).toBe('personal');
    expect(before[0].isDefault).toBe(true);

    const res = await fetch(`${base}/api/pm/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Work Stuff' }),
    });
    expect(res.status).toBe(201);
    const ws = await res.json() as Ws;
    expect(ws.id).toMatch(WS_ID);
    expect(ws.name).toBe('Work Stuff');
    expect(ws.slug).toBe('work-stuff'); // lowercase, non-alnum → '-', collapsed/trimmed
    expect(ws.isDefault).toBe(false);

    const after = await listWorkspaces(base);
    expect(after.length).toBe(2);
    const created = after.find((w) => w.slug === 'work-stuff');
    expect(created).toBeTruthy();
    expect(created!.id).toBe(ws.id);
    expect(created!.isDefault).toBe(false);
  });

  it('DELETE /api/pm/workspaces/{id} removes a created workspace', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);

    const createRes = await fetch(`${base}/api/pm/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Temp WS' }),
    });
    expect(createRes.status).toBe(201);
    const ws = await createRes.json() as Ws;
    expect((await listWorkspaces(base)).length).toBe(2);

    const delRes = await fetch(`${base}/api/pm/workspaces/${ws.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });

    const after = await listWorkspaces(base);
    expect(after.length).toBe(1);
    expect(after[0].isDefault).toBe(true);
  });

  it('DELETE /api/pm/workspaces/{default} → 400 (cannot delete the default)', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);

    const [personal] = await listWorkspaces(base);
    expect(personal.isDefault).toBe(true);

    const res = await fetch(`${base}/api/pm/workspaces/${personal.id}`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Cannot delete the default workspace');

    // Still there.
    expect((await listWorkspaces(base)).length).toBe(1);
  });

  it('POST /api/pm/workspaces/{id}/api-keys returns a tk_ key once', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);

    const [personal] = await listWorkspaces(base);

    const res = await fetch(`${base}/api/pm/workspaces/${personal.id}/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'CI server' }),
    });
    expect(res.status).toBe(201);
    const key = await res.json() as { key: string; keyPrefix: string; keyLast4: string; workspaceId: string; label: string };

    // Raw secret: "tk_" + 24 bytes hex (48 chars). Returned exactly once.
    expect(key.key).toMatch(/^tk_[0-9a-f]{48}$/);
    expect(key.keyPrefix).toBe(key.key.slice(0, 11)); // "tk_" + 8 hex
    expect(key.keyPrefix).toMatch(/^tk_[0-9a-f]{8}$/);
    expect(key.keyLast4).toBe(key.key.slice(-4));
    expect(key.workspaceId).toBe(personal.id);
    expect(key.label).toBe('CI server');
  });

  it('POST /api/pm/workspaces/{id}/api-keys → 404 for an unknown workspace', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const base = await pmBase(mcp);

    const res = await fetch(`${base}/api/pm/workspaces/ws_doesnotexist/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Workspace not found');
  });
});
