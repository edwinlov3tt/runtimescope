import { describe, it, expect, afterEach } from 'vitest';
import {
  MetricsRegistry,
  Counter,
  Gauge,
  CollectorServer,
  HttpServer,
  EventStore,
} from '../index.js';
import { makeNetworkEvent, makeConsoleEvent } from './factories.js';

describe('Phase 4: MetricsRegistry primitives', () => {
  it('Counter increments and renders the Prometheus exposition format', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('rs_test_total', 'A test counter', ['type']);
    c.inc(1, { type: 'network' });
    c.inc(3, { type: 'network' });
    c.inc(1, { type: 'console' });

    const text = reg.render();
    expect(text).toContain('# HELP rs_test_total A test counter');
    expect(text).toContain('# TYPE rs_test_total counter');
    expect(text).toContain('rs_test_total{type="network"} 4');
    expect(text).toContain('rs_test_total{type="console"} 1');
  });

  it('Counter rejects negative or non-finite values', () => {
    const c = new Counter('rs_x', 'h');
    c.inc(-1);
    c.inc(NaN);
    c.inc(Infinity);
    expect(c.collect()).toEqual([]);
  });

  it('Gauge.set + Gauge.setCollect both work', () => {
    const reg = new MetricsRegistry();
    const fixed = reg.gauge('rs_fixed', 'static');
    fixed.set(42);
    expect(reg.render()).toContain('rs_fixed 42');

    let live = 0;
    const dynamic = reg.gauge('rs_dyn', 'dynamic');
    dynamic.setCollect(() => live);
    live = 7;
    expect(reg.render()).toContain('rs_dyn 7');
    live = 99;
    expect(reg.render()).toContain('rs_dyn 99');
  });

  it('Gauge accepts label-aware setCollect output', () => {
    const reg = new MetricsRegistry();
    const g = reg.gauge('rs_with_labels', 'h', ['shard']);
    g.setCollect(() => [
      { labels: { shard: 'a' }, value: 1 },
      { labels: { shard: 'b' }, value: 2 },
    ]);
    const text = reg.render();
    expect(text).toContain('rs_with_labels{shard="a"} 1');
    expect(text).toContain('rs_with_labels{shard="b"} 2');
  });

  it('escapes special characters in label values', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('rs_escape_total', 'h', ['msg']);
    c.inc(1, { msg: 'a "b" \\ c\nd' });
    const text = reg.render();
    // Quotes, backslashes, and newlines must all be escaped per the spec.
    expect(text).toContain('rs_escape_total{msg="a \\"b\\" \\\\ c\\nd"} 1');
  });

  it('rejects invalid metric names', () => {
    const reg = new MetricsRegistry();
    expect(() => reg.counter('1bad', 'h')).toThrow(/Invalid metric name/);
    expect(() => reg.counter('with space', 'h')).toThrow();
  });

  it('renders with a trailing newline', () => {
    const reg = new MetricsRegistry();
    reg.counter('rs_a', 'h').inc();
    expect(reg.render().endsWith('\n')).toBe(true);
  });

  it('Gauge.collect() handles +Inf, -Inf, NaN per Prometheus spec', () => {
    const g = new Gauge('rs_special', 'h');
    g.set(Number.POSITIVE_INFINITY);
    expect(g.collect()[0].value).toBe(Number.POSITIVE_INFINITY);
    const reg = new MetricsRegistry();
    const g2 = reg.gauge('rs_inf', 'h');
    g2.set(Number.POSITIVE_INFINITY);
    expect(reg.render()).toContain('rs_inf +Inf');
  });
});

describe('Phase 4: CollectorServer metrics wiring', () => {
  let collector: CollectorServer | null = null;

  afterEach(async () => {
    try { collector?.stop(); } catch { /* ignore */ }
    collector = null;
    await new Promise((r) => setTimeout(r, 30));
  });

  it('runtimescope_events_total increments per event by type', async () => {
    collector = new CollectorServer({ bufferSize: 100 });
    await collector.start({ port: 0, maxRetries: 0 });
    const store = collector.getStore();

    store.addEvent(makeNetworkEvent({ eventId: 'n1' }));
    store.addEvent(makeNetworkEvent({ eventId: 'n2' }));
    store.addEvent(makeConsoleEvent({ eventId: 'c1' }));

    const text = collector.getMetricsRegistry().render();
    expect(text).toContain('runtimescope_events_total{type="network"} 2');
    expect(text).toContain('runtimescope_events_total{type="console"} 1');
  });

  it('exposes uptime, sessions_connected, buffer_size, projects, workspaces gauges', async () => {
    collector = new CollectorServer({ bufferSize: 100 });
    await collector.start({ port: 0, maxRetries: 0 });
    const text = collector.getMetricsRegistry().render();

    expect(text).toContain('# TYPE runtimescope_collector_uptime_seconds gauge');
    expect(text).toContain('# TYPE runtimescope_sessions_connected gauge');
    expect(text).toContain('# TYPE runtimescope_buffer_size gauge');
    expect(text).toContain('# TYPE runtimescope_projects gauge');
    expect(text).toContain('# TYPE runtimescope_workspaces gauge');

    // Buffer should reflect store.eventCount.
    collector.getStore().addEvent(makeNetworkEvent({ eventId: 'x' }));
    const after = collector.getMetricsRegistry().render();
    expect(after).toContain('runtimescope_buffer_size 1');
  });
});

describe('Phase 4: GET /metrics endpoint', () => {
  let httpServer: HttpServer | null = null;

  afterEach(async () => {
    try { await httpServer?.stop(); } catch { /* ignore */ }
    httpServer = null;
    delete process.env.RUNTIMESCOPE_DISABLE_METRICS;
    await new Promise((r) => setTimeout(r, 30));
  });

  it('returns text/plain with Prometheus exposition format', async () => {
    const reg = new MetricsRegistry();
    reg.counter('rs_demo_total', 'demo').inc(5);
    const store = new EventStore(100);
    httpServer = new HttpServer(store, undefined, {
      renderMetrics: () => reg.render(),
    });
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
    const body = await res.text();
    expect(body).toContain('rs_demo_total 5');
    expect(body).toContain('# TYPE rs_demo_total counter');
  });

  it('returns 404 when RUNTIMESCOPE_DISABLE_METRICS=1', async () => {
    process.env.RUNTIMESCOPE_DISABLE_METRICS = '1';
    const store = new EventStore(100);
    httpServer = new HttpServer(store, undefined, {
      renderMetrics: () => 'should-not-be-served',
    });
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Metrics disabled');
  });

  it('is reachable without auth even when authManager is enabled', async () => {
    const { AuthManager } = await import('../auth.js');
    const auth = new AuthManager({ enabled: true, apiKeys: [{ key: 'k_test', label: 't' }] });
    const reg = new MetricsRegistry();
    reg.counter('rs_x', 'h').inc(1);
    const store = new EventStore(100);
    httpServer = new HttpServer(store, undefined, {
      authManager: auth,
      renderMetrics: () => reg.render(),
    });
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);

    // Sanity: a non-public route still requires auth.
    const guarded = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(guarded.status).toBe(401);
  });

  it('returns an empty body when no renderMetrics callback is provided', async () => {
    const store = new EventStore(100);
    httpServer = new HttpServer(store, undefined, {});
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});
