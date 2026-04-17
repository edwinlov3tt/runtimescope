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
import { join, resolve } from 'node:path';
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
  // Prefer the sibling workspace build if we're running from the monorepo
  const require = createRequire(import.meta.url);

  // Try resolving via the @runtimescope/collector package
  try {
    const pkgJsonPath = require.resolve('@runtimescope/collector/package.json');
    const pkgDir = pkgJsonPath.replace(/\/package\.json$/, '');
    const standalone = join(pkgDir, 'dist', 'standalone.js');
    if (existsSync(standalone)) return standalone;
  } catch {
    /* fall through */
  }

  // Monorepo fallback — CLI installed from source
  const monorepoPath = resolve(
    new URL(import.meta.url).pathname,
    '..', '..', '..', 'collector', 'dist', 'standalone.js',
  );
  if (existsSync(monorepoPath)) return monorepoPath;

  throw new Error(
    'Could not locate the collector binary. Install runtimescope globally or from a monorepo.',
  );
}

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
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

function installLaunchd(): void {
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
  success('Service loaded and started');
  info(`  Node:      ${nodePath}`);
  info(`  Collector: ${collectorPath}`);
  info(`  Logs:      ${LOGS_DIR}`);
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

function statusLaunchd(): void {
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

function installSystemd(): void {
  const nodePath = process.execPath;
  const collectorPath = resolveCollectorPath();

  ensureLogsDir();
  if (!existsSync(SYSTEMD_UNIT_DIR)) mkdirSync(SYSTEMD_UNIT_DIR, { recursive: true });

  const unit = buildSystemdUnit(nodePath, collectorPath);
  writeFileSync(SYSTEMD_UNIT, unit);
  success(`Wrote ${SYSTEMD_UNIT}`);

  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', 'runtimescope.service']);
  success('Service enabled and started');
  info(`  Node:      ${nodePath}`);
  info(`  Collector: ${collectorPath}`);
  info('');
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

function statusSystemd(): void {
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
}

function restartSystemd(): void {
  if (!existsSync(SYSTEMD_UNIT)) {
    err('Service not installed. Run: runtimescope service install');
    return;
  }
  execFileSync('systemctl', ['--user', 'restart', 'runtimescope.service']);
  success('Service restarted');
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
      if (os === 'darwin') installLaunchd();
      else installSystemd();
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
      if (os === 'darwin') statusLaunchd();
      else statusSystemd();
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
      log(`    ${BOLD}status${RESET}      Show current service status`);
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
      info('Valid: install, uninstall, status, restart, logs');
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
