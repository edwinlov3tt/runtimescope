/**
 * Conformance: HTTP /api/events/* query filters actually FILTER.
 *
 * The audit (docs/audits/0002-rust-port-audit.md) found the gate asserted
 * counts/existence — never that a filter narrows the result set by the right
 * predicate. So a collector that ignored a query param (returning everything)
 * still passed. This spec locks the REAL filtering behavior of the read API:
 * each supported filter returns ONLY the rows matching it.
 *
 * Source of truth — packages/collector/src/http-server.ts route handlers +
 * packages/collector/src/store.ts (getNetworkRequests / getConsoleMessages):
 *
 *   GET /api/events/network  reads: since_seconds, url_pattern, method,
 *                                   session_id, project_id
 *     - method      → case-insensitive exact match (ne.method.toUpperCase())
 *     - url_pattern → substring match (ne.url.includes(pattern))
 *     - since_seconds → timestamp >= Date.now() - since_seconds*1000
 *     - NOTE: the route does NOT read `status`. The store supports a `status`
 *       filter, but the network handler never forwards it, so `&status=500`
 *       is a NO-OP at the HTTP layer. We lock that real behavior (returns all),
 *       per ADR-0006 — Node is the source of truth; we assert what it does,
 *       not what we wish it did.
 *
 *   GET /api/events/console  reads: since_seconds, level, search,
 *                                   session_id, project_id
 *     - level → exact match (ce.level === level)
 *
 * All routes envelope as { data: [...], count: number }.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnCollector, SdkDriver, type SpawnedCollector } from '../harness/index.js';

let collector: SpawnedCollector | null = null;
afterEach(async () => { await collector?.stop(); collector = null; });

const PROJECT = 'proj_conf_http_filters';

interface EventsBody {
  data: Array<Record<string, unknown>>;
  count: number;
}

async function getEvents(httpPort: number, path: string): Promise<EventsBody> {
  const res = await fetch(`http://127.0.0.1:${httpPort}${path}`);
  expect(res.status, `${path} should be 200`).toBe(200);
  const body = (await res.json()) as EventsBody;
  expect(Array.isArray(body.data), `${path} data is array`).toBe(true);
  expect(body.count, `${path} count === data.length`).toBe(body.data.length);
  return body;
}

/** Poll the network endpoint until the unfiltered count reaches `want`. */
async function waitForNetworkCount(httpPort: number, want: number, ms = 5000): Promise<number> {
  const deadline = Date.now() + ms;
  let last = 0;
  while (Date.now() < deadline) {
    const r = await getEvents(httpPort, `/api/events/network?project_id=${PROJECT}`);
    last = r.count;
    if (last >= want) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

async function waitForConsoleCount(httpPort: number, want: number, ms = 5000): Promise<number> {
  const deadline = Date.now() + ms;
  let last = 0;
  while (Date.now() < deadline) {
    const r = await getEvents(httpPort, `/api/events/console?project_id=${PROJECT}`);
    last = r.count;
    if (last >= want) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

function netEvent(sessionId: string, fields: {
  id: string;
  url: string;
  method: string;
  status: number;
  timestamp: number;
}): object {
  return {
    eventId: `net-${fields.id}`,
    sessionId,
    timestamp: fields.timestamp,
    eventType: 'network',
    url: fields.url,
    method: fields.method,
    status: fields.status,
    requestHeaders: {},
    responseHeaders: { 'content-type': 'application/json' },
    requestBodySize: 0,
    responseBodySize: 64,
    duration: 10,
    ttfb: 2,
    source: 'fetch',
  };
}

function consoleEvent(sessionId: string, fields: {
  id: string;
  level: string;
  message: string;
  timestamp: number;
}): object {
  return {
    eventId: `con-${fields.id}`,
    sessionId,
    timestamp: fields.timestamp,
    eventType: 'console',
    level: fields.level,
    message: fields.message,
    args: [],
    source: 'browser',
  };
}

describe('http /api/events/* query filters', () => {
  it('network: method, url_pattern, since_seconds each narrow the result set (and status is a no-op)', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const driver = new SdkDriver({ wsPort: collector.wsPort, appName: 'conf-filters', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 100));

    const now = Date.now();
    const old = now - 60_000; // 60s ago — outside a since_seconds=1 window

    // A deliberate mix across every dimension a filter discriminates on:
    //   - method: GET vs POST
    //   - status: 200 vs 500
    //   - url:    /users vs /orders substrings
    //   - time:   one event timestamped 60s in the past
    const batch = [
      netEvent(driver.sessionId, { id: 'a', url: 'https://api.test/users/1',  method: 'GET',  status: 200, timestamp: now }),
      netEvent(driver.sessionId, { id: 'b', url: 'https://api.test/users/2',  method: 'POST', status: 500, timestamp: now }),
      netEvent(driver.sessionId, { id: 'c', url: 'https://api.test/orders/9', method: 'POST', status: 200, timestamp: now }),
      netEvent(driver.sessionId, { id: 'd', url: 'https://api.test/orders/8', method: 'GET',  status: 500, timestamp: old }),
    ];
    driver.sendBatch(batch);
    await driver.flush();

    const total = await waitForNetworkCount(collector.httpPort, batch.length);
    expect(total).toBe(4);

    // --- method=POST → only the two POSTs (b, c) ---
    const post = await getEvents(collector.httpPort, `/api/events/network?project_id=${PROJECT}&method=POST`);
    expect(post.count).toBe(2);
    expect(post.data.every((e) => e.method === 'POST')).toBe(true);
    expect(new Set(post.data.map((e) => e.eventId))).toEqual(new Set(['net-b', 'net-c']));

    // method is case-insensitive (route lowercases? no — store .toUpperCase()s both sides).
    const postLower = await getEvents(collector.httpPort, `/api/events/network?project_id=${PROJECT}&method=post`);
    expect(postLower.count).toBe(2);
    expect(new Set(postLower.data.map((e) => e.eventId))).toEqual(new Set(['net-b', 'net-c']));

    // --- url_pattern=/users → substring match, only a + b ---
    const users = await getEvents(collector.httpPort, `/api/events/network?project_id=${PROJECT}&url_pattern=${encodeURIComponent('/users')}`);
    expect(users.count).toBe(2);
    expect(users.data.every((e) => String(e.url).includes('/users'))).toBe(true);
    expect(new Set(users.data.map((e) => e.eventId))).toEqual(new Set(['net-a', 'net-b']));

    // --- since_seconds=1 → only the 3 recent events; the 60s-old one (d) drops ---
    const recent = await getEvents(collector.httpPort, `/api/events/network?project_id=${PROJECT}&since_seconds=1`);
    expect(recent.count).toBe(3);
    expect(recent.data.some((e) => e.eventId === 'net-d')).toBe(false);
    expect(new Set(recent.data.map((e) => e.eventId))).toEqual(new Set(['net-a', 'net-b', 'net-c']));

    // --- status=500 is NOT a route param → NO-OP. Node returns ALL 4, not just
    //     the two 500s. This is the real contract; do not "fix" it here. ---
    const status500 = await getEvents(collector.httpPort, `/api/events/network?project_id=${PROJECT}&status=500`);
    expect(status500.count).toBe(4);

    await driver.close();
  });

  it('console: level filters to exactly that level', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const driver = new SdkDriver({ wsPort: collector.wsPort, appName: 'conf-filters-con', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 100));

    const now = Date.now();
    const batch = [
      consoleEvent(driver.sessionId, { id: 'log1',  level: 'log',   message: 'hello log one',   timestamp: now }),
      consoleEvent(driver.sessionId, { id: 'log2',  level: 'log',   message: 'hello log two',   timestamp: now }),
      consoleEvent(driver.sessionId, { id: 'err1',  level: 'error', message: 'boom one',        timestamp: now }),
    ];
    driver.sendBatch(batch);
    await driver.flush();

    const total = await waitForConsoleCount(collector.httpPort, batch.length);
    expect(total).toBe(3);

    // --- level=error → only the single error (err1) ---
    const errors = await getEvents(collector.httpPort, `/api/events/console?project_id=${PROJECT}&level=error`);
    expect(errors.count).toBe(1);
    expect(errors.data.every((e) => e.level === 'error')).toBe(true);
    expect(errors.data[0].eventId).toBe('con-err1');

    // --- level=log → only the two logs, never the error ---
    const logs = await getEvents(collector.httpPort, `/api/events/console?project_id=${PROJECT}&level=log`);
    expect(logs.count).toBe(2);
    expect(logs.data.every((e) => e.level === 'log')).toBe(true);
    expect(new Set(logs.data.map((e) => e.eventId))).toEqual(new Set(['con-log1', 'con-log2']));

    await driver.close();
  });
});
