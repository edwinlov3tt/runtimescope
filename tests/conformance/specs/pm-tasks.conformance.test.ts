/**
 * Conformance: the /api/pm/tasks CRUD + reorder surface (M5.5 Slice B) against
 * Node. Driven over the MCP server's EMBEDDED HTTP port. Unlike capex (which needs
 * discovery to populate), tasks are HTTP-creatable, so this exercises a full
 * lifecycle round-trip that Node and Rust must agree on:
 *
 *   - GET    /api/pm/tasks                  → { data: [], count: 0 } on a fresh db
 *   - POST   /api/pm/tasks                  → 201 task (uuid id, defaults applied, labels [])
 *   - POST   /api/pm/tasks (no body)        → 400 "Body required"
 *   - GET    /api/pm/tasks (+?status)       → reflects the created task; status filter works
 *   - PUT    /api/pm/tasks/{id}             → { ok: true }; GET reflects the change
 *   - PUT    /api/pm/tasks/{id} (no body)   → 400 "Body required"
 *   - PUT    /api/pm/tasks/{id}/reorder     → { ok: true }; status=done stamps completedAt
 *   - PUT    .../reorder (no body)          → 400 "Body required"
 *   - DELETE /api/pm/tasks/{id}             → { ok: true }; GET back to empty
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

interface Task {
  id: string; title: string; status: string; priority: string; labels: string[];
  source: string; sortOrder: number; createdAt: number; updatedAt: number;
  projectId?: string; description?: string; completedAt?: number;
}
async function listTasks(base: string, qs = ''): Promise<{ data: Task[]; count: number }> {
  const r = await fetch(`${base}/api/pm/tasks${qs}`);
  expect(r.status).toBe(200);
  return r.json() as Promise<{ data: Task[]; count: number }>;
}

describe('pm/ tasks HTTP routes (Node)', () => {
  it('GET /api/pm/tasks → empty on a fresh db', async () => {
    const base = await up();
    expect(await listTasks(base)).toEqual({ data: [], count: 0 });
  });

  it('POST /api/pm/tasks creates a task with defaults; 400 without a body', async () => {
    const base = await up();

    const noBody = await fetch(`${base}/api/pm/tasks`, { method: 'POST' });
    expect(noBody.status).toBe(400);
    expect((await noBody.json() as { error: string }).error).toBe('Body required');

    const res = await fetch(`${base}/api/pm/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Ship Slice B' }),
    });
    expect(res.status).toBe(201);
    const t = await res.json() as Task & Record<string, unknown>;
    expect(t.id).toMatch(UUID_V4);
    expect(t.title).toBe('Ship Slice B');
    expect(t.status).toBe('todo');     // default
    expect(t.priority).toBe('medium'); // default
    expect(t.labels).toEqual([]);      // default, always an array
    expect(t.source).toBe('manual');   // default
    expect(typeof t.sortOrder).toBe('number');
    expect(typeof t.createdAt).toBe('number');
    expect(typeof t.updatedAt).toBe('number');
    // Unset optionals are omitted (Node's `?? undefined`).
    expect('projectId' in t).toBe(false);
    expect('description' in t).toBe(false);
    expect('completedAt' in t).toBe(false);

    // Now visible via GET.
    const { data, count } = await listTasks(base);
    expect(count).toBe(1);
    expect(data[0].id).toBe(t.id);
  });

  it('honors ?status filter', async () => {
    const base = await up();
    await fetch(`${base}/api/pm/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'A', status: 'todo' }),
    });
    expect((await listTasks(base, '?status=todo')).count).toBe(1);
    expect((await listTasks(base, '?status=done')).count).toBe(0);
  });

  it('PUT updates fields (400 without a body) and GET reflects it', async () => {
    const base = await up();
    const created = await (await fetch(`${base}/api/pm/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Edit me', priority: 'low' }),
    })).json() as Task;

    const noBody = await fetch(`${base}/api/pm/tasks/${created.id}`, { method: 'PUT' });
    expect(noBody.status).toBe(400);
    expect((await noBody.json() as { error: string }).error).toBe('Body required');

    const upd = await fetch(`${base}/api/pm/tasks/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Edited', status: 'in_progress' }),
    });
    expect(upd.status).toBe(200);
    expect(await upd.json()).toEqual({ ok: true });

    const t = (await listTasks(base)).data[0];
    expect(t.title).toBe('Edited');
    expect(t.status).toBe('in_progress');
    expect(t.priority).toBe('low'); // untouched
  });

  it('PUT /reorder moves status + order; status=done stamps completedAt (400 without body)', async () => {
    const base = await up();
    const created = await (await fetch(`${base}/api/pm/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Reorder me' }),
    })).json() as Task;
    expect('completedAt' in created).toBe(false);

    const noBody = await fetch(`${base}/api/pm/tasks/${created.id}/reorder`, { method: 'PUT' });
    expect(noBody.status).toBe(400);

    const re = await fetch(`${base}/api/pm/tasks/${created.id}/reorder`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done', sortOrder: 42 }),
    });
    expect(re.status).toBe(200);
    expect(await re.json()).toEqual({ ok: true });

    const t = (await listTasks(base)).data[0];
    expect(t.status).toBe('done');
    expect(t.sortOrder).toBe(42);
    expect(typeof t.completedAt).toBe('number'); // done → stamped
  });

  it('DELETE removes the task', async () => {
    const base = await up();
    const created = await (await fetch(`${base}/api/pm/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Delete me' }),
    })).json() as Task;
    expect((await listTasks(base)).count).toBe(1);

    const del = await fetch(`${base}/api/pm/tasks/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    expect((await listTasks(base)).count).toBe(0);
  });
});
