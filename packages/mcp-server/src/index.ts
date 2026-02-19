import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

// --- Historical event persistence ---
import { registerHistoryTools } from './tools/history.js';

const COLLECTOR_PORT = parseInt(process.env.RUNTIMESCOPE_PORT ?? '9090', 10);
const HTTP_PORT = parseInt(process.env.RUNTIMESCOPE_HTTP_PORT ?? '9091', 10);
const BUFFER_SIZE = parseInt(process.env.RUNTIMESCOPE_BUFFER_SIZE ?? '10000', 10);

/**
 * Attempt to kill any stale process holding the collector port.
 * This handles the case where a previous MCP server process didn't
 * clean up (e.g. Claude Code session crashed).
 */
function killStaleProcess(port: number): void {
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (pids) {
      const myPid = process.pid.toString();
      for (const pid of pids.split('\n')) {
        if (pid && pid !== myPid) {
          console.error(`[RuntimeScope] Killing stale process ${pid} on port ${port}`);
          try {
            process.kill(parseInt(pid, 10), 'SIGTERM');
          } catch {
            // Process may have already exited
          }
        }
      }
    }
  } catch {
    // lsof not available or no process found — that's fine
  }
}

async function main() {
  // 1. Initialize project management
  const projectManager = new ProjectManager();
  projectManager.ensureGlobalDir();

  // 2. Clear any stale collector from a previous session
  killStaleProcess(COLLECTOR_PORT);
  killStaleProcess(HTTP_PORT);

  // 3. Start the collector WebSocket server with project scoping
  const collector = new CollectorServer({
    bufferSize: BUFFER_SIZE,
    projectManager,
  });
  await collector.start({ port: COLLECTOR_PORT, maxRetries: 5, retryDelayMs: 1000 });

  const store = collector.getStore();

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
      sessionManager.createSnapshot(sessionId, projectName);
      console.error(`[RuntimeScope] Session ${sessionId} metrics saved to SQLite`);
    } catch {
      // Non-fatal: snapshot failure shouldn't break anything
    }
  });

  // Retention policy: prune events older than N days on startup
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

  // 5. Start HTTP API for dashboard
  const httpServer = new HttpServer(store, processMonitor);
  try {
    await httpServer.start({ port: HTTP_PORT });
  } catch (err) {
    console.error('[RuntimeScope] HTTP API failed to start:', (err as Error).message);
    // Non-fatal: MCP tools still work without HTTP API
  }

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

  // --- Session Diffing (2 new) ---
  registerSessionDiffTools(mcp, sessionManager);

  // --- Recon / UI Analysis (9 new — extension-powered) ---
  registerReconMetadataTools(mcp, store, collector);
  registerReconDesignTokenTools(mcp, store, collector);
  registerReconFontTools(mcp, store);
  registerReconLayoutTools(mcp, store, collector);
  registerReconAccessibilityTools(mcp, store);
  registerReconComputedStyleTools(mcp, store, collector);
  registerReconElementSnapshotTools(mcp, store, collector);
  registerReconAssetTools(mcp, store);
  registerReconStyleDiffTools(mcp, store);

  // --- Playwright Scanner + SDK Snippet (2 new) ---
  registerScannerTools(mcp, store, scanner);

  // --- Historical Persistence (2 new) ---
  registerHistoryTools(mcp, collector, projectManager);

  // 9. Connect MCP to stdio transport
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  console.error('[RuntimeScope] MCP server running on stdio (v0.6.0 — 46 tools)');
  console.error(`[RuntimeScope] SDK snippet at http://127.0.0.1:${HTTP_PORT}/snippet`);
  console.error(`[RuntimeScope] SDK should connect to ws://127.0.0.1:${COLLECTOR_PORT}`);
  console.error(`[RuntimeScope] HTTP API at http://127.0.0.1:${HTTP_PORT}`);

  // 10. Robust shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    processMonitor.stop();
    await scanner.shutdown();
    await connectionManager.closeAll();
    await httpServer.stop();
    collector.stop();

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
