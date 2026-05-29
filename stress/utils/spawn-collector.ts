/**
 * Boot a fresh standalone RuntimeScope collector on a random pair of ports
 * and return handles so a stress scenario can talk to it + tear it down.
 *
 * Each scenario gets its own collector — total isolation, no shared SQLite,
 * no cross-pollination, no port-stealing from other test runs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SpawnedCollector {
  /** WS port for SDK clients. */
  wsPort: number;
  /** HTTP port for `/api/events/*`, `/metrics`, `/readyz`, etc. */
  httpPort: number;
  /** Throwaway `~/.runtimescope`-equivalent — deleted on stop(). */
  rootDir: string;
  /** Child process running the standalone. */
  proc: ChildProcess;
  /** Human label for the collector under test — "node" or the binary basename.
   *  Used by the bench harness to key baselines per implementation. */
  label: string;
  /** Wait until /readyz returns 200. Throws if it never does. */
  ready: () => Promise<void>;
  /** Kill the collector and remove its data directory. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Resolve the command that launches the collector under test.
 *
 * Default: today's Node standalone (`node packages/collector/dist/standalone.js`).
 * Override: set `RUNTIMESCOPE_COLLECTOR_CMD` to any executable — e.g. the Rust
 * collector binary at `./target/release/runtimescope-collector`. The whole
 * stress + bench suite then runs against that binary unchanged, which is how we
 * prove the Rust port is behaviorally equivalent before trusting it (differential
 * testing: identical suite, two implementations, identical observable results).
 *
 * The override may include space-separated args, e.g. "cargo run -q --bin coll".
 * The launched process MUST honor RUNTIMESCOPE_PORT / RUNTIMESCOPE_HTTP_PORT /
 * RUNTIMESCOPE_BUFFER_SIZE and serve /readyz — that's part of the locked contract.
 */
export function resolveCollectorCmd(): { cmd: string; args: string[]; label: string } {
  const override = process.env.RUNTIMESCOPE_COLLECTOR_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    const cmd = parts[0];
    const label = (cmd.split('/').pop() || cmd).replace(/\.[^.]+$/, '');
    return { cmd, args: parts.slice(1), label };
  }
  const distPath = join(
    new URL('.', import.meta.url).pathname,
    '..',
    '..',
    'packages',
    'collector',
    'dist',
    'standalone.js',
  );
  return { cmd: 'node', args: [distPath], label: 'node' };
}

let nextPort = 47000 + Math.floor(Math.random() * 1000);

/**
 * Find an unused TCP port pair (ws, ws+1). We just probe sequentially upward;
 * stress tests are local-only so we won't collide with anything serious.
 */
async function nextFreePair(): Promise<[number, number]> {
  // No real probing — port-retry on the collector side handles binding race.
  // The standalone binds ws first, then http, retrying upward on conflict.
  const start = nextPort;
  nextPort += 4; // leave headroom for the collector's port-retry
  return [start, start + 1];
}

export async function spawnCollector(
  options: {
    otelEndpoint?: string;
    bufferSize?: number;
    /** Override the SQLite idle-eviction timeout (ms). Used by the
     *  memory-leak scenario to drive eviction on a 1-second window
     *  instead of the 5-minute production default. */
    sqliteIdleMs?: number;
    sqliteSweepMs?: number;
  } = {},
): Promise<SpawnedCollector> {
  const [wsPort, httpPort] = await nextFreePair();
  const rootDir = mkdtempSync(join(tmpdir(), 'rs-stress-'));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: rootDir, // forces ~/.runtimescope to live under our temp dir
    RUNTIMESCOPE_PORT: String(wsPort),
    RUNTIMESCOPE_HTTP_PORT: String(httpPort),
  };
  if (options.otelEndpoint) env.RUNTIMESCOPE_OTEL_ENDPOINT = options.otelEndpoint;
  if (options.bufferSize) env.RUNTIMESCOPE_BUFFER_SIZE = String(options.bufferSize);
  if (options.sqliteIdleMs !== undefined) {
    env.RUNTIMESCOPE_SQLITE_IDLE_MS = String(options.sqliteIdleMs);
  }
  if (options.sqliteSweepMs !== undefined) {
    env.RUNTIMESCOPE_SQLITE_SWEEP_MS = String(options.sqliteSweepMs);
  }

  const { cmd, args, label } = resolveCollectorCmd();

  const proc = spawn(cmd, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Capture output so a failing stress scenario can dump useful context.
  const logLines: string[] = [];
  proc.stdout?.on('data', (b: Buffer) => logLines.push(b.toString()));
  proc.stderr?.on('data', (b: Buffer) => logLines.push(b.toString()));

  let stopped = false;
  let stopResolve: (() => void) | null = null;
  const exitPromise = new Promise<void>((resolve) => { stopResolve = resolve; });
  proc.on('exit', () => { stopResolve?.(); });

  const ready = async () => {
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
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // Dump the collector's own logs so the failure mode is visible.
    throw new Error(
      `Collector at :${httpPort} never reached /readyz=ready within 15s.\n--- collector log ---\n${logLines.join('').slice(-2000)}`,
    );
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!proc.killed) {
      proc.kill('SIGTERM');
      // Give it 2s to drain WAL + close DB. After that, force.
      const forced = setTimeout(() => proc.kill('SIGKILL'), 2000);
      await exitPromise;
      clearTimeout(forced);
    }
    try {
      if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  return { wsPort, httpPort, rootDir, proc, label, ready, stop };
}
