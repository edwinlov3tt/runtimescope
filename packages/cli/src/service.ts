// ============================================================
// RuntimeScope Service Manager
//
// Manages the collector as a background service that auto-starts
// on login and restarts on crash.
//
// Platforms:
//   - macOS  → launchd (~/Library/LaunchAgents/com.runtimescope.collector.plist)
//   - Linux  → systemd user service (~/.config/systemd/user/runtimescope.service)
//   - Other  → unsupported (for now — Windows via Task Scheduler is a later add)
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

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
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

const SYSTEMD_UNIT_DIR = join(homedir(), '.config', 'systemd', 'user');
const SYSTEMD_UNIT = join(SYSTEMD_UNIT_DIR, 'runtimescope.service');

const LOGS_DIR = join(homedir(), '.runtimescope', 'logs');
const STDOUT_LOG = join(LOGS_DIR, 'collector.out.log');
const STDERR_LOG = join(LOGS_DIR, 'collector.err.log');

// ---------- Resolve absolute paths to node + the collector entry point ----------

function resolveCollectorPath(): string {
  // Walk through several resolution strategies. Each attempt is recorded so
  // that on total failure we can surface a diagnostic listing every path tried
  // and why it failed — far more useful than the generic "could not locate"
  // message that sent every previous user on an archaeological dig.
  const require = createRequire(import.meta.url);
  const attempts: { strategy: string; result: string }[] = [];

  // Strategy 1: resolve via the @runtimescope/collector main entry.
  // We deliberately avoid require.resolve('@runtimescope/collector/package.json')
  // because the published exports map (≤ 0.10.2) only declared "." — that
  // lookup throws ERR_PACKAGE_PATH_NOT_EXPORTED. The main entry "." has always
  // been exported, so this works against every published version.
  try {
    const mainPath = require.resolve('@runtimescope/collector');
    const pkgDir = dirname(dirname(mainPath));
    const standalone = join(pkgDir, 'dist', 'standalone.js');
    if (existsSync(standalone)) return standalone;
    attempts.push({
      strategy: `require.resolve('@runtimescope/collector') → ${pkgDir}`,
      result: `standalone.js missing at ${standalone}`,
    });
  } catch (e) {
    attempts.push({
      strategy: `require.resolve('@runtimescope/collector')`,
      result: (e as Error).message,
    });
  }

  // Strategy 2: monorepo sibling — CLI running from source tree.
  // From packages/cli/dist/cli.js, ../../../collector/dist/standalone.js lands
  // at packages/collector/dist/standalone.js. Note: this only matches the
  // unscoped monorepo layout, not a global node_modules tree (where the path
  // would need the @runtimescope/ prefix).
  const monorepoPath = resolve(
    new URL(import.meta.url).pathname,
    '..', '..', '..', 'collector', 'dist', 'standalone.js',
  );
  if (existsSync(monorepoPath)) return monorepoPath;
  attempts.push({
    strategy: 'monorepo sibling (packages/collector/dist/standalone.js)',
    result: `not found at ${monorepoPath}`,
  });

  // Strategy 3: runtimescope-collector binary on PATH. The collector package
  // declares `bin: { runtimescope-collector: ./dist/standalone.js }`, so when
  // it's installed globally npm puts a wrapper on PATH. `which` resolves it
  // to the actual standalone.js even when require.resolve fails for any
  // weird package-resolution reason.
  try {
    const which = execFileSync('which', ['runtimescope-collector'], {
      encoding: 'utf-8',
    }).trim();
    if (which && existsSync(which)) {
      // The bin entry is usually a wrapper symlink; readlink-style
      // resolution isn't strictly needed because Node will follow it,
      // but the dist file IS the actual entry. If `which` returns a
      // direct path to standalone.js, use it; if it's a wrapper, use it
      // anyway since Node will execute it identically.
      return which;
    }
    attempts.push({
      strategy: `which runtimescope-collector`,
      result: `returned '${which}' but file missing`,
    });
  } catch (e) {
    attempts.push({
      strategy: 'which runtimescope-collector',
      result: (e as Error).message.split('\n')[0] ?? 'not on PATH',
    });
  }

  const summary = attempts
    .map(({ strategy, result }) => `    - ${strategy}\n        → ${result}`)
    .join('\n');

  throw new Error(
    `Could not locate the collector binary. Tried:\n${summary}\n` +
      `\n` +
      `If you installed runtimescope from npm, try reinstalling: npm install -g runtimescope@latest\n` +
      `If you're running from a monorepo, build it first: npm run build -w packages/collector`,
  );
}

// ---------- Install-method + version detection ----------

type InstallMethod = 'global-npm' | 'local-node-modules' | 'monorepo' | 'unknown';

function detectInstallMethod(): InstallMethod {
  const cliPath = new URL(import.meta.url).pathname;
  // Monorepo: path contains `/packages/cli/` (we're running the in-repo build)
  if (cliPath.includes('/packages/cli/')) return 'monorepo';
  // Global npm: path contains `/node_modules/runtimescope/` AND `/npm/` or similar global location
  if (cliPath.includes('/lib/node_modules/runtimescope/')) return 'global-npm';
  if (cliPath.includes('/.nvm/') && cliPath.includes('/node_modules/runtimescope/')) return 'global-npm';
  // Local node_modules
  if (cliPath.includes('/node_modules/runtimescope/')) return 'local-node-modules';
  return 'unknown';
}

function getInstalledCliVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('runtimescope/package.json') as { version?: string };
    return pkg.version ?? null;
  } catch {
    // Monorepo — read from source
    try {
      const cliPath = new URL(import.meta.url).pathname;
      // cli/dist/service.js → walk up to cli/package.json
      const packageJson = resolve(cliPath, '..', '..', 'package.json');
      if (existsSync(packageJson)) {
        const pkg = JSON.parse(readFileSync(packageJson, 'utf-8')) as { version?: string };
        return pkg.version ?? null;
      }
    } catch {
      /* give up */
    }
    return null;
  }
}

async function fetchLatestNpmVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('https://registry.npmjs.org/runtimescope/latest', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

async function fetchRunningCollectorVersion(port: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/** Compare semver-like strings. -1 if a<b, 0 if equal, 1 if a>b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

// ---------- Pre-install: detect a foreign collector on the standard port ----------

interface ForeignCollector {
  pid: number;
  /** Best-effort identification of who's running it. */
  source: 'plugin-embedded' | 'standalone' | 'unknown';
}

/**
 * Inspect port 6768. If something is already listening, identify it. Returns
 * null when the port is free (or when the only listener IS the launchd service
 * we're about to manage — that's not "foreign").
 *
 * "Foreign" specifically means: a collector started by something OTHER than
 * launchd (typically the Claude Code plugin's embedded MCP collector). Those
 * processes hold the port until the owner exits, so installing the launchd
 * service while one is running causes EADDRINUSE — and the failure mode is
 * silent unless we surface it here.
 */
function detectForeignCollector(): ForeignCollector | null {
  if (platform() !== 'darwin' && platform() !== 'linux') return null;

  // lsof is the lowest-friction way to find the listener. -i :PORT, -P avoids
  // service-name lookup, -n skips DNS, -t prints just the PID.
  let pidStr: string;
  try {
    pidStr = execFileSync('lsof', ['-tnP', '-iTCP:6768', '-sTCP:LISTEN'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Either lsof isn't installed or nothing's on the port. Either way, no foreign.
    return null;
  }
  if (!pidStr) return null;

  // Multiple PIDs is unexpected — treat the first as canonical.
  const pid = parseInt(pidStr.split('\n')[0] ?? '', 10);
  if (!Number.isFinite(pid)) return null;

  // If the listener is OUR launchd service, it's not foreign — it's ourselves.
  // launchctl reports the PID for the label when the service is running.
  // Silence stderr — when the label isn't registered, launchctl writes
  // "Could not find service ... in domain" to stderr that would otherwise
  // bleed into the user-facing install output above the foreign-collector
  // warning.
  try {
    const out = execFileSync('launchctl', ['list', LAUNCHD_LABEL], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const launchdPidMatch = out.match(/"PID"\s*=\s*(\d+)/);
    if (launchdPidMatch && parseInt(launchdPidMatch[1], 10) === pid) {
      return null;
    }
  } catch {
    /* not registered with launchd → definitely foreign */
  }

  // Identify the source by ps. Three patterns cover every form the plugin's
  // MCP collector takes in practice:
  //   1. `@runtimescope/mcp-server` — package path inside node_modules
  //   2. `mcp-server/dist` — local-link / monorepo build
  //   3. `runtimescope-mcp` bin — the npx-resolved bin entry. THIS is the
  //      most common case (the plugin's .mcp.json runs
  //      `npx -y @runtimescope/mcp-server@latest`, and npx resolves that
  //      to ~/.npm/_npx/<hash>/node_modules/.bin/runtimescope-mcp). Without
  //      this match the user falls into the generic "unknown PID" path
  //      and loses the "quit Claude Code, then re-run install" walkthrough.
  let source: ForeignCollector['source'] = 'unknown';
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
    }).trim();
    if (
      cmd.includes('@runtimescope/mcp-server') ||
      cmd.includes('mcp-server/dist') ||
      /[/\\.](?:bin\/)?runtimescope-mcp(?:\s|$)/.test(cmd)
    ) {
      source = 'plugin-embedded';
    } else if (cmd.includes('runtimescope-collector') || cmd.includes('collector/dist/standalone')) {
      source = 'standalone';
    }
  } catch {
    /* ps unavailable or process gone */
  }

  return { pid, source };
}

// ---------- Post-install: poll /readyz until the collector responds ----------

/**
 * After loading the launchd plist or starting the systemd unit, the service
 * manager reports "started" instantly — but the collector itself might crash
 * milliseconds later (most commonly EADDRINUSE if a foreign collector raced
 * us, or a node version incompatibility). Poll /readyz to confirm the
 * collector is actually serving traffic before we declare success.
 *
 * Returns true if the collector responded healthy within the deadline.
 */
async function waitForCollectorReady(timeoutMs: number = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      const res = await fetch('http://127.0.0.1:6768/readyz', {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Print the last `lines` of stderr log so users can see why it failed. */
function tailStderrLog(lines: number = 20): void {
  if (!existsSync(STDERR_LOG)) {
    info('No stderr log yet — service may not have started at all.');
    return;
  }
  try {
    const out = execFileSync('tail', ['-n', String(lines), STDERR_LOG], {
      encoding: 'utf-8',
    });
    if (out.trim()) {
      log('');
      log(`  ${DIM}Last ${lines} lines of ${STDERR_LOG}:${RESET}`);
      log('');
      for (const line of out.split('\n')) {
        if (line) log(`  ${DIM}│${RESET} ${line}`);
      }
    } else {
      info('Log is empty — collector may have exited before writing anything.');
    }
  } catch {
    info('Could not read stderr log.');
  }
}

// ---------- launchd (macOS) ----------

function buildLaunchdPlist(nodePath: string, collectorPath: string): string {
  // Uses <key>/<string> pairs rather than array-of-arrays for readability.
  // `KeepAlive { SuccessfulExit = false }` restarts on crash but NOT on clean exit.
  // `RunAtLoad = true` starts on user login (first login after install).
  // Hard memory ceiling: 256MB RSS.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${collectorPath}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>StandardOutPath</key>
  <string>${STDOUT_LOG}</string>

  <key>StandardErrorPath</key>
  <string>${STDERR_LOG}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>

  <key>ProcessType</key>
  <string>Background</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>HardResourceLimits</key>
  <dict>
    <key>ResidentSetSize</key>
    <integer>268435456</integer>
  </dict>
</dict>
</plist>
`;
}

async function installLaunchd(): Promise<void> {
  const nodePath = process.execPath;
  const collectorPath = resolveCollectorPath();

  ensureLogsDir();

  const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

  // Unload any existing instance first — lets us reinstall cleanly
  try {
    execFileSync('launchctl', ['unload', '-w', LAUNCHD_PLIST], { stdio: 'ignore' });
  } catch {
    /* not loaded yet */
  }

  const plist = buildLaunchdPlist(nodePath, collectorPath);
  writeFileSync(LAUNCHD_PLIST, plist);
  success(`Wrote ${LAUNCHD_PLIST}`);

  execFileSync('launchctl', ['load', '-w', LAUNCHD_PLIST]);
  info(`  Node:      ${nodePath}`);
  info(`  Collector: ${collectorPath}`);
  info(`  Logs:      ${LOGS_DIR}`);

  // launchctl returns success the moment the plist is loaded, but the
  // collector hasn't actually bound its ports yet. Poll /readyz so we report
  // the real state to the user — and tail the log if it never comes up.
  log('');
  info('Waiting for collector to come up…');
  const ready = await waitForCollectorReady(5000);
  if (ready) {
    success('Collector is healthy and serving on http://127.0.0.1:6768');
  } else {
    err('Collector did not respond on /readyz within 5s.');
    tailStderrLog(20);
    log('');
    info('Common causes:');
    info('  - Another process is holding port 6767 or 6768 (run: runtimescope service status)');
    info('  - Node version mismatch (collector targets node 20+)');
    info('  - Crash on startup (the log above should show the stack)');
  }
}

function uninstallLaunchd(): void {
  if (!existsSync(LAUNCHD_PLIST)) {
    info('Service is not installed.');
    return;
  }
  try {
    execFileSync('launchctl', ['unload', '-w', LAUNCHD_PLIST], { stdio: 'ignore' });
  } catch {
    /* already unloaded */
  }
  execFileSync('rm', ['-f', LAUNCHD_PLIST]);
  success('Service uninstalled');
}

async function statusLaunchd(): Promise<void> {
  if (!existsSync(LAUNCHD_PLIST)) {
    info('Service not installed. Run: runtimescope service install');
    return;
  }
  try {
    const out = execFileSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf-8' });
    // Output is property-list fragments like `"PID" = 12345;`
    const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
    const lastExitMatch = out.match(/"LastExitStatus"\s*=\s*(\d+)/);

    if (pidMatch) {
      success(`Service running — PID ${pidMatch[1]}`);
    } else {
      warn('Service installed but not currently running');
    }
    if (lastExitMatch) {
      info(`Last exit status: ${lastExitMatch[1]}`);
    }
    info(`Plist: ${LAUNCHD_PLIST}`);
    info(`Logs:  ${LOGS_DIR}`);

    await printVersionInfo();
  } catch {
    warn('Service installed but launchctl could not query it');
  }
}

function restartLaunchd(): void {
  if (!existsSync(LAUNCHD_PLIST)) {
    err('Service not installed. Run: runtimescope service install');
    return;
  }
  execFileSync('launchctl', ['unload', LAUNCHD_PLIST]);
  execFileSync('launchctl', ['load', LAUNCHD_PLIST]);
  success('Service restarted');
}

// ---------- systemd (Linux user service) ----------

function buildSystemdUnit(nodePath: string, collectorPath: string): string {
  // Runs as a user service. `loginctl enable-linger` recommended for always-on
  // behaviour even when the user isn't logged in.
  return `[Unit]
Description=RuntimeScope Collector
Documentation=https://github.com/edwinlov3tt/runtimescope
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${collectorPath}
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

# Resource ceiling
MemoryMax=256M
CPUQuota=50%

# Logs to journal — tail with: journalctl --user -u runtimescope -f
StandardOutput=journal
StandardError=journal
SyslogIdentifier=runtimescope

[Install]
WantedBy=default.target
`;
}

async function installSystemd(): Promise<void> {
  const nodePath = process.execPath;
  const collectorPath = resolveCollectorPath();

  ensureLogsDir();
  if (!existsSync(SYSTEMD_UNIT_DIR)) mkdirSync(SYSTEMD_UNIT_DIR, { recursive: true });

  const unit = buildSystemdUnit(nodePath, collectorPath);
  writeFileSync(SYSTEMD_UNIT, unit);
  success(`Wrote ${SYSTEMD_UNIT}`);

  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', 'runtimescope.service']);
  info(`  Node:      ${nodePath}`);
  info(`  Collector: ${collectorPath}`);

  // systemctl returns once the unit is started — same readiness gap as
  // launchd. Poll /readyz before declaring success.
  log('');
  info('Waiting for collector to come up…');
  const ready = await waitForCollectorReady(5000);
  if (ready) {
    success('Collector is healthy and serving on http://127.0.0.1:6768');
  } else {
    err('Collector did not respond on /readyz within 5s.');
    log('');
    info(`Tail the journal: ${CYAN}journalctl --user -u runtimescope.service -n 20${RESET}`);
    log('');
    info('Common causes:');
    info('  - Another process is holding port 6767 or 6768');
    info('  - Node version mismatch (collector targets node 20+)');
  }

  log('');
  info('Optional: keep running when you log out (always-on):');
  info(`  sudo loginctl enable-linger $USER`);
}

function uninstallSystemd(): void {
  if (!existsSync(SYSTEMD_UNIT)) {
    info('Service is not installed.');
    return;
  }
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', 'runtimescope.service'], {
      stdio: 'ignore',
    });
  } catch {
    /* already disabled */
  }
  execFileSync('rm', ['-f', SYSTEMD_UNIT]);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  success('Service uninstalled');
}

async function statusSystemd(): Promise<void> {
  if (!existsSync(SYSTEMD_UNIT)) {
    info('Service not installed. Run: runtimescope service install');
    return;
  }
  try {
    const isActive = execFileSync(
      'systemctl',
      ['--user', 'is-active', 'runtimescope.service'],
      { encoding: 'utf-8' },
    ).trim();
    if (isActive === 'active') {
      success('Service is active');
    } else {
      warn(`Service state: ${isActive}`);
    }
  } catch {
    warn('Service not active');
  }
  info(`Unit file: ${SYSTEMD_UNIT}`);
  info('Logs: journalctl --user -u runtimescope -f');

  await printVersionInfo();
}

function restartSystemd(): void {
  if (!existsSync(SYSTEMD_UNIT)) {
    err('Service not installed. Run: runtimescope service install');
    return;
  }
  execFileSync('systemctl', ['--user', 'restart', 'runtimescope.service']);
  success('Service restarted');
}

// ---------- Version info + update ----------

async function printVersionInfo(): Promise<void> {
  const installed = getInstalledCliVersion();
  const runningCollector = await fetchRunningCollectorVersion(6768);
  const latest = await fetchLatestNpmVersion();

  if (installed) info(`CLI version: ${installed}`);
  if (runningCollector) info(`Running collector version: ${runningCollector}`);
  if (installed && latest) {
    const cmp = compareVersions(installed, latest);
    if (cmp < 0) {
      warn(`Newer version available: ${latest} (you have ${installed})`);
      info(`  Run: ${CYAN}runtimescope service update${RESET}`);
    }
  }
}

async function updateService(): Promise<void> {
  const os = platform();
  if (os !== 'darwin' && os !== 'linux') {
    err(`Platform '${os}' not supported.`);
    return;
  }

  log('');
  log(`  ${BOLD}Updating RuntimeScope service…${RESET}`);
  log('');

  const installed = getInstalledCliVersion();
  const latest = await fetchLatestNpmVersion();
  const installMethod = detectInstallMethod();

  info(`Installed CLI: ${installed ?? 'unknown'}`);
  info(`Latest on npm: ${latest ?? 'unknown (offline?)'}`);
  info(`Install method: ${installMethod}`);
  log('');

  if (installed && latest && compareVersions(installed, latest) >= 0) {
    success('Already running the latest version.');
    log('');
    info('Restarting the service anyway to reload any local changes…');
    if (os === 'darwin') restartLaunchd();
    else restartSystemd();
    return;
  }

  // Update the package
  switch (installMethod) {
    case 'global-npm': {
      info('Running npm install -g runtimescope@latest…');
      try {
        execFileSync('npm', ['install', '-g', 'runtimescope@latest'], { stdio: 'inherit' });
        success('npm package updated.');
      } catch {
        err('npm install failed. Try manually: npm install -g runtimescope@latest');
        return;
      }
      break;
    }
    case 'local-node-modules': {
      info('Running npm install runtimescope@latest in this project…');
      try {
        execFileSync('npm', ['install', 'runtimescope@latest'], { stdio: 'inherit' });
        success('npm package updated.');
      } catch {
        err('npm install failed. Try manually: npm install runtimescope@latest');
        return;
      }
      break;
    }
    case 'monorepo': {
      warn('Running from a monorepo — no package to update via npm.');
      info('Pull the latest changes and rebuild:');
      info('  git pull && npm install && npm run build -w packages/collector -w packages/cli');
      info('Then re-run this command to regenerate the service plist and restart.');
      break;
    }
    case 'unknown': {
      warn('Could not detect install method — skipping package update.');
      break;
    }
  }

  // Regenerate plist/unit (paths may have changed when Node version changed etc.)
  info('Regenerating service configuration with current paths…');
  if (os === 'darwin') await installLaunchd();
  else await installSystemd();

  // Already restarted as part of install, but double-check health
  log('');
  const port = 6768;
  const runningVersion = await fetchRunningCollectorVersion(port);
  if (runningVersion) {
    success(`Collector is up — version ${runningVersion}`);
  } else {
    warn('Collector not responding yet. Give it a few seconds, then run `runtimescope service status`.');
  }
  log('');
}

// ---------- Logs ----------

function tailLogs(lines: number): void {
  if (platform() === 'darwin') {
    if (!existsSync(STDERR_LOG) && !existsSync(STDOUT_LOG)) {
      info('No log files yet. Start the service first.');
      return;
    }
    log(`${BOLD}${STDERR_LOG}${RESET}`);
    try {
      const out = execFileSync('tail', ['-n', String(lines), STDERR_LOG], { encoding: 'utf-8' });
      console.log(out);
    } catch {
      info('(empty)');
    }
    log(`${BOLD}${STDOUT_LOG}${RESET}`);
    try {
      const out = execFileSync('tail', ['-n', String(lines), STDOUT_LOG], { encoding: 'utf-8' });
      console.log(out);
    } catch {
      info('(empty)');
    }
    return;
  }
  if (platform() === 'linux') {
    // Use journalctl
    try {
      const out = execFileSync(
        'journalctl',
        ['--user', '-u', 'runtimescope.service', '-n', String(lines), '--no-pager'],
        { encoding: 'utf-8' },
      );
      console.log(out);
    } catch {
      err('Could not read journalctl logs — is systemd available?');
    }
    return;
  }
  err(`Platform '${platform()}' is not supported for log tailing yet.`);
}

// ---------- Dispatcher ----------

export async function serviceCommand(subcmd: string | undefined): Promise<void> {
  const os = platform();

  if (os !== 'darwin' && os !== 'linux') {
    err(`Platform '${os}' is not supported yet. Sorry!`);
    info('macOS and Linux are supported today. Windows support via Task Scheduler is planned.');
    info('');
    info('In the meantime, run it manually in a terminal:');
    info('  runtimescope start');
    process.exit(1);
  }

  switch (subcmd) {
    case 'install': {
      log('');
      log(`  ${BOLD}Installing RuntimeScope as a background service…${RESET}`);
      log('');

      // Detect a foreign collector before we touch the service manager.
      // Continuing past this would just trade one EADDRINUSE for another,
      // so name the conflict and the fix instead of letting the user
      // discover it via mysterious "service installed but not responding".
      const foreign = detectForeignCollector();
      if (foreign) {
        warn(`Collector already running on :6768 (PID ${foreign.pid}, not owned by launchd)`);
        log('');
        if (foreign.source === 'plugin-embedded') {
          info('This is the Claude Code plugin\'s embedded collector. To free the port:');
          info('  1. Quit Claude Code (the plugin\'s collector exits with it)');
          info('  2. Re-run: runtimescope service install');
          info('  3. Restart Claude Code — the plugin will detect the launchd service and yield');
        } else if (foreign.source === 'standalone') {
          info('A standalone collector is already running. To free the port:');
          info(`  kill ${foreign.pid}`);
          info('  Then re-run: runtimescope service install');
        } else {
          info(`Some process (PID ${foreign.pid}) is holding the port. To inspect:`);
          info(`  ps -o command= -p ${foreign.pid}`);
          info(`  Then either kill it or stop the program that started it, then re-run install.`);
        }
        log('');
        info('Install aborted.');
        log('');
        process.exit(1);
      }

      if (os === 'darwin') await installLaunchd();
      else await installSystemd();
      log('');
      log('  The collector will now start automatically on login and');
      log('  restart if it crashes. Check status with:');
      log('');
      log(`    ${CYAN}runtimescope service status${RESET}`);
      log('');
      break;
    }
    case 'uninstall': {
      log('');
      log(`  ${BOLD}Uninstalling RuntimeScope service…${RESET}`);
      log('');
      if (os === 'darwin') uninstallLaunchd();
      else uninstallSystemd();
      log('');
      break;
    }
    case 'status': {
      log('');
      log(`  ${BOLD}RuntimeScope Service Status${RESET}`);
      log('');
      if (os === 'darwin') await statusLaunchd();
      else await statusSystemd();
      log('');
      break;
    }
    case 'restart': {
      log('');
      if (os === 'darwin') restartLaunchd();
      else restartSystemd();
      log('');
      break;
    }
    case 'update': {
      await updateService();
      break;
    }
    case 'logs': {
      log('');
      log(`  ${BOLD}Recent logs (last 50 lines)${RESET}`);
      log('');
      tailLogs(50);
      log('');
      break;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h': {
      log('');
      log(`  ${BOLD}runtimescope service${RESET} — background service management`);
      log('');
      log(`  ${BOLD}Subcommands:${RESET}`);
      log(`    ${BOLD}install${RESET}     Install as a background service (auto-start on login)`);
      log(`    ${BOLD}uninstall${RESET}   Remove the background service`);
      log(`    ${BOLD}status${RESET}      Show current service status (+ version check)`);
      log(`    ${BOLD}update${RESET}      Update the collector to the latest version and restart`);
      log(`    ${BOLD}restart${RESET}     Restart the service`);
      log(`    ${BOLD}logs${RESET}        Show recent logs (last 50 lines)`);
      log('');
      log(`  ${DIM}On macOS, uses launchd (~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist).${RESET}`);
      log(`  ${DIM}On Linux, uses systemd user service (~/.config/systemd/user/runtimescope.service).${RESET}`);
      log('');
      break;
    }
    default: {
      err(`Unknown subcommand: ${subcmd}`);
      info('Valid: install, uninstall, status, update, restart, logs');
      process.exit(1);
    }
  }
}

// Re-export some helpers for tests / tooling
export const __service__ = {
  LAUNCHD_PLIST,
  SYSTEMD_UNIT,
  LOGS_DIR,
  buildLaunchdPlist,
  buildSystemdUnit,
};
