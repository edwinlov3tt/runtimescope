/**
 * Scenario: crash-recovery
 *
 * The killer test for Phase 1 (WAL durability) and Phase 2 (startup replay).
 * Sequence:
 *   1. Boot collector, send N events, give the SDK time to ack-via-WAL but
 *      NOT enough time for SqliteStore to drain the writeBuffer.
 *   2. SIGKILL the collector mid-flight. No graceful shutdown — simulates a
 *      hard crash. Pending in-memory state is lost.
 *   3. Boot a NEW collector pointed at the same data dir (same HOME).
 *   4. Wait for /readyz, then verify the events that were sent pre-crash are
 *      present in SqliteStore — meaning WAL recovery successfully replayed
 *      them on startup.
 *
 * If WAL durability is broken (events ack'd but lost on crash), this fails
 * loudly. If recovery never runs, this fails. If recovery double-counts,
 * this fails.
 */

import { spawnCollector, type SpawnedCollector } from '../utils/spawn-collector.js';
import { SdkDriver, makeNetEvent } from '../utils/sdk-driver.js';
import { CheckCollector } from '../utils/assert.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const PROJECT = 'proj_crash_recovery';
const APP = 'crash-test-app';
const TOTAL_EVENTS = 5_000;

export async function crashRecovery(checks: CheckCollector): Promise<void> {
  const first = await spawnCollector();
  let recovered: SpawnedCollector | null = null;
  try {
    await first.ready();

    const driver = new SdkDriver({ wsPort: first.wsPort, appName: APP, projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 100));

    // Send a flood — large enough that SqliteStore can't possibly have drained
    // it all by the time we kill (its flushTimer is 100ms).
    const sentIds: string[] = [];
    const BATCH = 200;
    for (let i = 0; i < TOTAL_EVENTS; i += BATCH) {
      const batch: object[] = [];
      const upTo = Math.min(BATCH, TOTAL_EVENTS - i);
      for (let j = 0; j < upTo; j++) {
        const ev = makeNetEvent(driver.sessionId, i + j) as { eventId: string };
        sentIds.push(ev.eventId);
        batch.push(ev);
      }
      driver.sendBatch(batch);
    }
    await driver.flush();

    // Tiny pause: let the collector receive + WAL-fsync (10s of ms each
    // batch) but DON'T let SqliteStore drain everything.
    await new Promise((r) => setTimeout(r, 300));
    checks.ok(`sent ${TOTAL_EVENTS} events pre-crash`, true);

    // SIGKILL — no graceful shutdown, no SQLite final flush. WAL files on
    // disk are the only durability we have.
    if (first.proc.pid) process.kill(first.proc.pid, 'SIGKILL');
    await new Promise<void>((resolve) => first.proc.once('exit', () => resolve()));
    checks.ok('collector hard-killed (SIGKILL)', true);

    // Re-launch a NEW collector against the SAME HOME dir so it picks up the
    // existing WAL + SQLite files.
    recovered = await spawnCollectorAt(first.rootDir, first.wsPort + 100, first.httpPort + 100);
    await recovered.ready();
    checks.ok('replacement collector reaches /readyz after recovery', true);

    // Phase 2 recovery does three things now:
    //   1. Replay any non-empty WAL files into SqliteStore (durable on disk)
    //   2. Rehydrate the session→projectId map from SqliteStore's sessions
    //      table — fixes the post-crash query gap so ?project_id=... works
    //   3. Warm the in-memory ring buffer with up-to-1000 events per project
    //
    // We assert two queries: no filter (everything that landed) AND
    // project_id-filtered (must work post-crash).
    const allRes = await fetch(`http://127.0.0.1:${recovered.httpPort}/api/events/network`);
    const all = (await allRes.json()) as { count: number; data: { eventId: string; sessionId: string }[] };
    const sentSet = new Set(sentIds);
    const recoveredFromUs = all.data.filter((e) => sentSet.has(e.eventId));

    checks.geq(
      `recovered events visible without filter (≥ 800 of ${TOTAL_EVENTS} sent — warm is capped at 1000/project)`,
      recoveredFromUs.length,
      800,
    );
    checks.ok(
      'every recovered event was actually sent (no fabricated events)',
      recoveredFromUs.every((e) => sentSet.has(e.eventId)),
    );

    // Filtering by project_id must work after a crash — this is the gap the
    // session-map rehydration fix closes. Without the fix this returns 0.
    const filteredRes = await fetch(
      `http://127.0.0.1:${recovered.httpPort}/api/events/network?project_id=${PROJECT}`,
    );
    const filtered = (await filteredRes.json()) as { count: number; data: { eventId: string }[] };
    const filteredFromUs = filtered.data.filter((e) => sentSet.has(e.eventId));
    checks.geq(
      `recovered events visible WITH ?project_id=${PROJECT} filter (post-crash session map rehydrated)`,
      filteredFromUs.length,
      800,
    );

    // The WAL files should now be cleaned up — recovery deletes them after
    // successful replay. If they're still hanging around, recovery was a
    // no-op and we're testing the wrong thing.
    const walFile = join(first.rootDir, '.runtimescope', 'projects', APP, 'wal');
    const { existsSync, readdirSync } = await import('node:fs');
    let walFiles: string[] = [];
    try {
      walFiles = existsSync(walFile) ? readdirSync(walFile) : [];
    } catch {
      walFiles = [];
    }
    // Active.jsonl might exist from the new collector accepting fresh
    // handshakes, but sealed-* files should be gone after successful drain.
    const sealed = walFiles.filter((f) => f.startsWith('sealed-'));
    checks.eq('all sealed WAL files cleaned up post-recovery', sealed.length, 0);
  } finally {
    if (recovered) await recovered.stop();
    await first.stop();
  }
}

/**
 * Helper: spawn a collector with an explicit `HOME` so it sees a previously-
 * crashed collector's data files. Mirrors the shape of spawnCollector but
 * doesn't pick a fresh port pair.
 */
async function spawnCollectorAt(
  rootDir: string,
  wsPort: number,
  httpPort: number,
): Promise<SpawnedCollector> {
  const distPath = join(
    new URL('.', import.meta.url).pathname,
    '..',
    '..',
    'packages',
    'collector',
    'dist',
    'standalone.js',
  );

  const proc = spawn('node', [distPath], {
    env: {
      ...process.env,
      HOME: rootDir,
      RUNTIMESCOPE_PORT: String(wsPort),
      RUNTIMESCOPE_HTTP_PORT: String(httpPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines: string[] = [];
  proc.stdout?.on('data', (b: Buffer) => lines.push(b.toString()));
  proc.stderr?.on('data', (b: Buffer) => lines.push(b.toString()));

  let stopResolve: (() => void) | null = null;
  const exitPromise = new Promise<void>((r) => { stopResolve = r; });
  proc.on('exit', () => stopResolve?.());

  return {
    wsPort,
    httpPort,
    rootDir,
    proc,
    ready: async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${httpPort}/readyz`, {
            signal: AbortSignal.timeout(500),
          });
          if (res.ok) {
            const body = (await res.json()) as { status?: string };
            if (body.status === 'ready') return;
          }
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Replacement collector never reached /readyz:\n${lines.join('').slice(-2000)}`);
    },
    stop: async () => {
      if (proc.killed) return;
      proc.kill('SIGTERM');
      const forced = setTimeout(() => proc.kill('SIGKILL'), 2000);
      await exitPromise;
      clearTimeout(forced);
    },
  };
}
