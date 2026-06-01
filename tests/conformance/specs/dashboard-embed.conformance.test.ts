/**
 * Conformance: the embedded dashboard SPA at /dashboard (M6 Slice A) against Node.
 *
 * The collector serves the built dashboard SPA at /dashboard (+ /assets/* because
 * Vite emits absolute asset paths) — Node from packages/dashboard/dist on disk,
 * Rust from the same bytes compiled in via rust-embed. Both read the same dist, so
 * the served shape matches. Verified over `spawnCollector` (collector-server); the
 * route is public + binary-agnostic, so this gates green-vs-both.
 *
 * NB: the Rust binary serves this WITHOUT packages/dashboard on disk (the build is
 * embedded) — proven by a from-/tmp smoke during development; here we assert the
 * served contract (status + content-type + SPA fallback) both runtimes share.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnCollector, type SpawnedCollector } from '../harness/index.js';

let collector: SpawnedCollector | null = null;
afterEach(async () => { await collector?.stop(); collector = null; });

describe('embedded dashboard SPA at /dashboard (Node)', () => {
  it('GET /dashboard → 200 text/html SPA shell (#root)', async () => {
    collector = await spawnCollector();
    await collector.ready();
    const r = await fetch(`http://127.0.0.1:${collector.httpPort}/dashboard`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toContain('id="root"');
  });

  it('serves the absolute /assets/* bundle index.html references (application/javascript)', async () => {
    collector = await spawnCollector();
    await collector.ready();
    const base = `http://127.0.0.1:${collector.httpPort}`;
    const html = await (await fetch(`${base}/dashboard`)).text();
    const assetPath = html.match(/\/assets\/[^"']+\.js/)?.[0];
    expect(assetPath, 'index.html should reference a hashed /assets/*.js bundle').toBeTruthy();
    const a = await fetch(`${base}${assetPath}`);
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toMatch(/javascript/);
  });

  it('GET /dashboard/<client-route> → 200 index.html (SPA fallback)', async () => {
    collector = await spawnCollector();
    await collector.ready();
    const r = await fetch(`http://127.0.0.1:${collector.httpPort}/dashboard/projects`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(await r.text()).toContain('id="root"');
  });

  it('GET /assets/<unknown> → 404 (asset routes do not SPA-fallback)', async () => {
    collector = await spawnCollector();
    await collector.ready();
    const r = await fetch(`http://127.0.0.1:${collector.httpPort}/assets/does-not-exist-xyz.js`);
    expect(r.status).toBe(404);
  });
});
