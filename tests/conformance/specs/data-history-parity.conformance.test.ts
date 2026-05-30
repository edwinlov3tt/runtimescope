/**
 * Conformance: DATA + HISTORY tool *parity edge cases* against Node.
 *
 * These cases were surfaced by an external differential probe (audit 0002,
 * second review) that the original data-history-shapes spec did NOT exercise —
 * it used a single happy-path session with no render/web-vital events, a single
 * app, and ASCII-only query strings. A port could (and did) pass the original
 * gate while diverging here:
 *   - runtime_qa_check computed metrics over a fixed event-type whitelist (not
 *     ALL session events), read render components from top-level fields instead
 *     of profiles[], and Web Vitals from the wrong key.
 *   - get_historical_events / list_projects scoped by the projectId key, so two
 *     apps SHARING one projectId leaked/merged each other's history.
 *   - capture_har byte-cast percent-decoded bytes, corrupting UTF-8 query params.
 *   - get_session_history surfaced the snapshot creation time, not the session's
 *     connect time.
 *
 * Each assertion runs vs Node first (source of truth); RUNTIMESCOPE_MCP_CMD then
 * swaps the Rust binary. Separate `it` blocks (NOT one monolithic block) so an
 * early failure can't mask a later one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver, SdkDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

function netEvent(
  sessionId: string,
  i: number,
  opts: { method: string; status: number; duration: number; ttfb: number; url: string },
): object {
  return {
    eventId: `evt-net-${sessionId}-${i}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'network',
    url: opts.url,
    method: opts.method,
    status: opts.status,
    requestHeaders: { 'x-test': 'rs' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBodySize: 0,
    responseBodySize: 256,
    duration: opts.duration,
    ttfb: opts.ttfb,
    source: 'conformance',
  };
}

function renderEvent(sessionId: string, i: number, components: string[]): object {
  return {
    eventId: `evt-render-${sessionId}-${i}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'render',
    profiles: components.map((name) => ({
      componentName: name,
      renderCount: 3,
      totalDuration: 30,
      avgDuration: 10,
      lastRenderPhase: 'update',
      renderVelocity: 1,
      suspicious: false,
    })),
    snapshotWindowMs: 1000,
    totalRenders: components.length * 3,
    suspiciousComponents: [],
  };
}

function perfEvent(sessionId: string, i: number, metricName: string, value: number, rating: string): object {
  return {
    eventId: `evt-perf-${sessionId}-${i}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'performance',
    metricName,
    value,
    rating,
    unit: 'ms',
  };
}

describe('MCP data + history parity edge cases (Node)', () => {
  // --------------------------------------------------------------------------
  // runtime_qa_check: metrics over ALL session events; render components come
  // from profiles[]; Web Vitals keyed by metricName (only rating-bearing perf).
  // --------------------------------------------------------------------------
  it('runtime_qa_check derives componentCount from render profiles and webVitals by metricName', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const PROJECT = 'proj_parity_qa';
    const APP = 'parity-qa-app';
    const d = new SdkDriver({ wsPort: mcp.wsPort, appName: APP, projectId: PROJECT });
    await d.connect();
    await new Promise((r) => setTimeout(r, 150));

    d.sendBatch([
      // 1 render event carrying TWO component profiles → componentCount = 2.
      renderEvent(d.sessionId, 1, ['Header', 'Sidebar']),
      // 1 web-vital perf event (has rating) → webVitals.LCP; 1 server metric
      // (no rating) → excluded from webVitals.
      perfEvent(d.sessionId, 2, 'LCP', 2400, 'good'),
      { eventId: `evt-perf-${d.sessionId}-3`, sessionId: d.sessionId, timestamp: Date.now(),
        eventType: 'performance', metricName: 'heap_used', value: 1048576, unit: 'bytes' },
      netEvent(d.sessionId, 4, { method: 'GET', status: 200, duration: 20, ttfb: 5, url: 'https://x.test/a' }),
    ]);
    await d.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp.callTool('runtime_qa_check', { project_id: PROJECT, label: 'p' });
    const env = envelope as {
      data: { snapshot: { metrics: { totalEvents: number; componentCount: number; webVitals: Record<string, unknown> } } };
      metadata: { webVitals: unknown };
    };
    const m = env.data.snapshot.metrics;

    // totalEvents counts ALL session events: render + 2 perf + network + the
    // synthetic session connect = 5 (NOT a fixed type whitelist).
    expect(m.totalEvents).toBe(5);
    // Components come from the render event's profiles[] array.
    expect(m.componentCount).toBe(2);
    // Web Vitals keyed by metricName, only the rating-bearing entry.
    expect(typeof m.webVitals).toBe('object');
    expect(Object.keys(m.webVitals)).toContain('LCP');
    expect(Object.keys(m.webVitals)).not.toContain('heap_used');
    // metadata.webVitals is the human summary string ("LCP: 2400.0 (good)"),
    // NOT null — the LCP web-vital has a rating.
    expect(typeof env.metadata.webVitals).toBe('string');
    expect(env.metadata.webVitals as string).toContain('LCP');
    expect(env.metadata.webVitals as string).toContain('(good)');

    await d.close();
  });

  // --------------------------------------------------------------------------
  // list_projects keys by appName, NOT by the shared projectId.
  //
  // The old Rust list_projects grouped by the project-scope key (projectId), so
  // two apps sharing one projectId collapsed into a SINGLE merged row reporting
  // the combined event count. Node (and the fix) key by appName → one row per
  // app. (We deliberately do NOT assert per-app history ISOLATION here: Node's
  // shared-projectId persistence is itself asymmetric — app-alpha's history shows
  // only its own session while app-beta's shows both — so "isolation" is not a
  // clean Node contract to gate against. The leak fix is covered by reasoning +
  // the unknown-project_id case below; this locks the list_projects keying.)
  // --------------------------------------------------------------------------
  it('list_projects keys by appName, not the shared projectId', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const PROJECT = 'proj_shared';
    const A = new SdkDriver({ wsPort: mcp.wsPort, appName: 'app-alpha', projectId: PROJECT });
    const B = new SdkDriver({ wsPort: mcp.wsPort, appName: 'app-beta', projectId: PROJECT });
    await A.connect();
    await B.connect();
    await new Promise((r) => setTimeout(r, 150));
    A.sendBatch([netEvent(A.sessionId, 1, { method: 'GET', status: 200, duration: 10, ttfb: 2, url: 'https://x.test/alpha1' })]);
    B.sendBatch([netEvent(B.sessionId, 1, { method: 'GET', status: 200, duration: 10, ttfb: 2, url: 'https://x.test/beta1' })]);
    await A.flush();
    await B.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope: listEnv } = await mcp.callTool('list_projects', {});
    const list = listEnv as { data: Array<{ name: string; eventCount: number; sessionCount: number }> };
    const a = list.data.find((p) => p.name === 'app-alpha');
    const b = list.data.find((p) => p.name === 'app-beta');
    // Two DISTINCT app rows (not one merged projectId row).
    expect(a, 'app-alpha is its own project entry').toBeTruthy();
    expect(b, 'app-beta is its own project entry').toBeTruthy();
    expect(a!.eventCount).toBeGreaterThan(0);
    expect(b!.eventCount).toBeGreaterThan(0);
    expect(a!.sessionCount).toBeGreaterThanOrEqual(1);
    expect(b!.sessionCount).toBeGreaterThanOrEqual(1);

    await A.close();
    await B.close();
  });

  // --------------------------------------------------------------------------
  // Unknown project_id → data: null (not an empty success).
  // --------------------------------------------------------------------------
  it('get_historical_events returns data:null for an unknown project_id', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const { envelope } = await mcp.callTool('get_historical_events', { project_id: 'proj_does_not_exist' });
    const env = envelope as { data: unknown; issues: string[] };
    expect(env.data).toBeNull();
    expect(env.issues.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // capture_har decodes UTF-8 percent-encoded query params correctly.
  // --------------------------------------------------------------------------
  it('capture_har decodes UTF-8 percent-encoded query params', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const PROJECT = 'proj_har_utf8';
    const d = new SdkDriver({ wsPort: mcp.wsPort, appName: 'har-utf8', projectId: PROJECT });
    await d.connect();
    await new Promise((r) => setTimeout(r, 150));

    // %E2%9C%93 = ✓ ; '+' = space.
    d.sendBatch([
      netEvent(d.sessionId, 1, {
        method: 'GET', status: 200, duration: 12, ttfb: 3,
        url: 'https://x.test/s?q=%E2%9C%93+done&page=2',
      }),
    ]);
    await d.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp.callTool('capture_har', { project_id: PROJECT });
    const env = envelope as { data: { log: { entries: Array<{ request: { queryString: Array<{ name: string; value: string }> } }> } } };
    const qs = env.data.log.entries[0].request.queryString;
    expect(qs).toContainEqual({ name: 'q', value: '✓ done' });
    expect(qs).toContainEqual({ name: 'page', value: '2' });
  });

  // --------------------------------------------------------------------------
  // get_session_history.createdAt is the session CONNECT time, not the snapshot
  // creation time. (Probe: Node false, old-Rust true for "equals qa snapshot".)
  // --------------------------------------------------------------------------
  it('get_session_history createdAt is the session connect time, not the snapshot time', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const PROJECT = 'proj_history_created';
    const APP = 'history-created';
    const d = new SdkDriver({ wsPort: mcp.wsPort, appName: APP, projectId: PROJECT });
    await d.connect();
    await new Promise((r) => setTimeout(r, 150));
    d.sendBatch([netEvent(d.sessionId, 1, { method: 'GET', status: 200, duration: 10, ttfb: 2, url: 'https://x.test/h' })]);
    await d.flush();
    // Deliberate gap so the snapshot time is clearly later than connect time.
    await new Promise((r) => setTimeout(r, 600));

    const { envelope: qa } = await mcp.callTool('runtime_qa_check', { project_id: PROJECT, label: 'baseline' });
    const snapCreatedAt = (qa as { data: { snapshot: { createdAt: string } } }).data.snapshot.createdAt;

    const { envelope: hist } = await mcp.callTool('get_session_history', { project: APP });
    const env = hist as { data: Array<{ sessionId: string; createdAt: string }> };
    const sess = env.data.find((s) => s.sessionId === d.sessionId);
    expect(sess).toBeTruthy();
    expect(sess!.createdAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Connect happened strictly before the qa snapshot was taken.
    expect(new Date(sess!.createdAt).getTime()).toBeLessThan(new Date(snapCreatedAt).getTime());

    await d.close();
  });
});
