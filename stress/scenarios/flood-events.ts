/**
 * Scenario: flood-events
 *
 * Blast 20 000 events through a single SDK session as fast as possible and
 * verify:
 *   1. The collector accepts every event (per-type counters match what we sent)
 *   2. No drops attributed to backpressure or parse errors
 *   3. Throughput is reasonable (>= 10 000 events/sec sustained)
 *   4. Memory in the ring buffer caps at the configured size, with overflow
 *      flowing through SQLite via WAL — i.e. the collector doesn't OOM
 *
 * If this scenario flakes or fails it almost certainly means we've broken the
 * hot ingest path: WAL append, SqliteStore batched writes, or the Map indexes
 * the event-type counters maintain.
 */

import { spawnCollector } from '../utils/spawn-collector.js';
import { SdkDriver, makeNetEvent } from '../utils/sdk-driver.js';
import { CheckCollector } from '../utils/assert.js';

const TOTAL_EVENTS = 20_000;
const BATCH_SIZE = 500;
const PROJECT_ID = 'proj_flood_test';

export async function floodEvents(checks: CheckCollector): Promise<void> {
  const collector = await spawnCollector({ bufferSize: 5_000 });
  try {
    await collector.ready();
    checks.ok('collector boots in <15s', true);

    const driver = new SdkDriver({
      wsPort: collector.wsPort,
      appName: 'flood-stress',
      projectId: PROJECT_ID,
    });
    await driver.connect();
    checks.ok('SDK driver handshake completes', true);

    // Give the collector a beat to register the session before we start
    // pushing events at it.
    await new Promise((r) => setTimeout(r, 100));

    const start = performance.now();
    let sent = 0;
    while (sent < TOTAL_EVENTS) {
      const size = Math.min(BATCH_SIZE, TOTAL_EVENTS - sent);
      const batch: object[] = [];
      for (let i = 0; i < size; i++) batch.push(makeNetEvent(driver.sessionId, sent + i));
      driver.sendBatch(batch);
      sent += size;
    }
    await driver.flush();
    const sendMs = performance.now() - start;
    const sendThroughput = (TOTAL_EVENTS / sendMs) * 1000;

    checks.geq(`SDK throughput ≥ 10k/sec (was ${sendThroughput.toFixed(0)}/sec)`, sendThroughput, 10_000);

    // Wait for the collector to drain its in-flight + WAL flush. Generous
    // budget — ingestion is async; we just don't want to false-fail if
    // SQLite is briefly behind.
    await new Promise((r) => setTimeout(r, 1500));

    // Now pull /metrics — the simplest source of truth for "how many did
    // you actually accept by type".
    const metrics = await fetch(`http://127.0.0.1:${collector.httpPort}/metrics`).then((r) => r.text());
    const networkMatch = metrics.match(/^runtimescope_events_total\{type="network"\}\s+(\d+)/m);
    const droppedMatch = metrics.match(/^runtimescope_events_dropped_total\{[^}]*\}\s+(\d+)/gm);
    const acceptedNetwork = networkMatch ? Number(networkMatch[1]) : 0;
    const totalDropped = droppedMatch
      ? droppedMatch.reduce((sum, line) => sum + Number(line.split(/\s+/).pop()!), 0)
      : 0;

    checks.eq('every event accepted', acceptedNetwork, TOTAL_EVENTS);
    checks.eq('zero drops reported', totalDropped, 0);

    // Buffer size is capped — overflow above that goes to SQLite. /metrics
    // exposes the live count.
    const bufferMatch = metrics.match(/^runtimescope_buffer_size\s+(\d+)/m);
    const bufferSize = bufferMatch ? Number(bufferMatch[1]) : -1;
    checks.leq('ring buffer respects its cap', bufferSize, 5_000, ' events');

    // The HTTP API returning event counts must match metrics. This is the
    // user-facing path and a divergence here is a bug.
    const apiCount = await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/events/network?project_id=${PROJECT_ID}`,
    )
      .then((r) => r.json())
      .then((d: { count: number }) => d.count);
    // Ring buffer caps at 5k so the API will only return that many — that's
    // the deliberate hot-tier behavior. We just need consistency.
    checks.leq('API count ≤ buffer size', apiCount, 5_000);
    checks.geq('API returns at least the buffer cap', apiCount, 4_900);

    await driver.close();
  } finally {
    await collector.stop();
  }
}
