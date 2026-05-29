/**
 * Conformance: every event family round-trips.
 *
 * `event-roundtrip` proves the network path with field fidelity; this proves the
 * STORE + READ API handle all the event families the SDKs emit — console, state,
 * render, performance, database, custom, ui — each sent over the WS event-batch
 * frame and queried back via its `/api/events/<route>` endpoint.
 *
 * This is the gate for Milestone 2 (the full read API): the Rust collector must
 * store + return every family, not just network. Passes against the Node
 * collector today (the source of truth); the current Rust slice only does
 * network, so it will fail these until M2 — which is the point.
 *
 * Note the route↔type mismatch for renders (`/api/events/renders` ← eventType
 * `render`). Source: packages/collector/src/http-server.ts route table.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnCollector, SdkDriver, type SpawnedCollector } from '../harness/index.js';

let collector: SpawnedCollector | null = null;
afterEach(async () => { await collector?.stop(); collector = null; });

function makeEvent(type: string, sessionId: string, i: number, fields: Record<string, unknown>): object {
  return {
    eventId: `evt-${type}-${i}-${randomBytes(4).toString('hex')}`,
    sessionId,
    timestamp: Date.now(),
    eventType: type,
    ...fields,
  };
}

// HTTP route ↔ eventType ↔ a minimal valid payload (fields from types.ts).
const FAMILIES: Array<{ route: string; type: string; fields: (i: number) => Record<string, unknown> }> = [
  { route: 'console', type: 'console', fields: (i) => ({ level: 'log', message: `msg ${i}`, args: [] }) },
  { route: 'state', type: 'state', fields: (i) => ({ storeId: 's1', library: 'zustand', phase: 'update', state: { n: i } }) },
  { route: 'renders', type: 'render', fields: (i) => ({ profiles: [], snapshotWindowMs: 1000, totalRenders: i, suspiciousComponents: [] }) },
  { route: 'performance', type: 'performance', fields: (i) => ({ metricName: 'LCP', value: 1000 + i }) },
  { route: 'database', type: 'database', fields: (i) => ({ query: 'SELECT 1', normalizedQuery: 'SELECT ?', duration: 5, tablesAccessed: ['t'], operation: 'SELECT', source: 'pg' }) },
  { route: 'custom', type: 'custom', fields: (i) => ({ name: 'my_event', properties: { i } }) },
  { route: 'ui', type: 'ui', fields: (i) => ({ action: 'click', target: `#btn-${i}` }) },
];

const N = 8;
const PROJECT = 'proj_event_families';

describe('event families round-trip', () => {
  it('every family is queryable via its /api/events/<route> endpoint with the right count', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const driver = new SdkDriver({ wsPort: collector.wsPort, appName: 'fam', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 100));

    // Send N of each family in one session.
    for (const fam of FAMILIES) {
      driver.sendBatch(Array.from({ length: N }, (_, i) => makeEvent(fam.type, driver.sessionId, i, fam.fields(i))));
    }
    await driver.flush();
    await new Promise((r) => setTimeout(r, 800));

    // Each family must come back with exactly N, scoped to the project.
    for (const fam of FAMILIES) {
      const url = `http://127.0.0.1:${collector.httpPort}/api/events/${fam.route}?project_id=${PROJECT}`;
      const body = await fetch(url).then((r) => r.json()) as { data: unknown[]; count: number };
      expect(body.count, `${fam.type} → /api/events/${fam.route} count`).toBe(N);
      expect(body.data.length, `${fam.type} data length`).toBe(N);
    }

    await driver.close();
  });
});
