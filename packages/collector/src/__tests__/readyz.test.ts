import { describe, it, expect, afterEach } from 'vitest';
import { CollectorServer, HttpServer, EventStore } from '../index.js';

describe('Phase 2: /readyz endpoint', () => {
  let httpServer: HttpServer | null = null;
  let collector: CollectorServer | null = null;

  afterEach(async () => {
    try { await httpServer?.stop(); } catch { /* ignore */ }
    try { collector?.stop(); } catch { /* ignore */ }
    httpServer = null;
    collector = null;
    // Small delay to let sockets release
    await new Promise((r) => setTimeout(r, 30));
  });

  it('returns 503 status:starting when collector is not ready', async () => {
    let ready = false;
    const store = new EventStore(100);
    httpServer = new HttpServer(store, undefined, {
      isReady: () => ready,
    });
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('starting');
  });

  it('returns 200 status:ready when collector reports ready', async () => {
    const store = new EventStore(100);
    httpServer = new HttpServer(store, undefined, {
      isReady: () => true,
    });
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
  });

  it('defaults to ready when no isReady callback is provided', async () => {
    const store = new EventStore(100);
    httpServer = new HttpServer(store, undefined, {});
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(200);
  });

  it('CollectorServer.isReady is true after start() resolves', async () => {
    collector = new CollectorServer({ bufferSize: 100 });
    expect(collector.isReady()).toBe(false);
    await collector.start({ port: 0, maxRetries: 0 });
    expect(collector.isReady()).toBe(true);
  });

  it('CollectorServer.isReady flips back to false after stop()', async () => {
    collector = new CollectorServer({ bufferSize: 100 });
    await collector.start({ port: 0, maxRetries: 0 });
    expect(collector.isReady()).toBe(true);
    collector.stop();
    expect(collector.isReady()).toBe(false);
  });

  it('/readyz is reachable without auth even when authManager is enabled', async () => {
    // Construct an HttpServer with auth enabled but no token in the request —
    // a 200 from /readyz proves the public-allowlist exemption works.
    const store = new EventStore(100);
    const { AuthManager } = await import('../auth.js');
    const auth = new AuthManager({ enabled: true, apiKeys: [{ key: 'k_test', label: 'test' }] });
    httpServer = new HttpServer(store, undefined, {
      authManager: auth,
      isReady: () => true,
    });
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(200);

    // Sanity: a non-public route requires auth.
    const guarded = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(guarded.status).toBe(401);
  });
});
