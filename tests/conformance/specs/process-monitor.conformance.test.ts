/**
 * Conformance: /api/processes + /api/ports (M5.5 Core) against Node.
 *
 * These routes are PER-BINARY in Node (the "read the consumer" finding):
 *  - standalone collector-server → `new HttpServer(store, undefined, …)` (no
 *    ProcessMonitor) → both routes return `{data:[],count:0}`; DELETE → 500.
 *  - mcp-server → `new ProcessMonitor(store).start()` is passed in → LIVE ps/lsof
 *    data (non-deterministic machine state).
 *
 * So we gate two ways:
 *  - via `spawnCollector` (→ collector-server): the deterministic empty + 500
 *    shapes, asserted EQUAL green-vs-both.
 *  - via `McpDriver` (→ mcp-server): the live path is non-deterministic, so we
 *    assert the ENVELOPE + item SHAPE only (a Rust integration test pins the one
 *    deterministic fact — a known spawned listener appears).
 *
 * Authored green-vs-Node first; confirm vs Rust via RUNTIMESCOPE_*_CMD.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnCollector, McpDriver, type SpawnedCollector } from '../harness/index.js';

describe('/api/processes + /api/ports — standalone collector (no ProcessMonitor) [Node]', () => {
  let collector: SpawnedCollector | null = null;
  afterEach(async () => { await collector?.stop(); collector = null; });

  it('GET both → empty; DELETE → 500 (deterministic, equal vs both)', async () => {
    collector = await spawnCollector();
    await collector.ready();
    const base = `http://127.0.0.1:${collector.httpPort}`;

    const procs = await fetch(`${base}/api/processes`);
    expect(procs.status).toBe(200);
    expect(await procs.json()).toEqual({ data: [], count: 0 });

    const ports = await fetch(`${base}/api/ports`);
    expect(ports.status).toBe(200);
    expect(await ports.json()).toEqual({ data: [], count: 0 });

    const del = await fetch(`${base}/api/processes?pid=999999`, { method: 'DELETE' });
    expect(del.status).toBe(500);
    expect(await del.json()).toEqual({ error: 'Process monitor not available' });
  });
});

describe('/api/processes + /api/ports — mcp-server (live ProcessMonitor) [Node]', () => {
  let mcp: McpDriver | null = null;
  afterEach(async () => { await mcp?.stop(); mcp = null; });

  async function base(): Promise<string> {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const b = `http://127.0.0.1:${mcp.httpPort}`;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${b}/readyz`)).ok) return b; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    return b;
  }

  it('GET /api/processes → well-formed envelope + DevProcess item shape (shape-only)', async () => {
    const b = await base();
    const r = await fetch(`${b}/api/processes`);
    expect(r.status).toBe(200);
    const body = await r.json() as { data: Array<Record<string, unknown>>; count: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.count).toBe(body.data.length);
    // Live data is machine-dependent; assert the SHAPE of any row that's present.
    for (const p of body.data) {
      expect(typeof p.pid).toBe('number');
      expect(typeof p.command).toBe('string');
      expect(typeof p.type).toBe('string');
      expect(typeof p.cpuPercent).toBe('number');
      expect(typeof p.memoryMB).toBe('number');
      expect(Array.isArray(p.ports)).toBe(true);
      expect(typeof p.isOrphaned).toBe('boolean');
    }
  });

  it('GET /api/ports → well-formed envelope + PortUsage item shape (shape-only)', async () => {
    const b = await base();
    const r = await fetch(`${b}/api/ports`);
    expect(r.status).toBe(200);
    const body = await r.json() as { data: Array<Record<string, unknown>>; count: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.count).toBe(body.data.length);
    for (const p of body.data) {
      expect(typeof p.port).toBe('number');
      expect(typeof p.pid).toBe('number');
      expect(typeof p.process).toBe('string');
      expect(typeof p.type).toBe('string');
    }
    // Sorted ascending by port (Node getPortUsage sorts).
    const ports = body.data.map((p) => p.port as number);
    expect(ports).toEqual([...ports].sort((a, z) => a - z));
  });

  it('DELETE /api/processes without a pid → 400 "pid is required"', async () => {
    const b = await base();
    const r = await fetch(`${b}/api/processes`, { method: 'DELETE' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'pid is required' });
  });
});
