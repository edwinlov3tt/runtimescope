import { execSync } from 'node:child_process';
import type { EventStore } from '../store.js';
import type { DevProcess, DevProcessType, PortUsage, DetectedIssue } from '../types.js';

// ============================================================
// Process Monitor Engine
// Scans for running dev processes (macOS/Linux only)
// ============================================================

const PROCESS_PATTERNS: [RegExp, DevProcessType][] = [
  [/next[\s-]dev|next-server/, 'next'],
  [/vite/, 'vite'],
  [/webpack[\s-]dev[\s-]server|webpack serve/, 'webpack'],
  [/wrangler/, 'wrangler'],
  [/prisma\s+studio|prisma\s+dev/, 'prisma'],
  [/docker/, 'docker'],
  [/postgres|pg_/, 'postgres'],
  [/mysqld/, 'mysql'],
  [/redis-server/, 'redis'],
  [/\bbun\b/, 'bun'],
  [/\bdeno\b/, 'deno'],
  [/\bpython[23]?\b/, 'python'],
  [/\bnode\b/, 'node'],
];

function detectProcessType(command: string): DevProcessType {
  for (const [pattern, type] of PROCESS_PATTERNS) {
    if (pattern.test(command)) return type;
  }
  return 'unknown';
}

function parsePs(): { pid: number; cpu: number; mem: number; command: string }[] {
  try {
    const output = execSync('ps aux', { encoding: 'utf-8', timeout: 5000 });
    const lines = output.split('\n').slice(1); // Skip header
    const results: { pid: number; cpu: number; mem: number; command: string }[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parseInt(parts[1], 10);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      // VSZ is in KB, convert to MB
      const command = parts.slice(10).join(' ');

      if (isNaN(pid)) continue;
      results.push({ pid, cpu, mem, command });
    }

    return results;
  } catch {
    return [];
  }
}

function getListenPorts(pid: number): number[] {
  try {
    const output = execSync(`lsof -nP -p ${pid} 2>/dev/null | grep LISTEN`, {
      encoding: 'utf-8',
      timeout: 3000,
    });

    const ports: number[] = [];
    for (const line of output.split('\n')) {
      const match = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (match) {
        ports.push(parseInt(match[1], 10));
      }
    }
    return [...new Set(ports)];
  } catch {
    return [];
  }
}

function getCwd(pid: number): string | undefined {
  try {
    // macOS: lsof -p PID | grep cwd
    const output = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const match = output.match(/cwd\s+\w+\s+\w+\s+\d+\w?\s+\d+\s+\d+\s+\d+\s+(.+)/);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function getMemoryMB(pid: number): number {
  try {
    const output = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf-8', timeout: 2000 });
    const rss = parseInt(output.trim(), 10);
    return isNaN(rss) ? 0 : rss / 1024;
  } catch {
    return 0;
  }
}

export class ProcessMonitor {
  private store: EventStore;
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private processes: Map<number, DevProcess> = new Map();
  private lastActivity: Map<number, number> = new Map();

  constructor(store: EventStore) {
    this.store = store;
  }

  start(intervalMs = 10_000): void {
    this.scan();
    this.scanInterval = setInterval(() => this.scan(), intervalMs);
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
  }

  scan(): void {
    const allProcesses = parsePs();
    const relevantTypes: Set<DevProcessType> = new Set([
      'next', 'vite', 'webpack', 'wrangler', 'prisma',
      'docker', 'postgres', 'mysql', 'redis', 'bun', 'deno',
    ]);

    const foundPids = new Set<number>();

    for (const proc of allProcesses) {
      const type = detectProcessType(proc.command);
      // Only track known dev-related processes, or node processes listening on ports
      if (type === 'unknown' || type === 'python') continue;
      if (type === 'node' && !relevantTypes.has(type)) {
        // For generic node processes, only include if they look like dev servers
        if (!proc.command.includes('server') && !proc.command.includes('dev') && !proc.command.includes('start')) {
          continue;
        }
      }

      foundPids.add(proc.pid);

      // Only do expensive lsof lookups on first discovery or periodically
      const existing = this.processes.get(proc.pid);
      const ports = existing?.ports ?? getListenPorts(proc.pid);
      const cwd = existing?.cwd ?? getCwd(proc.pid);
      const memoryMB = getMemoryMB(proc.pid);

      // Check orphan status: no activity in 30 minutes
      const lastActive = this.lastActivity.get(proc.pid) ?? Date.now();
      const isOrphaned = Date.now() - lastActive > 30 * 60 * 1000;

      this.processes.set(proc.pid, {
        pid: proc.pid,
        command: proc.command.slice(0, 200),
        type,
        cpuPercent: proc.cpu,
        memoryMB,
        ports,
        cwd,
        isOrphaned,
      });
    }

    // Remove processes that no longer exist
    for (const pid of this.processes.keys()) {
      if (!foundPids.has(pid)) {
        this.processes.delete(pid);
        this.lastActivity.delete(pid);
      }
    }
  }

  getProcesses(filter?: { project?: string; type?: DevProcessType }): DevProcess[] {
    const results = Array.from(this.processes.values());

    return results.filter((p) => {
      if (filter?.type && p.type !== filter.type) return false;
      if (filter?.project && p.project !== filter.project) return false;
      return true;
    });
  }

  killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): { success: boolean; error?: string } {
    try {
      process.kill(pid, signal);
      this.processes.delete(pid);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  getPortUsage(port?: number): PortUsage[] {
    const results: PortUsage[] = [];

    for (const proc of this.processes.values()) {
      for (const p of proc.ports) {
        if (port !== undefined && p !== port) continue;
        results.push({
          port: p,
          pid: proc.pid,
          process: proc.command.slice(0, 100),
          type: proc.type,
          project: proc.project,
        });
      }
    }

    return results.sort((a, b) => a.port - b.port);
  }

  detectIssues(): DetectedIssue[] {
    const issues: DetectedIssue[] = [];

    for (const proc of this.processes.values()) {
      // Orphaned process
      if (proc.isOrphaned) {
        issues.push({
          id: `orphaned-${proc.pid}`,
          pattern: 'orphaned_process',
          severity: 'low',
          title: `Orphaned Process: ${proc.type} (PID ${proc.pid})`,
          description: `Dev server process has had no activity for 30+ minutes.`,
          evidence: [
            `PID: ${proc.pid}`,
            `Type: ${proc.type}`,
            `Memory: ${proc.memoryMB.toFixed(0)}MB`,
            `Command: ${proc.command.slice(0, 100)}`,
          ],
          suggestion: `Kill with: kill ${proc.pid}`,
        });
      }

      // High memory
      if (proc.memoryMB > 1024) {
        issues.push({
          id: `high-memory-${proc.pid}`,
          pattern: 'high_memory_process',
          severity: 'medium',
          title: `High Memory: ${proc.type} using ${proc.memoryMB.toFixed(0)}MB`,
          description: `Process is using ${proc.memoryMB.toFixed(0)}MB of memory (>1GB).`,
          evidence: [
            `PID: ${proc.pid}`,
            `Memory: ${proc.memoryMB.toFixed(0)}MB`,
            `CPU: ${proc.cpuPercent}%`,
          ],
          suggestion: 'Restart the process or investigate memory leaks.',
        });
      }
    }

    return issues;
  }
}
