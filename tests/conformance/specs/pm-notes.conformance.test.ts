/**
 * Conformance: the /api/pm/notes CRUD surface (M5.5 Slice C) against Node, over
 * the MCP server's EMBEDDED HTTP port. Notes are HTTP-creatable, so this is a full
 * lifecycle round-trip Node and Rust must agree on:
 *
 *   - GET    /api/pm/notes                 → { data: [], count: 0 } on a fresh db
 *   - POST   /api/pm/notes                 → 201 note (uuid id, defaults, tags [])
 *   - POST   /api/pm/notes (no body)       → 400 "Body required"
 *   - GET    /api/pm/notes (+?pinned=1)    → pinned-only filter
 *   - pinned sort: pinned DESC, updated_at DESC
 *   - PUT    /api/pm/notes/{id}            → { ok: true }; GET reflects change
 *   - PUT    /api/pm/notes/{id} (no body)  → 400 "Body required"
 *   - DELETE /api/pm/notes/{id}            → { ok: true }; GET back to empty
 *
 * Authored green-vs-Node first; confirm vs Rust via RUNTIMESCOPE_*_CMD.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

interface Note {
  id: string; title: string; content: string; pinned: boolean; tags: string[];
  createdAt: number; updatedAt: number; projectId?: string; sessionId?: string;
}
async function listNotes(base: string, qs = ''): Promise<{ data: Note[]; count: number }> {
  const r = await fetch(`${base}/api/pm/notes${qs}`);
  expect(r.status).toBe(200);
  return r.json() as Promise<{ data: Note[]; count: number }>;
}
async function createNote(base: string, body: Record<string, unknown>): Promise<Note> {
  const r = await fetch(`${base}/api/pm/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(r.status).toBe(201);
  return r.json() as Promise<Note>;
}

describe('pm/ notes HTTP routes (Node)', () => {
  it('GET /api/pm/notes → empty on a fresh db', async () => {
    const base = await up();
    expect(await listNotes(base)).toEqual({ data: [], count: 0 });
  });

  it('POST applies defaults; 400 without a body', async () => {
    const base = await up();

    const noBody = await fetch(`${base}/api/pm/notes`, { method: 'POST' });
    expect(noBody.status).toBe(400);
    expect((await noBody.json() as { error: string }).error).toBe('Body required');

    const n = await createNote(base, {}); // all defaults
    expect(n.id).toMatch(UUID_V4);
    expect(n.title).toBe('Untitled');
    expect(n.content).toBe('');
    expect(n.pinned).toBe(false);
    expect(n.tags).toEqual([]);
    expect(typeof n.createdAt).toBe('number');
    expect(typeof n.updatedAt).toBe('number');
    expect('projectId' in n).toBe(false);
    expect('sessionId' in n).toBe(false);

    expect((await listNotes(base)).count).toBe(1);
  });

  it('preserves provided fields + tags array', async () => {
    const base = await up();
    // NB: no projectId/sessionId here — those columns carry FK constraints to
    // pm_projects/pm_sessions, and Node (better-sqlite3 defaults foreign_keys=ON)
    // 400s on a dangling ref while Rust (rusqlite, FK OFF) would accept it. That
    // FK-enforcement divergence is tracked separately (see roadmap M5.5 note); it
    // spans every pm table + the live discovery insert order, so it's handled in a
    // dedicated pass rather than per-slice. Here we pin the field-preservation path.
    const n = await createNote(base, {
      title: 'Hello', content: 'world', pinned: true, tags: ['a', 'b'],
    });
    expect(n.title).toBe('Hello');
    expect(n.content).toBe('world');
    expect(n.pinned).toBe(true);
    expect(n.tags).toEqual(['a', 'b']);
  });

  it('sorts pinned first and honors ?pinned=1', async () => {
    const base = await up();
    await createNote(base, { title: 'plain' });
    const pinned = await createNote(base, { title: 'pinned one', pinned: true });

    const all = await listNotes(base);
    expect(all.count).toBe(2);
    expect(all.data[0].id).toBe(pinned.id); // pinned DESC

    const onlyPinned = await listNotes(base, '?pinned=1');
    expect(onlyPinned.count).toBe(1);
    expect(onlyPinned.data[0].id).toBe(pinned.id);
  });

  it('PUT updates fields (400 without body); GET reflects it', async () => {
    const base = await up();
    const n = await createNote(base, { title: 'Edit me', content: 'old' });

    const noBody = await fetch(`${base}/api/pm/notes/${n.id}`, { method: 'PUT' });
    expect(noBody.status).toBe(400);

    const upd = await fetch(`${base}/api/pm/notes/${n.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'new', pinned: true }),
    });
    expect(upd.status).toBe(200);
    expect(await upd.json()).toEqual({ ok: true });

    const got = (await listNotes(base)).data[0];
    expect(got.content).toBe('new');
    expect(got.pinned).toBe(true);
    expect(got.title).toBe('Edit me'); // untouched
  });

  it('POST with a dangling projectId → 400 (FK enforced in both runtimes)', async () => {
    const base = await up();
    // Fresh db has no projects, so any projectId is a dangling FK ref. Node
    // (better-sqlite3 foreign_keys=ON) and Rust (pragma on + FK constraints) both
    // reject the insert → the route's catch returns 400 with the SQLite message.
    const r = await fetch(`${base}/api/pm/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'orphan', projectId: 'does-not-exist' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/FOREIGN KEY constraint failed/);
  });

  it('DELETE removes the note', async () => {
    const base = await up();
    const n = await createNote(base, { title: 'Delete me' });
    expect((await listNotes(base)).count).toBe(1);

    const del = await fetch(`${base}/api/pm/notes/${n.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect((await listNotes(base)).count).toBe(0);
  });
});
