/**
 * Conformance: session metadata — appName vs projectId, and persistence.
 *
 * Audit #7: the collector must keep `appName` (the app/project display name) and
 * the runtime `projectId` (proj_xxx) as DISTINCT fields, and sessions must
 * survive a restart (rehydrated from SQLite as isConnected:false). The original
 * Rust port conflated them (projectName = projectId) and kept sessions in memory
 * only, so post-restart project metadata was wrong/empty.
 *
 * Source of truth: packages/collector/src/store.ts (getSessionInfo / warmFromSqlite),
 * packages/collector/src/server.ts (handshake → session record). Green vs Node.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCollectorCmd, SdkDriver } from '../harness/index.js';

let port = 49600 + Math.floor(Math.random() * 200) * 4;
let rootDir: string | null = null;
let current: ChildProcess | null = null;

afterEach(async () => {
  if (current && !current.killed) current.kill('SIGKILL');
  current = null;
  try { if (rootDir && existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true }); } catch { /* best effort */ }
  rootDir = null;
});

function spawnAt(home: string, wsPort: number, httpPort: number): ChildProcess {
  const { cmd, args } = resolveCollectorCmd();
  return spawn(cmd, args, {
    env: { ...process.env, HOME: home, RUNTIMESCOPE_PORT: String(wsPort), RUNTIMESCOPE_HTTP_PORT: String(httpPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady(httpPort: number, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${httpPort}/readyz`, { signal: AbortSignal.timeout(500) });
      if (r.ok && ((await r.json()) as { status?: string }).status === 'ready') return;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`collector :${httpPort} never ready`);
}

async function sessions(httpPort: number): Promise<Array<Record<string, unknown>>> {
  const body = await fetch(`http://127.0.0.1:${httpPort}/api/sessions`).then((r) => r.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

describe('session metadata', () => {
  it('keeps appName and projectId distinct (no projectName conflation)', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'rs-conf-sess-'));
    const wsPort = port; const httpPort = port + 1; port += 4;
    current = spawnAt(rootDir, wsPort, httpPort);
    await waitReady(httpPort);

    const driver = new SdkDriver({ wsPort, appName: 'sess-app', projectId: 'proj_sess' });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 200));

    const list = await sessions(httpPort);
    const mine = list.find((s) => s.sessionId === driver.sessionId);
    expect(mine, 'session present').toBeTruthy();
    expect(mine!.appName).toBe('sess-app');
    expect(mine!.projectId).toBe('proj_sess');
    // The bug: projectId leaking into the appName/name slot.
    expect(mine!.appName).not.toBe('proj_sess');
    expect(mine!.isConnected).toBe(true);

    await driver.close();
  });

  it('persists sessions across a restart, rehydrated as disconnected', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'rs-conf-sess2-'));
    const wsPort = port; const httpPort = port + 1; port += 4;

    current = spawnAt(rootDir, wsPort, httpPort);
    await waitReady(httpPort);
    const driver = new SdkDriver({ wsPort, appName: 'persist-app', projectId: 'proj_persist' });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 300));
    const sid = driver.sessionId;
    await driver.close();
    // let the disconnect + any persistence settle, then hard-restart
    await new Promise((r) => setTimeout(r, 500));
    current.kill('SIGKILL');
    await new Promise<void>((r) => current!.on('exit', () => r()));

    current = spawnAt(rootDir, wsPort, httpPort);
    await waitReady(httpPort);
    const list = await sessions(httpPort);
    const mine = list.find((s) => s.sessionId === sid);
    expect(mine, 'session survived restart').toBeTruthy();
    expect(mine!.appName).toBe('persist-app');
    expect(mine!.projectId).toBe('proj_persist');
    expect(mine!.isConnected, 'rehydrated as disconnected (no live WS after restart)').toBe(false);
  });
});
