// ============================================================
// RuntimeScope CLI
//
// Usage:
//   npx runtimescope init          — interactive setup wizard
//   npx runtimescope start         — start the collector
//   npx runtimescope               — start the collector (default)
// ============================================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execSync, spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

// ── Helpers ──────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function log(msg: string) { console.log(msg); }
function success(msg: string) { log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string) { log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function info(msg: string) { log(`  ${DIM}${msg}${RESET}`); }
function err(msg: string) { log(`  ${RED}✗${RESET} ${msg}`); }

function ask(question: string, defaultVal?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultVal ? ` ${DIM}(${defaultVal})${RESET}` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix} `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function confirm(question: string, defaultYes = true): Promise<boolean> {
  return ask(`${question} ${DIM}[${defaultYes ? 'Y/n' : 'y/N'}]${RESET}`).then(
    (a) => (a === '' ? defaultYes : /^y(es)?$/i.test(a))
  );
}

function run(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

// ── Framework detection ──────────────────────────────────────

type Framework = {
  name: string;
  entryFiles: string[];
  importStyle: 'npm' | 'script';
  snippet: (appName: string) => string;
  placement: string;
};

const FRAMEWORKS: Record<string, Framework> = {
  react: {
    name: 'React',
    entryFiles: ['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx', 'src/main.ts', 'src/index.ts'],
    importStyle: 'npm',
    snippet: (app) => `import { RuntimeScope } from 'runtimescope'\n\nRuntimeScope.init({ appName: '${app}' })`,
    placement: 'Add to your entry file, before createRoot/ReactDOM.render.',
  },
  nextjs: {
    name: 'Next.js',
    entryFiles: ['src/app/layout.tsx', 'app/layout.tsx', 'src/pages/_app.tsx', 'pages/_app.tsx'],
    importStyle: 'npm',
    snippet: (app) => `'use client'\nimport { RuntimeScope } from 'runtimescope'\n\nRuntimeScope.init({ appName: '${app}' })`,
    placement: 'Create a client component wrapper and import it in your root layout.',
  },
  vue: {
    name: 'Vue',
    entryFiles: ['src/main.ts', 'src/main.js'],
    importStyle: 'npm',
    snippet: (app) => `import { RuntimeScope } from 'runtimescope'\n\nRuntimeScope.init({ appName: '${app}' })`,
    placement: 'Add to src/main.ts, before createApp().',
  },
  nuxt: {
    name: 'Nuxt',
    entryFiles: ['plugins/runtimescope.client.ts', 'plugins/runtimescope.client.js'],
    importStyle: 'npm',
    snippet: (app) => `import { RuntimeScope } from 'runtimescope'\n\nexport default defineNuxtPlugin(() => {\n  RuntimeScope.init({ appName: '${app}' })\n})`,
    placement: 'Create plugins/runtimescope.client.ts.',
  },
  angular: {
    name: 'Angular',
    entryFiles: ['src/main.ts'],
    importStyle: 'npm',
    snippet: (app) => `import { RuntimeScope } from 'runtimescope'\n\nRuntimeScope.init({ appName: '${app}' })`,
    placement: 'Add to src/main.ts, before bootstrapApplication().',
  },
  svelte: {
    name: 'Svelte',
    entryFiles: ['src/main.ts', 'src/main.js'],
    importStyle: 'npm',
    snippet: (app) => `import { RuntimeScope } from 'runtimescope'\n\nRuntimeScope.init({ appName: '${app}' })`,
    placement: 'Add to src/main.ts, before new App().',
  },
  html: {
    name: 'HTML',
    entryFiles: ['index.html', 'public/index.html'],
    importStyle: 'script',
    snippet: (app) => `<script src="https://unpkg.com/runtimescope/dist/index.global.js"></script>\n<script>\n  RuntimeScope.init({ appName: '${app}' })\n</script>`,
    placement: 'Paste before </body> in your HTML file.',
  },
};

function detectFramework(cwd: string): { framework: Framework; key: string } | null {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    // No package.json — check for plain HTML
    if (existsSync(join(cwd, 'index.html'))) {
      return { framework: FRAMEWORKS.html, key: 'html' };
    }
    return null;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }

  const allDeps = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  };

  // Order matters — more specific first
  if (allDeps['next']) return { framework: FRAMEWORKS.nextjs, key: 'nextjs' };
  if (allDeps['nuxt'] || allDeps['nuxt3']) return { framework: FRAMEWORKS.nuxt, key: 'nuxt' };
  if (allDeps['@angular/core']) return { framework: FRAMEWORKS.angular, key: 'angular' };
  if (allDeps['svelte']) return { framework: FRAMEWORKS.svelte, key: 'svelte' };
  if (allDeps['vue']) return { framework: FRAMEWORKS.vue, key: 'vue' };
  if (allDeps['react']) return { framework: FRAMEWORKS.react, key: 'react' };

  // Fallback: has package.json but no known framework — treat as npm project with HTML
  return { framework: FRAMEWORKS.html, key: 'html' };
}

function findEntryFile(cwd: string, framework: Framework): string | null {
  for (const entry of framework.entryFiles) {
    const full = join(cwd, entry);
    if (existsSync(full)) return entry;
  }
  return null;
}

function deriveAppName(cwd: string): string {
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name) {
        // Strip scope prefix
        const name = (pkg.name as string).replace(/^@[^/]+\//, '');
        return name;
      }
    } catch { /* ignore */ }
  }
  return basename(cwd);
}

// ── Collector management ─────────────────────────────────────

function isCollectorRunning(): boolean {
  const result = run('curl -sf http://127.0.0.1:6767 2>&1') ??
                 run('curl -sf http://127.0.0.1:6768/api/health 2>&1');
  return result !== null;
}

function startCollector(): boolean {
  // Try to find the collector binary
  const paths = [
    join(__dirname, '..', '..', 'collector', 'dist', 'standalone.js'),  // monorepo
    'runtimescope-collector',  // global install
  ];

  for (const binPath of paths) {
    try {
      const resolved = binPath.startsWith('/') ? binPath : binPath;
      const child = spawn('node', [resolved], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
      return true;
    } catch {
      continue;
    }
  }

  // Try npx as last resort
  try {
    const child = spawn('npx', ['runtimescope-collector'], {
      detached: true,
      stdio: 'ignore',
      shell: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ── MCP registration ─────────────────────────────────────────

function isMcpRegistered(): boolean {
  const result = run('claude mcp list 2>&1');
  return result !== null && result.includes('runtimescope');
}

function registerMcp(): boolean {
  // Find the MCP server entry point
  const paths = [
    join(__dirname, '..', '..', 'mcp-server', 'dist', 'index.js'),  // monorepo
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      const result = run(`claude mcp add runtimescope node ${p}`);
      return result !== null;
    }
  }

  // Try the npm-installed version
  const result = run('claude mcp add runtimescope -- npx runtimescope-mcp');
  return result !== null;
}

// ── Inject SDK into entry file ───────────────────────────────

function injectSdk(cwd: string, entryFile: string, framework: Framework, appName: string): boolean {
  const filePath = join(cwd, entryFile);
  const content = readFileSync(filePath, 'utf-8');

  // Already has RuntimeScope?
  if (content.includes('RuntimeScope') || content.includes('runtimescope')) {
    return false;
  }

  if (framework.importStyle === 'npm') {
    const importLine = `import { RuntimeScope } from 'runtimescope'\nRuntimeScope.init({ appName: '${appName}' })\n`;
    // Insert after existing imports
    const lines = content.split('\n');
    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('import ') || lines[i].startsWith('import{')) {
        lastImportIdx = i;
      }
    }

    if (lastImportIdx >= 0) {
      lines.splice(lastImportIdx + 1, 0, '', importLine);
    } else {
      lines.unshift(importLine, '');
    }

    writeFileSync(filePath, lines.join('\n'));
    return true;
  }

  // Script tag injection for HTML files
  if (entryFile.endsWith('.html')) {
    const scriptTag = `\n<!-- RuntimeScope -->\n<script src="https://unpkg.com/runtimescope/dist/index.global.js"></script>\n<script>RuntimeScope.init({ appName: '${appName}' })</script>\n`;
    const injected = content.replace('</body>', `${scriptTag}</body>`);
    if (injected !== content) {
      writeFileSync(filePath, injected);
      return true;
    }
  }

  return false;
}

// ── Commands ─────────────────────────────────────────────────

async function init() {
  const cwd = process.cwd();

  log('');
  log(`  ${BOLD}RuntimeScope Setup${RESET}`);
  log('');

  // 1. Detect framework
  const detected = detectFramework(cwd);
  if (detected) {
    success(`Detected: ${BOLD}${detected.framework.name}${RESET}`);
  } else {
    warn('Could not detect framework. You can still use RuntimeScope with a <script> tag.');
  }

  const framework = detected?.framework ?? FRAMEWORKS.html;

  // 2. App name
  const defaultName = deriveAppName(cwd);
  const appName = await ask(`App name?`, defaultName);

  log('');

  // 3. Collector
  if (isCollectorRunning()) {
    success('Collector already running');
  } else {
    const started = startCollector();
    if (started) {
      success('Collector started on ws://localhost:6767');
      info('Dashboard at http://localhost:6768');
    } else {
      warn('Could not start collector automatically');
      info('Run manually: npx runtimescope start');
    }
  }

  // 4. MCP registration
  if (isMcpRegistered()) {
    success('MCP server already registered with Claude Code');
  } else {
    if (await confirm('Register MCP server with Claude Code?')) {
      const registered = registerMcp();
      if (registered) {
        success('MCP server registered with Claude Code');
      } else {
        warn('Could not register MCP server automatically');
        info('Run manually: claude mcp add runtimescope -- npx runtimescope-mcp');
      }
    }
  }

  // 5. SDK snippet
  log('');
  const entryFile = findEntryFile(cwd, framework);

  if (entryFile) {
    const filePath = join(cwd, entryFile);
    const content = readFileSync(filePath, 'utf-8');

    if (content.includes('RuntimeScope') || content.includes('runtimescope')) {
      success(`SDK already installed in ${entryFile}`);
    } else {
      log(`  ${CYAN}Add to ${entryFile}:${RESET}`);
      log('');
      for (const line of framework.snippet(appName).split('\n')) {
        log(`    ${line}`);
      }
      log('');

      if (await confirm(`Auto-add to ${entryFile}?`)) {
        const injected = injectSdk(cwd, entryFile, framework, appName);
        if (injected) {
          success(`SDK added to ${entryFile}`);
        } else {
          warn('Could not auto-inject. Please add manually.');
        }
      }
    }
  } else {
    log(`  ${CYAN}Add this to your entry file:${RESET}`);
    log('');
    for (const line of framework.snippet(appName).split('\n')) {
      log(`    ${line}`);
    }
    log('');
    info(framework.placement);
  }

  // 6. Install runtimescope package if using npm
  if (framework.importStyle === 'npm') {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (!allDeps['runtimescope'] && !allDeps['@runtimescope/sdk']) {
        log('');
        if (await confirm('Install runtimescope package?')) {
          const pm = existsSync(join(cwd, 'bun.lockb')) ? 'bun'
            : existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
            : existsSync(join(cwd, 'yarn.lock')) ? 'yarn'
            : 'npm';
          const installCmd = pm === 'npm' ? 'npm install runtimescope' :
                             pm === 'yarn' ? 'yarn add runtimescope' :
                             pm === 'pnpm' ? 'pnpm add runtimescope' :
                             'bun add runtimescope';
          log(`  Running ${DIM}${installCmd}${RESET}...`);
          try {
            execSync(installCmd, { cwd, stdio: 'inherit' });
            success('Package installed');
          } catch {
            warn(`Install failed. Run manually: ${installCmd}`);
          }
        }
      }
    }
  }

  // 7. Summary
  log('');
  log(`  ${GREEN}${BOLD}Done!${RESET} RuntimeScope is ready.`);
  log('');
  info('Collector:  ws://localhost:6767');
  info('Dashboard:  http://localhost:6768');
  info('MCP tools:  46 tools available in Claude Code');
  log('');
}

async function start() {
  log('');
  log(`  ${BOLD}RuntimeScope Collector${RESET}`);
  log('');

  if (isCollectorRunning()) {
    success('Collector is already running');
    info('Dashboard: http://localhost:6768');
    return;
  }

  // Run collector in foreground (not detached) so logs are visible
  const paths = [
    join(__dirname, '..', '..', 'collector', 'dist', 'standalone.js'),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      info(`Starting collector from ${p}`);
      const child = spawn('node', [p], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code ?? 0));
      return;
    }
  }

  // Fallback to npx
  info('Starting collector via npx...');
  const child = spawn('npx', ['runtimescope-collector'], { stdio: 'inherit', shell: true });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function status() {
  log('');
  log(`  ${BOLD}RuntimeScope Status${RESET}`);
  log('');

  const healthJson = run('curl -sf http://127.0.0.1:6768/api/health 2>&1');
  if (!healthJson) {
    err('Collector is NOT running');
    info('Start with: npx runtimescope start');
    log('');
    return;
  }

  let health: { status?: string; version?: string; uptime?: number; sessions?: number; authEnabled?: boolean } = {};
  try { health = JSON.parse(healthJson); } catch { /* non-JSON — still running */ }

  success(`Collector running — status: ${health.status ?? 'unknown'}`);
  if (health.version) info(`Version: ${health.version}`);
  info(`Uptime: ${health.uptime ?? 0}s`);
  info(`Live sessions: ${health.sessions ?? 0}`);
  info(`Auth: ${health.authEnabled ? 'enabled' : 'disabled'}`);
  info(`Ports: ws://localhost:6767  •  http://localhost:6768`);

  const projJson = run('curl -sf http://127.0.0.1:6768/api/projects 2>&1');
  if (projJson) {
    try {
      const data = JSON.parse(projJson) as { data: Array<{ appName: string; sessions: string[]; isConnected: boolean; eventCount: number; projectId?: string }> };
      const connected = data.data.filter((p) => p.isConnected);
      if (connected.length > 0) {
        log('');
        log(`  ${BOLD}Connected projects:${RESET}`);
        for (const p of connected) {
          log(`  ${GREEN}●${RESET} ${p.appName.padEnd(30)} ${DIM}events=${p.eventCount}  projectId=${p.projectId ?? 'none'}${RESET}`);
        }
      } else {
        log('');
        info('No SDK connections yet. Start your app with a DSN configured.');
      }
    } catch { /* ignore */ }
  }

  log('');
}

async function stop() {
  log('');
  log(`  ${BOLD}Stopping RuntimeScope Collector${RESET}`);
  log('');

  if (!isCollectorRunning()) {
    info('Collector is not running');
    return;
  }

  let killed = 0;
  let skipped = 0;
  for (const port of [6767, 6768]) {
    try {
      // execFileSync with explicit args — no shell, no injection
      const pidList = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8' }).trim();
      for (const pid of pidList.split('\n').filter(Boolean)) {
        const pidNum = parseInt(pid, 10);
        if (!Number.isFinite(pidNum)) continue;

        // Verify the PID is actually a RuntimeScope process before killing.
        // Without this check, `runtimescope stop` will SIGTERM any dev server
        // that happens to be on :6767/:6768 — which is common once the user
        // has shifted to our default ports.
        let cmdline = '';
        try {
          cmdline = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf-8' }).trim();
        } catch {
          skipped++;
          continue;
        }
        const looksLikeCollector =
          /runtimescope/i.test(cmdline) ||
          /standalone\.js/i.test(cmdline) ||
          /@runtimescope\/(collector|mcp-server)/i.test(cmdline);
        if (!looksLikeCollector) {
          warn(`PID ${pid} on port ${port} is not a RuntimeScope process — skipping`);
          skipped++;
          continue;
        }

        try {
          process.kill(pidNum);
          killed++;
        } catch { /* already gone */ }
      }
    } catch {
      // lsof returns non-zero when port is free — that's expected
    }
  }

  if (killed > 0) {
    success(`Stopped ${killed} collector process${killed === 1 ? '' : 'es'}`);
  } else if (skipped > 0) {
    warn('No RuntimeScope collector found — ports are held by unrelated processes');
  } else {
    warn('Could not find a running collector process to stop');
  }
  log('');
}

async function doctor() {
  log('');
  log(`  ${BOLD}RuntimeScope Doctor${RESET}`);
  log('');

  const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];

  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10);
  checks.push({
    label: `Node.js ${nodeVersion}`,
    ok: nodeMajor >= 18,
    detail: nodeMajor < 18 ? 'Requires Node 18+' : undefined,
  });

  const healthJson = run('curl -sf http://127.0.0.1:6768/api/health 2>&1');
  checks.push({
    label: 'Collector on :6768',
    ok: healthJson !== null,
    detail: healthJson === null ? 'Not running — start with `npx runtimescope start`' : undefined,
  });

  const wsListen = run('lsof -ti :6767 2>/dev/null');
  checks.push({
    label: 'WebSocket on :6767',
    ok: wsListen !== null && wsListen !== '',
    detail: wsListen === null || wsListen === '' ? 'Not listening — collector may be stopped' : undefined,
  });

  const collectorPids = run('lsof -ti :6768 2>/dev/null')?.split('\n').filter(Boolean) ?? [];
  checks.push({
    label: `Port :6768 owned by ${collectorPids.length} process${collectorPids.length === 1 ? '' : 'es'}`,
    ok: collectorPids.length <= 1,
    detail: collectorPids.length > 1 ? 'Multiple processes fighting for :6768 — `npx runtimescope stop` and restart' : undefined,
  });

  const mcpRegistered = isMcpRegistered();
  checks.push({
    label: 'MCP server registered with Claude Code',
    ok: mcpRegistered,
    detail: !mcpRegistered ? 'Run `claude mcp add runtimescope -s user -- npx -y @runtimescope/mcp-server`' : undefined,
  });

  const localConfigPath = join(process.cwd(), '.runtimescope', 'config.json');
  const hasLocalConfig = existsSync(localConfigPath);
  checks.push({
    label: `.runtimescope/config.json in ${basename(process.cwd())}`,
    ok: hasLocalConfig,
    detail: !hasLocalConfig ? 'Run `npx runtimescope init` to scaffold' : undefined,
  });

  const dsn = process.env.RUNTIMESCOPE_DSN;
  checks.push({
    label: 'RUNTIMESCOPE_DSN env var',
    ok: !!dsn,
    detail: !dsn ? 'Not required for dev, but needed in production' : undefined,
  });

  for (const check of checks) {
    if (check.ok) success(check.label);
    else err(check.label);
    if (check.detail) info(`  ${check.detail}`);
  }

  const failures = checks.filter((c) => !c.ok).length;
  log('');
  if (failures === 0) {
    log(`  ${GREEN}${BOLD}All ${checks.length} checks passed.${RESET}`);
  } else {
    log(`  ${YELLOW}${failures} of ${checks.length} checks need attention.${RESET}`);
  }
  log('');
}

function printHelp() {
  log('');
  log(`  ${BOLD}runtimescope${RESET} — runtime observability for web apps`);
  log('');
  log(`  ${BOLD}Commands:${RESET}`);
  log(`    ${BOLD}init${RESET}          Set up RuntimeScope in your project (interactive)`);
  log(`    ${BOLD}start${RESET}         Start the collector server in the foreground`);
  log(`    ${BOLD}stop${RESET}          Stop any running collector on :6767/:6768`);
  log(`    ${BOLD}status${RESET}        Show collector health and connected projects`);
  log(`    ${BOLD}doctor${RESET}        Diagnose common problems and suggest fixes`);
  log(`    ${BOLD}service${RESET} <sub> Manage the background service (install/uninstall/status/restart/logs)`);
  log(`    ${DIM}(no args)${RESET}     Start the collector (same as ${BOLD}start${RESET})`);
  log('');
  log(`  ${BOLD}Packages:${RESET}`);
  log(`    import { RuntimeScope } from '@runtimescope/sdk'          Browser SDK`);
  log(`    import { RuntimeScope } from '@runtimescope/server-sdk'   Server SDK`);
  log('');
}

// ── Main ─────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case 'init':
    init().catch((e) => { err(e.message); process.exit(1); });
    break;
  case 'start':
    start().catch((e) => { err(e.message); process.exit(1); });
    break;
  case 'stop':
    stop().catch((e) => { err(e.message); process.exit(1); });
    break;
  case 'status':
    status().catch((e) => { err(e.message); process.exit(1); });
    break;
  case 'doctor':
    doctor().catch((e) => { err(e.message); process.exit(1); });
    break;
  case 'service': {
    // Lazy-load so the CLI stays fast for non-service commands
    import('./service.js').then(({ serviceCommand }) =>
      serviceCommand(process.argv[3]),
    ).catch((e) => { err(e.message); process.exit(1); });
    break;
  }
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    if (command && !command.startsWith('-')) {
      err(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
    }
    // Default: start collector
    start().catch((e) => { err(e.message); process.exit(1); });
}
