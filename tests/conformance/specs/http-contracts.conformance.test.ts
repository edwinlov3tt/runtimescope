/**
 * Conformance: HTTP API contracts.
 *
 * Locks the request/response shapes + status codes + the public/auth gate for
 * the HTTP surface external consumers depend on (the tray, the dashboard, the
 * SDK ingest path). The Rust collector-server must match these.
 *
 * Source of truth: packages/collector/src/http-server.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnCollector, type SpawnedCollector } from '../harness/index.js';

let collector: SpawnedCollector | null = null;
afterEach(async () => { await collector?.stop(); collector = null; });

describe('http contracts', () => {
  it('GET /api/health returns the documented envelope', async () => {
    collector = await spawnCollector();
    await collector.ready();
    const res = await fetch(`http://127.0.0.1:${collector.httpPort}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.timestamp).toBe('number');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.sessions).toBe('number');
    expect(typeof body.authEnabled).toBe('boolean');
  });

  it('GET /readyz returns 200 {status:"ready"} once warm', async () => {
    collector = await spawnCollector();
    await collector.ready();
    const res = await fetch(`http://127.0.0.1:${collector.httpPort}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ready');
  });

  it('GET /metrics is public and Prometheus-formatted', async () => {
    collector = await spawnCollector();
    await collector.ready();
    const res = await fetch(`http://127.0.0.1:${collector.httpPort}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toMatch(/runtimescope_/);
  });

  it('GET /api/sessions returns { data, count }', async () => {
    collector = await spawnCollector();
    await collector.ready();
    const body = await fetch(`http://127.0.0.1:${collector.httpPort}/api/sessions`).then((r) => r.json()) as {
      data: unknown[]; count: number;
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.count).toBe(body.data.length);
  });

  it('an unknown route returns 404 { error, path }', async () => {
    collector = await spawnCollector();
    await collector.ready();
    const res = await fetch(`http://127.0.0.1:${collector.httpPort}/api/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; path: string };
    expect(body.error).toBeTruthy();
    expect(body.path).toBe('/api/does-not-exist');
  });

  it('the public-route set is reachable without auth even when auth is enabled', async () => {
    collector = await spawnCollector({ authToken: 'tk_conf_http' });
    await collector.ready();
    for (const path of ['/api/health', '/readyz', '/metrics']) {
      const res = await fetch(`http://127.0.0.1:${collector.httpPort}${path}`);
      expect(res.status, `${path} should be public`).toBe(200);
    }
    // A gated route without a token should be rejected.
    const gated = await fetch(`http://127.0.0.1:${collector.httpPort}/api/sessions`);
    expect(gated.status).toBe(401);
  });
});
