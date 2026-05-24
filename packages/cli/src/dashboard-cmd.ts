// ============================================================
// runtimescope dashboard — open the built dashboard in a browser
//
// The collector serves the dashboard SPA at /dashboard (see
// packages/collector/src/http-server.ts). This command:
//   - Detects whether the launchd/systemd collector is running
//   - Opens http://127.0.0.1:6768/dashboard in the system browser
//   - With --network: shows the LAN-reachable URL instead, and offers to
//     re-install the service with RUNTIMESCOPE_HOST=0.0.0.0 if it's
//     currently bound to 127.0.0.1
// ============================================================

import { execFileSync, spawn } from 'node:child_process';
import { networkInterfaces, platform } from 'node:os';

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

const HTTP_PORT = parseInt(process.env.RUNTIMESCOPE_HTTP_PORT ?? '6768', 10);

/** Returns the first non-loopback IPv4 address on the machine, or null. */
function getLanIp(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

/** Open a URL in the system browser. Best-effort; if `open` fails we still print the URL. */
function openInBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* swallow — the user can copy the URL from the printed output */
  }
}

interface CollectorHealth {
  status?: string;
  version?: string;
  uptime?: number;
}

async function probeCollector(host: string = '127.0.0.1'): Promise<CollectorHealth | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`http://${host}:${HTTP_PORT}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json()) as CollectorHealth;
  } catch {
    return null;
  }
}

/**
 * Check what host the launchd plist (or systemd unit) configured the
 * collector with. Returns the configured RUNTIMESCOPE_HOST string, or
 * '127.0.0.1' if unset (the production default). Used to decide whether
 * the dashboard is reachable from the network.
 */
function detectConfiguredHost(): string {
  if (platform() === 'darwin') {
    try {
      const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.runtimescope.collector.plist`;
      const out = execFileSync('plutil', ['-extract', 'EnvironmentVariables', 'raw', '-o', '-', plistPath], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // Extract RUNTIMESCOPE_HOST from the plist if present. Easier than parsing the whole dict.
      const m = out.match(/RUNTIMESCOPE_HOST.*?=\s*"([^"]+)"/);
      if (m) return m[1]!;
    } catch {
      /* plist not present or plutil failed — fall through */
    }
  }
  return '127.0.0.1';
}

export async function dashboardCommand(args: string[]): Promise<void> {
  const network = args.includes('--network');

  log('');
  log(`  ${BOLD}RuntimeScope Dashboard${RESET}`);
  log('');

  // 1. Probe the local collector first — if nothing's running, we have nothing to open.
  const health = await probeCollector('127.0.0.1');
  if (!health) {
    err(`Collector not responding on http://127.0.0.1:${HTTP_PORT}`);
    info('Start it with one of:');
    info(`  ${CYAN}runtimescope service install${RESET}    — persistent background service`);
    info(`  ${CYAN}runtimescope start${RESET}              — foreground (Ctrl+C to stop)`);
    log('');
    process.exit(1);
  }

  success(`Collector responding (version ${health.version ?? 'unknown'})`);

  // 2. Local mode: just open http://127.0.0.1
  if (!network) {
    const url = `http://127.0.0.1:${HTTP_PORT}/dashboard`;
    info(`Opening ${url}`);
    openInBrowser(url);
    log('');
    info(`If your browser didn't open, paste the URL: ${CYAN}${url}${RESET}`);
    log('');
    return;
  }

  // 3. Network mode: requires the collector to be bound to 0.0.0.0
  const lan = getLanIp();
  if (!lan) {
    err('No LAN IPv4 address detected — is your network interface up?');
    log('');
    process.exit(1);
  }

  const configuredHost = detectConfiguredHost();
  if (configuredHost !== '0.0.0.0') {
    warn(`Collector is bound to ${configuredHost}, not reachable from the network.`);
    log('');
    info('To enable network access, re-install the service with the network host:');
    info(`  ${CYAN}RUNTIMESCOPE_HOST=0.0.0.0 runtimescope service install${RESET}`);
    log('');
    info('After re-install, run this command again. The dashboard will be at:');
    info(`  ${CYAN}http://${lan}:${HTTP_PORT}/dashboard${RESET}`);
    log('');
    info(`${DIM}Security note: binding to 0.0.0.0 exposes the collector + dashboard${RESET}`);
    info(`${DIM}to your whole local network. Anyone on your Wi-Fi can connect.${RESET}`);
    log('');
    process.exit(1);
  }

  // Sanity-check: actually try fetching from the LAN address to confirm reachability.
  const lanHealth = await probeCollector(lan);
  if (!lanHealth) {
    warn(`Collector is configured for 0.0.0.0 but did not respond on http://${lan}:${HTTP_PORT}`);
    info('It may not have picked up the new HOST yet. Try:');
    info(`  ${CYAN}runtimescope service restart${RESET}`);
    log('');
    process.exit(1);
  }

  const url = `http://${lan}:${HTTP_PORT}/dashboard`;
  success(`Dashboard reachable on LAN at ${url}`);
  info('Opening in your browser; share the URL above with other devices on your network.');
  openInBrowser(url);
  log('');
}
