#!/usr/bin/env node

// ============================================================
// RuntimeScope Dashboard Launcher
//
// Smart single command that:
// 1. Detects if MCP server is already running (port 9090/9091)
// 2. Starts standalone collector on free ports if needed
// 3. Launches the dashboard Vite dev server
//
// Usage:
//   node dist/dashboard.js
//   npm run dashboard       (from repo root)
// ============================================================

import { createServer, type Server } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const MCP_WS_PORT = 9090;
const MCP_HTTP_PORT = 9091;
const FALLBACK_WS_PORT = 9092;
const FALLBACK_HTTP_PORT = 9093;
const DASHBOARD_PORT = 3200;

// ---- Port checking ----

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server: Server = createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, '127.0.0.1');
  });
}

// ---- Main ----

async function main(): Promise<void> {
  const children: ChildProcess[] = [];

  const cleanup = () => {
    console.error('\n[RuntimeScope] Shutting down...');
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // 1. Detect if MCP server is already running
  const mcpRunning = await isPortInUse(MCP_HTTP_PORT);
  let collectorHttpPort: number;
  let collectorWsPort: number;
  let collectorProcess: ChildProcess | null = null;

  if (mcpRunning) {
    // MCP server is running — check if it has our HTTP API
    try {
      const res = await fetch(`http://127.0.0.1:${MCP_HTTP_PORT}/api/health`);
      const data = await res.json() as { status?: string };
      if (data.status === 'ok') {
        console.error(`[RuntimeScope] MCP server detected on :${MCP_HTTP_PORT}`);
        collectorHttpPort = MCP_HTTP_PORT;
        collectorWsPort = MCP_WS_PORT;
      } else {
        throw new Error('Not RuntimeScope');
      }
    } catch {
      // Port 9091 is in use but not by RuntimeScope — use fallback
      console.error(`[RuntimeScope] Port ${MCP_HTTP_PORT} in use (not RuntimeScope) — using fallback ports`);
      collectorHttpPort = FALLBACK_HTTP_PORT;
      collectorWsPort = FALLBACK_WS_PORT;
    }
  } else {
    // Nothing on 9090/9091 — start collector on default ports
    collectorHttpPort = MCP_HTTP_PORT;
    collectorWsPort = MCP_WS_PORT;
  }

  // 2. Start standalone collector if MCP isn't providing the API
  const needsCollector = collectorHttpPort !== MCP_HTTP_PORT || !mcpRunning;

  if (needsCollector) {
    const standalonePath = join(__dirname, 'standalone.js');
    if (!existsSync(standalonePath)) {
      console.error('[RuntimeScope] Error: standalone.js not found. Run `npm run build -w packages/collector` first.');
      process.exit(1);
    }

    console.error(`[RuntimeScope] Starting collector on ws://:${collectorWsPort} + http://:${collectorHttpPort}...`);

    collectorProcess = spawn('node', [standalonePath], {
      env: {
        ...process.env,
        RUNTIMESCOPE_PORT: String(collectorWsPort),
        RUNTIMESCOPE_HTTP_PORT: String(collectorHttpPort),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    children.push(collectorProcess);

    // Wait for collector to be ready
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${collectorHttpPort}/api/health`);
        if (res.ok) break;
      } catch { /* not ready yet */ }
    }
  }

  // 3. Check if collector API is healthy
  try {
    const res = await fetch(`http://127.0.0.1:${collectorHttpPort}/api/health`);
    const data = await res.json() as { status?: string; sessions?: number };
    console.error(`[RuntimeScope] Collector ready (${data.sessions ?? 0} sessions)`);
  } catch {
    console.error(`[RuntimeScope] Warning: Could not reach collector on :${collectorHttpPort}`);
  }

  // 4. Start dashboard
  const dashboardDir = join(REPO_ROOT, 'packages', 'dashboard');
  if (!existsSync(dashboardDir)) {
    console.error(`[RuntimeScope] Dashboard not found at ${dashboardDir}`);
    process.exit(1);
  }

  // Check if port 3200 is free
  const dashboardInUse = await isPortInUse(DASHBOARD_PORT);
  if (dashboardInUse) {
    console.error(`[RuntimeScope] Dashboard already running on http://localhost:${DASHBOARD_PORT}`);
    console.error(`[RuntimeScope] Open http://localhost:${DASHBOARD_PORT} in your browser`);
    if (!needsCollector) process.exit(0);
    // Keep running if we started a collector
    return;
  }

  console.error(`[RuntimeScope] Starting dashboard on http://localhost:${DASHBOARD_PORT}...`);

  const vite = spawn('npx', ['vite', '--port', String(DASHBOARD_PORT)], {
    cwd: dashboardDir,
    env: {
      ...process.env,
      VITE_API_TARGET: `http://127.0.0.1:${collectorHttpPort}`,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(vite);

  // Wait for Vite to be ready and show the URL
  vite.stdout?.on('data', (data: Buffer) => {
    const line = data.toString();
    if (line.includes('Local:') || line.includes('ready')) {
      // Don't echo Vite's output — we'll print our own summary
    }
  });

  // Wait a moment for Vite to start
  await new Promise((r) => setTimeout(r, 3000));

  // 5. Print summary
  console.error('');
  console.error('  ╔══════════════════════════════════════════════╗');
  console.error('  ║          RuntimeScope Dashboard              ║');
  console.error('  ╠══════════════════════════════════════════════╣');
  console.error(`  ║  Dashboard:  http://localhost:${DASHBOARD_PORT}            ║`);
  console.error(`  ║  Collector:  ws://127.0.0.1:${collectorWsPort}             ║`);
  console.error(`  ║  HTTP API:   http://127.0.0.1:${collectorHttpPort}           ║`);
  console.error(`  ║  Source:     ${mcpRunning && collectorHttpPort === MCP_HTTP_PORT ? 'MCP Server (Claude Code)' : 'Standalone Collector  '}  ║`);
  console.error('  ╚══════════════════════════════════════════════╝');
  console.error('');
  console.error('  Press Ctrl+C to stop.');
  console.error('');

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[RuntimeScope] Fatal:', err);
  process.exit(1);
});
