/**
 * Conformance: HTTP response item FIELD FIDELITY.
 *
 * The existing gate proved counts and a few network fields round-trip, but it
 * never pinned the full SHAPE of a `data[i]` item. The store getters
 * (getNetworkRequests / getConsoleMessages / getPerformanceMetrics in store.ts)
 * return the stored events VERBATIM — no projection, no rename, no nesting, no
 * numeric→string coercion. That raw-passthrough is the contract external
 * consumers (dashboard, tray, MCP tools) bind to. A reimplementation that
 * reshapes (e.g. nests timing under `timing.duration`, stringifies `timestamp`,
 * folds headers into a flat string, or drops `eventType`) would still pass a
 * count-only gate while breaking every consumer.
 *
 * This spec sends KNOWN network + console + performance events with fully
 * specified payloads and asserts the returned item has the EXACT field NAMES
 * and JS TYPES Node emits — discovered by reading http-server.ts (handlers call
 * store getters and `json(res, { data, count })`) + store.ts (getters return the
 * raw `*Event` objects) + types.ts (the canonical event shapes). The values are
 * echoed back unchanged, so we assert by-value where the value is load-bearing.
 *
 * Source of truth: packages/collector/src/{http-server.ts,store.ts,types.ts}.
 *
 * GREEN vs the Node collector (the default). EXPECTED RED vs the Rust binary
 * until it returns byte-identical raw events — which is the gap this catches.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnCollector, SdkDriver, type SpawnedCollector } from '../harness/index.js';

let collector: SpawnedCollector | null = null;
afterEach(async () => { await collector?.stop(); collector = null; });

const PROJECT = 'proj_field_fidelity';

/** Poll an /api/events/<route> endpoint until count ≥ want or timeout. */
async function waitForCount(httpPort: number, route: string, want: number, ms = 5000): Promise<number> {
  const deadline = Date.now() + ms;
  let last = 0;
  while (Date.now() < deadline) {
    const r = await fetch(`http://127.0.0.1:${httpPort}/api/events/${route}?project_id=${PROJECT}`)
      .then((x) => x.json()) as { count: number };
    last = r.count;
    if (last >= want) return last;
    await new Promise((res) => setTimeout(res, 50));
  }
  return last;
}

async function queryData(httpPort: number, route: string): Promise<Array<Record<string, unknown>>> {
  const body = await fetch(`http://127.0.0.1:${httpPort}/api/events/${route}?project_id=${PROJECT}`)
    .then((r) => r.json()) as { data: Array<Record<string, unknown>>; count: number };
  return body.data;
}

const evtId = (label: string) => `evt-${label}-${randomBytes(6).toString('hex')}`;

describe('http response item field fidelity', () => {
  it('network items are returned raw: exact field names + JS types, timing as top-level numbers', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const driver = new SdkDriver({ wsPort: collector.wsPort, appName: 'ff-net', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 100));

    const sentAt = 1_700_000_000_123; // fixed, known timestamp (ms epoch)
    const sent = {
      eventId: evtId('net'),
      sessionId: driver.sessionId,
      timestamp: sentAt,
      eventType: 'network',
      url: 'https://api.example.com/widgets/42?q=1',
      method: 'POST',
      status: 201,
      requestHeaders: { 'content-type': 'application/json' },
      responseHeaders: { 'content-type': 'application/json', 'x-trace': 'abc' },
      requestBodySize: 17,
      responseBodySize: 4096,
      duration: 123.5,
      ttfb: 12,
      source: 'fetch',
    };
    driver.sendBatch([sent]);
    await driver.flush();

    expect(await waitForCount(collector.httpPort, 'network', 1)).toBe(1);
    const data = await queryData(collector.httpPort, 'network');
    expect(data.length).toBe(1);
    const item = data[0];

    // --- Identity / base fields survive verbatim, NOT renamed or dropped. ---
    expect(item.eventType).toBe('network');               // type tag preserved
    expect(typeof item.eventId).toBe('string');
    expect(item.eventId).toBe(sent.eventId);
    expect(typeof item.sessionId).toBe('string');
    expect(item.sessionId).toBe(driver.sessionId);

    // --- timestamp is a NUMBER (ms epoch), not an ISO string, not nested. ---
    expect(typeof item.timestamp).toBe('number');
    expect(item.timestamp).toBe(sentAt);

    // --- Core request fields: exact names + types + values. ---
    expect(typeof item.url).toBe('string');
    expect(item.url).toBe(sent.url);
    expect(typeof item.method).toBe('string');
    expect(item.method).toBe('POST');                     // NOT lowercased / normalized
    expect(typeof item.status).toBe('number');
    expect(item.status).toBe(201);

    // --- Timing is TOP-LEVEL numbers (duration/ttfb), not nested under a
    //     `timing` object and not stringified. Float precision preserved. ---
    expect(typeof item.duration).toBe('number');
    expect(item.duration).toBe(123.5);
    expect(typeof item.ttfb).toBe('number');
    expect(item.ttfb).toBe(12);
    expect(item.timing).toBeUndefined();                  // never reshaped into a sub-object

    // --- Byte counts: top-level numbers with the exact field names. ---
    expect(typeof item.requestBodySize).toBe('number');
    expect(item.requestBodySize).toBe(17);
    expect(typeof item.responseBodySize).toBe('number');
    expect(item.responseBodySize).toBe(4096);

    // --- Headers stay structured objects, not flattened to a string. ---
    expect(typeof item.requestHeaders).toBe('object');
    expect(Array.isArray(item.requestHeaders)).toBe(false);
    expect((item.requestHeaders as Record<string, string>)['content-type']).toBe('application/json');
    expect(typeof item.responseHeaders).toBe('object');
    expect((item.responseHeaders as Record<string, string>)['x-trace']).toBe('abc');

    await driver.close();
  });

  it('console items preserve level/message/args with exact names + types', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const driver = new SdkDriver({ wsPort: collector.wsPort, appName: 'ff-con', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 100));

    const sentAt = 1_700_000_000_777;
    const sent = {
      eventId: evtId('con'),
      sessionId: driver.sessionId,
      timestamp: sentAt,
      eventType: 'console',
      level: 'warn',
      message: 'disk almost full',
      args: ['detail', 42, { nested: true }],
      source: 'server',
    };
    driver.sendBatch([sent]);
    await driver.flush();

    expect(await waitForCount(collector.httpPort, 'console', 1)).toBe(1);
    const data = await queryData(collector.httpPort, 'console');
    expect(data.length).toBe(1);
    const item = data[0];

    expect(item.eventType).toBe('console');
    expect(typeof item.timestamp).toBe('number');
    expect(item.timestamp).toBe(sentAt);

    // level: exact field name, exact string value (not numeric severity).
    expect(typeof item.level).toBe('string');
    expect(item.level).toBe('warn');

    // message: a string under the name `message` (NOT `text` / `msg`).
    expect(typeof item.message).toBe('string');
    expect(item.message).toBe('disk almost full');

    // args: an ARRAY, preserved structurally (not JSON-stringified into one blob).
    expect(Array.isArray(item.args)).toBe(true);
    const args = item.args as unknown[];
    expect(args.length).toBe(3);
    expect(args[0]).toBe('detail');
    expect(args[1]).toBe(42);
    expect(args[2]).toEqual({ nested: true });

    await driver.close();
  });

  it('performance items preserve metricName/value with exact names + numeric type', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const driver = new SdkDriver({ wsPort: collector.wsPort, appName: 'ff-perf', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 100));

    const sentAt = 1_700_000_001_000;
    const sent = {
      eventId: evtId('perf'),
      sessionId: driver.sessionId,
      timestamp: sentAt,
      eventType: 'performance',
      metricName: 'LCP',
      value: 2345.67,
      rating: 'needs-improvement',
      unit: 'ms',
    };
    driver.sendBatch([sent]);
    await driver.flush();

    expect(await waitForCount(collector.httpPort, 'performance', 1)).toBe(1);
    const data = await queryData(collector.httpPort, 'performance');
    expect(data.length).toBe(1);
    const item = data[0];

    expect(item.eventType).toBe('performance');
    expect(typeof item.timestamp).toBe('number');
    expect(item.timestamp).toBe(sentAt);

    // metricName: exact field name (NOT `name` / `metric`), exact value.
    expect(typeof item.metricName).toBe('string');
    expect(item.metricName).toBe('LCP');

    // value: a NUMBER under `value`, float precision intact (not stringified).
    expect(typeof item.value).toBe('number');
    expect(item.value).toBe(2345.67);

    // Optional fields that were sent are echoed back with their names + types.
    expect(typeof item.rating).toBe('string');
    expect(item.rating).toBe('needs-improvement');
    expect(typeof item.unit).toBe('string');
    expect(item.unit).toBe('ms');

    await driver.close();
  });
});
