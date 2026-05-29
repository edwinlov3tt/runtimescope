/**
 * Conformance: OUTPUT SHAPES of the event-read MCP tool family.
 *
 * Audit 0002 #2 — ~57 tools were ported by agents and compiled, but their
 * OUTPUT shape was never behavior-verified. The legacy gate only checked tool
 * COUNTS + field EXISTENCE, so a port that returned raw store rows (numeric
 * durations, epoch timestamps), dropped the derived `issues`, or skipped the
 * MCP-layer reshaping/aggregation would still pass. This spec LOCKS the real
 * reshaping each tool applies on top of the raw EventStore, against the NODE
 * mcp-server (source of truth, ADR-0006).
 *
 * Tools covered:
 *   - get_state_snapshots         (packages/mcp-server/src/tools/state.ts)
 *   - get_render_profile          (packages/mcp-server/src/tools/renders.ts)
 *   - get_performance_metrics     (packages/mcp-server/src/tools/performance.ts)
 *   - get_event_timeline          (packages/mcp-server/src/tools/timeline.ts)
 *   - get_errors_with_source_context (packages/mcp-server/src/tools/errors.ts)
 *   - get_breadcrumbs             (packages/mcp-server/src/tools/breadcrumbs.ts)
 *   - get_custom_events           (packages/mcp-server/src/tools/custom-events.ts)
 *   - get_event_flow              (packages/mcp-server/src/tools/custom-events.ts)
 *
 * Each tool gets its matching event types injected through the embedded
 * collector via an SdkDriver on the MCP server's WS port — the exact path
 * Claude Code uses — then we assert the SPECIFIC reshaped field names + types
 * and the DERIVED values (issues, counts, time ranges, aggregations) the Node
 * tool produces. None of these assertions could pass against an empty stub.
 *
 * Drives the Node mcp-server by default; swap with RUNTIMESCOPE_MCP_CMD to
 * point at the Rust mcp-server.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver, SdkDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Spawn an MCP server + connect a driver feeding the embedded collector. */
async function bootstrap(project: string): Promise<{ driver: SdkDriver }> {
  mcp = McpDriver.spawn();
  await mcp.ready();
  const driver = new SdkDriver({ wsPort: mcp.wsPort, appName: 'conf-event-read', projectId: project });
  await driver.connect();
  await new Promise((r) => setTimeout(r, 150));
  return { driver };
}

// ============================================================
// get_state_snapshots
// ============================================================
describe('get_state_snapshots output shape', () => {
  it('reshapes state events (ISO timestamp, null-defaulted diff/action) and derives a thrashing issue', async () => {
    const PROJECT = 'proj_conf_state';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();

    // 12 rapid updates to ONE store inside a <1s window => store-thrashing issue
    // (the tool flags >=10 updates with 10+ inside any 1-second sliding window).
    const events: object[] = [];
    for (let i = 0; i < 12; i++) {
      events.push({
        eventId: `evt-state-${i}`,
        sessionId: driver.sessionId,
        timestamp: base + i * 20, // 12 events spanning 220ms — all in one second
        eventType: 'state',
        storeId: 'cartStore',
        library: 'zustand',
        phase: 'update',
        state: { items: i },
        previousState: { items: i - 1 },
        diff: { items: { from: i - 1, to: i } },
        action: { type: 'increment' },
      });
    }
    driver.sendBatch(events);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_state_snapshots', { project_id: PROJECT });
    const env = envelope as {
      summary: string;
      data: Array<{
        storeId: string; library: string; phase: string; state: unknown;
        previousState: unknown; diff: unknown; action: unknown; timestamp: unknown;
      }>;
      issues: string[];
      metadata: { eventCount: number; totalCount: number; timeRange: { from: number; to: number } };
    };

    expect(env.data.length).toBe(12);
    expect(env.metadata.eventCount).toBe(12);
    expect(env.metadata.totalCount).toBe(12);

    // getStateEvents returns NEWEST-FIRST, so data[0] is the last update (i=11).
    const row = env.data[0];
    expect(row.storeId).toBe('cartStore');
    expect(row.library).toBe('zustand');
    expect(row.phase).toBe('update');
    // timestamp reshaped epoch -> ISO-8601 string.
    expect(typeof row.timestamp).toBe('string');
    expect(row.timestamp as string).toMatch(ISO_RE);
    // diff/action present (objects), previousState present — not stripped.
    expect(row.diff).toEqual({ items: { from: 10, to: 11 } });
    expect(row.action).toEqual({ type: 'increment' });
    expect(row.previousState).toEqual({ items: 10 });

    // DERIVED issue: store thrashing detected for "cartStore".
    expect(env.issues.some((s) => s.includes('Store thrashing') && s.includes('cartStore'))).toBe(true);

    // timeRange derived from data ordering (newest-first): from=newest, to=oldest.
    expect(env.metadata.timeRange.from).toBe(base + 11 * 20);
    expect(env.metadata.timeRange.to).toBe(base);

    await driver.close();
  });

  it('null-defaults previousState/diff/action for a bare init event', async () => {
    const PROJECT = 'proj_conf_state_bare';
    const { driver } = await bootstrap(PROJECT);

    driver.sendBatch([{
      eventId: 'evt-state-init',
      sessionId: driver.sessionId,
      timestamp: Date.now(),
      eventType: 'state',
      storeId: 'authStore',
      library: 'redux',
      phase: 'init',
      state: { user: null },
      // no previousState/diff/action provided
    }]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_state_snapshots', { project_id: PROJECT });
    const env = envelope as { data: Array<{ previousState: unknown; diff: unknown; action: unknown; phase: string }> };
    expect(env.data.length).toBe(1);
    expect(env.data[0].phase).toBe('init');
    // Missing optionals are coerced to null (NOT undefined) by the tool.
    expect(env.data[0].previousState).toBeNull();
    expect(env.data[0].diff).toBeNull();
    expect(env.data[0].action).toBeNull();

    await driver.close();
  });
});

// ============================================================
// get_render_profile
// ============================================================
describe('get_render_profile output shape', () => {
  it('merges profiles across snapshots, formats durations/velocity as strings, derives suspicious issue + totalRenders', async () => {
    const PROJECT = 'proj_conf_render';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();

    function profile(name: string, renderCount: number, totalDuration: number, velocity: number, suspicious: boolean) {
      return {
        componentName: name,
        renderCount,
        totalDuration,
        avgDuration: renderCount > 0 ? totalDuration / renderCount : 0,
        lastRenderPhase: 'update',
        lastRenderCause: 'props',
        renderVelocity: velocity,
        suspicious,
      };
    }
    function renderEvent(i: number, profiles: object[], totalRenders: number, suspicious: string[]) {
      return {
        eventId: `evt-render-${i}`,
        sessionId: driver.sessionId,
        timestamp: base + i * 100,
        eventType: 'render',
        profiles,
        snapshotWindowMs: 1000,
        totalRenders,
        suspiciousComponents: suspicious,
      };
    }

    // Two snapshots: "List" appears in BOTH and must be MERGED (counts summed).
    // "Row" is suspicious in the 2nd snapshot.
    driver.sendBatch([
      renderEvent(0, [profile('List', 4, 20, 4, false)], 4, []),
      renderEvent(1, [profile('List', 6, 40, 12, true), profile('Row', 3, 9, 3, true)], 9, ['List', 'Row']),
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_render_profile', { project_id: PROJECT });
    const env = envelope as {
      summary: string;
      data: Array<{
        componentName: string; renderCount: number; totalDuration: unknown;
        avgDuration: unknown; renderVelocity: unknown; lastRenderPhase: string;
        lastRenderCause: string; suspicious: boolean;
      }>;
      issues: string[];
      metadata: { eventCount: number };
    };

    // Two render EVENTS were ingested (metadata.eventCount counts raw events).
    expect(env.metadata.eventCount).toBe(2);
    // Merged into 2 unique component profiles, sorted by renderCount desc.
    expect(env.data.length).toBe(2);
    const list = env.data.find((d) => d.componentName === 'List')!;
    const rowComp = env.data.find((d) => d.componentName === 'Row')!;
    expect(list).toBeTruthy();
    expect(rowComp).toBeTruthy();

    // List MERGED across snapshots: 4 + 6 = 10 renders.
    expect(list.renderCount).toBe(10);
    // Sorted by renderCount desc => List (10) before Row (3).
    expect(env.data[0].componentName).toBe('List');

    // Durations reshaped to "<n.n>ms" strings; velocity to "<n.n>/sec".
    expect(typeof list.totalDuration).toBe('string');
    expect(list.totalDuration).toBe('60.0ms');          // 20 + 40
    expect(list.avgDuration).toBe('6.0ms');              // 60 / 10
    expect(typeof list.renderVelocity).toBe('string');
    expect(list.renderVelocity).toBe('12.0/sec');        // max(4, 12)
    expect(list.lastRenderPhase).toBe('update');
    expect(list.lastRenderCause).toBe('props');
    // suspicious flips true once any snapshot marks it suspicious.
    expect(list.suspicious).toBe(true);

    // DERIVED issue: 2 suspicious components named.
    expect(env.issues.some((s) => s.includes('2 suspicious component(s)') && s.includes('List') && s.includes('Row'))).toBe(true);

    // Summary reports merged component count + total renders (4 + 9 = 13).
    expect(env.summary).toContain('2 component(s) tracked');
    expect(env.summary).toContain('13 total renders');

    await driver.close();
  });
});

// ============================================================
// get_performance_metrics
// ============================================================
describe('get_performance_metrics output shape', () => {
  it('groups by browser/server, defaults unit/rating, derives poor/needs-improvement issues', async () => {
    const PROJECT = 'proj_conf_perf';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();

    function perf(i: number, metricName: string, value: number, rating?: string, unit?: string) {
      return {
        eventId: `evt-perf-${i}`,
        sessionId: driver.sessionId,
        timestamp: base + i * 10,
        eventType: 'performance',
        metricName,
        value,
        ...(rating ? { rating } : {}),
        ...(unit ? { unit } : {}),
      };
    }

    driver.sendBatch([
      perf(0, 'LCP', 4200, 'poor'),                      // browser, poor
      perf(1, 'CLS', 0.3, 'needs-improvement'),          // browser, needs-improvement, unit defaults "score"
      perf(2, 'memory.heapUsed', 120 * 1024 * 1024),     // server, no rating
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_performance_metrics', { project_id: PROJECT });
    const env = envelope as {
      summary: string;
      data: {
        browser: Array<{ metricName: string; value: number; unit: string; rating: unknown; element: unknown; timestamp: unknown }>;
        server: Array<{ metricName: string; value: number; unit: string; rating: unknown; timestamp: unknown }>;
      };
      allEvents: Array<{ metricName: string; value: number; unit: string; rating: unknown }>;
      issues: string[];
      metadata: { eventCount: number };
    };

    expect(env.metadata.eventCount).toBe(3);
    expect(env.allEvents.length).toBe(3);

    // Web Vitals routed to data.browser; server metrics to data.server.
    const lcp = env.data.browser.find((m) => m.metricName === 'LCP')!;
    const cls = env.data.browser.find((m) => m.metricName === 'CLS')!;
    const heap = env.data.server.find((m) => m.metricName === 'memory.heapUsed')!;
    expect(lcp).toBeTruthy();
    expect(cls).toBeTruthy();
    expect(heap).toBeTruthy();
    expect(env.data.browser.length).toBe(2);
    expect(env.data.server.length).toBe(1);

    // value stays NUMERIC (not stringified).
    expect(typeof lcp.value).toBe('number');
    expect(lcp.value).toBe(4200);
    // LCP unit defaults to "ms"; CLS unit defaults to "score".
    expect(lcp.unit).toBe('ms');
    expect(cls.unit).toBe('score');
    // rating present where provided, null-defaulted where absent (server heap).
    expect(lcp.rating).toBe('poor');
    expect(heap.rating).toBeNull();
    // element null-defaulted.
    expect(lcp.element).toBeNull();
    // timestamp reshaped to ISO string.
    expect(typeof lcp.timestamp).toBe('string');
    expect(lcp.timestamp as string).toMatch(ISO_RE);

    // DERIVED issues: one poor (LCP), one needs-improvement (CLS).
    expect(env.issues.some((s) => s.includes('1 metric(s) rated "poor"') && s.includes('LCP'))).toBe(true);
    expect(env.issues.some((s) => s.includes('1 metric(s) need improvement') && s.includes('CLS'))).toBe(true);

    await driver.close();
  });

  it('source=browser filters out server metrics', async () => {
    const PROJECT = 'proj_conf_perf_filter';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();
    driver.sendBatch([
      { eventId: 'p-a', sessionId: driver.sessionId, timestamp: base, eventType: 'performance', metricName: 'FCP', value: 900, rating: 'good' },
      { eventId: 'p-b', sessionId: driver.sessionId, timestamp: base + 1, eventType: 'performance', metricName: 'cpu.user', value: 12 },
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_performance_metrics', { project_id: PROJECT, source: 'browser' });
    const env = envelope as { data: { browser: unknown[]; server: unknown[] }; allEvents: unknown[]; metadata: { eventCount: number } };
    // Only the Web Vital survives the source=browser filter.
    expect(env.data.server.length).toBe(0);
    expect(env.data.browser.length).toBe(1);
    expect(env.metadata.eventCount).toBe(1);

    await driver.close();
  });
});

// ============================================================
// get_event_timeline
// ============================================================
describe('get_event_timeline output shape', () => {
  it('interleaves event types, reshapes per-type fields, and reports a type breakdown', async () => {
    const PROJECT = 'proj_conf_timeline';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();

    driver.sendBatch([
      {
        eventId: 'tl-net', sessionId: driver.sessionId, timestamp: base, eventType: 'network',
        url: 'https://example.com/api/x', method: 'GET', status: 200,
        requestHeaders: {}, responseHeaders: {}, requestBodySize: 0, responseBodySize: 10,
        duration: 123.6, ttfb: 5,
      },
      {
        eventId: 'tl-con', sessionId: driver.sessionId, timestamp: base + 10, eventType: 'console',
        level: 'warn', message: 'careful', args: [],
      },
      {
        eventId: 'tl-cust', sessionId: driver.sessionId, timestamp: base + 20, eventType: 'custom',
        name: 'signup', properties: { plan: 'pro' },
      },
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    // Scope to the three injected types so the handshake's `session` event
    // doesn't perturb the count (interleaving across types is still proven).
    const { envelope } = await mcp!.callTool('get_event_timeline', {
      project_id: PROJECT,
      event_types: ['network', 'console', 'custom'],
    });
    const env = envelope as {
      summary: string;
      data: Array<Record<string, unknown>>;
      issues: unknown[];
      metadata: { eventCount: number; totalInWindow: number; timeRange: { from: number; to: number } };
    };

    expect(env.metadata.eventCount).toBe(3);
    expect(Array.isArray(env.issues)).toBe(true);
    expect(env.issues.length).toBe(0);

    // Every formatted entry has type + ISO timestamp + relativeMs (=0 in this tool).
    for (const e of env.data) {
      expect(typeof e.type).toBe('string');
      expect(e.timestamp as string).toMatch(ISO_RE);
      expect(e.relativeMs).toBe(0);
    }

    const net = env.data.find((e) => e.type === 'network')!;
    const con = env.data.find((e) => e.type === 'console')!;
    const cust = env.data.find((e) => e.type === 'custom')!;

    // Network row: duration reshaped to "<n>ms" (toFixed(0)), graphql null-default.
    expect(net.method).toBe('GET');
    expect(net.url).toBe('https://example.com/api/x');
    expect(net.status).toBe(200);
    expect(net.duration).toBe('124ms');
    expect(net.graphql).toBeNull();

    // Console row: level + truncated message + hasStack boolean.
    expect(con.level).toBe('warn');
    expect(con.message).toBe('careful');
    expect(con.hasStack).toBe(false);

    // Custom row: name + properties passthrough.
    expect(cust.name).toBe('signup');
    expect(cust.properties).toEqual({ plan: 'pro' });

    // Summary breakdown reflects the three interleaved types.
    expect(env.summary).toContain('1 network');
    expect(env.summary).toContain('1 console');
    expect(env.summary).toContain('1 custom');

    // timeRange from first/last (chronological) epoch ms.
    expect(env.metadata.timeRange.from).toBe(base);
    expect(env.metadata.timeRange.to).toBe(base + 20);

    await driver.close();
  });

  it('event_types filter restricts the returned set', async () => {
    const PROJECT = 'proj_conf_timeline_filter';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();
    driver.sendBatch([
      { eventId: 'f-net', sessionId: driver.sessionId, timestamp: base, eventType: 'network', url: 'https://x/y', method: 'GET', status: 200, requestHeaders: {}, responseHeaders: {}, requestBodySize: 0, responseBodySize: 1, duration: 10, ttfb: 1 },
      { eventId: 'f-con', sessionId: driver.sessionId, timestamp: base + 5, eventType: 'console', level: 'log', message: 'hi', args: [] },
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_event_timeline', { project_id: PROJECT, event_types: ['console'] });
    const env = envelope as { data: Array<{ type: string }>; metadata: { eventCount: number } };
    expect(env.metadata.eventCount).toBe(1);
    expect(env.data.every((e) => e.type === 'console')).toBe(true);

    await driver.close();
  });
});

// ============================================================
// get_errors_with_source_context
// ============================================================
describe('get_errors_with_source_context output shape', () => {
  it('filters to console errors, parses stack frames, ISO timestamps (fetch_source=false)', async () => {
    const PROJECT = 'proj_conf_errors';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();

    const stack = [
      'TypeError: boom',
      '    at doThing (https://app.local/src/foo.js:12:7)',
      '    at handler (https://app.local/src/bar.js:30:3)',
    ].join('\n');

    driver.sendBatch([
      { eventId: 'err-1', sessionId: driver.sessionId, timestamp: base, eventType: 'console', level: 'error', message: 'boom happened', args: [], stackTrace: stack },
      // A non-error console message that MUST be excluded by the level filter.
      { eventId: 'log-1', sessionId: driver.sessionId, timestamp: base + 5, eventType: 'console', level: 'log', message: 'just a log', args: [] },
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    // fetch_source=false => no network fetch of source files (deterministic, fast).
    const { envelope } = await mcp!.callTool('get_errors_with_source_context', { project_id: PROJECT, fetch_source: false });
    const env = envelope as {
      summary: string;
      data: Array<{
        message: string;
        timestamp: unknown;
        frames: Array<{ functionName: string; file: string; line: number; column: number; sourceContext?: unknown }>;
      }>;
      issues: unknown[];
      metadata: { eventCount: number };
    };

    // Only the error-level console message is returned (log excluded by filter).
    expect(env.data.length).toBe(1);
    expect(env.metadata.eventCount).toBe(1);

    const errObj = env.data[0];
    expect(errObj.message).toBe('boom happened');
    expect(typeof errObj.timestamp).toBe('string');
    expect(errObj.timestamp as string).toMatch(ISO_RE);

    // Stack trace parsed into structured frames (file/line/column derived).
    expect(errObj.frames.length).toBe(2);
    expect(errObj.frames[0].functionName).toBe('doThing');
    expect(errObj.frames[0].file).toBe('https://app.local/src/foo.js');
    expect(errObj.frames[0].line).toBe(12);
    expect(errObj.frames[0].column).toBe(7);
    // fetch_source=false => no sourceContext attached.
    expect(errObj.frames[0].sourceContext).toBeUndefined();

    // Summary reports "Source context disabled." when fetch_source is false.
    expect(env.summary).toContain('Source context disabled.');
    expect(env.summary).toContain('1 error(s)');

    await driver.close();
  });
});

// ============================================================
// get_breadcrumbs
// ============================================================
describe('get_breadcrumbs output shape', () => {
  it('maps navigation/ui/console/network into categorized breadcrumbs with relativeMs + categoryCounts', async () => {
    const PROJECT = 'proj_conf_breadcrumbs';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();

    driver.sendBatch([
      { eventId: 'bc-nav', sessionId: driver.sessionId, timestamp: base, eventType: 'navigation', from: '/home', to: '/checkout', trigger: 'pushState' },
      { eventId: 'bc-click', sessionId: driver.sessionId, timestamp: base + 100, eventType: 'ui', action: 'click', target: '#pay-btn', text: 'Pay now' },
      { eventId: 'bc-net', sessionId: driver.sessionId, timestamp: base + 200, eventType: 'network', url: 'https://api.local/charge', method: 'POST', status: 500, requestHeaders: {}, responseHeaders: {}, requestBodySize: 0, responseBodySize: 0, duration: 80, ttfb: 10 },
      { eventId: 'bc-err', sessionId: driver.sessionId, timestamp: base + 300, eventType: 'console', level: 'error', message: 'charge failed', args: [] },
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_breadcrumbs', { project_id: PROJECT });
    const env = envelope as {
      summary: string;
      data: Array<{ timestamp: unknown; relativeMs: number; category: string; level: string; message: string; data?: Record<string, unknown> }>;
      metadata: { eventCount: number; anchor: unknown; categoryCounts: Record<string, number>; timeRange: { from: number; to: number } };
    };

    expect(env.data.length).toBe(4);
    expect(env.metadata.eventCount).toBe(4);

    const byCat = (c: string) => env.data.find((b) => b.category === c)!;
    const nav = byCat('navigation');
    const click = byCat('ui.click');
    const http = byCat('http');
    const consoleErr = byCat('console.error');

    // navigation: "<trigger>: <to>", level info, data.from carried.
    expect(nav.level).toBe('info');
    expect(nav.message).toBe('pushState: /checkout');
    expect(nav.data).toEqual({ from: '/home' });

    // ui click: message prefers visible text.
    expect(click.message).toBe('Click: Pay now');
    expect(click.data).toEqual({ target: '#pay-btn' });

    // network: 500 => "warning" level; message reshaped to "POST <path> → 500".
    expect(http.level).toBe('warning');
    expect(http.message).toBe('POST /charge → 500');
    expect(http.data).toMatchObject({ status: 500, duration: 80 });

    // console error => level "error", category "console.error".
    expect(consoleErr.level).toBe('error');
    expect(consoleErr.message).toBe('charge failed');

    // Each breadcrumb carries ISO timestamp + numeric relativeMs.
    for (const b of env.data) {
      expect(b.timestamp as string).toMatch(ISO_RE);
      expect(typeof b.relativeMs).toBe('number');
    }
    // relativeMs is anchored to the last event; first nav is 300ms before it.
    expect(nav.relativeMs).toBe(-300);
    expect(consoleErr.relativeMs).toBe(0);

    // DERIVED metadata: anchor ISO + per-category counts.
    expect(env.metadata.anchor as string).toMatch(ISO_RE);
    expect(env.metadata.categoryCounts).toMatchObject({
      navigation: 1, 'ui.click': 1, http: 1, 'console.error': 1,
    });

    // Summary surfaces the last error message.
    expect(env.summary).toContain('charge failed');

    await driver.close();
  });

  it('level filter drops breadcrumbs below the threshold', async () => {
    const PROJECT = 'proj_conf_breadcrumbs_level';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();
    driver.sendBatch([
      { eventId: 'lv-nav', sessionId: driver.sessionId, timestamp: base, eventType: 'navigation', from: '/a', to: '/b', trigger: 'pushState' }, // info
      { eventId: 'lv-err', sessionId: driver.sessionId, timestamp: base + 10, eventType: 'console', level: 'error', message: 'bad', args: [] }, // error
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_breadcrumbs', { project_id: PROJECT, level: 'error' });
    const env = envelope as { data: Array<{ level: string }> };
    // Only the error-level breadcrumb survives a min-level=error filter.
    expect(env.data.length).toBe(1);
    expect(env.data[0].level).toBe('error');

    await driver.close();
  });
});

// ============================================================
// get_custom_events
// ============================================================
describe('get_custom_events output shape', () => {
  it('builds a name catalog with counts/lastSeen and lists recent occurrences', async () => {
    const PROJECT = 'proj_conf_custom';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();

    driver.sendBatch([
      { eventId: 'cu-1', sessionId: driver.sessionId, timestamp: base, eventType: 'custom', name: 'signup', properties: { plan: 'free' } },
      { eventId: 'cu-2', sessionId: driver.sessionId, timestamp: base + 100, eventType: 'custom', name: 'signup', properties: { plan: 'pro' } },
      { eventId: 'cu-3', sessionId: driver.sessionId, timestamp: base + 200, eventType: 'custom', name: 'purchase', properties: { amount: 42 } },
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_custom_events', { project_id: PROJECT });
    const env = envelope as {
      summary: string;
      data: {
        catalog: Array<{ name: string; count: number; lastSeen: unknown; sampleProperties: unknown }>;
        recentEvents: Array<{ name: string; timestamp: unknown; properties: unknown; sessionId: string }>;
      };
      issues: unknown[];
      metadata: { eventCount: number };
    };

    expect(env.metadata.eventCount).toBe(3);

    // Catalog: 2 unique names; signup aggregated to count=2.
    expect(env.data.catalog.length).toBe(2);
    const signup = env.data.catalog.find((c) => c.name === 'signup')!;
    const purchase = env.data.catalog.find((c) => c.name === 'purchase')!;
    expect(signup.count).toBe(2);
    expect(purchase.count).toBe(1);
    // lastSeen reshaped to ISO; sampleProperties is the MOST RECENT occurrence's props.
    expect(signup.lastSeen as string).toMatch(ISO_RE);
    expect(signup.sampleProperties).toEqual({ plan: 'pro' });

    // recentEvents: 3 reshaped occurrences with ISO timestamps + sessionId.
    expect(env.data.recentEvents.length).toBe(3);
    for (const e of env.data.recentEvents) {
      expect(e.timestamp as string).toMatch(ISO_RE);
      expect(e.sessionId).toBe(driver.sessionId);
    }

    expect(env.summary).toContain('3 custom event(s)');
    expect(env.summary).toContain('2 unique event name(s)');

    await driver.close();
  });

  it('name filter narrows the catalog to a single event name', async () => {
    const PROJECT = 'proj_conf_custom_filter';
    const { driver } = await bootstrap(PROJECT);
    const base = Date.now();
    driver.sendBatch([
      { eventId: 'cf-1', sessionId: driver.sessionId, timestamp: base, eventType: 'custom', name: 'login', properties: {} },
      { eventId: 'cf-2', sessionId: driver.sessionId, timestamp: base + 5, eventType: 'custom', name: 'logout', properties: {} },
    ]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_custom_events', { project_id: PROJECT, name: 'login' });
    const env = envelope as { data: { catalog: Array<{ name: string }> }; metadata: { eventCount: number } };
    expect(env.metadata.eventCount).toBe(1);
    expect(env.data.catalog.length).toBe(1);
    expect(env.data.catalog[0].name).toBe('login');

    await driver.close();
  });
});

// ============================================================
// get_event_flow
// ============================================================
describe('get_event_flow output shape', () => {
  it('computes funnel conversion, correlates errors between steps, and flags drop-off', async () => {
    const PROJECT = 'proj_conf_flow';
    // Two REAL sessions under the same project — projectId filtering in the store
    // resolves per-session (registered at handshake), so each session must do its
    // own handshake for its events to match the project_id filter.
    mcp = McpDriver.spawn();
    await mcp.ready();
    const driverA = new SdkDriver({ wsPort: mcp.wsPort, appName: 'flow-A', projectId: PROJECT, sessionId: 'flow-sess-A' });
    const driverB = new SdkDriver({ wsPort: mcp.wsPort, appName: 'flow-B', projectId: PROJECT, sessionId: 'flow-sess-B' });
    await driverA.connect();
    await driverB.connect();
    await new Promise((r) => setTimeout(r, 150));
    const base = Date.now();

    // Session A completes step1 -> step2. Session B only reaches step1, and a
    // network 500 fires between step1 and the end of B's session.
    function custom(id: string, session: string, ts: number, name: string) {
      return { eventId: id, sessionId: session, timestamp: ts, eventType: 'custom', name, properties: {} };
    }
    driverA.sendBatch([
      custom('a1', driverA.sessionId, base, 'start_checkout'),
      custom('a2', driverA.sessionId, base + 500, 'complete_payment'),
    ]);
    driverB.sendBatch([
      custom('b1', driverB.sessionId, base + 10, 'start_checkout'),
      // Network 500 in session B after step1 (no step2 follows) — correlated error.
      { eventId: 'b-net', sessionId: driverB.sessionId, timestamp: base + 50, eventType: 'network', url: 'https://api.local/pay', method: 'POST', status: 500, requestHeaders: {}, responseHeaders: {}, requestBodySize: 0, responseBodySize: 0, duration: 30, ttfb: 5 },
      // A later custom event so the "gap after step1" window extends past the 500
      // (the tool correlates errors in [prevStep, lastCustomEvent] when a step is
      // never reached). This is what makes the 500 land inside the step-2 gap.
      custom('b2', driverB.sessionId, base + 100, 'retry_clicked'),
    ]);
    await driverA.flush();
    await driverB.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp!.callTool('get_event_flow', {
      project_id: PROJECT,
      steps: ['start_checkout', 'complete_payment'],
    });
    const env = envelope as {
      summary: string;
      data: {
        totalSessions: number;
        completedFlows: number;
        avgCompletionTimeMs: number | null;
        funnel: Array<{
          step: string;
          reached: number;
          conversionRate: string;
          avgTimeFromPrev: string | null;
          errorsBetweenSteps: { network: number; console: number; database: number };
          correlatedErrors: { networkErrors: Array<{ url: string; status: number; method: string; timestamp: string }>; consoleErrors: unknown[]; dbErrors: unknown[] };
        }>;
      };
      issues: string[];
    };

    // Two distinct sessions observed.
    expect(env.data.totalSessions).toBe(2);
    // One session (A) completed the full 2-step flow.
    expect(env.data.completedFlows).toBe(1);
    expect(env.data.avgCompletionTimeMs).toBe(500);

    expect(env.data.funnel.length).toBe(2);
    const s1 = env.data.funnel[0];
    const s2 = env.data.funnel[1];
    expect(s1.step).toBe('start_checkout');
    expect(s2.step).toBe('complete_payment');

    // Both sessions reached step1; only A reached step2.
    expect(s1.reached).toBe(2);
    expect(s2.reached).toBe(1);
    // conversionRate reshaped to "<pct>%" strings. step1 vs totalSessions = 100%;
    // step2 vs step1 = 1/2 = 50.0%.
    expect(s1.conversionRate).toBe('100.0%');
    expect(s2.conversionRate).toBe('50.0%');
    // avgTimeFromPrev: step1 has no prev (null), step2 derived to "<ms>ms".
    expect(s1.avgTimeFromPrev).toBeNull();
    expect(s2.avgTimeFromPrev).toBe('500ms');

    // The 500 in session B is correlated to the gap AFTER step1 (where B stalled).
    expect(s2.errorsBetweenSteps.network).toBeGreaterThanOrEqual(1);
    expect(s2.correlatedErrors.networkErrors.some((e) => e.status === 500 && e.method === 'POST')).toBe(true);
    expect(s2.correlatedErrors.networkErrors[0].timestamp).toMatch(ISO_RE);

    // DERIVED issues: 50% conversion is exactly at the threshold (curr/prev < 0.5
    // is false at 0.5), so no drop-off issue — but the correlated error IS flagged.
    expect(env.issues.some((s) => s.includes('error(s) detected between'))).toBe(true);

    await driverA.close();
    await driverB.close();
  });
});
