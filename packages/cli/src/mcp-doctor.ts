// ============================================================
// RuntimeScope MCP Doctor
//
// When the Claude Code plugin reports "failed to reconnect to
// runtimescope", this command spawns the published mcp-server
// the same way the plugin would, times the MCP handshake, and
// reports concrete next steps. The intent is to turn a vague
// "MCP isn't working" into "your launchd collector died" or
// "your global runtimescope-mcp v0.6.0 is stale".
//
// We don't try to fix anything automatically — we tell the user
// exactly what's wrong and what to run.
// ============================================================

import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function log(m: string) { console.log(m); }
function success(m: string) { log(`  ${GREEN}✓${RESET} ${m}`); }
function warn(m: string) { log(`  ${YELLOW}⚠${RESET} ${m}`); }
function info(m: string) { log(`  ${DIM}${m}${RESET}`); }
function err(m: string) { log(`  ${RED}✗${RESET} ${m}`); }

const LAUNCHD_LABEL = 'com.runtimescope.collector';

/**
 * Probe the HTTP API on 6768 with a short timeout. Returns the version
 * string if the collector is up and healthy, null otherwise.
 */
async function probeCollector(): Promise<{ version: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetch('http://127.0.0.1:6768/api/health', {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return { version: data.version ?? 'unknown' };
  } catch {
    return null;
  }
}

/**
 * Look up which process is listening on the standard HTTP port. Used to
 * tell the user "this PID is holding it" when a foreign collector is in
 * the way of the launchd service.
 */
function whoOwns6768(): { pid: number; command: string } | null {
  try {
    const pidStr = execFileSync('lsof', ['-tnP', '-iTCP:6768', '-sTCP:LISTEN'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!pidStr) return null;
    const pid = parseInt(pidStr.split('\n')[0] ?? '', 10);
    if (!Number.isFinite(pid)) return null;
    let command = '';
    try {
      command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf-8',
      }).trim();
    } catch {
      /* ps unavailable — leave command blank */
    }
    return { pid, command };
  } catch {
    return null;
  }
}

/**
 * Confirm whether the launchd-managed collector is the one on 6768.
 * Returns the launchd-reported PID, or null when the label isn't loaded.
 */
function launchdManagedPid(): number | null {
  if (platform() !== 'darwin') return null;
  try {
    const out = execFileSync('launchctl', ['list', LAUNCHD_LABEL], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/"PID"\s*=\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/**
 * Spawn the published mcp-server the same way the Claude Code plugin's
 * .mcp.json does, send an MCP `initialize` request over stdio, and time
 * the response. Returns the elapsed milliseconds, or null on failure.
 *
 * The plugin's reconnect timeout (~30s in current Claude Code builds) is
 * the user-facing budget, but anything over ~10s in practice means the
 * user has hit it at least once. We surface the actual number so the user
 * knows whether they're close to the edge or way over.
 */
async function timeMcpHandshake(timeoutMs: number = 30000): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    // stderr is discarded — the spawned mcp-server prints ~50 lines of
    // SQLite-store-opened noise during boot that would drown out the
    // doctor's own output. We only care about the JSON-RPC response on
    // stdout for handshake timing.
    const child = spawn('npx', ['-y', '@runtimescope/mcp-server@latest'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    let buf = '';
    let resolved = false;
    const finish = (ms: number | null) => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch { /* already dead */ }
      resolve(ms);
    };

    const killTimer = setTimeout(() => finish(null), timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      // Look for any JSON-RPC response on stdout — the very first line out
      // of mcp-server should be a `result` for our `initialize` request.
      // We don't fully parse; we just need to know "the server responded."
      if (buf.includes('"jsonrpc"') && buf.includes('"id":1')) {
        clearTimeout(killTimer);
        finish(Date.now() - start);
      }
    });

    child.on('error', () => {
      clearTimeout(killTimer);
      finish(null);
    });

    child.on('exit', () => {
      clearTimeout(killTimer);
      if (!resolved) finish(null);
    });

    // Send an MCP initialize request once the child is alive. Wait one
    // tick to let the spawn settle.
    setTimeout(() => {
      const initReq = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'runtimescope-mcp-doctor', version: '1.0.0' },
        },
      };
      try {
        child.stdin?.write(JSON.stringify(initReq) + '\n');
      } catch {
        finish(null);
      }
    }, 50);
  });
}

export async function mcpDoctor(): Promise<void> {
  log('');
  log(`  ${BOLD}RuntimeScope MCP Doctor${RESET}`);
  log('');
  info('Diagnoses why Claude Code can\'t connect to the runtimescope MCP.');
  log('');

  // ── Check 1: is *something* on 6768? ─────────────────────────────────
  log(`${BOLD}1. Collector on http://127.0.0.1:6768${RESET}`);
  const probe = await probeCollector();
  if (probe) {
    success(`Collector responding (version ${probe.version})`);
  } else {
    err('Nothing healthy on 6768. The MCP server\'s "skip our own HTTP API" optimization');
    err('relies on a launchd collector being there.');
    log('');
    info(`Fix: ${CYAN}runtimescope service install${RESET}`);
    log('');
  }

  // ── Check 2: who actually owns the port? ─────────────────────────────
  log('');
  log(`${BOLD}2. Process owning :6768${RESET}`);
  const owner = whoOwns6768();
  const launchdPid = launchdManagedPid();
  if (!owner) {
    warn('No process listening on :6768 (which contradicts check 1 if collector responded).');
  } else if (launchdPid && launchdPid === owner.pid) {
    success(`PID ${owner.pid} — managed by launchd (${LAUNCHD_LABEL})`);
  } else if (/[/\\.](?:bin\/)?runtimescope-mcp(?:\s|$)/.test(owner.command)) {
    warn(`PID ${owner.pid} — Claude Code plugin's embedded MCP collector`);
    log('');
    info('This is fine while Claude Code is open, but it goes away when you quit.');
    info('For a persistent collector, install the launchd service:');
    info(`  1. Quit Claude Code`);
    info(`  2. ${CYAN}runtimescope service install${RESET}`);
    info(`  3. Restart Claude Code — the plugin will detect launchd and yield`);
  } else if (owner.command.includes('runtimescope-collector') || owner.command.includes('collector/dist/standalone')) {
    warn(`PID ${owner.pid} — a standalone collector (not launchd-managed)`);
    info(`  Command: ${owner.command.slice(0, 100)}`);
    info('Either let it keep running, or:');
    info(`  kill ${owner.pid}`);
    info(`  ${CYAN}runtimescope service install${RESET}`);
  } else {
    warn(`PID ${owner.pid} — unknown process holding :6768`);
    info(`  Command: ${owner.command.slice(0, 100)}`);
    info(`Inspect: ${CYAN}ps -o command= -p ${owner.pid}${RESET}`);
  }

  // ── Check 3: is there a stale runtimescope-mcp v0.6.0 on PATH? ───────
  log('');
  log(`${BOLD}3. Stale CLI on PATH${RESET}`);
  try {
    const oldBin = execFileSync('which', ['runtimescope-mcp'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (oldBin) {
      // runtimescope-mcp is the OLD binary name (≤ v0.6.0). The current
      // package ships `runtimescope` (CLI) and `runtimescope-collector` (bin).
      // If `runtimescope-mcp` is still on PATH, it's stale and confusing.
      warn(`Found stale binary: ${oldBin}`);
      info('runtimescope-mcp was the v0.6.0 entrypoint. Current versions use:');
      info(`  ${CYAN}runtimescope${RESET}             — CLI`);
      info(`  ${CYAN}runtimescope-collector${RESET}   — collector bin`);
      info('Remove it:');
      info(`  npm uninstall -g <whatever-package-shipped-it>`);
      info(`  rm ${oldBin}`);
    } else {
      success('No stale runtimescope-mcp binary on PATH');
    }
  } catch {
    success('No stale runtimescope-mcp binary on PATH');
  }

  // ── Check 4: time the MCP handshake the plugin does ──────────────────
  log('');
  log(`${BOLD}4. MCP handshake timing (npx @runtimescope/mcp-server@latest)${RESET}`);
  info('Spawning the same way the plugin\'s .mcp.json does. This may take 5-30s…');
  const elapsedMs = await timeMcpHandshake();
  if (elapsedMs === null) {
    err('MCP handshake timed out or failed.');
    info('The plugin would see this as "Failed to reconnect."');
    info('Check the npm cache and try a clean reinstall:');
    info(`  ${CYAN}rm -rf ~/.npm/_npx${RESET}`);
    info(`  ${CYAN}npm cache clean --force${RESET}`);
    info(`  ${CYAN}npx -y @runtimescope/mcp-server@latest${RESET}   ${DIM}# verify it boots${RESET}`);
  } else if (elapsedMs > 15000) {
    warn(`MCP responded in ${(elapsedMs / 1000).toFixed(1)}s — close to plugin timeout.`);
    info('Most common cause: many projects on disk → slow SQLite warm-up.');
    info(`Verify the launchd collector is on :6768 (skips the warm-up entirely):`);
    info(`  ${CYAN}runtimescope service status${RESET}`);
  } else {
    success(`MCP responded in ${(elapsedMs / 1000).toFixed(2)}s — well under plugin timeout`);
  }

  log('');
  log(`${BOLD}Next steps${RESET}`);
  if (!probe) {
    info(`Most likely fix: ${CYAN}runtimescope service install${RESET}`);
  } else if (owner && launchdPid !== owner.pid) {
    info('Most likely fix: quit whatever owns :6768, then `runtimescope service install`');
  } else if (elapsedMs && elapsedMs > 15000) {
    info(`Most likely fix: ${CYAN}runtimescope service install${RESET} (collector on :6768 makes MCP boot near-instant)`);
  } else {
    info('No obvious problem detected. If the plugin is still failing:');
    info(`  - Restart Claude Code`);
    info(`  - Try a clean reinstall: ${CYAN}/plugin uninstall runtimescope@runtimescope${RESET} then re-install`);
    info(`  - Check the plugin's MCP logs in Claude Code's developer tools`);
  }
  log('');
}

// Re-export for the dispatcher in cli.ts.
export const __mcpDoctor__ = {
  homedir,
  join,
  existsSync,
};
