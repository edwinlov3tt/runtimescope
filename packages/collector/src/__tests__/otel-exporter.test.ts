import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  OtelExporter,
  parseOtelHeaders,
  otelOptionsFromEnv,
  traceIdFromSession,
  CollectorServer,
} from '../index.js';
import {
  makeNetworkEvent,
  makeConsoleEvent,
  makeRenderEvent,
  makePerformanceEvent,
  makeDatabaseEvent,
} from './factories.js';

interface CapturedRequest {
  path: string;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Spin up a tiny HTTP server that mimics the OTLP `/v1/{traces,logs,metrics}`
 * endpoints, captures the JSON bodies, and shuts down cleanly. Used as the
 * stand-in for an OTel collector in unit tests.
 */
async function startCapture(): Promise<{
  server: Server;
  endpoint: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
  setStatus: (code: number) => void;
}> {
  const captured: CapturedRequest[] = [];
  let nextStatus = 200;

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push({
        path: req.url ?? '',
        body: body ? JSON.parse(body) : null,
        headers: req.headers,
      });
      res.writeHead(nextStatus, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port =
    addr && typeof addr === 'object' && typeof addr.port === 'number' ? addr.port : 0;

  return {
    server,
    endpoint: `http://127.0.0.1:${port}`,
    captured,
    setStatus: (code) => { nextStatus = code; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Phase 5: OtelExporter wire format', () => {
  let cap: Awaited<ReturnType<typeof startCapture>>;

  beforeEach(async () => {
    cap = await startCapture();
  });

  afterEach(async () => {
    await cap.close();
  });

  it('converts a network event into an OTLP CLIENT span on /v1/traces', async () => {
    const exporter = new OtelExporter({ endpoint: cap.endpoint, flushIntervalMs: 1_000_000 });
    exporter.ingest(
      makeNetworkEvent({
        eventId: 'n1',
        sessionId: 'sess-A',
        url: 'https://api.example.com/users?token=secret',
        method: 'GET',
        status: 200,
        duration: 150,
        timestamp: 1_700_000_000_000,
      }),
    );
    await exporter.flush();

    expect(cap.captured).toHaveLength(1);
    const req = cap.captured[0];
    expect(req.path).toBe('/v1/traces');
    expect(req.headers['content-type']).toBe('application/json');

    const span = req.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.kind).toBe(3); // CLIENT
    expect(span.name).toBe('GET https://api.example.com/users');
    // 16-byte hex
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    // 8-byte hex
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    // Times in nanoseconds, end - start = duration in ns
    expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(150_000_000n);
    // Status OK for 200
    expect(span.status.code).toBe(1);

    const attrs = span.attributes as { key: string; value: any }[];
    const find = (k: string) => attrs.find((a) => a.key === k);
    expect(find('http.request.method')?.value.stringValue).toBe('GET');
    expect(find('http.response.status_code')?.value.intValue).toBe('200');

    await exporter.close();
  });

  it('marks 5xx as ERROR status', async () => {
    const exporter = new OtelExporter({ endpoint: cap.endpoint, flushIntervalMs: 1_000_000 });
    exporter.ingest(makeNetworkEvent({ eventId: 'fail', status: 503, duration: 10 }));
    await exporter.flush();

    const span = cap.captured[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status.code).toBe(2); // ERROR
    expect(span.status.message).toBe('HTTP 503');

    await exporter.close();
  });

  it('groups all events for one session under the same traceId', async () => {
    const exporter = new OtelExporter({ endpoint: cap.endpoint, flushIntervalMs: 1_000_000 });
    exporter.ingest(makeNetworkEvent({ sessionId: 'sess-X', duration: 1 }));
    exporter.ingest(makeDatabaseEvent({ sessionId: 'sess-X', duration: 1 }));
    await exporter.flush();

    const traces = cap.captured[0].body.resourceSpans[0].scopeSpans[0].spans;
    expect(traces).toHaveLength(2);
    expect(traces[0].traceId).toBe(traces[1].traceId);
    expect(traces[0].traceId).toBe(traceIdFromSession('sess-X'));
    expect(traces[0].spanId).not.toBe(traces[1].spanId);

    await exporter.close();
  });

  it('emits a database span with db.* attributes', async () => {
    const exporter = new OtelExporter({ endpoint: cap.endpoint, flushIntervalMs: 1_000_000 });
    exporter.ingest(
      makeDatabaseEvent({
        eventId: 'db1',
        query: 'SELECT * FROM users WHERE id = ?',
        operation: 'SELECT',
        source: 'pg',
        tablesAccessed: ['users'],
        duration: 12,
      }),
    );
    await exporter.flush();

    const span = cap.captured[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe('SELECT users');
    expect(span.kind).toBe(3); // CLIENT

    const attrs = span.attributes as { key: string; value: any }[];
    const find = (k: string) => attrs.find((a) => a.key === k);
    expect(find('db.system')?.value.stringValue).toBe('pg');
    expect(find('db.operation')?.value.stringValue).toBe('SELECT');
    expect(find('db.statement')?.value.stringValue).toBe('SELECT * FROM users WHERE id = ?');
    expect(find('db.sql.table')?.value.stringValue).toBe('users');

    await exporter.close();
  });

  it('emits one render span per profile', async () => {
    const exporter = new OtelExporter({ endpoint: cap.endpoint, flushIntervalMs: 1_000_000 });
    exporter.ingest(
      makeRenderEvent({
        profiles: [
          {
            componentName: 'A',
            renderCount: 1,
            totalDuration: 5,
            avgDuration: 5,
            lastRenderPhase: 'mount',
            renderVelocity: 1,
            suspicious: false,
          },
          {
            componentName: 'B',
            renderCount: 30,
            totalDuration: 200,
            avgDuration: 6.67,
            lastRenderPhase: 'update',
            renderVelocity: 30,
            suspicious: true,
          },
        ],
      }),
    );
    await exporter.flush();

    const spans = cap.captured[0].body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(2);
    expect(spans[0].name).toBe('render A');
    expect(spans[1].name).toBe('render B');
    expect(spans[1].status.code).toBe(2); // suspicious → ERROR

    await exporter.close();
  });

  it('console events become OTLP log records on /v1/logs with severity mapping', async () => {
    const exporter = new OtelExporter({ endpoint: cap.endpoint, flushIntervalMs: 1_000_000 });
    exporter.ingest(makeConsoleEvent({ level: 'info', message: 'hello' }));
    exporter.ingest(makeConsoleEvent({ level: 'error', message: 'boom', stackTrace: 'at x.js:1' }));
    await exporter.flush();

    const logsReq = cap.captured.find((r) => r.path === '/v1/logs');
    expect(logsReq).toBeDefined();
    const records = logsReq!.body.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(2);

    expect(records[0].severityNumber).toBe(9);  // INFO
    expect(records[0].severityText).toBe('info');
    expect(records[1].severityNumber).toBe(17); // ERROR
    expect(records[1].body.stringValue).toBe('boom');
    // Stacktrace surfaces as exception.* attributes for log-search backends.
    const errAttrs = records[1].attributes as { key: string; value: any }[];
    expect(errAttrs.some((a: any) => a.key === 'exception.stacktrace')).toBe(true);

    await exporter.close();
  });

  it('Web Vitals become OTLP gauge metrics with appropriate units', async () => {
    const exporter = new OtelExporter({ endpoint: cap.endpoint, flushIntervalMs: 1_000_000 });
    exporter.ingest(makePerformanceEvent({ metricName: 'LCP', value: 2400, rating: 'good' }));
    exporter.ingest(makePerformanceEvent({ metricName: 'CLS', value: 0.05, rating: 'good' }));
    await exporter.flush();

    const metricsReq = cap.captured.find((r) => r.path === '/v1/metrics');
    expect(metricsReq).toBeDefined();
    const metrics = metricsReq!.body.resourceMetrics[0].scopeMetrics[0].metrics;

    const lcp = metrics.find((m: any) => m.name === 'runtimescope.web_vitals.lcp');
    expect(lcp.unit).toBe('ms');
    expect(lcp.gauge.dataPoints[0].asDouble).toBe(2400);

    const cls = metrics.find((m: any) => m.name === 'runtimescope.web_vitals.cls');
    expect(cls.unit).toBe('1'); // unitless
    expect(cls.gauge.dataPoints[0].asDouble).toBe(0.05);

    await exporter.close();
  });

  it('forwards configured headers (auth tokens etc.)', async () => {
    const exporter = new OtelExporter({
      endpoint: cap.endpoint,
      headers: { authorization: 'Bearer test', 'x-honeycomb-team': 'k_xxx' },
      flushIntervalMs: 1_000_000,
    });
    exporter.ingest(makeNetworkEvent({ duration: 1 }));
    await exporter.flush();

    expect(cap.captured[0].headers.authorization).toBe('Bearer test');
    expect(cap.captured[0].headers['x-honeycomb-team']).toBe('k_xxx');

    await exporter.close();
  });

  it('flushes automatically when maxBatchSize is reached', async () => {
    const exporter = new OtelExporter({
      endpoint: cap.endpoint,
      flushIntervalMs: 1_000_000,
      maxBatchSize: 3,
    });
    exporter.ingest(makeNetworkEvent({ duration: 1 }));
    exporter.ingest(makeNetworkEvent({ duration: 1 }));
    exporter.ingest(makeNetworkEvent({ duration: 1 }));
    // Allow the fire-and-forget flush to settle
    await new Promise((r) => setTimeout(r, 30));

    expect(cap.captured.length).toBeGreaterThanOrEqual(1);
    await exporter.close();
  });

  it('survives a non-2xx response without throwing or crashing the collector', async () => {
    cap.setStatus(503);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exporter = new OtelExporter({ endpoint: cap.endpoint, flushIntervalMs: 1_000_000 });
    exporter.ingest(makeNetworkEvent({ duration: 1 }));
    await exporter.flush();

    expect(cap.captured).toHaveLength(1);
    // Failure logged but no exception escapes.
    expect(consoleSpy).toHaveBeenCalled();

    await exporter.close();
    consoleSpy.mockRestore();
  });

  it('skips event types it does not map (state/session/ui/dom_snapshot)', async () => {
    const exporter = new OtelExporter({ endpoint: cap.endpoint, flushIntervalMs: 1_000_000 });
    exporter.ingest({
      eventId: 'irrelevant',
      sessionId: 'sess-skip',
      timestamp: Date.now(),
      eventType: 'session',
      appName: 'x',
      connectedAt: Date.now(),
      sdkVersion: '0',
    });
    await exporter.flush();

    expect(cap.captured).toHaveLength(0);
    await exporter.close();
  });
});

describe('Phase 5: env-var configuration', () => {
  beforeEach(() => {
    delete process.env.RUNTIMESCOPE_OTEL_ENDPOINT;
    delete process.env.RUNTIMESCOPE_OTEL_HEADERS;
    delete process.env.RUNTIMESCOPE_OTEL_SERVICE_NAME;
  });

  it('parseOtelHeaders splits "k1=v1,k2=v2" pairs', () => {
    expect(parseOtelHeaders('a=1,b=2')).toEqual({ a: '1', b: '2' });
    expect(parseOtelHeaders('  authorization=Bearer xyz ')).toEqual({ authorization: 'Bearer xyz' });
    expect(parseOtelHeaders('')).toEqual({});
    expect(parseOtelHeaders(undefined)).toEqual({});
    // Malformed entries are dropped, not thrown.
    expect(parseOtelHeaders('=novalue,key=value')).toEqual({ key: 'value' });
  });

  it('otelOptionsFromEnv returns null when endpoint is absent', () => {
    expect(otelOptionsFromEnv()).toBeNull();
  });

  it('otelOptionsFromEnv reads endpoint, headers, and serviceName', () => {
    process.env.RUNTIMESCOPE_OTEL_ENDPOINT = 'http://otel:4318';
    process.env.RUNTIMESCOPE_OTEL_SERVICE_NAME = 'my-collector';
    process.env.RUNTIMESCOPE_OTEL_HEADERS = 'authorization=Bearer t';
    const opts = otelOptionsFromEnv();
    expect(opts).toEqual({
      endpoint: 'http://otel:4318',
      serviceName: 'my-collector',
      headers: { authorization: 'Bearer t' },
    });
  });
});

describe('Phase 5: CollectorServer integration', () => {
  let cap: Awaited<ReturnType<typeof startCapture>>;
  let collector: CollectorServer | null = null;

  beforeEach(async () => {
    cap = await startCapture();
  });

  afterEach(async () => {
    try { collector?.stop(); } catch { /* ignore */ }
    collector = null;
    await cap.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('exports events to the configured OTel endpoint when constructed with otel options', async () => {
    collector = new CollectorServer({
      bufferSize: 100,
      // Tiny batch so adding two events triggers the auto-flush — avoids
      // racing the timer-driven flush in a unit test.
      otel: { endpoint: cap.endpoint, flushIntervalMs: 1_000_000, maxBatchSize: 2 },
    });
    await collector.start({ port: 0, maxRetries: 0 });

    collector.getStore().addEvent(makeNetworkEvent({ duration: 1, sessionId: 'live' }));
    collector.getStore().addEvent(makeConsoleEvent({ sessionId: 'live', message: 'ok' }));

    // Wait for the auto-flush to round-trip to the capture server.
    await new Promise((r) => setTimeout(r, 100));

    expect(cap.captured.length).toBeGreaterThan(0);
    const traces = cap.captured.find((r) => r.path === '/v1/traces');
    expect(traces).toBeDefined();
  });
});
