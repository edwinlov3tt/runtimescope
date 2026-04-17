/**
 * collector-control — MCP tools that let Claude start, stop, and query
 * the RuntimeScope collector lifecycle.
 *
 * When the MCP server itself is running, a collector is already embedded
 * inside it (port 6767/6768 by default). These tools are for the
 * persistent always-on case: installing/stopping the launchd or systemd
 * service so the collector survives Claude Code restarts.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

const LAUNCHD_LABEL = 'com.runtimescope.collector';
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = join(homedir(), '.config', 'systemd', 'user', 'runtimescope.service');

interface ControlResponse {
  summary: string;
  data: {
    was_already_running: boolean;
    started: boolean;
    method: 'already-running' | 'service-started' | 'spawned' | 'failed';
    pid: number | null;
    version: string | null;
    http_endpoint: string;
    ws_endpoint: string;
    service_installed: boolean;
    platform: string;
  };
  issues: string[];
  metadata: {
    timeRange: { from: number; to: number };
    eventCount: number;
    sessionId: null;
    projectId: null;
  };
}

async function isCollectorReachable(
  port: number,
): Promise<{ reachable: boolean; version: string | null }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { reachable: false, version: null };
    const data = (await res.json()) as { status?: string; version?: string };
    return {
      reachable: data.status === 'ok',
      version: data.version ?? null,
    };
  } catch {
    return { reachable: false, version: null };
  }
}

function isServiceInstalled(): boolean {
  const os = platform();
  if (os === 'darwin') return existsSync(LAUNCHD_PLIST);
  if (os === 'linux') return existsSync(SYSTEMD_UNIT);
  return false;
}

function getServicePid(): number | null {
  const os = platform();
  try {
    if (os === 'darwin') {
      const out = execFileSync('launchctl', ['list', LAUNCHD_LABEL], {
        encoding: 'utf-8',
      });
      const m = out.match(/"PID"\s*=\s*(\d+)/);
      return m ? parseInt(m[1], 10) : null;
    }
    if (os === 'linux') {
      const out = execFileSync(
        'systemctl',
        ['--user', 'show', 'runtimescope.service', '--property=MainPID', '--value'],
        { encoding: 'utf-8' },
      ).trim();
      const pid = parseInt(out, 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
  } catch {
    /* service not installed or not running */
  }
  return null;
}

function startInstalledService(): boolean {
  const os = platform();
  try {
    if (os === 'darwin') {
      execFileSync('launchctl', ['load', '-w', LAUNCHD_PLIST], { stdio: 'ignore' });
      return true;
    }
    if (os === 'linux') {
      execFileSync('systemctl', ['--user', 'start', 'runtimescope.service'], {
        stdio: 'ignore',
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function stopInstalledService(): boolean {
  const os = platform();
  try {
    if (os === 'darwin') {
      execFileSync('launchctl', ['unload', LAUNCHD_PLIST], { stdio: 'ignore' });
      return true;
    }
    if (os === 'linux') {
      execFileSync('systemctl', ['--user', 'stop', 'runtimescope.service'], {
        stdio: 'ignore',
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Spawn the collector directly, detached, so it outlives this process. */
function spawnDetachedCollector(): { ok: boolean; pid: number | null; message: string } {
  try {
    // Prefer the CLI so env+paths are resolved consistently
    const child = spawn('npx', ['-y', 'runtimescope', 'start'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return {
      ok: true,
      pid: child.pid ?? null,
      message: 'Spawned via `npx -y runtimescope start`',
    };
  } catch (err) {
    return {
      ok: false,
      pid: null,
      message: `spawn failed: ${(err as Error).message}`,
    };
  }
}

export function registerCollectorControlTools(server: McpServer): void {
  server.tool(
    'start_collector',
    'Start the RuntimeScope collector if it is not already running. By default, starts the installed launchd/systemd service (if present) or spawns a detached `npx runtimescope start` process. Set persist=true to also install the service so the collector auto-starts on every user login.',
    {
      persist: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'If true, install the collector as a background service (launchd on macOS, systemd user service on Linux) so it starts on every login and restarts on crash.',
        ),
    },
    async ({ persist }) => {
      const os = platform();
      const httpPort = parseInt(process.env.RUNTIMESCOPE_HTTP_PORT ?? '6768', 10);
      const wsPort = parseInt(process.env.RUNTIMESCOPE_PORT ?? '6767', 10);

      // 1. Already running?
      const health = await isCollectorReachable(httpPort);
      if (health.reachable) {
        const response: ControlResponse = {
          summary: `Collector is already running${health.version ? ` (v${health.version})` : ''} on http://127.0.0.1:${httpPort}.`,
          data: {
            was_already_running: true,
            started: false,
            method: 'already-running',
            pid: getServicePid(),
            version: health.version,
            http_endpoint: `http://127.0.0.1:${httpPort}`,
            ws_endpoint: `ws://127.0.0.1:${wsPort}`,
            service_installed: isServiceInstalled(),
            platform: os,
          },
          issues: [],
          metadata: {
            timeRange: { from: 0, to: Date.now() },
            eventCount: 0,
            sessionId: null,
            projectId: null,
          },
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        };
      }

      const issues: string[] = [];
      let method: ControlResponse['data']['method'] = 'failed';
      let started = false;

      // 2. If persist=true and service isn't installed, install it via the CLI
      if (persist && !isServiceInstalled()) {
        if (os !== 'darwin' && os !== 'linux') {
          issues.push(`Platform '${os}' does not support the background service yet.`);
        } else {
          try {
            execFileSync('npx', ['-y', 'runtimescope', 'service', 'install'], {
              stdio: 'pipe',
            });
            method = 'service-started';
            started = true;
          } catch (err) {
            issues.push(`Service install failed: ${(err as Error).message}`);
          }
        }
      }

      // 3. Try the already-installed service
      if (!started && isServiceInstalled()) {
        if (startInstalledService()) {
          method = 'service-started';
          started = true;
        } else {
          issues.push('Installed service failed to start — will try direct spawn.');
        }
      }

      // 4. Fall back to a detached `npx runtimescope start`
      if (!started) {
        const spawnResult = spawnDetachedCollector();
        if (spawnResult.ok) {
          method = 'spawned';
          started = true;
        } else {
          issues.push(spawnResult.message);
        }
      }

      // 5. Wait up to 5s for the collector to come up
      let postHealth = { reachable: false, version: null as string | null };
      if (started) {
        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 200));
          postHealth = await isCollectorReachable(httpPort);
          if (postHealth.reachable) break;
        }
      }

      const response: ControlResponse = {
        summary: postHealth.reachable
          ? `Collector started${postHealth.version ? ` (v${postHealth.version})` : ''} via ${method}. Listening on http://127.0.0.1:${httpPort}.`
          : started
            ? `Collector process started but /api/health is not responding yet. Wait a few seconds and re-check.`
            : `Could not start the collector. See issues for details.`,
        data: {
          was_already_running: false,
          started,
          method,
          pid: getServicePid(),
          version: postHealth.version,
          http_endpoint: `http://127.0.0.1:${httpPort}`,
          ws_endpoint: `ws://127.0.0.1:${wsPort}`,
          service_installed: isServiceInstalled(),
          platform: os,
        },
        issues,
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: 0,
          sessionId: null,
          projectId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'stop_collector',
    "Stop the RuntimeScope collector. If it was started as a launchd/systemd service, this stops the service. If it was spawned directly (or is another process), this sends SIGTERM to whatever process is holding the collector's HTTP port.",
    {
      uninstall_service: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'If true, also remove the launchd/systemd service definition so the collector no longer auto-starts on login.',
        ),
    },
    async ({ uninstall_service }) => {
      const httpPort = parseInt(process.env.RUNTIMESCOPE_HTTP_PORT ?? '6768', 10);
      const wsPort = parseInt(process.env.RUNTIMESCOPE_PORT ?? '6767', 10);
      const os = platform();

      const issues: string[] = [];
      let stopped = false;

      // 1. If installed as a service, stop the service
      if (isServiceInstalled()) {
        if (stopInstalledService()) {
          stopped = true;
        } else {
          issues.push('Service was installed but could not be stopped cleanly.');
        }
      }

      // 2. If anything else is still on the port, kill it
      if (os === 'darwin' || os === 'linux') {
        try {
          const pidList = execFileSync('lsof', ['-ti', `:${httpPort}`], {
            encoding: 'utf-8',
          }).trim();
          for (const pidStr of pidList.split('\n').filter(Boolean)) {
            const pid = parseInt(pidStr, 10);
            if (Number.isFinite(pid) && pid !== process.pid) {
              try {
                process.kill(pid);
                stopped = true;
              } catch {
                /* already gone */
              }
            }
          }
        } catch {
          /* lsof returns non-zero when port is free — that's fine */
        }
      }

      // 3. If requested, uninstall the service definition
      let uninstalled = false;
      if (uninstall_service && isServiceInstalled()) {
        try {
          execFileSync('npx', ['-y', 'runtimescope', 'service', 'uninstall'], {
            stdio: 'pipe',
          });
          uninstalled = true;
        } catch (err) {
          issues.push(`Service uninstall failed: ${(err as Error).message}`);
        }
      }

      const health = await isCollectorReachable(httpPort);
      const response: ControlResponse = {
        summary: health.reachable
          ? 'Collector is still reachable after stop attempt — check issues.'
          : stopped
            ? `Collector stopped${uninstalled ? ' and service uninstalled' : ''}.`
            : 'Collector was not running.',
        data: {
          was_already_running: true,
          started: false,
          method: stopped ? 'service-started' : 'already-running',
          pid: null,
          version: null,
          http_endpoint: `http://127.0.0.1:${httpPort}`,
          ws_endpoint: `ws://127.0.0.1:${wsPort}`,
          service_installed: isServiceInstalled(),
          platform: os,
        },
        issues,
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: 0,
          sessionId: null,
          projectId: null,
        },
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
