/**
 * Conformance: the /api/pm/memory* + /api/pm/rules* surface (M5.5 Slice D) against
 * Node, over the MCP server's EMBEDDED HTTP port. These routes are keyed on a
 * project that must exist in pm.db (memory also needs its claudeProjectKey), and
 * the harness's temp HOME has NO discovered projects — so every route hits its
 * no-project / invalid-scope branch, which is exactly what's pinned here:
 *
 *   - GET    /api/pm/memory/{id}             → { data: [], count: 0 } (no project)
 *   - GET    /api/pm/memory/{id}/{file}      → 404 "File not found"? no — "Project not found"
 *   - PUT    /api/pm/memory/{id}/{file}      → 404 "Project not found" (project checked before body)
 *   - DELETE /api/pm/memory/{id}/{file}      → 404 "Project not found"
 *   - GET    /api/pm/rules/{id}              → 404 "Project not found"
 *   - GET    /api/pm/rules/{id}/{bad}        → 400 "Invalid scope. Must be: global, project, or local"
 *   - GET    /api/pm/rules/{id}/global       → 404 "Project not found" (valid scope, no project)
 *   - PUT    /api/pm/rules/{id}/{bad}        → 400 "Invalid scope"
 *   - PUT    /api/pm/rules/{id}/global       → 404 "Project not found"
 *
 * The populated file-I/O paths (readdir/read/write under ~/.claude) require a
 * discovered project the harness can't seed over HTTP; they're covered by Rust
 * unit tests for the security-critical helpers (sanitize_filename, rules_paths).
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
async function err(base: string, method: string, path: string, body?: string): Promise<{ status: number; body: { error?: string } }> {
  const init: RequestInit = { method };
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = body; }
  const r = await fetch(`${base}${path}`, init);
  return { status: r.status, body: await r.json() as { error?: string } };
}

describe('pm/ memory + rules HTTP routes (Node)', () => {
  it('GET /api/pm/memory/{id} → empty list when the project is unknown', async () => {
    const base = await up();
    const r = await fetch(`${base}/api/pm/memory/proj-x`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: [], count: 0 });
  });

  it('memory single-file routes → 404 "Project not found" for an unknown project', async () => {
    const base = await up();
    expect(await err(base, 'GET', '/api/pm/memory/proj-x/notes.md')).toEqual({ status: 404, body: { error: 'Project not found' } });
    // project is checked before the body, so a bodyless PUT still 404s.
    expect(await err(base, 'PUT', '/api/pm/memory/proj-x/notes.md')).toEqual({ status: 404, body: { error: 'Project not found' } });
    expect(await err(base, 'PUT', '/api/pm/memory/proj-x/notes.md', JSON.stringify({ content: 'x' }))).toEqual({ status: 404, body: { error: 'Project not found' } });
    expect(await err(base, 'DELETE', '/api/pm/memory/proj-x/notes.md')).toEqual({ status: 404, body: { error: 'Project not found' } });
  });

  it('GET /api/pm/rules/{id} → 404 for an unknown project', async () => {
    const base = await up();
    expect(await err(base, 'GET', '/api/pm/rules/proj-x')).toEqual({ status: 404, body: { error: 'Project not found' } });
  });

  it('rules /{scope}: invalid scope → 400 (before project lookup); valid scope + no project → 404', async () => {
    const base = await up();
    expect(await err(base, 'GET', '/api/pm/rules/proj-x/bogus'))
      .toEqual({ status: 400, body: { error: 'Invalid scope. Must be: global, project, or local' } });
    for (const scope of ['global', 'project', 'local']) {
      expect(await err(base, 'GET', `/api/pm/rules/proj-x/${scope}`))
        .toEqual({ status: 404, body: { error: 'Project not found' } });
    }
  });

  it('PUT rules /{scope}: invalid scope → 400; valid scope + no project → 404', async () => {
    const base = await up();
    expect(await err(base, 'PUT', '/api/pm/rules/proj-x/bogus', JSON.stringify({ content: 'x' })))
      .toEqual({ status: 400, body: { error: 'Invalid scope' } });
    // valid scope, unknown project → 404 (project checked before body).
    expect(await err(base, 'PUT', '/api/pm/rules/proj-x/global', JSON.stringify({ content: 'x' })))
      .toEqual({ status: 404, body: { error: 'Project not found' } });
    expect(await err(base, 'PUT', '/api/pm/rules/proj-x/global'))
      .toEqual({ status: 404, body: { error: 'Project not found' } });
  });
});
