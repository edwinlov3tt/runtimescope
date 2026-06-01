/**
 * Conformance: HTTP ingest path + timeline merge + unknown-route 404.
 *
 * Three behaviors the count/existence gate missed entirely:
 *
 *  1. POST /api/events — the serverless ingest path used by the Workers SDK and
 *     the Python SDK (they cannot hold a WebSocket). A JSON body
 *     { sessionId, appName, projectId, events:[...] } must be accepted, the
 *     handler must reply with the exact ingest receipt
 *     { accepted, dropped, rejected, sessionId } and a 200, AND the events must
 *     actually land in the store — provably so by reading them back through the
 *     normal /api/events/<type>?project_id=P read API (the WS path's read API).
 *     A stub that returns {ok:true} without storing would pass an existence
 *     check but fails here.
 *
 *  2. GET /api/events/timeline?project_id=P — must MERGE event families into one
 *     chronological stream. We POST a mix of network + console + custom and
 *     assert the timeline contains all three eventTypes, preserves insertion
 *     (send) order across families, and its count reflects the merge (not a
 *     single family). Node's store.getEventTimeline returns buffer.toArray()
 *     (oldest-inserted → newest-inserted), so it is insertion-ordered, not a
 *     timestamp re-sort — the spec locks the actual behavior, not an assumption.
 *
 *  3. GET /api/events/<unknown> — Node registers explicit /api/events/<type>
 *     routes; an unregistered one falls through to the 404 fallback returning
 *     { error, path } with the requested pathname echoed back.
 *
 * Source of truth: packages/collector/src/http-server.ts
 *   - POST /api/events handler (~line 457): receipt shape + 200/429 status
 *   - GET /api/events/timeline handler (~line 411) + store.getEventTimeline
 *     (chronological, full RuntimeEvent rows incl. eventType)
 *   - 404 fallback (~line 1017): { error:'Not found', path: url.pathname }
 *
 * GREEN against the Node collector (the source of truth). The Rust slice does
 * not implement the HTTP POST ingest path / timeline merge, so it is expected
 * to fail these — which is the gap this spec exists to catch.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnCollector, type SpawnedCollector } from '../harness/index.js';

let collector: SpawnedCollector | null = null;
afterEach(async () => { await collector?.stop(); collector = null; });

const PROJECT = 'proj_http_ingest';

/** POST a batch over the HTTP ingest path (the Workers/Python seam). */
async function postEvents(
  httpPort: number,
  body: { sessionId: string; appName?: string; projectId?: string; events: object[] },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Build a network event with an explicit timestamp so ordering is deterministic. */
function netEvent(sessionId: string, i: number, ts: number): object {
  return {
    eventId: `net-${i}-${randomBytes(4).toString('hex')}`,
    sessionId,
    timestamp: ts,
    eventType: 'network',
    url: `https://example.com/api/http/${i}`,
    method: 'POST',
    status: 201,
    requestHeaders: {},
    responseHeaders: { 'content-type': 'application/json' },
    requestBodySize: 0,
    responseBodySize: 42,
    duration: 7,
    ttfb: 2,
    source: 'http-ingest',
  };
}

function consoleEvent(sessionId: string, i: number, ts: number): object {
  return {
    eventId: `con-${i}-${randomBytes(4).toString('hex')}`,
    sessionId,
    timestamp: ts,
    eventType: 'console',
    level: 'error',
    message: `boom ${i}`,
    args: [],
  };
}

function customEvent(sessionId: string, i: number, ts: number): object {
  return {
    eventId: `cus-${i}-${randomBytes(4).toString('hex')}`,
    sessionId,
    timestamp: ts,
    eventType: 'custom',
    name: 'checkout',
    properties: { i },
  };
}

describe('http ingest + routes', () => {
  it('POST /api/events accepts a batch, returns the ingest receipt, and the events land in the read API', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const sessionId = `http-${randomBytes(6).toString('hex')}`;
    const base = Date.now();
    const N = 6;
    const events = Array.from({ length: N }, (_, i) => netEvent(sessionId, i, base + i));

    const { status, json } = await postEvents(collector.httpPort, {
      sessionId,
      appName: 'http-app',
      projectId: PROJECT,
      events,
    });

    // Exact ingest receipt — not a vague {ok:true}.
    expect(status).toBe(200);
    expect(json.accepted).toBe(N);
    expect(json.dropped).toBe(0);
    expect(json.rejected).toBe(0);
    expect(json.sessionId).toBe(sessionId);

    // The whole point: events POSTed over HTTP are queryable over the read API
    // scoped by project_id (proves they actually entered the store, not echoed).
    const read = await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/events/network?project_id=${PROJECT}`,
    ).then((r) => r.json()) as { data: Array<{ url: string; method: string; status: number }>; count: number };

    expect(read.count).toBe(N);
    expect(read.data.length).toBe(N);
    // Field fidelity through the HTTP ingest path.
    const sample = read.data[0];
    expect(sample.method).toBe('POST');
    expect(sample.status).toBe(201);
    expect(sample.url).toMatch(/example\.com\/api\/http\//);
  });

  it('POST /api/events rejects events with an unknown eventType (counted in `rejected`) but accepts the valid ones', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const sessionId = `http-${randomBytes(6).toString('hex')}`;
    const base = Date.now();
    const events: object[] = [
      netEvent(sessionId, 0, base),
      netEvent(sessionId, 1, base + 1),
      // Unknown eventType — Node validates against VALID_EVENT_TYPES and rejects.
      { eventId: `bad-${randomBytes(4).toString('hex')}`, sessionId, timestamp: base + 2, eventType: 'not_a_real_type' },
    ];

    const { status, json } = await postEvents(collector.httpPort, {
      sessionId,
      appName: 'http-app-mixed',
      projectId: `${PROJECT}_mixed`,
      events,
    });

    expect(status).toBe(200);
    expect(json.accepted).toBe(2);
    expect(json.rejected).toBe(1);
    expect(json.dropped).toBe(0);
  });

  it('POST /api/events backfills a missing eventId/timestamp so the event is stored, not silently dropped', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const sessionId = `http-${randomBytes(6).toString('hex')}`;
    const PROJ = `${PROJECT}_backfill`;
    // A Workers/Python client may omit eventId + timestamp. Node backfills both
    // (eventId = "http-<ts>-<rand>", timestamp = now); the event MUST land in the
    // store, not be no-op'd by INSERT OR IGNORE on an empty id.
    const events = [
      { sessionId, eventType: 'network', url: 'https://example.com/api/no-id-1',
        method: 'GET', status: 200, requestHeaders: {}, responseHeaders: {},
        requestBodySize: 0, responseBodySize: 10, duration: 5, ttfb: 1, source: 'http-ingest' },
      { sessionId, eventType: 'network', url: 'https://example.com/api/no-id-2',
        method: 'GET', status: 200, requestHeaders: {}, responseHeaders: {},
        requestBodySize: 0, responseBodySize: 10, duration: 5, ttfb: 1, source: 'http-ingest' },
    ];

    const { status, json } = await postEvents(collector.httpPort, {
      sessionId, appName: 'http-backfill', projectId: PROJ, events,
    });
    expect(status).toBe(200);
    expect(json.accepted).toBe(2);

    // Both events are queryable — proves the backfilled eventId let them persist.
    const read = await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/events/network?project_id=${PROJ}`,
    ).then((r) => r.json()) as { data: Array<{ url: string }>; count: number };
    expect(read.count).toBe(2);
    expect(read.data.length).toBe(2);
  });

  it('POST /api/events validates the payload: empty events array → 400 INVALID_PAYLOAD', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const res = await fetch(`http://127.0.0.1:${collector.httpPort}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sx', appName: 'a', projectId: 'p', events: [] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('INVALID_PAYLOAD');
    expect(body.error).toBeTruthy();
  });

  it('GET /api/events/timeline merges mixed families into one chronological stream', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const sessionId = `http-${randomBytes(6).toString('hex')}`;
    const base = Date.now();
    // Interleave families with strictly increasing timestamps so we can assert
    // both the MERGE (all three types present) and the ORDERING (chronological).
    const events: object[] = [
      netEvent(sessionId, 0, base + 0),
      consoleEvent(sessionId, 0, base + 1),
      customEvent(sessionId, 0, base + 2),
      netEvent(sessionId, 1, base + 3),
      consoleEvent(sessionId, 1, base + 4),
    ];

    const post = await postEvents(collector.httpPort, {
      sessionId,
      appName: 'http-timeline',
      projectId: `${PROJECT}_timeline`,
      events,
    });
    expect(post.status).toBe(200);
    expect(post.json.accepted).toBe(events.length);

    const tl = await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/events/timeline?project_id=${PROJECT}_timeline`,
    ).then((r) => r.json()) as { data: Array<{ eventType: string; timestamp: number }>; count: number };

    // Merge: the timeline holds multiple families, not a single one.
    const types = new Set(tl.data.map((e) => e.eventType));
    expect(types.has('network')).toBe(true);
    expect(types.has('console')).toBe(true);
    expect(types.has('custom')).toBe(true);
    expect(types.size).toBeGreaterThanOrEqual(3);

    // Count reflects the merge: at least the 5 we sent (Node also auto-registers
    // a `session` row on first sight of this sessionId, so >= is the contract).
    expect(tl.count).toBeGreaterThanOrEqual(events.length);
    expect(tl.count).toBe(tl.data.length);

    // The five events we sent are all present, by eventId.
    const idOrder = tl.data.map((e) => (e as { eventId?: string }).eventId);
    const ids = new Set(idOrder);
    for (const ev of events) expect(ids.has((ev as { eventId: string }).eventId)).toBe(true);

    // Ordering: store.getEventTimeline returns buffer.toArray() — oldest-inserted
    // → newest-inserted (insertion order, NOT a timestamp re-sort). So the five
    // events we POSTed appear in the SAME relative order we sent them, merged
    // across families. (Node also inserts a `session` row first on first sight
    // of this sessionId; we only assert the relative order of OUR events.)
    const sentOrder = events.map((ev) => (ev as { eventId: string }).eventId);
    const observedOfOurs = idOrder.filter((id) => sentOrder.includes(id!));
    expect(observedOfOurs).toEqual(sentOrder);
  });

  it('GET /api/events/timeline?event_types= filters the merged stream to the requested families', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const sessionId = `http-${randomBytes(6).toString('hex')}`;
    const base = Date.now();
    const events: object[] = [
      netEvent(sessionId, 0, base + 0),
      consoleEvent(sessionId, 0, base + 1),
      customEvent(sessionId, 0, base + 2),
    ];
    const proj = `${PROJECT}_filter`;
    await postEvents(collector.httpPort, { sessionId, appName: 'http-filter', projectId: proj, events });

    const tl = await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/events/timeline?project_id=${proj}&event_types=network,console`,
    ).then((r) => r.json()) as { data: Array<{ eventType: string }>; count: number };

    const types = new Set(tl.data.map((e) => e.eventType));
    expect(types.has('network')).toBe(true);
    expect(types.has('console')).toBe(true);
    // The filter actually filters: custom (and the session row) are excluded.
    expect(types.has('custom')).toBe(false);
    expect(types.has('session')).toBe(false);
    expect(tl.count).toBe(2);
  });

  it('GET /api/events/timeline?session_id= filters the merged stream to one session', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const sA = `http-${randomBytes(6).toString('hex')}`;
    const sB = `http-${randomBytes(6).toString('hex')}`;
    const base = Date.now();
    const proj = `${PROJECT}_tlsession`;
    await postEvents(collector.httpPort, {
      sessionId: sA, appName: 'http-tls-a', projectId: proj,
      events: [netEvent(sA, 0, base + 0), consoleEvent(sA, 0, base + 1)],
    });
    await postEvents(collector.httpPort, {
      sessionId: sB, appName: 'http-tls-b', projectId: proj,
      events: [netEvent(sB, 0, base + 2)],
    });

    const tl = await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/events/timeline?project_id=${proj}&session_id=${sA}`,
    ).then((r) => r.json()) as { data: Array<{ sessionId: string; eventId: string }>; count: number };

    // Only session A's events (Node matchesSessionFilter = exact match) — none of B's.
    expect(tl.data.every((e) => e.sessionId === sA)).toBe(true);
    expect(tl.data.some((e) => e.sessionId === sB)).toBe(false);
    expect(tl.count).toBe(tl.data.length);
  });

  it('GET /api/events/timeline?since_seconds= excludes events older than the cutoff', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const sessionId = `http-${randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const proj = `${PROJECT}_tlsince`;
    // One ancient event (2h old) + one recent; since_seconds=3600 keeps only recent.
    await postEvents(collector.httpPort, {
      sessionId, appName: 'http-tls', projectId: proj,
      events: [netEvent(sessionId, 0, now - 7200_000), consoleEvent(sessionId, 0, now)],
    });

    const tl = await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/events/timeline?project_id=${proj}&since_seconds=3600`,
    ).then((r) => r.json()) as { data: Array<{ eventType: string; timestamp: number }>; count: number };

    // The 2h-old network event is excluded; the just-now console event survives.
    expect(tl.data.some((e) => e.eventType === 'console')).toBe(true);
    expect(tl.data.every((e) => e.timestamp >= now - 3600_000)).toBe(true);
    expect(tl.data.some((e) => e.timestamp === now - 7200_000)).toBe(false);
  });

  it('GET an unknown /api/events/<kind> route returns 404 { error, path }', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const res = await fetch(`http://127.0.0.1:${collector.httpPort}/api/events/nope`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; path: string };
    expect(body.error).toBe('Not found');
    expect(body.path).toBe('/api/events/nope');
  });
});
