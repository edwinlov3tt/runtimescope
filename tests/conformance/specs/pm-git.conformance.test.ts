/**
 * Conformance: the /api/pm/projects/{id}/git/* surface (M5.5 Slice F) against
 * Node, over the MCP server's EMBEDDED HTTP port. Every git route resolves a
 * pm.db project (and its on-disk path) first; the harness's temp HOME has no
 * discovered projects, so all six hit the no-project 404 — that's what's pinned
 * here. The real git exec + porcelain/log parsing is covered by collector-core
 * unit tests (including a live `git` run against this repo).
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

describe('pm/ git HTTP routes (Node)', () => {
  it('all git routes → 404 "Project not found" for an unknown project', async () => {
    const base = await up();
    const expect404 = async (method: string, path: string, body?: string) => {
      const init: RequestInit = { method };
      if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = body; }
      const r = await fetch(`${base}${path}`, init);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(await r.json()).toEqual({ error: 'Project not found' });
    };

    await expect404('GET', '/api/pm/projects/proj-x/git/status');
    await expect404('GET', '/api/pm/projects/proj-x/git/log');
    await expect404('GET', '/api/pm/projects/proj-x/git/diff');
    await expect404('GET', '/api/pm/projects/proj-x/git/diff?staged=1&file=src/x.rs');
    await expect404('POST', '/api/pm/projects/proj-x/git/stage', JSON.stringify({ files: ['a.rs'] }));
    await expect404('POST', '/api/pm/projects/proj-x/git/unstage', JSON.stringify({ files: ['a.rs'] }));
    await expect404('POST', '/api/pm/projects/proj-x/git/commit', JSON.stringify({ message: 'x' }));
    // project is resolved before the body, so a bodyless mutate still 404s.
    await expect404('POST', '/api/pm/projects/proj-x/git/stage');
    await expect404('POST', '/api/pm/projects/proj-x/git/commit');
  });
});
