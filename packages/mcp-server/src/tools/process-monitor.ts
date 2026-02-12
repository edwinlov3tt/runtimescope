import { z } from 'zod';
import { execSync, spawn } from 'node:child_process';
import { existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProcessMonitor } from '@runtimescope/collector';

export function registerProcessMonitorTools(
  server: McpServer,
  processMonitor: ProcessMonitor
): void {
  // --- get_dev_processes ---
  server.tool(
    'get_dev_processes',
    'List all running dev processes (Next.js, Vite, Prisma, Docker, databases, etc.) with PID, port, memory, and CPU usage.',
    {
      type: z.string().optional().describe('Filter by process type (next, vite, docker, postgres, etc.)'),
      project: z.string().optional().describe('Filter by project name'),
    },
    async ({ type, project }) => {
      processMonitor.scan();
      const processes = processMonitor.getProcesses({
        type: type as Parameters<typeof processMonitor.getProcesses>[0] extends undefined ? never : NonNullable<Parameters<typeof processMonitor.getProcesses>[0]>['type'],
        project,
      });

      const issues = processMonitor.detectIssues();

      const response = {
        summary: `${processes.length} dev process(es) running.${issues.length > 0 ? ` ${issues.length} issue(s) detected.` : ''}`,
        data: processes.map((p) => ({
          pid: p.pid,
          type: p.type,
          command: p.command,
          cpuPercent: `${p.cpuPercent}%`,
          memoryMB: `${p.memoryMB.toFixed(0)}MB`,
          ports: p.ports,
          cwd: p.cwd ?? null,
          project: p.project ?? null,
          isOrphaned: p.isOrphaned,
        })),
        issues: issues.map((i) => i.title),
        metadata: {
          timeRange: { from: Date.now(), to: Date.now() },
          eventCount: processes.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- kill_process ---
  server.tool(
    'kill_process',
    'Terminate a dev process by PID. Default signal is SIGTERM; use SIGKILL for force kill.',
    {
      pid: z.number().describe('Process ID to kill'),
      signal: z.enum(['SIGTERM', 'SIGKILL']).optional().describe('Signal to send (default: SIGTERM)'),
    },
    async ({ pid, signal }) => {
      const result = processMonitor.killProcess(pid, signal ?? 'SIGTERM');

      const response = {
        summary: result.success
          ? `Process ${pid} terminated with ${signal ?? 'SIGTERM'}.`
          : `Failed to kill process ${pid}: ${result.error}`,
        data: result,
        issues: result.error ? [result.error] : [],
        metadata: {
          timeRange: { from: Date.now(), to: Date.now() },
          eventCount: 1,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_port_usage ---
  server.tool(
    'get_port_usage',
    'Show which dev processes are bound to which ports. Useful for debugging port conflicts.',
    {
      port: z.number().optional().describe('Filter by specific port number'),
    },
    async ({ port }) => {
      processMonitor.scan();
      const ports = processMonitor.getPortUsage(port);

      const response = {
        summary: `${ports.length} port binding(s) found.`,
        data: ports.map((p) => ({
          port: p.port,
          pid: p.pid,
          process: p.process,
          type: p.type,
          project: p.project ?? null,
        })),
        issues: [] as string[],
        metadata: {
          timeRange: { from: Date.now(), to: Date.now() },
          eventCount: ports.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- purge_caches ---
  server.tool(
    'purge_caches',
    'Delete common build/dev cache directories (.next/cache, node_modules/.cache, .vite, .turbo, .swc, .parcel-cache, etc.) for a project directory. Reports size freed per cache.',
    {
      directory: z.string().describe('Absolute path to the project directory'),
      dryRun: z.boolean().optional().describe('If true, report what would be deleted without actually deleting (default: false)'),
    },
    async ({ directory, dryRun }) => {
      const CACHE_TARGETS = [
        '.next/cache',
        'node_modules/.cache',
        'node_modules/.vite',
        '.turbo',
        '.cache',
        '.swc',
        '.parcel-cache',
        '.nuxt',
        'tsconfig.tsbuildinfo',
      ];

      const purged: { path: string; sizeMB: number; deleted: boolean }[] = [];
      let totalFreed = 0;

      for (const target of CACHE_TARGETS) {
        const fullPath = join(directory, target);
        if (!existsSync(fullPath)) continue;

        const sizeMB = getDirSizeMB(fullPath);
        const deleted = !dryRun;

        if (!dryRun) {
          try {
            rmSync(fullPath, { recursive: true, force: true });
          } catch {
            purged.push({ path: target, sizeMB, deleted: false });
            continue;
          }
        }

        totalFreed += sizeMB;
        purged.push({ path: target, sizeMB, deleted });
      }

      const mode = dryRun ? 'Dry run' : 'Purged';
      const response = {
        summary: purged.length > 0
          ? `${mode}: ${purged.length} cache(s), ${totalFreed.toFixed(1)}MB ${dryRun ? 'would be freed' : 'freed'}.`
          : 'No caches found to purge.',
        data: {
          directory,
          dryRun: dryRun ?? false,
          totalFreedMB: parseFloat(totalFreed.toFixed(1)),
          caches: purged,
        },
        issues: purged.filter((p) => !p.deleted && !dryRun).map((p) => `Failed to delete ${p.path}`),
        metadata: {
          timeRange: { from: Date.now(), to: Date.now() },
          eventCount: purged.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- restart_dev_server ---
  server.tool(
    'restart_dev_server',
    'Kill a dev server process, purge build caches in its working directory, and restart it with the same or a custom command. Combines kill_process + purge_caches + spawn into one operation.',
    {
      pid: z.number().describe('PID of the dev server process to restart'),
      command: z.string().optional().describe('Custom start command (e.g. "npm run dev"). If omitted, infers from process type.'),
      skipCachePurge: z.boolean().optional().describe('If true, skip cache purging (default: false)'),
      signal: z.enum(['SIGTERM', 'SIGKILL']).optional().describe('Kill signal (default: SIGTERM)'),
    },
    async ({ pid, command, skipCachePurge, signal }) => {
      // 1. Get process info before killing
      processMonitor.scan();
      const processes = processMonitor.getProcesses();
      const proc = processes.find((p) => p.pid === pid);

      if (!proc) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: `Process ${pid} not found. It may have already exited.`,
              data: { pid, found: false },
              issues: [`Process ${pid} not found`],
              metadata: { timeRange: { from: Date.now(), to: Date.now() }, eventCount: 0, sessionId: null },
            }, null, 2),
          }],
        };
      }

      const cwd = proc.cwd;
      const startCommand = command ?? inferStartCommand(proc.type, proc.command);

      // 2. Kill the process
      const killResult = processMonitor.killProcess(pid, signal ?? 'SIGTERM');
      if (!killResult.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: `Failed to kill process ${pid}: ${killResult.error}`,
              data: { pid, killed: false, error: killResult.error },
              issues: [killResult.error ?? 'Unknown error'],
              metadata: { timeRange: { from: Date.now(), to: Date.now() }, eventCount: 0, sessionId: null },
            }, null, 2),
          }],
        };
      }

      // Wait briefly for process to exit
      await new Promise((r) => setTimeout(r, 500));

      // 3. Purge caches
      let cachesFreedMB = 0;
      let cachesPurged = 0;
      if (!skipCachePurge && cwd) {
        const CACHE_TARGETS = [
          '.next/cache', 'node_modules/.cache', 'node_modules/.vite',
          '.turbo', '.cache', '.swc', '.parcel-cache', '.nuxt', 'tsconfig.tsbuildinfo',
        ];
        for (const target of CACHE_TARGETS) {
          const fullPath = join(cwd, target);
          if (!existsSync(fullPath)) continue;
          const sizeMB = getDirSizeMB(fullPath);
          try {
            rmSync(fullPath, { recursive: true, force: true });
            cachesFreedMB += sizeMB;
            cachesPurged++;
          } catch {
            // skip failures
          }
        }
      }

      // 4. Restart with new command
      let restarted = false;
      let newPid: number | null = null;
      let restartError: string | undefined;

      if (startCommand && cwd) {
        try {
          const child = spawn(startCommand, {
            cwd,
            shell: true,
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
          newPid = child.pid ?? null;
          restarted = true;
        } catch (err) {
          restartError = (err as Error).message;
        }
      } else if (!startCommand) {
        restartError = 'Could not infer start command. Provide one via the "command" parameter.';
      } else if (!cwd) {
        restartError = 'Could not determine working directory for the process. Provide a command and working directory manually.';
      }

      const response = {
        summary: [
          `Killed ${proc.type} process ${pid}.`,
          cachesPurged > 0 ? `Purged ${cachesPurged} cache(s) (${cachesFreedMB.toFixed(1)}MB).` : null,
          restarted ? `Restarted with PID ${newPid} using: ${startCommand}` : null,
          restartError ? `Restart failed: ${restartError}` : null,
        ].filter(Boolean).join(' '),
        data: {
          killed: { pid, type: proc.type, signal: signal ?? 'SIGTERM' },
          cachesPurged: { count: cachesPurged, freedMB: parseFloat(cachesFreedMB.toFixed(1)) },
          restarted: { success: restarted, newPid, command: startCommand, cwd },
        },
        issues: restartError ? [restartError] : [],
        metadata: {
          timeRange: { from: Date.now(), to: Date.now() },
          eventCount: 1,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}

// --- Helpers ---

function getDirSizeMB(path: string): number {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return stat.size / (1024 * 1024);

    // Use du for directories (fast, handles nested files)
    const output = execSync(`du -sk "${path}" 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 });
    const kb = parseInt(output.trim().split('\t')[0], 10);
    return isNaN(kb) ? 0 : kb / 1024;
  } catch {
    return 0;
  }
}

function inferStartCommand(type: string, rawCommand: string): string | null {
  // Common dev server start commands by type
  const defaults: Record<string, string> = {
    next: 'npx next dev',
    vite: 'npx vite',
    webpack: 'npx webpack serve',
    wrangler: 'npx wrangler dev',
    prisma: 'npx prisma studio',
    bun: 'bun run dev',
    deno: 'deno task dev',
  };

  if (defaults[type]) return defaults[type];

  // For node processes, check if the original command gives us clues
  if (rawCommand.includes('ts-node') || rawCommand.includes('tsx')) {
    // Extract the script path
    const match = rawCommand.match(/(ts-node|tsx)\s+(.+)/);
    if (match) return `npx ${match[1]} ${match[2]}`;
  }

  // Fallback: try npm run dev (most common)
  if (type === 'node') return 'npm run dev';

  return null;
}
