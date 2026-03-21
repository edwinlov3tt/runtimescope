import { execFileSync, execSync } from 'node:child_process';
import { readlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================
// Cross-platform process utilities (macOS, Linux, Windows)
// Replaces macOS-only lsof calls throughout the codebase.
//
// All inputs to shell commands are numeric PIDs/ports or
// internal paths — never user-supplied strings.
// ============================================================

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

/** Run execFileSync, return trimmed stdout or null on failure. */
function runFile(cmd: string, args: string[], timeoutMs = 5000): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', timeout: timeoutMs }).trim();
  } catch {
    return null;
  }
}

/**
 * Run a shell command (needed when piping). All inputs must be
 * trusted internal values (PIDs, ports, paths).
 */
function runShell(cmd: string, timeoutMs = 5000): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs }).trim();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// getPidsOnPort — find which PIDs are listening on a given port
// ------------------------------------------------------------------

function getPidsOnPort_unix(port: number): number[] {
  // Try lsof first (macOS always, Linux usually)
  const lsof = runFile('lsof', ['-ti', `:${port}`], 5000);
  if (lsof) {
    return lsof.split('\n').map(Number).filter((n) => n > 0);
  }
  // Fallback: ss (Linux, typically pre-installed)
  if (IS_LINUX) {
    // ss requires piping through grep, so use shell
    const ss = runShell(`ss -tlnp 2>/dev/null | grep ':${port} '`);
    if (ss) {
      const pids: number[] = [];
      for (const match of ss.matchAll(/pid=(\d+)/g)) {
        pids.push(parseInt(match[1], 10));
      }
      return [...new Set(pids)];
    }
  }
  return [];
}

function getPidsOnPort_win(port: number): number[] {
  // netstat + findstr requires shell piping
  const out = runShell(`netstat -ano | findstr :${port} | findstr LISTENING`);
  if (!out) return [];
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const pid = parseInt(parts[parts.length - 1], 10);
    if (pid > 0) pids.push(pid);
  }
  return [...new Set(pids)];
}

/** Find PIDs listening on `port`. Cross-platform. */
export function getPidsOnPort(port: number): number[] {
  return IS_WIN ? getPidsOnPort_win(port) : getPidsOnPort_unix(port);
}

// ------------------------------------------------------------------
// getListenPorts — find which ports a PID is listening on
// ------------------------------------------------------------------

function getListenPorts_unix(pid: number): number[] {
  // lsof + grep requires piping
  const lsof = runShell(`lsof -nP -p ${pid} 2>/dev/null | grep LISTEN`, 3000);
  if (lsof) {
    const ports: number[] = [];
    for (const line of lsof.split('\n')) {
      const match = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (match) ports.push(parseInt(match[1], 10));
    }
    return [...new Set(ports)];
  }
  // Fallback: ss (Linux)
  if (IS_LINUX) {
    const ss = runShell(`ss -tlnp 2>/dev/null | grep 'pid=${pid},'`, 3000);
    if (ss) {
      const ports: number[] = [];
      for (const match of ss.matchAll(/:(\d+)\s/g)) {
        ports.push(parseInt(match[1], 10));
      }
      return [...new Set(ports)];
    }
  }
  return [];
}

function getListenPorts_win(pid: number): number[] {
  const out = runShell(`netstat -ano | findstr ${pid} | findstr LISTENING`);
  if (!out) return [];
  const ports: number[] = [];
  for (const line of out.split('\n')) {
    // Format: TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  12345
    const match = line.match(/:(\d+)\s/);
    if (match) {
      const port = parseInt(match[1], 10);
      const linePid = parseInt(line.trim().split(/\s+/).pop()!, 10);
      if (linePid === pid) ports.push(port);
    }
  }
  return [...new Set(ports)];
}

/** Find which ports a PID is listening on. Cross-platform. */
export function getListenPorts(pid: number): number[] {
  return IS_WIN ? getListenPorts_win(pid) : getListenPorts_unix(pid);
}

// ------------------------------------------------------------------
// getProcessCwd — get the working directory of a process
// ------------------------------------------------------------------

function getProcessCwd_mac(pid: number): string | undefined {
  const out = runShell(`lsof -p ${pid} 2>/dev/null | grep cwd`, 3000);
  if (!out) return undefined;
  const match = out.match(/cwd\s+\w+\s+\w+\s+\d+\w?\s+\d+\s+\d+\s+\d+\s+(.+)/);
  return match?.[1]?.trim();
}

function getProcessCwd_linux(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // Fallback to lsof on Linux too (works if installed)
    return getProcessCwd_mac(pid);
  }
}

/** Get the working directory of a process. Returns undefined on Windows or failure. */
export function getProcessCwd(pid: number): string | undefined {
  if (IS_WIN) return undefined; // No reliable cross-platform equivalent
  if (IS_LINUX) return getProcessCwd_linux(pid);
  return getProcessCwd_mac(pid); // macOS
}

// ------------------------------------------------------------------
// findPidsInDirectory — find PIDs with open files in a directory
// ------------------------------------------------------------------

function findPidsInDir_lsof(dir: string): number[] {
  // lsof + head requires piping
  const out = runShell(`lsof -t +D "${dir}" 2>/dev/null | head -20`);
  if (!out) return [];
  return out.split('\n').map(Number).filter((n) => n > 0);
}

function findPidsInDir_linux(dir: string): number[] {
  // Try lsof first (most reliable)
  const lsofResult = findPidsInDir_lsof(dir);
  if (lsofResult.length > 0) return lsofResult;

  // Fallback: scan /proc/*/cwd for processes rooted in this directory
  try {
    const pids: number[] = [];
    for (const entry of readdirSync('/proc')) {
      const pid = parseInt(entry, 10);
      if (isNaN(pid) || pid <= 1) continue;
      try {
        const cwd = readlinkSync(join('/proc', entry, 'cwd'));
        if (cwd.startsWith(dir)) pids.push(pid);
      } catch {
        // Permission denied or process exited — skip
      }
    }
    return pids;
  } catch {
    return [];
  }
}

/** Find PIDs with open files/cwd in a directory. Best-effort on Windows (returns []). */
export function findPidsInDirectory(dir: string): number[] {
  if (IS_WIN) return []; // No reliable equivalent
  if (IS_LINUX) return findPidsInDir_linux(dir);
  return findPidsInDir_lsof(dir); // macOS
}

// ------------------------------------------------------------------
// parseProcessList — cross-platform process listing
// ------------------------------------------------------------------

export interface ProcessInfo {
  pid: number;
  cpu: number;
  mem: number;
  command: string;
}

function parseProcessList_unix(): ProcessInfo[] {
  const output = runFile('ps', ['aux']);
  if (!output) return [];
  const lines = output.split('\n').slice(1); // Skip header
  const results: ProcessInfo[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;
    const pid = parseInt(parts[1], 10);
    const cpu = parseFloat(parts[2]);
    const mem = parseFloat(parts[3]);
    const command = parts.slice(10).join(' ');
    if (isNaN(pid)) continue;
    results.push({ pid, cpu, mem, command });
  }
  return results;
}

function parseProcessList_win(): ProcessInfo[] {
  const output = runFile('tasklist', ['/FO', 'CSV', '/NH'], 10000);
  if (!output) return [];
  const results: ProcessInfo[] = [];
  for (const line of output.split('\n')) {
    // Format: "Image Name","PID","Session Name","Session#","Mem Usage"
    const parts = line.match(/"([^"]*)"/g);
    if (!parts || parts.length < 5) continue;
    const pid = parseInt(parts[1].replace(/"/g, ''), 10);
    const command = parts[0].replace(/"/g, '');
    const memStr = parts[4].replace(/"/g, '').replace(/[, K]/gi, '');
    const mem = parseInt(memStr, 10) / 1024; // KB → MB rough
    if (isNaN(pid)) continue;
    results.push({ pid, cpu: 0, mem, command }); // CPU not available from tasklist
  }
  return results;
}

/** List all running processes. Cross-platform. */
export function parseProcessList(): ProcessInfo[] {
  return IS_WIN ? parseProcessList_win() : parseProcessList_unix();
}

// ------------------------------------------------------------------
// getProcessMemoryMB — get RSS of a process in MB
// ------------------------------------------------------------------

function getProcessMemoryMB_unix(pid: number): number {
  const out = runFile('ps', ['-o', 'rss=', '-p', String(pid)], 2000);
  if (!out) return 0;
  const rss = parseInt(out, 10);
  return isNaN(rss) ? 0 : rss / 1024;
}

function getProcessMemoryMB_win(pid: number): number {
  const out = runFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 3000);
  if (!out) return 0;
  const parts = out.match(/"([^"]*)"/g);
  if (!parts || parts.length < 5) return 0;
  const memStr = parts[4].replace(/"/g, '').replace(/[, K]/gi, '');
  const kb = parseInt(memStr, 10);
  return isNaN(kb) ? 0 : kb / 1024;
}

/** Get RSS memory in MB for a given PID. Cross-platform. */
export function getProcessMemoryMB(pid: number): number {
  return IS_WIN ? getProcessMemoryMB_win(pid) : getProcessMemoryMB_unix(pid);
}
