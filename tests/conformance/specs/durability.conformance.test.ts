/**
 * Conformance: WAL durability.
 *
 * The single most important invariant for a reimplementation: an event that
 * has been committed (fsync'd) survives an ungraceful kill (SIGKILL — no
 * graceful WAL drain) and is recovered on the next start. This pins the
 * fsync-before-commit ordering (wal.ts:98) and torn-tail recovery (wal.ts:162).
 *
 * Distinct from the `crash-recovery` stress scenario (which also runs against
 * the seam): this is the minimal, framed-as-contract version.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCollectorCmd, SdkDriver, makeNetEvent } from '../harness/index.js';

const PROJECT = 'proj_conf_durability';
let port = 49000 + Math.floor(Math.random() * 200) * 4;

interface Handle { proc: ChildProcess; wsPort: number; httpPort: number; }

/** Spawn the collector-under-test at an explicit HOME (so a restart sees the
 *  prior run's WAL) on a fixed port pair. Honors RUNTIMESCOPE_COLLECTOR_CMD. */
function spawnAt(rootDir: string, wsPort: number, httpPort: number): Handle {
  const { cmd, args } = resolveCollectorCmd();
  const proc = spawn(cmd, args, {
    env: { ...process.env, HOME: rootDir, RUNTIMESCOPE_PORT: String(wsPort), RUNTIMESCOPE_HTTP_PORT: String(httpPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { proc, wsPort, httpPort };
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
  throw new Error(`collector at :${httpPort} never became ready`);
}

let rootDir: string | null = null;
let current: Handle | null = null;
afterEach(async () => {
  if (current && !current.proc.killed) { current.proc.kill('SIGKILL'); }
  current = null;
  try { if (rootDir && existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true }); } catch { /* best effort */ }
  rootDir = null;
});

describe('WAL durability', () => {
  it('committed events survive SIGKILL and are recovered on restart', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'rs-conf-dur-'));
    const wsPort = port; const httpPort = port + 1; port += 4;

    // 1. Boot, send a batch, flush so the bytes are handed to the collector.
    current = spawnAt(rootDir, wsPort, httpPort);
    await waitReady(httpPort);
    const driver = new SdkDriver({ wsPort, appName: 'conf-dur', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 100));
    const N = 50;
    driver.sendBatch(Array.from({ length: N }, (_, i) => makeNetEvent(driver.sessionId, i)));
    await driver.flush();

    // Give the collector time to fsync the WAL (commit), then HARD kill — no
    // SIGTERM, no graceful drain. Only fsync'd events may be claimed durable.
    await new Promise((r) => setTimeout(r, 1500));
    current.proc.kill('SIGKILL');
    await new Promise<void>((r) => current!.proc.on('exit', () => r()));

    // 2. Restart at the SAME HOME — WAL replay should recover the committed events.
    current = spawnAt(rootDir, wsPort, httpPort);
    await waitReady(httpPort);

    const deadline = Date.now() + 8000;
    let recovered = 0;
    while (Date.now() < deadline) {
      recovered = await fetch(`http://127.0.0.1:${httpPort}/api/events/network?project_id=${PROJECT}`)
        .then((r) => r.json()).then((d: { count: number }) => d.count).catch(() => 0);
      if (recovered >= N) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(recovered, 'all committed events recovered after SIGKILL + restart').toBe(N);
  });

  it('recovers fsync’d lines behind a tail torn mid-UTF-8-codepoint', async () => {
    // A crash can tear the WAL inside a multi-byte UTF-8 sequence (any
    // non-ASCII string in an event). The file is then not valid UTF-8 as a
    // whole; recovery must still replay every complete line before the tear —
    // a whole-file UTF-8 validation failure must never cost committed events.
    rootDir = mkdtempSync(join(tmpdir(), 'rs-conf-dur-utf8-'));
    const wsPort = port; const httpPort = port + 1; port += 4;

    // 1. Boot once so the data dir + SQLite exist, then hard-kill.
    current = spawnAt(rootDir, wsPort, httpPort);
    await waitReady(httpPort);
    current.proc.kill('SIGKILL');
    await new Promise<void>((r) => current!.proc.on('exit', () => r()));

    // 2. Fabricate the post-crash WAL: N good lines whose events carry
    //    multi-byte UTF-8, then a final line torn mid-codepoint ('é' is
    //    0xC3 0xA9 — only the 0xC3 byte made it to disk).
    const N = 20;
    const goodLines = Array.from({ length: N }, (_, i) =>
      JSON.stringify({
        seq: i + 1,
        project: PROJECT,
        event: {
          eventId: `evt-utf8-${i}`,
          sessionId: 'sess-utf8',
          timestamp: Date.now(),
          eventType: 'network',
          url: `https://example.com/héllo/wörld/日本語/${i}`,
          method: 'GET',
          status: 200,
          duration: 5,
        },
      })
    );
    const tornTail = Buffer.concat([
      Buffer.from(`{"seq":${N + 1},"project":"${PROJECT}","event":{"eventId":"torn","msg":"h`),
      Buffer.from([0xc3]), // first byte of a 2-byte codepoint — never completed
    ]);
    const walDir = join(rootDir, '.runtimescope', 'wal');
    mkdirSync(walDir, { recursive: true });
    writeFileSync(
      join(walDir, 'active.jsonl'),
      Buffer.concat([Buffer.from(goodLines.join('\n') + '\n'), tornTail])
    );

    // 3. Restart — every complete line must be healed past the tear and replayed.
    current = spawnAt(rootDir, wsPort, httpPort);
    await waitReady(httpPort);
    const deadline = Date.now() + 8000;
    let recovered = 0;
    while (Date.now() < deadline) {
      recovered = await fetch(`http://127.0.0.1:${httpPort}/api/events/network?project_id=${PROJECT}`)
        .then((r) => r.json()).then((d: { count: number }) => d.count).catch(() => 0);
      if (recovered >= N) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(recovered, 'good lines before a torn UTF-8 tail must be recovered').toBe(N);
  });
});
