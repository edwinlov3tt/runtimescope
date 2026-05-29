/**
 * Conformance: api-discovery family OUTPUT SHAPES against the Node mcp-server.
 *
 * Audit 0002 #2: ~57 tools were ported and compiled but never behavior-verified.
 * This spec LOCKS the reshaping the api-discovery MCP tools apply on top of the
 * ApiDiscoveryEngine — the exact derived strings/objects Node returns — so a
 * port (Rust) that returns raw engine rows, drops the percentile/error rollup,
 * mis-normalizes URLs, or emits an empty stub will FAIL.
 *
 * Source of truth (ADR-0006):
 *   packages/mcp-server/src/tools/api-discovery.ts  (the reshaping layer)
 *   packages/collector/src/engines/api-discovery.ts (the derivation engine)
 *
 * What we pin per tool:
 *   get_api_catalog       — data.services[] + data.endpoints[]; normalizedPath
 *                           (`:id` segments), callCount, ISO firstSeen/lastSeen,
 *                           "<n>ms" avgLatency, "<p>%" errorRate, auth.type,
 *                           responseFields count, metadata.eventCount = total calls.
 *   get_api_health        — data[]: successRate/errorRate/avg/p50/p95 as "<n>%"/
 *                           "<n>ms" strings, errorCodes map; derived issues for
 *                           >50% error rate and p95 > 5s.
 *   get_api_documentation — RAW markdown string mentioning an endpoint.
 *   get_service_map       — data[]: detectedPlatform (Stripe), auth OBJECT,
 *                           endpointCount, totalCalls, "<n>ms"/"<p>%" strings.
 *   get_api_changes       — added/removed/modified rollup between two sessions;
 *                           data[] ApiChangeRecord with changeType, removed issue.
 *
 * Drives the Node mcp-server over stdio (default). Events flow through the
 * embedded collector via an SdkDriver on the MCP server's WS port — the exact
 * path Claude Code uses. RUNTIMESCOPE_MCP_CMD swaps in the Rust bin later.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver, SdkDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const PROJECT = 'proj_conf_api_discovery';

interface NetOpts {
  url: string;
  method: string;
  status: number;
  duration: number;
  requestHeaders?: Record<string, string>;
  responseBody?: string;
}

function netEvent(sessionId: string, i: number, o: NetOpts): object {
  return {
    eventId: `evt-apidisc-${i}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'network',
    url: o.url,
    method: o.method,
    status: o.status,
    requestHeaders: o.requestHeaders ?? {},
    responseHeaders: { 'content-type': 'application/json' },
    requestBodySize: 0,
    responseBodySize: 256,
    duration: o.duration,
    ttfb: Math.min(o.duration, 10),
    ...(o.responseBody ? { responseBody: o.responseBody } : {}),
    source: 'conformance',
  };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('api-discovery MCP tool shapes (Node source of truth)', () => {
  it('catalog/health/docs/service-map/changes derive the exact Node shapes', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();

    const driver = new SdkDriver({ wsPort: mcp.wsPort, appName: 'conf-apidisc', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 150));

    // --- Build a corpus that exercises every derivation -------------------
    //
    // Two services:
    //   * "example.com"  (host api.example.com, no service pattern → last 2 labels)
    //   * "Stripe"       (host api.stripe.com → SERVICE_PATTERNS → detectedPlatform)
    //
    // example.com endpoints:
    //   GET  /users/:id   — numeric id normalized to :id; called 3 times, all 200,
    //                       carries a JSON responseBody → contract responseFields.
    //   POST /orders      — bearer auth; called 4 times, 3 of them 500 → errorRate
    //                       0.75 (>0.5 → health issue) and a slow 6000ms call so
    //                       p95 > 5000 (>5s → second health issue).
    // Stripe endpoint:
    //   GET  /v1/charges  — 401 once (error), api_key auth via Authorization.
    //
    const usersBody = JSON.stringify({ id: 7, name: 'Ada', active: true });
    const events: object[] = [
      // GET /users/123,456,789  -> normalizes to /users/:id  (callCount 3)
      netEvent(driver.sessionId, 1, { url: 'https://api.example.com/users/123', method: 'GET', status: 200, duration: 40, responseBody: usersBody }),
      netEvent(driver.sessionId, 2, { url: 'https://api.example.com/users/456', method: 'GET', status: 200, duration: 60, responseBody: usersBody }),
      netEvent(driver.sessionId, 3, { url: 'https://api.example.com/users/789', method: 'GET', status: 200, duration: 80, responseBody: usersBody }),
      // POST /orders  (callCount 4): 1x 201, 3x 500, one of the 500s is slow (6000ms)
      netEvent(driver.sessionId, 4, { url: 'https://api.example.com/orders', method: 'POST', status: 201, duration: 100, requestHeaders: { Authorization: 'Bearer tok_abc' } }),
      netEvent(driver.sessionId, 5, { url: 'https://api.example.com/orders', method: 'POST', status: 500, duration: 200, requestHeaders: { Authorization: 'Bearer tok_abc' } }),
      netEvent(driver.sessionId, 6, { url: 'https://api.example.com/orders', method: 'POST', status: 500, duration: 300, requestHeaders: { Authorization: 'Bearer tok_abc' } }),
      netEvent(driver.sessionId, 7, { url: 'https://api.example.com/orders', method: 'POST', status: 500, duration: 6000, requestHeaders: { Authorization: 'Bearer tok_abc' } }),
      // Stripe GET /v1/charges  401 (detectedPlatform Stripe, api_key auth)
      netEvent(driver.sessionId, 8, { url: 'https://api.stripe.com/v1/charges', method: 'GET', status: 401, duration: 50, requestHeaders: { Authorization: 'sk_test_123' } }),
    ];
    driver.sendBatch(events);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    // ====================================================================
    // get_api_catalog
    // ====================================================================
    {
      const { envelope } = await mcp.callTool('get_api_catalog', { project_id: PROJECT });
      const env = envelope as {
        summary: string;
        data: {
          services: Array<{ name: string; baseUrl: string; endpointCount: number; totalCalls: number; avgLatency: string; errorRate: string; auth: string; platform: string | null }>;
          endpoints: Array<{ method: string; path: string; service: string; callCount: number; auth: string; firstSeen: string; lastSeen: string; graphql: unknown; responseFields: number }>;
        };
        issues: string[];
        metadata: { timeRange: { from: number; to: number }; eventCount: number };
      };

      expect(typeof env.summary).toBe('string');
      // 3 endpoints (GET /users/:id, POST /orders, GET /v1/charges) across 2 services.
      expect(env.data.endpoints.length).toBe(3);
      expect(env.data.services.length).toBe(2);
      expect(env.summary).toBe('Discovered 3 API endpoint(s) across 2 service(s).');

      const byKey = (m: string, p: string) => env.data.endpoints.find((e) => e.method === m && e.path === p);

      // URL NORMALIZATION: numeric segment collapsed to :id.
      const users = byKey('GET', '/users/:id');
      expect(users, 'GET /users/:id present (numeric id normalized)').toBeTruthy();
      expect(users!.callCount).toBe(3);            // 3 distinct ids merged
      expect(users!.service).toBe('example.com');  // host api.example.com → last 2 labels
      expect(users!.auth).toBe('none');            // no auth header on users calls
      // ISO timestamp reshaping (engine epoch → tool .toISOString()).
      expect(users!.firstSeen).toMatch(ISO_RE);
      expect(users!.lastSeen).toMatch(ISO_RE);
      expect(Number.isNaN(Date.parse(users!.firstSeen))).toBe(false);
      // contract inference: responseBody JSON → responseFields > 0 (id,name,active).
      expect(users!.responseFields).toBeGreaterThanOrEqual(3);
      // plain REST → graphql null (not undefined).
      expect(users!.graphql).toBeNull();

      const orders = byKey('POST', '/orders');
      expect(orders, 'POST /orders present').toBeTruthy();
      expect(orders!.callCount).toBe(4);
      expect(orders!.auth).toBe('bearer');         // Authorization: Bearer ... → bearer

      const charges = byKey('GET', '/v1/charges');
      expect(charges, 'GET /v1/charges present').toBeTruthy();
      expect(charges!.service).toBe('Stripe');

      // catalog sorted by callCount desc → POST /orders (4) first.
      expect(env.data.endpoints[0].callCount).toBe(4);

      // Service rollup reshaping: avgLatency "<n>ms", errorRate "<p>%", auth type string.
      const stripeSvc = env.data.services.find((s) => s.name === 'Stripe');
      expect(stripeSvc, 'Stripe service present').toBeTruthy();
      expect(stripeSvc!.platform).toBe('Stripe');  // detectedPlatform surfaced as `platform`
      expect(stripeSvc!.avgLatency).toMatch(/^\d+ms$/);
      expect(stripeSvc!.errorRate).toMatch(/^\d+\.\d%$/);
      // 1 call, 401 → 100.0% error rate.
      expect(stripeSvc!.errorRate).toBe('100.0%');
      expect(stripeSvc!.endpointCount).toBe(1);
      expect(stripeSvc!.totalCalls).toBe(1);
      expect(typeof stripeSvc!.auth).toBe('string'); // catalog flattens auth → auth.type

      const exampleSvc = env.data.services.find((s) => s.name === 'example.com');
      expect(exampleSvc!.platform).toBeNull();       // no SERVICE_PATTERN match
      expect(exampleSvc!.totalCalls).toBe(7);        // 3 users + 4 orders
      expect(exampleSvc!.endpointCount).toBe(2);

      // metadata.eventCount = SUM of callCounts (3+4+1 = 8), not endpoint count.
      expect(env.metadata.eventCount).toBe(8);
      expect(env.metadata.timeRange.from).toBeLessThanOrEqual(env.metadata.timeRange.to);
      expect(env.metadata.timeRange.from).toBeGreaterThan(0);
    }

    // ====================================================================
    // get_api_health
    // ====================================================================
    {
      const { envelope } = await mcp.callTool('get_api_health', { project_id: PROJECT });
      const env = envelope as {
        summary: string;
        data: Array<{
          method: string; path: string; service: string; callCount: number;
          successRate: string; avgLatency: string; p50Latency: string; p95Latency: string;
          errorRate: string; errorCodes: Record<string, number>;
        }>;
        issues: string[];
        metadata: { eventCount: number };
      };

      const orders = env.data.find((e) => e.method === 'POST' && e.path === '/orders');
      expect(orders, 'health for POST /orders').toBeTruthy();
      expect(orders!.callCount).toBe(4);
      // 3 of 4 are 500 → errorRate 0.75 → "75.0%", successRate 0.25 → "25.0%".
      expect(orders!.errorRate).toBe('75.0%');
      expect(orders!.successRate).toBe('25.0%');
      // latency reshaping: "<n>ms" strings (rounded, .toFixed(0)).
      expect(orders!.avgLatency).toMatch(/^\d+ms$/);
      expect(orders!.p50Latency).toMatch(/^\d+ms$/);
      expect(orders!.p95Latency).toMatch(/^\d+ms$/);
      // p95 of [100,200,300,6000] (ceil(4*0.95)-1 = idx 3) = 6000ms.
      expect(orders!.p95Latency).toBe('6000ms');
      // errorCodes is an object keyed by status code → 3x 500.
      expect(orders!.errorCodes['500']).toBe(3);

      const users = env.data.find((e) => e.method === 'GET' && e.path === '/users/:id');
      expect(users!.successRate).toBe('100.0%');
      expect(users!.errorRate).toBe('0.0%');
      expect(users!.errorCodes).toEqual({}); // no 4xx/5xx

      // DERIVED ISSUES (mcp tool layer, not engine):
      //   POST /orders errorRate 0.75 > 0.5 → "POST /orders: 75% error rate"
      //   POST /orders p95 6000 > 5000      → "POST /orders: p95 latency 6.0s"
      expect(env.issues).toContain('POST /orders: 75% error rate');
      expect(env.issues).toContain('POST /orders: p95 latency 6.0s');
      // Stripe /v1/charges is 100% error but the issue text is per-endpoint:
      expect(env.issues).toContain('GET /v1/charges: 100% error rate');
      expect(env.summary).toContain('issue(s) found');

      // eventCount = sum of callCounts across endpoints = 8.
      expect(env.metadata.eventCount).toBe(8);
    }

    // ====================================================================
    // get_api_documentation  (RAW markdown string)
    // ====================================================================
    {
      const { envelope } = await mcp.callTool('get_api_documentation', { project_id: PROJECT });
      // This tool returns markdown text, not a JSON envelope.
      expect(typeof envelope).toBe('string');
      const md = envelope as string;
      expect(md.length).toBeGreaterThan(0);
      // Markdown header + at least one endpoint heading mentioning a path.
      expect(md).toContain('# API Documentation');
      expect(md).toContain('### POST /orders');
      expect(md).toContain('/users/:id');
      // Derived health line rendered into the doc.
      expect(md).toMatch(/Error Rate: 75\.0%/);
    }

    // ====================================================================
    // get_service_map
    // ====================================================================
    {
      const { envelope } = await mcp.callTool('get_service_map', { project_id: PROJECT });
      const env = envelope as {
        summary: string;
        data: Array<{
          name: string; baseUrl: string; endpointCount: number; totalCalls: number;
          avgLatency: string; errorRate: string;
          auth: { type: string; headerName?: string };
          detectedPlatform: string | null;
        }>;
        issues: string[];
        metadata: { eventCount: number };
      };

      expect(env.data.length).toBe(2);
      expect(env.summary).toBe('2 service(s) detected from network traffic.');
      // sorted by totalCalls desc → example.com (7) before Stripe (1).
      expect(env.data[0].name).toBe('example.com');
      expect(env.data[0].totalCalls).toBe(7);
      expect(env.data[0].endpointCount).toBe(2);
      expect(env.data[0].avgLatency).toMatch(/^\d+ms$/);
      expect(env.data[0].errorRate).toMatch(/^\d+\.\d%$/);

      const stripe = env.data.find((s) => s.name === 'Stripe')!;
      expect(stripe.detectedPlatform).toBe('Stripe');
      expect(stripe.baseUrl).toBe('https://api.stripe.com');
      // service_map keeps auth as the full OBJECT (unlike catalog which flattens to .type).
      expect(typeof stripe.auth).toBe('object');
      expect(stripe.auth.type).toBe('api_key'); // Authorization not Bearer/Basic → api_key
      expect(stripe.errorRate).toBe('100.0%');

      const example = env.data.find((s) => s.name === 'example.com')!;
      expect(example.detectedPlatform).toBeNull();

      // eventCount = sum of totalCalls = 8.
      expect(env.metadata.eventCount).toBe(8);
    }

    // ====================================================================
    // get_api_changes  (between this session and an empty/other session)
    // ====================================================================
    {
      const otherSession = 'sess-empty-for-changes';
      // sessionA = the live session (has 3 endpoints), sessionB = empty session.
      // So every endpoint in A is "removed" relative to B.
      const { envelope } = await mcp.callTool('get_api_changes', {
        project_id: PROJECT,
        session_a: driver.sessionId,
        session_b: otherSession,
      });
      const env = envelope as {
        summary: string;
        data: Array<{ method: string; normalizedPath: string; changeType: string }>;
        issues: string[];
        metadata: { eventCount: number };
      };

      // A has 3 endpoints, B has 0 → 3 removed, 0 added, 0 modified.
      expect(env.data.length).toBe(3);
      expect(env.data.every((c) => c.changeType === 'removed')).toBe(true);
      const paths = env.data.map((c) => `${c.method} ${c.normalizedPath}`).sort();
      expect(paths).toContain('GET /users/:id');
      expect(paths).toContain('POST /orders');
      expect(paths).toContain('GET /v1/charges');
      expect(env.summary).toBe('3 API change(s) between sessions: 0 added, 3 removed, 0 modified.');
      // removed > 0 → derived issue.
      expect(env.issues.length).toBe(1);
      expect(env.issues[0]).toContain('3 endpoint(s) no longer called');
      expect(env.metadata.eventCount).toBe(3);
    }

    await driver.close();
  });
});
