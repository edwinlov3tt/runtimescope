/**
 * Conformance: event round-trip.
 *
 * The core data contract: events sent over the WS event-batch frame
 * ({ type:'event', payload:{ events:[...] } }) become queryable via the HTTP
 * read API with their fields intact. This is what every MCP tool and the
 * dashboard ultimately depend on.
 *
 * Source of truth: server.ts (event case), http-server.ts (/api/events/*),
 * types.ts (event shapes).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnCollector, SdkDriver, makeNetEvent, type SpawnedCollector } from '../harness/index.js';

let collector: SpawnedCollector | null = null;
afterEach(async () => { await collector?.stop(); collector = null; });

const PROJECT = 'proj_conf_roundtrip';

/** Poll /api/events/network until count ≥ want or timeout. */
async function waitForCount(httpPort: number, want: number, ms = 5000): Promise<number> {
  const deadline = Date.now() + ms;
  let last = 0;
  while (Date.now() < deadline) {
    const r = await fetch(`http://127.0.0.1:${httpPort}/api/events/network?project_id=${PROJECT}`).then((x) => x.json()) as { count: number };
    last = r.count;
    if (last >= want) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

describe('event round-trip', () => {
  it('network events sent over WS are queryable over HTTP with fields intact', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const driver = new SdkDriver({ wsPort: collector.wsPort, appName: 'conf-rt', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 100));

    const N = 25;
    const batch = Array.from({ length: N }, (_, i) => makeNetEvent(driver.sessionId, i));
    driver.sendBatch(batch);
    await driver.flush();

    const count = await waitForCount(collector.httpPort, N);
    expect(count).toBe(N);

    const body = await fetch(`http://127.0.0.1:${collector.httpPort}/api/events/network?project_id=${PROJECT}`).then((r) => r.json()) as {
      data: Array<{ url: string; method: string; status: number }>;
      count: number;
    };
    expect(body.count).toBe(N);
    expect(body.data.length).toBe(N);
    // Field fidelity: shapes survive the round-trip.
    const sample = body.data[0];
    expect(sample.method).toBe('GET');
    expect(sample.status).toBe(200);
    expect(sample.url).toMatch(/example\.com\/api\/test\//);

    await driver.close();
  });

  it('events from a different project are isolated by project_id', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const a = new SdkDriver({ wsPort: collector.wsPort, appName: 'conf-a', projectId: 'proj_conf_a' });
    const b = new SdkDriver({ wsPort: collector.wsPort, appName: 'conf-b', projectId: 'proj_conf_b' });
    await a.connect(); await b.connect();
    await new Promise((r) => setTimeout(r, 100));

    a.sendBatch(Array.from({ length: 10 }, (_, i) => makeNetEvent(a.sessionId, i)));
    b.sendBatch(Array.from({ length: 3 }, (_, i) => makeNetEvent(b.sessionId, i)));
    await a.flush(); await b.flush();
    await new Promise((r) => setTimeout(r, 500));

    const countA = await fetch(`http://127.0.0.1:${collector.httpPort}/api/events/network?project_id=proj_conf_a`).then((r) => r.json()).then((d: { count: number }) => d.count);
    const countB = await fetch(`http://127.0.0.1:${collector.httpPort}/api/events/network?project_id=proj_conf_b`).then((r) => r.json()).then((d: { count: number }) => d.count);
    expect(countA).toBe(10);
    expect(countB).toBe(3);

    await a.close(); await b.close();
  });
});
