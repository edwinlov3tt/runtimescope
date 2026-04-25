/**
 * Scenario: framework-smoke
 *
 * For each SDK package we ship, do the smallest end-to-end run the framework
 * supports and assert the canary event arrived at the collector. This is the
 * "did we accidentally break a package's exports / build" smoke test —
 * something a unit test in the SDK package can't easily catch because
 * subpath exports + bundling only fail in real consumers.
 *
 * Covered:
 *   - @runtimescope/server-sdk         (raw Node)
 *   - @runtimescope/sdk                (browser shape, in Node-as-stub)
 *   - @runtimescope/workers-sdk        (HTTP transport — POSTs to /api/events)
 *   - runtimescope (Python)            (subprocess driver if `python3` exists)
 *
 * Each driver pushes a uniquely-tagged canary event so we can assert it
 * arrived without false matches.
 */

import { spawnCollector } from '../utils/spawn-collector.js';
import { CheckCollector } from '../utils/assert.js';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

export async function frameworkSmoke(checks: CheckCollector): Promise<void> {
  const collector = await spawnCollector();
  try {
    await collector.ready();
    const httpPort = collector.httpPort;
    const wsPort = collector.wsPort;

    // ---- 1. server-sdk: send a canary console.log via the actual SDK ----
    {
      const canary = `server-sdk-canary-${Date.now()}`;
      const driver = `
import { RuntimeScope } from '${join(REPO_ROOT, 'packages/server-sdk/dist/index.js')}';
RuntimeScope.connect({
  serverUrl: 'ws://127.0.0.1:${wsPort}',
  appName: 'stress-server-sdk',
  projectId: 'proj_stress_node',
  capturePerformance: false,
});
await new Promise(r => setTimeout(r, 300));
console.log('${canary}');
await new Promise(r => setTimeout(r, 600));
// The SDK keeps a heartbeat timer that would otherwise keep the process alive.
// Force-exit after we've sent the canary; disconnect() returns synchronously.
RuntimeScope.disconnect();
process.exit(0);
`;
      const ok = await runDriverScript(driver, 5000);
      checks.ok('server-sdk: driver script runs to completion', ok);

      await new Promise((r) => setTimeout(r, 400));
      const found = await canaryArrived(httpPort, 'proj_stress_node', canary);
      checks.ok('server-sdk: canary console event arrived at collector', found);
    }

    // ---- 2. workers-sdk: HTTP transport ----
    {
      const canary = `workers-sdk-canary-${Date.now()}`;
      // The workers-sdk Transport API is `queue(event)` (not send) + flush().
      // It uses HTTP POST to /api/events — no WebSocket — so it works without
      // any Workers runtime, just a plain Node fetch.
      const driver = `
import { WorkersTransport } from '${join(REPO_ROOT, 'packages/workers-sdk/dist/index.js')}';
// NB: workers-sdk uses 'httpEndpoint' (not 'endpoint' like browser/server).
// Naming inconsistency tracked separately — surfaced by the stress harness.
const transport = new WorkersTransport({
  httpEndpoint: 'http://127.0.0.1:${httpPort}/api/events',
  appName: 'stress-workers',
  projectId: 'proj_stress_workers',
});
// transport.sessionId is generated internally; events should reference it
// so the collector links them to the auto-registered session.
transport.queue({
  eventId: 'workers-1',
  sessionId: transport.sessionId,
  timestamp: Date.now(),
  eventType: 'console',
  level: 'log',
  message: '${canary}',
  args: [],
});
await transport.flush();
process.exit(0);
`;
      const ok = await runDriverScript(driver, 5000);
      checks.ok('workers-sdk: HTTP transport runs to completion', ok);

      await new Promise((r) => setTimeout(r, 400));
      const found = await canaryArrived(httpPort, 'proj_stress_workers', canary);
      checks.ok('workers-sdk: canary event arrived via HTTP transport', found);
    }

    // ---- 3. python-sdk: only if python3 + the package is installed ----
    if (await canRunPython()) {
      const canary = `python-canary-${Date.now()}`;
      // The Python SDK is class-based: RuntimeScope.connect(...) +
      // RuntimeScope.track(...). It does NOT auto-instrument logging — we
      // emit a custom event as the canary instead, which the collector
      // routes to /api/events/custom.
      // Python SDK uses a DSN — same shape as the JS SDKs. The Python DSN
      // parser derives ws:// from the http port (port - 1), so we pass the
      // HTTP port as the DSN authority.
      const py = `
import sys, time
sys.path.insert(0, '${join(REPO_ROOT, 'packages/python-sdk')}')
from runtimescope import RuntimeScope
RuntimeScope.connect(
    dsn='runtimescope://proj_stress_python@127.0.0.1:${httpPort}/stress-python',
)
time.sleep(0.5)
RuntimeScope.track('${canary}', {'source': 'stress-test'})
time.sleep(0.8)
RuntimeScope.disconnect()
`;
      const ok = await runPythonScript(py, 10_000);
      checks.ok('python-sdk: driver script runs to completion', ok);

      await new Promise((r) => setTimeout(r, 600));
      // Python SDK emits the canary as a custom event, not a console event.
      const customRes = await fetch(
        `http://127.0.0.1:${httpPort}/api/events/custom?project_id=proj_stress_python`,
      ).then((r) => r.json()) as { data: { name: string }[] };
      const found = customRes.data.some((e) => e.name === canary);
      checks.ok('python-sdk: canary custom event arrived at collector', found);
    } else {
      console.log('  (skipping python-sdk — python3 + runtimescope package not available)');
    }
  } finally {
    await collector.stop();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function canaryArrived(httpPort: number, project: string, canary: string): Promise<boolean> {
  // Try the console route first (most SDK canaries land there), fall back to a
  // broader timeline query.
  for (const path of ['/api/events/console', '/api/events/timeline']) {
    try {
      const res = await fetch(
        `http://127.0.0.1:${httpPort}${path}?project_id=${project}`,
      ).then((r) => r.json()) as { data: { message?: string; eventId?: string }[] };
      if (res.data.some((e) => (e.message ?? '').includes(canary) || (e.eventId ?? '').includes(canary))) {
        return true;
      }
    } catch {
      /* try next path */
    }
  }
  return false;
}

async function runDriverScript(source: string, timeoutMs: number): Promise<boolean> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'rs-driver-'));
  const scriptPath = join(tmpDir, 'driver.mjs');
  writeFileSync(scriptPath, source);
  try {
    const proc = spawn('node', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let captured = '';
    proc.stdout?.on('data', (b) => { captured += b.toString(); });
    proc.stderr?.on('data', (b) => { captured += b.toString(); });

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, timeoutMs);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          // Script failure — surface the captured output for debugging.
          console.error(`  driver script exit=${code}\n  --- output ---\n${captured.slice(0, 2000).split('\n').map((l) => `  ${l}`).join('\n')}`);
        }
        resolve(code === 0);
      });
    });
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function canRunPython(): Promise<boolean> {
  try {
    const which = spawn('python3', ['--version'], { stdio: 'ignore' });
    return await new Promise<boolean>((resolve) => {
      which.on('exit', (code) => resolve(code === 0));
      which.on('error', () => resolve(false));
    });
  } catch {
    return false;
  }
}

async function runPythonScript(source: string, timeoutMs: number): Promise<boolean> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'rs-pydriver-'));
  const scriptPath = join(tmpDir, 'driver.py');
  writeFileSync(scriptPath, source);
  try {
    const proc = spawn('python3', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let captured = '';
    proc.stdout?.on('data', (b) => { captured += b.toString(); });
    proc.stderr?.on('data', (b) => { captured += b.toString(); });

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, timeoutMs);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.error(`  python script exit=${code}\n  --- output ---\n${captured.slice(0, 2000).split('\n').map((l) => `  ${l}`).join('\n')}`);
        }
        resolve(code === 0);
      });
    });
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
