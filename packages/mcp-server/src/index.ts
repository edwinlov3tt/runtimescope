import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'node:path';
import {
  CollectorServer,
  ProjectManager,
  ApiDiscoveryEngine,
  ProcessMonitor,
  InfraConnector,
  ConnectionManager,
  SchemaIntrospector,
  DataBrowser,
  SessionManager,
  HttpServer,
  SqliteStore,
  isSqliteAvailable,
  AuthManager,
  Redactor,
  resolveTlsConfig,
  PmStore,
  ProjectDiscovery,
  getPidsOnPort,
  migrateProjectIds,
} from '@runtimescope/collector';

// --- Existing M1/M2 tool registrations ---
import { registerNetworkTools } from './tools/network.js';
import { registerConsoleTools } from './tools/console.js';
import { registerSessionTools } from './tools/session.js';
import { registerIssueTools } from './tools/issues.js';
import { registerTimelineTools } from './tools/timeline.js';
import { registerStateTools } from './tools/state.js';
import { registerRenderTools } from './tools/renders.js';
import { registerPerformanceTools } from './tools/performance.js';
import { registerDomSnapshotTools } from './tools/dom-snapshot.js';
import { registerHarTools } from './tools/har.js';
import { registerErrorTools } from './tools/errors.js';

// --- New M3 tool registrations ---
import { registerApiDiscoveryTools } from './tools/api-discovery.js';
import { registerDatabaseTools } from './tools/database.js';
import { registerProcessMonitorTools } from './tools/process-monitor.js';
import { registerInfraTools } from './tools/infra-connector.js';
import { registerSessionDiffTools } from './tools/session-diff.js';
import { registerQaCheckTools } from './tools/qa-check.js';
import { registerSetupTools } from './tools/setup.js';

// --- Recon tools (extension-powered UI analysis) ---
import { registerReconMetadataTools } from './tools/recon-metadata.js';
import { registerReconDesignTokenTools } from './tools/recon-design-tokens.js';
import { registerReconFontTools } from './tools/recon-fonts.js';
import { registerReconLayoutTools } from './tools/recon-layout.js';
import { registerReconAccessibilityTools } from './tools/recon-accessibility.js';
import { registerReconComputedStyleTools } from './tools/recon-computed-styles.js';
import { registerReconElementSnapshotTools } from './tools/recon-element-snapshot.js';
import { registerReconAssetTools } from './tools/recon-assets.js';
import { registerReconStyleDiffTools } from './tools/recon-style-diff.js';

// --- Playwright scanner ---
import { PlaywrightScanner } from './scanner/index.js';
import { registerScannerTools } from './tools/scanner.js';

// --- Custom event tracking ---
import { registerCustomEventTools } from './tools/custom-events.js';

// --- Breadcrumb trail (debugging context) ---
import { registerBreadcrumbTools } from './tools/breadcrumbs.js';

// --- Historical event persistence ---
import { registerHistoryTools } from './tools/history.js';

// --- Collector lifecycle (start/stop the background service) ---
import { registerCollectorControlTools } from './tools/collector-control.js';

// --- Multi-tenant workspaces ---
import { registerWorkspaceTools } from './tools/workspaces.js';

const COLLECTOR_PORT = parseInt(process.env.RUNTIMESCOPE_PORT ?? '6767', 10);
const HTTP_PORT = parseInt(process.env.RUNTIMESCOPE_HTTP_PORT ?? '6768', 10);
const BUFFER_SIZE = parseInt(process.env.RUNTIMESCOPE_BUFFER_SIZE ?? '10000', 10);

/**
 * Attempt to kill any stale process holding the collector port.
 * This handles the case where a previous MCP server process didn't
 * clean up (e.g. Claude Code session crashed).
 * Cross-platform: uses lsof on macOS, lsof/ss on Linux, netstat on Windows.
 */
function killStaleProcess(port: number): void {
  try {
    const pids = getPidsOnPort(port);
    const myPid = process.pid;
    for (const pid of pids) {
      if (pid !== myPid) {
        console.error(`[RuntimeScope] Killing stale process ${pid} on port ${port}`);
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // Platform utility failed — that's fine, port will fail with EADDRINUSE and retry
  }
}

/**
 * Check whether a RuntimeScope collector that has finished startup recovery
 * is already on our HTTP port. We probe `/readyz` rather than `/api/health`
 * so a peer that's listening-but-still-warming doesn't trigger us to back
 * off — we'd rather log "another collector is starting up" once it's actually
 * serving traffic. `/readyz` returns 503 during recovery, 200 when ready.
 */
async function detectExistingCollector(httpPort: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    const res = await fetch(`http://127.0.0.1:${httpPort}/readyz`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data.status === 'ready';
  } catch {
    return false;
  }
}

async function main() {
  // Install global crash resilience — every uncaught error is logged to stderr
  // (never stdout, which is reserved for the JSON-RPC stream) and the process
  // keeps running. Without this, a single bug in any handler kills the MCP
  // server and Claude Code sees every tool call fail until restart.
  process.on('uncaughtException', (err) => {
    console.error('[RuntimeScope] uncaughtException:', err instanceof Error ? err.stack ?? err.message : err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[RuntimeScope] unhandledRejection:', reason);
  });

  // 1. Initialize project management
  const projectManager = new ProjectManager();
  projectManager.ensureGlobalDir();

  // 1b. Load security config from ~/.runtimescope/config.json
  const globalConfig = projectManager.getGlobalConfig();

  const authManager = new AuthManager({
    enabled: globalConfig.auth?.enabled ?? false,
    apiKeys: globalConfig.auth?.apiKeys ?? [],
  });

  const tlsConfig = resolveTlsConfig() ?? globalConfig.tls ?? undefined;

  const redactor = new Redactor({
    enabled: globalConfig.redaction?.enabled ?? false,
    useBuiltIn: true,
    rules: globalConfig.redaction?.rules?.map(r => ({
      name: r.name,
      pattern: new RegExp(r.pattern, 'gi'),
      replacement: r.replacement,
    })),
  });

  const corsOrigins = process.env.RUNTIMESCOPE_CORS_ORIGINS?.split(',').map(s => s.trim())
    ?? globalConfig.corsOrigins;

  if (authManager.isEnabled()) {
    console.error(`[RuntimeScope] Auth enabled (${globalConfig.auth?.apiKeys?.length ?? 0} API keys)`);
  }
  if (tlsConfig) {
    console.error(`[RuntimeScope] TLS enabled (cert: ${tlsConfig.certPath})`);
  }
  if (redactor.isEnabled()) {
    console.error('[RuntimeScope] Payload redaction enabled');
  }

  // 2. Detect whether another RuntimeScope collector is already on our ports.
  //    If so, we do NOT kill it (previously this would SIGTERM the user's
  //    `npm run dashboard` standalone). We also do NOT exit — exiting here
  //    leaves Claude Code with zero MCP tools. Instead we start our own
  //    collector on alternate ports (port-increment retry handles this) and
  //    log clearly so the user knows to point their SDK at the MCP instance
  //    or the standalone, depending on which they want to query.
  const existingHealthy = await detectExistingCollector(HTTP_PORT);
  if (existingHealthy) {
    console.error(
      `[RuntimeScope] Another collector is already listening on :${HTTP_PORT}.`,
    );
    console.error(
      '[RuntimeScope] Starting our own on alternate ports so MCP tools stay available.',
    );
    console.error(
      '[RuntimeScope] Point SDK at the port logged below for MCP tools to see events.',
    );
  } else {
    // Only kill stale processes if no healthy collector is holding the port.
    killStaleProcess(COLLECTOR_PORT);
    killStaleProcess(HTTP_PORT);
  }

  // 3. Start the collector WebSocket server with project scoping
  const collector = new CollectorServer({
    bufferSize: BUFFER_SIZE,
    projectManager,
    authManager,
    rateLimits: globalConfig.rateLimits,
    tls: tlsConfig,
  });
  // When an existing healthy collector is already serving 6768, the MCP
  // server's in-process collector binds an alternate WS port and receives
  // zero SDK events (SDKs talk to the launchd collector). Skipping the
  // recovery pass in that mode shaves multiple seconds off boot — on a
  // machine with 40+ projects, opening every SQLite store synchronously
  // pushed the MCP transport-ready time past Claude Code's plugin reconnect
  // timeout, manifesting as "no matter how many times I restart, MCP can't
  // connect". The recovery still runs lazily on the first SDK connection.
  await collector.start({
    port: COLLECTOR_PORT,
    maxRetries: 5,
    retryDelayMs: 50,
    skipRecovery: existingHealthy,
  });
  const actualWsPort = collector.getPort() ?? COLLECTOR_PORT;

  const store = collector.getStore();

  // Wire in redactor for defense-in-depth event sanitization
  if (redactor.isEnabled()) {
    store.setRedactor(redactor);
  }

  // 4. Initialize engines
  const apiDiscovery = new ApiDiscoveryEngine(store);
  const connectionManager = new ConnectionManager();
  const schemaIntrospector = new SchemaIntrospector();
  const dataBrowser = new DataBrowser();
  const processMonitor = new ProcessMonitor(store);
  processMonitor.start();

  const infraConnector = new InfraConnector(store);

  // Session manager shares the collector's SQLite stores (by reference)
  const sqliteStores = collector.getSqliteStores();
  const sessionManager = new SessionManager(projectManager, sqliteStores, store);

  // Auto-snapshot session metrics on SDK disconnect
  collector.onDisconnect((sessionId, projectName) => {
    try {
      sessionManager.createSnapshot(sessionId, projectName, 'auto-disconnect');
      console.error(`[RuntimeScope] Session ${sessionId} metrics saved to SQLite`);
    } catch {
      // Non-fatal: snapshot failure shouldn't break anything
    }
  });

  // Periodic auto-snapshot for long-running sessions (every 5 minutes)
  const AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
  let autoSnapshotCount = 0;
  const autoSnapshotTimer = setInterval(() => {
    const sessions = collector.getConnectedSessions();
    if (sessions.length === 0) return;

    autoSnapshotCount++;
    const minutes = autoSnapshotCount * 5;
    for (const { sessionId, projectName } of sessions) {
      try {
        sessionManager.createSnapshot(sessionId, projectName, `auto-${minutes}m`);
      } catch {
        // Non-fatal
      }
    }
  }, AUTO_SNAPSHOT_INTERVAL_MS);

  // Retention policy: prune events older than N days on startup (requires SQLite).
  // When an existing healthy collector is already running, retention is its
  // job — duplicating it from this short-lived MCP-embedded process just
  // serializes 40+ SQLite open/close cycles into the boot path and pushes the
  // MCP handshake past Claude Code's reconnect timeout.
  if (isSqliteAvailable() && !existingHealthy) {
    const RETENTION_DAYS = parseInt(process.env.RUNTIMESCOPE_RETENTION_DAYS ?? '30', 10);
    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const projectName of projectManager.listProjects()) {
      const dbPath = projectManager.getProjectDbPath(projectName);
      if (existsSync(dbPath)) {
        try {
          const tempStore = new SqliteStore({ dbPath });
          const deleted = tempStore.deleteOldEvents(cutoffMs);
          if (deleted > 0) {
            console.error(`[RuntimeScope] Pruned ${deleted} events older than ${RETENTION_DAYS}d from "${projectName}"`);
          }
          tempStore.close();
        } catch {
          // Non-fatal: retention cleanup failure shouldn't prevent startup
        }
      }
    }
  }

  // 5. Project Management layer (requires SQLite)
  let pmStore: InstanceType<typeof PmStore> | undefined;
  let discovery: InstanceType<typeof ProjectDiscovery> | undefined;

  if (isSqliteAvailable()) {
    const pmDbPath = join(projectManager.rootDir, 'pm.db');
    pmStore = new PmStore({ dbPath: pmDbPath });
    discovery = new ProjectDiscovery(pmStore, projectManager);

    // Wire PM store into collector so handshake can resolve projectIds
    collector.setPmStore(pmStore);

    // Run discovery in background (non-blocking)
    discovery.discoverAll().then((result) => {
      console.error(`[RuntimeScope] PM: ${result.projectsDiscovered} projects, ${result.sessionsDiscovered} sessions discovered`);

      // Rebuild app index after discovery completes
      projectManager.rebuildAppIndex(pmStore);

      // Migrate project IDs — unify multi-app projects
      try {
        const migrationResult = migrateProjectIds(projectManager, pmStore);
        if (migrationResult.unified > 0) {
          console.error(`[RuntimeScope] Unified ${migrationResult.unified} project IDs`);
          for (const detail of migrationResult.details) {
            console.error(`[RuntimeScope]   ${detail}`);
          }
          // Rebuild the app index after migration
          projectManager.rebuildAppIndex(pmStore);
        }
      } catch { /* non-fatal */ }
    }).catch((err) => {
      console.error('[RuntimeScope] PM discovery error:', (err as Error).message);
    });
  }

  // 6. Start HTTP API for dashboard — only when no other healthy collector
  //    is already serving it. Starting our own here when one exists previously
  //    led to an `EADDRINUSE` that surfaced as an uncaughtException AND left
  //    httpServer.start() hung (neither resolving nor rejecting), which
  //    blocked `mcp.connect(transport)` and timed out Claude Code's MCP
  //    handshake. The user's existing collector already serves /snippet, the
  //    dashboard, and SSE, so MCP tools work fine without our own HTTP API.
  let httpServer: InstanceType<typeof HttpServer> | undefined;
  let actualHttpPort = HTTP_PORT;
  if (!existingHealthy) {
    httpServer = new HttpServer(store, processMonitor, {
      authManager,
      allowedOrigins: corsOrigins,
      rateLimiter: collector.getRateLimiter(),
      pmStore,
      discovery,
      projectManager,
      getConnectedSessions: () => collector.getConnectedSessions(),
      isReady: () => collector.isReady(),
      createSnapshot: () => collector.createSnapshot(),
      renderMetrics: () => collector.getMetricsRegistry().render(),
    });
    try {
      await httpServer.start({ port: HTTP_PORT, tls: tlsConfig });
      actualHttpPort = httpServer.getPort() ?? HTTP_PORT;
    } catch (err) {
      console.error('[RuntimeScope] HTTP API failed to start:', (err as Error).message);
      httpServer = undefined;
    }
  } else {
    console.error('[RuntimeScope] Skipping our own HTTP API — existing collector serves it.');
  }

  collector.onConnect((sessionId, projectName, projectId) => {
    if (httpServer) {
      try { httpServer.broadcastSessionChange('session_connected', sessionId, projectName); } catch { /* non-fatal */ }
    }
    if (pmStore) {
      try { pmStore.autoLinkApp(projectName, projectId); } catch { /* non-fatal */ }
    }
  });
  collector.onDisconnect((sessionId, projectName) => {
    if (httpServer) {
      try { httpServer.broadcastSessionChange('session_disconnected', sessionId, projectName); } catch { /* non-fatal */ }
    }
  });

  // 6. Create Playwright scanner (lazy — browser launches on first scan)
  const scanner = new PlaywrightScanner();

  // 7. Create MCP server
  const mcp = new McpServer({
    name: 'runtimescope',
    version: '0.6.0',
  });

  // 8. Register all 46 tools

  // --- Core Runtime (12 existing) ---
  registerNetworkTools(mcp, store);
  registerConsoleTools(mcp, store);
  registerSessionTools(mcp, store);
  registerIssueTools(mcp, store, apiDiscovery, processMonitor);
  registerTimelineTools(mcp, store);
  registerStateTools(mcp, store);
  registerRenderTools(mcp, store);
  registerPerformanceTools(mcp, store);
  registerDomSnapshotTools(mcp, store, collector);
  registerHarTools(mcp, store);
  registerErrorTools(mcp, store);

  // --- API Discovery (5 new) ---
  registerApiDiscoveryTools(mcp, store, apiDiscovery);

  // --- Database (7 new) ---
  registerDatabaseTools(mcp, store, connectionManager, schemaIntrospector, dataBrowser);

  // --- Process Monitor (3 new) ---
  registerProcessMonitorTools(mcp, processMonitor);

  // --- Infrastructure (4 new) ---
  registerInfraTools(mcp, infraConnector);

  // --- Session Diffing (4 — compare, history, create snapshot, list snapshots) ---
  registerSessionDiffTools(mcp, sessionManager, collector, projectManager);

  // --- QA Check (1 — snapshot + detect issues in one call) ---
  registerQaCheckTools(mcp, store, sessionManager, collector, apiDiscovery);

  // --- Project Setup (1 — deterministic setup_project tool) ---
  registerSetupTools(mcp, store, collector, projectManager, pmStore);

  // --- Recon / UI Analysis (9 new — extension-powered) ---
  registerReconMetadataTools(mcp, store, collector);
  registerReconDesignTokenTools(mcp, store, collector);
  registerReconFontTools(mcp, store);
  registerReconLayoutTools(mcp, store, collector);
  registerReconAccessibilityTools(mcp, store);
  registerReconComputedStyleTools(mcp, store, collector, scanner);
  registerReconElementSnapshotTools(mcp, store, collector, scanner);
  registerReconAssetTools(mcp, store);
  registerReconStyleDiffTools(mcp, store);

  // --- Playwright Scanner + SDK Snippet (2 new) ---
  registerScannerTools(mcp, store, scanner, projectManager);

  // --- Custom Event Tracking (2 new) ---
  registerCustomEventTools(mcp, store);

  // --- Breadcrumb Trail (1 new) ---
  registerBreadcrumbTools(mcp, store);

  // --- Historical Persistence (2 new) ---
  registerHistoryTools(mcp, collector, projectManager);

  // --- Collector lifecycle (2 new) ---
  registerCollectorControlTools(mcp);

  // --- Workspaces (4 new) ---
  registerWorkspaceTools(mcp, pmStore);

  // 9. Connect MCP to stdio transport
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  console.error(`[RuntimeScope] MCP server running on stdio (55 tools)`);
  console.error(`[RuntimeScope] SDK snippet at http://127.0.0.1:${actualHttpPort}/snippet`);
  console.error(`[RuntimeScope] SDK should connect to ws://127.0.0.1:${actualWsPort}`);
  console.error(`[RuntimeScope] HTTP API at http://127.0.0.1:${actualHttpPort}`);
  if (actualWsPort !== COLLECTOR_PORT || actualHttpPort !== HTTP_PORT) {
    console.error(
      `[RuntimeScope] NOTE: bound to ${actualWsPort}/${actualHttpPort} because ${COLLECTOR_PORT}/${HTTP_PORT} were in use.`,
    );
    console.error(
      `[RuntimeScope] SDK must target ws://127.0.0.1:${actualWsPort} for events to be visible to MCP tools.`,
    );
  }

  // 10. Robust shutdown — each step is wrapped so one failure can't block
  //     the others, and we never try to stop servers we don't own (attach mode).
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const safe = async (label: string, fn: () => unknown | Promise<unknown>) => {
      try { await fn(); } catch (err) {
        console.error(`[RuntimeScope] shutdown:${label} error:`, (err as Error).message);
      }
    };

    await safe('autoSnapshotTimer', () => clearInterval(autoSnapshotTimer));
    await safe('processMonitor', () => processMonitor.stop());
    await safe('scanner', () => scanner.shutdown());
    await safe('connectionManager', () => connectionManager.closeAll());
    await safe('httpServer', () => httpServer?.stop());
    await safe('collector', () => collector.stop());
    await safe('pmStore', () => pmStore?.close());

    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });
  process.on('beforeExit', () => { shutdown(); });

  // If stdin closes (Claude Code disconnected), shut down cleanly
  process.stdin.on('end', () => { shutdown(); });
  process.stdin.on('close', () => { shutdown(); });
}

main().catch((err) => {
  console.error('[RuntimeScope] Fatal error:', err);
  process.exit(1);
});
