/**
 * Regression tests for WAL handle LRU eviction (audit F3).
 *
 * The v0.10.8 release fixed the equivalent leak for SQLite stores. This
 * test locks in the same behavior for WAL handles — without eviction we
 * leak a file descriptor per distinct project ever seen, which on a
 * 40+ project machine eventually trips ulimit -n.
 *
 * Approach:
 *   - Spawn CollectorServer with a tight idle/sweep window via env.
 *   - Connect WS clients for two projects, send a few events to force
 *     ensureWal() for each.
 *   - Disconnect, wait past the idle timeout + a sweep interval, assert
 *     both WAL handles are gone from getOpenHandleCounts().wals.
 *   - Re-connect for project A, assert the WAL handle is back (eviction
 *     must be transparent — not a one-way delete).
 *
 * See: docs/audits/0001-collector-process-lifetime.md F3
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CollectorServer, ProjectManager, isSqliteAvailable } from '../index.js';

// Tight enough that the test runs fast but loose enough to dodge timer
// jitter on busy CI workers. The production default is 5min idle /
// 60s sweep — overridable for the test via the env var path we added
// in v0.10.8 for the SQLite eviction.
const IDLE_MS = 200;
const SWEEP_MS = 100;

describe('WAL handle LRU eviction (audit F3)', () => {
  let collector: CollectorServer | null = null;
  let tempRoot: string | null = null;
  let savedEnv: { idle?: string; sweep?: string };

  function makeProjectManager(): ProjectManager {
    tempRoot = mkdtempSync(join(tmpdir(), 'rs-wal-evict-'));
    const pm = new ProjectManager(tempRoot);
    pm.ensureGlobalDir();
    return pm;
  }

  beforeEachOverride();
  function beforeEachOverride() {
    // Capture/restore env so we don't leak the tight timeouts to other tests.
    savedEnv = {
      idle: process.env.RUNTIMESCOPE_SQLITE_IDLE_MS,
      sweep: process.env.RUNTIMESCOPE_SQLITE_SWEEP_MS,
    };
    process.env.RUNTIMESCOPE_SQLITE_IDLE_MS = String(IDLE_MS);
    process.env.RUNTIMESCOPE_SQLITE_SWEEP_MS = String(SWEEP_MS);
  }

  afterEach(async () => {
    try { collector?.stop(); } catch { /* ignore */ }
    collector = null;
    if (tempRoot) {
      try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      tempRoot = null;
    }
    // Restore env
    if (savedEnv.idle === undefined) delete process.env.RUNTIMESCOPE_SQLITE_IDLE_MS;
    else process.env.RUNTIMESCOPE_SQLITE_IDLE_MS = savedEnv.idle;
    if (savedEnv.sweep === undefined) delete process.env.RUNTIMESCOPE_SQLITE_SWEEP_MS;
    else process.env.RUNTIMESCOPE_SQLITE_SWEEP_MS = savedEnv.sweep;
    // Re-prime env for next test
    beforeEachOverride();
    await new Promise((r) => setTimeout(r, 30));
  });

  async function connectAndSend(port: number, projectName: string, projectId: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({
      type: 'handshake',
      timestamp: Date.now(),
      payload: { sessionId: `sess-${projectName}`, appName: projectName, projectId, sdkVersion: '0.0.0-test' },
    }));
    // Send one event to force ensureWal() — the WAL is opened on first append.
    // Wait a tick so the handshake completes before sending events
    // (the server rejects events from pendingHandshakes connections).
    await new Promise((r) => setTimeout(r, 80));
    ws.send(JSON.stringify({
      type: 'event',
      timestamp: Date.now(),
      payload: {
        events: [{
          eventId: `e-${projectName}-0`,
          eventType: 'network',
          sessionId: `sess-${projectName}`,
          timestamp: Date.now(),
          url: 'https://api.example.com/probe',
          method: 'GET',
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          requestBodySize: 0,
          responseBodySize: 0,
          duration: 1,
          ttfb: 1,
        }],
      },
    }));
    // Let the server process the batch (write to WAL, commit, push to store).
    await new Promise((r) => setTimeout(r, 80));
    return ws;
  }

  it.skipIf(!isSqliteAvailable())(
    'evicts idle WAL handles after the idle window',
    async () => {
      collector = new CollectorServer({
        bufferSize: 100,
        projectManager: makeProjectManager(),
      });
      await collector.start({ port: 0, maxRetries: 0 });
      const port = collector.getPort()!;

      // Two projects active → two WAL handles open.
      const wsA = await connectAndSend(port, 'proj-a', 'proj_aaa');
      const wsB = await connectAndSend(port, 'proj-b', 'proj_bbb');
      expect(collector.getOpenHandleCounts().wals).toBeGreaterThanOrEqual(2);

      // Disconnect both — handles still open until eviction sweep.
      wsA.close();
      wsB.close();
      await new Promise((r) => setTimeout(r, 50));

      // Wait past idle + a full sweep window. With IDLE_MS=200 + SWEEP_MS=100,
      // 500ms is comfortably enough for the first eviction tick to fire after
      // the handles cross the idle threshold.
      await new Promise((r) => setTimeout(r, IDLE_MS + SWEEP_MS * 3));

      const counts = collector.getOpenHandleCounts();
      expect(counts.wals).toBe(0);
    },
  );

  it.skipIf(!isSqliteAvailable())(
    'does NOT evict WAL handles belonging to currently-connected clients',
    async () => {
      collector = new CollectorServer({
        bufferSize: 100,
        projectManager: makeProjectManager(),
      });
      await collector.start({ port: 0, maxRetries: 0 });
      const port = collector.getPort()!;

      const wsA = await connectAndSend(port, 'proj-a', 'proj_aaa');
      const wsB = await connectAndSend(port, 'proj-b', 'proj_bbb');

      // Disconnect only B. A stays connected — its WAL must survive eviction.
      wsB.close();
      await new Promise((r) => setTimeout(r, 50));

      // Wait past the idle window.
      await new Promise((r) => setTimeout(r, IDLE_MS + SWEEP_MS * 3));

      const counts = collector.getOpenHandleCounts();
      expect(counts.wals).toBe(1);

      wsA.close();
    },
  );

  it.skipIf(!isSqliteAvailable())(
    're-opens an evicted WAL handle transparently on next event',
    async () => {
      collector = new CollectorServer({
        bufferSize: 100,
        projectManager: makeProjectManager(),
      });
      await collector.start({ port: 0, maxRetries: 0 });
      const port = collector.getPort()!;

      // Open a WAL, disconnect, wait for eviction.
      const wsFirst = await connectAndSend(port, 'proj-a', 'proj_aaa');
      wsFirst.close();
      await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, IDLE_MS + SWEEP_MS * 3));
      expect(collector.getOpenHandleCounts().wals).toBe(0);

      // Re-connect for the same project. ensureWal() should transparently
      // re-open the handle on the next event.
      const wsSecond = await connectAndSend(port, 'proj-a', 'proj_aaa');
      expect(collector.getOpenHandleCounts().wals).toBe(1);

      wsSecond.close();
    },
  );
});
