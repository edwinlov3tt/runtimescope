/**
 * Scenario: memory-leak
 *
 * Long-running pseudo-soak: 10 cycles of (connect → flood → disconnect) with
 * heap measurements after each. If anything in the collector retains
 * references between session lifecycles — the session map, sqlite stores,
 * WAL handles, the OTel queue, the metrics counters — the heap will trend
 * upward across cycles instead of plateauing.
 *
 * We measure heap via `node --expose-gc`-style hooks unavailable from outside
 * the process, so we use the next best thing: /metrics's
 * runtimescope_buffer_size + a sample of the collector's RSS via `ps`.
 *
 * Pass condition: heap grows by less than 50% from cycle 1 to cycle 10. A
 * real leak shows linear growth and trips this easily.
 */

import { spawnCollector } from '../utils/spawn-collector.js';
import { SdkDriver, makeNetEvent } from '../utils/sdk-driver.js';
import { CheckCollector } from '../utils/assert.js';
import { execFileSync } from 'node:child_process';

const CYCLES = 10;
const EVENTS_PER_CYCLE = 2_000;

async function rssMb(pid: number): Promise<number> {
  try {
    // RSS in KB on macOS/Linux. Convert to MB.
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'rss='], {
      encoding: 'utf-8',
    }).trim();
    return Math.round(Number(out) / 1024);
  } catch {
    return 0;
  }
}

export async function memoryLeak(checks: CheckCollector): Promise<void> {
  // Tight eviction window so the per-project SQLite store handles get
  // closed during the test instead of after the 5-minute production
  // default. Without this, the test can't observe the LRU eviction fix.
  const collector = await spawnCollector({
    bufferSize: 10_000,
    sqliteIdleMs: 1_000,
    sqliteSweepMs: 500,
  });
  try {
    await collector.ready();
    const pid = collector.proc.pid!;

    const samples: number[] = [];
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const driver = new SdkDriver({
        wsPort: collector.wsPort,
        appName: `leak-test-${cycle}`,
        projectId: `proj_leak_${cycle}`,
      });
      await driver.connect();

      const batch: object[] = [];
      for (let i = 0; i < EVENTS_PER_CYCLE; i++) batch.push(makeNetEvent(driver.sessionId, i));
      // Send in chunks of 200 so each WS message stays under ~256KB.
      for (let i = 0; i < batch.length; i += 200) {
        driver.sendBatch(batch.slice(i, i + 200));
      }
      await driver.flush();
      await driver.close();

      // Wait past the idle threshold so this cycle's store gets evicted
      // before we sample. Without this, every cycle's handle is still open
      // and the growth measurement reflects pre-fix behaviour.
      await new Promise((r) => setTimeout(r, 1_500));

      const rss = await rssMb(pid);
      samples.push(rss);
    }

    const first = samples[0];
    const last = samples[samples.length - 1];
    const growth = ((last - first) / first) * 100;

    checks.ok(
      `RSS samples (MB) across ${CYCLES} cycles: ${samples.join(' → ')}`,
      true,
    );
    // Pre-fix this was 49% — a hair under the 50% gate, hiding a real
    // per-project handle leak. With LRU eviction in place, observed
    // growth is ~28-36% depending on whether earlier scenarios warmed
    // V8's heap in this process (the harness runs scenarios sequentially
    // in the same node process, so memory-leak after framework-smoke
    // sees a hotter starting baseline than memory-leak in isolation).
    // The 40% gate still catches a real regression to per-project-
    // permanent handles (which trips at ≥47%) without flaking on
    // V8/SQLite hygiene noise.
    checks.leq(
      `heap growth from cycle 1 to ${CYCLES}`,
      growth,
      40,
      '%',
    );

    // Sessions map shouldn't grow unboundedly either. After all cycles, the
    // session map has CYCLES entries (one per project session). That's fine
    // and bounded. But if it had thousands, that'd indicate a leak in the
    // disconnect cleanup.
    const sessions = (await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/sessions`,
    ).then((r) => r.json())) as { data: unknown[] };
    checks.leq('session map size proportional to cycles', sessions.data.length, CYCLES * 2);
  } finally {
    await collector.stop();
  }
}
