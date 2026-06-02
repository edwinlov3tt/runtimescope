#!/usr/bin/env node
// ============================================================================
// detect-ui-drift.mjs — Dashboard ⇄ Rust-collector drift detector
// ----------------------------------------------------------------------------
// Catches the three drift classes the dashboard audit found:
//
//   1. HTTP drift   — a path/method the dashboard CALLS that the collector does
//                     not SERVE (called-but-unserved), or a route the collector
//                     serves that nothing in the dashboard calls (served-but-
//                     uncalled, informational). Method-aware: catches the
//                     `DELETE /api/events` → 405 case where the path exists but
//                     only POST is registered.
//
//   2. WS drift     — a `msg.type` the dashboard HANDLES in ws-client.ts that
//                     the collector never BROADCASTS over /api/ws/events
//                     (e.g. dev_server_status / dev_server_log = dead handlers),
//                     and vice-versa.
//
//   3. Live shape   — (--live, needs a running collector) samples real
//                     /api/ws/events frames and asserts that the fields
//                     ws-client.ts reads off `msg.data` (projectId, sessionId)
//                     actually exist on the wire. Catches the projectId-filter
//                     bug: ws-client filters on data.projectId but events carry
//                     none, so live filtering silently degrades.
//
// Exit code: 0 = no blocking drift, 1 = drift found (CI gate), 2 = bad usage.
//
// Usage:
//   node scripts/detect-ui-drift.mjs            # static checks only
//   node scripts/detect-ui-drift.mjs --live     # + probe running collector
//   node scripts/detect-ui-drift.mjs --live --url http://localhost:6768
//   node scripts/detect-ui-drift.mjs --json     # machine-readable report
// ============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const DASH_SRC = join(REPO, 'packages/dashboard/src');
const SERVER_RS = join(REPO, 'crates/collector-core/src/server.rs');
const STORE_RS = join(REPO, 'crates/collector-core/src/store.rs');
const WS_CLIENT = join(DASH_SRC, 'lib/ws-client.ts');

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const JSON_OUT = args.includes('--json');
const URL = (() => {
  const i = args.indexOf('--url');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'http://localhost:6768';
})();

// Routes the collector serves but that legitimately have no dashboard caller
// (health probes, MCP-only ingest, admin). Listed here so "served-but-uncalled"
// stays signal, not noise. Add to this list ONLY for genuinely non-dashboard routes.
const SERVED_UNCALLED_ALLOW = [
  '/readyz', '/metrics', '/api/health',
  '/dashboard', '/dashboard/{*rest}', '/assets/{*rest}',
  '/api/v1/admin/snapshot',
  '/api/events',            // POST ingest — Workers/Python SDK, not the dashboard
  '/',                      // SPA root
  '/api/ws/events',         // opened via new WebSocket(), checked in the WS section
];

// Dev-only / unreachable dirs whose `/api/...` string literals are mock fixtures,
// not real calls. The showcase kitchen-sink is not wired into any route (audit).
const SKIP_DIRS = ['components/showcase'];

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Extract dashboard HTTP calls  →  Set<{path, method, file, line}>
// ---------------------------------------------------------------------------
function methodFor(before, after) {
  // explicit fetch(..., { method: 'X' })
  const m = /method:\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]/i.exec(after);
  if (m) return m[1].toUpperCase();
  // wrapper call immediately preceding the path literal, allowing a generic
  // type arg: post<T>('/api/..'), del('/api/..'), put<T>(`/api/..`)
  if (/\bdel(?:ete)?\s*(?:<[^>]*>)?\s*\(\s*$/.test(before)) return 'DELETE';
  if (/\bpost\s*(?:<[^>]*>)?\s*\(\s*$/.test(before)) return 'POST';
  if (/\bput\s*(?:<[^>]*>)?\s*\(\s*$/.test(before)) return 'PUT';
  if (/\b(?:get|getList)\s*(?:<[^>]*>)?\s*\(\s*$/.test(before)) return 'GET';
  return 'GET'; // default: plain fetch / href / getCapexExportUrl etc.
}

function extractDashboardCalls() {
  const calls = new Map(); // key path|method -> {path, method, sites:[]}
  const files = walk(DASH_SRC).filter(
    (f) => !SKIP_DIRS.some((d) => f.includes('/' + d + '/')),
  );
  // match /api/... inside '...', "...", or `...` up to a terminator
  const re = /['"`](\$\{[^}]*\})?(\/api\/[^'"`?\s)]+)/g;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    let m;
    while ((m = re.exec(text)) !== null) {
      let path = m[2];
      // collapse ${...} template segments to a single :param placeholder
      path = path.replace(/\$\{[^}]*\}/g, ':p');
      // some literals are like `${BASE}/api/...` — BASE already stripped by regex group; ok
      const idx = m.index;
      const before = text.slice(Math.max(0, idx - 96), idx);
      const after = text.slice(idx, idx + 80);
      const method = methodFor(before, after);
      const line = text.slice(0, idx).split('\n').length;
      const key = `${method} ${path}`;
      if (!calls.has(key)) calls.set(key, { path, method, sites: [] });
      const rel = file.replace(REPO + '/', '');
      calls.get(key).sites.push(`${rel}:${line}`);
    }
  }
  return [...calls.values()];
}

// ---------------------------------------------------------------------------
// 2. Extract collector routes  →  [{path, methods:Set, regex}]
// ---------------------------------------------------------------------------
function extractCollectorRoutes() {
  const text = readFileSync(SERVER_RS, 'utf8');
  const routes = [];
  const re = /\.route\(\s*"([^"]+)"/g;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ path: m[1], idx: m.index });
  for (let i = 0; i < marks.length; i++) {
    const { path, idx } = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1].idx : Math.min(text.length, idx + 400);
    const window = text.slice(idx, end);
    const methods = new Set();
    if (/\bget\s*\(/.test(window)) methods.add('GET');
    if (/\bpost\s*\(/.test(window)) methods.add('POST');
    if (/\bput\s*\(/.test(window)) methods.add('PUT');
    if (/(?:routing::)?\bdelete\s*\(/.test(window)) methods.add('DELETE');
    if (/\bpatch\s*\(/.test(window)) methods.add('PATCH');
    if (methods.size === 0) methods.add('GET');
    routes.push({ path, methods, regex: routeToRegex(path) });
  }
  return routes;
}

function routeToRegex(path) {
  // axum params: {id} {projectId} {*rest}; our dashboard placeholder is :p
  const pat = path
    .replace(/[.*+?^$()|[\]\\]/g, (c) => (c === '*' ? '*' : '\\' + c)) // escape regex meta (keep * for wildcard handling below)
    .replace(/\\\{[^}]*\\\}/g, '[^/]+')   // {id} -> one segment
    .replace(/\{\*[^}]*\}/g, '.*')        // {*rest} -> greedy (already escaped braces? handled below)
    .replace(/\{[^}]*\}/g, '[^/]+');
  return new RegExp('^' + pat + '$');
}

function matchPath(dashPath, routes) {
  const probe = dashPath.replace(/:p/g, 'PARAM');
  return routes.filter((r) => r.regex.test(probe));
}

// ---------------------------------------------------------------------------
// 3. WS message-type drift
// ---------------------------------------------------------------------------
function extractWsHandledTypes() {
  const text = readFileSync(WS_CLIENT, 'utf8');
  const types = new Set();
  const re = /msg\.type\s*===\s*['"]([a-z_]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) types.add(m[1]);
  return types;
}
function extractWsBroadcastTypes() {
  const types = new Set();
  for (const f of [STORE_RS, SERVER_RS]) {
    const text = readFileSync(f, 'utf8');
    const re = /"type"\s*:\s*"([a-z_]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) types.add(m[1]);
  }
  return types;
}

// ---------------------------------------------------------------------------
// 4. Live probing (optional)
// ---------------------------------------------------------------------------
async function probeLive() {
  const findings = [];
  // health
  let healthy = false;
  try {
    const r = await fetch(`${URL}/api/health`);
    healthy = r.ok;
  } catch { /* ignore */ }
  if (!healthy) {
    findings.push({ level: 'skip', msg: `collector not reachable at ${URL} — skipping --live checks` });
    return findings;
  }

  // sample WS frames and assert ws-client-read fields exist
  let WS;
  try {
    const require = createRequire(join(REPO, 'package.json'));
    WS = require('ws');
  } catch {
    findings.push({ level: 'skip', msg: 'ws module not installed — skipping WS frame sampling' });
    return findings;
  }
  const wsUrl = URL.replace(/^http/, 'ws') + '/api/ws/events';
  const seen = { event: 0, withProjectId: 0, withSessionId: 0, byType: {} };
  await new Promise((res) => {
    let done = false;
    const sock = new WS(wsUrl);
    const finish = () => { if (done) return; done = true; try { sock.close(); } catch {} res(); };
    sock.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.type === 'event' && msg.data) {
        seen.event++;
        const et = msg.data.eventType || '?';
        seen.byType[et] = (seen.byType[et] || 0) + 1;
        if ('projectId' in msg.data) seen.withProjectId++;
        if ('sessionId' in msg.data) seen.withSessionId++;
      }
    });
    sock.on('error', finish);
    setTimeout(finish, 12000);
  });

  if (seen.event === 0) {
    findings.push({ level: 'skip', msg: 'no live event frames in 12s (idle app?) — could not verify event shape' });
  } else {
    // ws-client.ts:83-86 reads msg.data.projectId (primary filter) and msg.data.sessionId (fallback)
    if (seen.withProjectId === 0) {
      findings.push({
        level: 'drift',
        msg: `ws-client.ts filters on msg.data.projectId, but 0/${seen.event} live event frames carried a projectId field. ` +
             `Live project-filtering silently degrades to the stale sessionId-list fallback. ` +
             `Fix: collector should attach projectId to broadcast event payloads (store.rs broadcastEvent).`,
      });
    } else if (seen.withProjectId < seen.event) {
      findings.push({ level: 'warn', msg: `only ${seen.withProjectId}/${seen.event} event frames carried projectId` });
    }
    if (seen.withSessionId < seen.event) {
      findings.push({ level: 'warn', msg: `only ${seen.withSessionId}/${seen.event} event frames carried sessionId (fallback filter key)` });
    }
    findings.push({ level: 'info', msg: `sampled ${seen.event} event frames: ${JSON.stringify(seen.byType)}` });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const calls = extractDashboardCalls();
const routes = extractCollectorRoutes();
const handled = extractWsHandledTypes();
const broadcast = extractWsBroadcastTypes();

const calledButUnserved = []; // blocking
const methodMismatch = [];    // blocking
for (const c of calls) {
  const matches = matchPath(c.path, routes);
  if (matches.length === 0) {
    calledButUnserved.push(c);
  } else {
    const methods = new Set(matches.flatMap((r) => [...r.methods]));
    if (!methods.has(c.method)) {
      methodMismatch.push({ ...c, served: [...methods].sort().join(','), via: matches.map((r) => r.path) });
    }
  }
}

// served-but-uncalled (informational unless surprising)
const servedButUncalled = [];
for (const r of routes) {
  if (SERVED_UNCALLED_ALLOW.includes(r.path)) continue;
  const called = calls.some((c) => matchPath(c.path, [r]).length > 0);
  if (!called) servedButUncalled.push(r);
}

// WS drift
const wsHandledNotBroadcast = [...handled].filter((t) => !broadcast.has(t));
const wsBroadcastNotHandled = [...broadcast].filter((t) => !handled.has(t) && t !== 'error');

let live = [];
if (LIVE) live = await probeLive();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const liveDrift = live.filter((f) => f.level === 'drift');
const blocking =
  calledButUnserved.length + methodMismatch.length + wsHandledNotBroadcast.length + liveDrift.length;

if (JSON_OUT) {
  console.log(JSON.stringify({
    calledButUnserved, methodMismatch, servedButUncalled: servedButUncalled.map((r) => ({ path: r.path, methods: [...r.methods] })),
    wsHandledNotBroadcast, wsBroadcastNotHandled, live, blocking,
  }, null, 2));
  process.exit(blocking > 0 ? 1 : 0);
}

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YEL = (s) => `\x1b[33m${s}\x1b[0m`;
const GRN = (s) => `\x1b[32m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

console.log(B('\n  Dashboard ⇄ Collector drift report'));
console.log(DIM(`  dashboard calls: ${calls.length}   collector routes: ${routes.length}\n`));

console.log(B('  [1] HTTP — called but UNSERVED (path not registered):'));
if (!calledButUnserved.length) console.log(GRN('      none'));
for (const c of calledButUnserved) console.log(RED(`      ✗ ${c.method} ${c.path}`) + DIM(`  ${c.sites[0]}`));

console.log(B('\n  [2] HTTP — METHOD mismatch (path served, method not):'));
if (!methodMismatch.length) console.log(GRN('      none'));
for (const c of methodMismatch) console.log(RED(`      ✗ ${c.method} ${c.path}`) + DIM(`  served=[${c.served}] via ${c.via.join(',')}  ${c.sites[0]}`));

console.log(B('\n  [3] WS — handled by dashboard but NEVER broadcast by collector:'));
if (!wsHandledNotBroadcast.length) console.log(GRN('      none'));
for (const t of wsHandledNotBroadcast) console.log(RED(`      ✗ "${t}"`) + DIM('  (dead ws-client handler — collector emits no such frame)'));

console.log(B('\n  [4] WS — broadcast by collector but not handled by dashboard:'));
if (!wsBroadcastNotHandled.length) console.log(GRN('      none'));
for (const t of wsBroadcastNotHandled) console.log(YEL(`      ⚠ "${t}"`));

console.log(B('\n  [info] collector routes with no dashboard caller (MCP/external or dead):'));
if (!servedButUncalled.length) console.log(DIM('      none'));
for (const r of servedButUncalled) console.log(DIM(`      · ${[...r.methods].sort().join(',')} ${r.path}`));

if (LIVE) {
  console.log(B('\n  [5] LIVE shape probe:'));
  for (const f of live) {
    const tag = f.level === 'drift' ? RED('✗') : f.level === 'warn' ? YEL('⚠') : f.level === 'skip' ? DIM('–') : DIM('·');
    console.log(`      ${tag} ${f.msg}`);
  }
}

console.log('');
if (blocking > 0) {
  console.log(RED(B(`  DRIFT DETECTED — ${blocking} blocking finding(s). See above.\n`)));
  process.exit(1);
} else {
  console.log(GRN(B('  No blocking drift.\n')));
  process.exit(0);
}
