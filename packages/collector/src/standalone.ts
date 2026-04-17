#!/usr/bin/env node

// ============================================================
// RuntimeScope Standalone Collector
// Runs CollectorServer + HttpServer as a standalone service
// without MCP, Playwright, or ProcessMonitor.
//
// Usage:
//   node dist/standalone.js
//   npx @runtimescope/collector
//   docker run runtimescope
// ============================================================

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CollectorServer } from './server.js';
import { HttpServer } from './http-server.js';
import { ProjectManager } from './project-manager.js';
import { PmStore } from './pm/pm-store.js';
import { ProjectDiscovery } from './pm/project-discovery.js';
import { SessionManager } from './session-manager.js';
import { SqliteStore } from './sqlite-store.js';
import { isSqliteAvailable } from './sqlite-check.js';
import { AuthManager } from './auth.js';
import { Redactor } from './redactor.js';
import { resolveTlsConfig } from './tls.js';
import { migrateProjectIds } from './project-config.js';

const HOST = process.env.RUNTIMESCOPE_HOST ?? '127.0.0.1';
// Same default ports as MCP server — only one should run at a time
const COLLECTOR_PORT = parseInt(process.env.RUNTIMESCOPE_PORT ?? '6767', 10);
const HTTP_PORT = parseInt(process.env.RUNTIMESCOPE_HTTP_PORT ?? '6768', 10);
const BUFFER_SIZE = parseInt(process.env.RUNTIMESCOPE_BUFFER_SIZE ?? '10000', 10);
const RETENTION_DAYS = parseInt(process.env.RUNTIMESCOPE_RETENTION_DAYS ?? '30', 10);

async function main() {
  console.error('[RuntimeScope] Starting standalone collector...');

  // 1. Initialize project management + config
  const projectManager = new ProjectManager();
  projectManager.ensureGlobalDir();
  const globalConfig = projectManager.getGlobalConfig();

  // 2. Security: auth, TLS, redaction, CORS
  // RUNTIMESCOPE_AUTH_TOKEN env var provides a quick way to enable auth in Docker
  // deployments without mounting a config file. Multiple tokens can be passed
  // comma-separated. If set, it takes precedence over the config file.
  const envAuthToken = process.env.RUNTIMESCOPE_AUTH_TOKEN;
  const authFromEnv = envAuthToken
    ? {
        enabled: true,
        apiKeys: envAuthToken
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .map((key, i) => ({
            key,
            label: `env-token-${i + 1}`,
            createdAt: Date.now(),
          })),
      }
    : null;
  const authManager = new AuthManager({
    enabled: authFromEnv?.enabled ?? globalConfig.auth?.enabled ?? false,
    apiKeys: authFromEnv?.apiKeys ?? globalConfig.auth?.apiKeys ?? [],
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
    const keyCount = (authFromEnv?.apiKeys?.length ?? globalConfig.auth?.apiKeys?.length ?? 0);
    const source = authFromEnv ? 'env' : 'config';
    console.error(`[RuntimeScope] Auth enabled (${keyCount} API key${keyCount === 1 ? '' : 's'} from ${source})`);
  }
  if (tlsConfig) {
    console.error(`[RuntimeScope] TLS enabled (cert: ${tlsConfig.certPath})`);
  }
  if (redactor.isEnabled()) {
    console.error('[RuntimeScope] Payload redaction enabled');
  }

  // 3. Start collector WebSocket server
  const collector = new CollectorServer({
    bufferSize: BUFFER_SIZE,
    projectManager,
    authManager,
    rateLimits: globalConfig.rateLimits,
    tls: tlsConfig,
  });
  await collector.start({ port: COLLECTOR_PORT, host: HOST, maxRetries: 5, retryDelayMs: 1000 });

  const store = collector.getStore();

  // Wire redactor for defense-in-depth
  if (redactor.isEnabled()) {
    store.setRedactor(redactor);
  }

  // 4. Session management — auto-snapshot on disconnect
  const sqliteStores = collector.getSqliteStores();
  const sessionManager = new SessionManager(projectManager, sqliteStores, store);

  collector.onDisconnect((sessionId, projectName) => {
    try {
      sessionManager.createSnapshot(sessionId, projectName);
      console.error(`[RuntimeScope] Session ${sessionId} metrics saved`);
    } catch {
      // Non-fatal
    }
  });

  // 5. Retention pruning (only if SQLite is available)
  if (isSqliteAvailable()) {
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
          // Non-fatal
        }
      }
    }
  }

  // 6. Project Management layer (requires SQLite)
  let pmStore: PmStore | undefined;
  let discovery: ProjectDiscovery | undefined;

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

  // 7. Start HTTP API server (with POST /api/events + PM routes)
  const httpServer = new HttpServer(store, undefined, {
    authManager,
    allowedOrigins: corsOrigins,
    rateLimiter: collector.getRateLimiter(),
    pmStore,
    discovery,
    projectManager,
    getConnectedSessions: () => collector.getConnectedSessions(),
  });

  try {
    await httpServer.start({ port: HTTP_PORT, host: HOST, tls: tlsConfig });
  } catch (err) {
    console.error('[RuntimeScope] HTTP API failed to start:', (err as Error).message);
  }

  // Push session connect/disconnect to dashboard in real-time
  collector.onConnect((sessionId, projectName, projectId) => {
    httpServer.broadcastSessionChange('session_connected', sessionId, projectName);
    // Auto-link SDK appName to PM project
    if (pmStore) {
      try { pmStore.autoLinkApp(projectName, projectId); } catch { /* non-fatal */ }
    }
  });
  collector.onDisconnect((sessionId, projectName) => {
    httpServer.broadcastSessionChange('session_disconnected', sessionId, projectName);
  });

  // 7. Startup summary
  const proto = tlsConfig ? 'wss' : 'ws';
  const httpProto = tlsConfig ? 'https' : 'http';
  console.error(`[RuntimeScope] Standalone collector ready`);
  console.error(`[RuntimeScope]   WebSocket: ${proto}://${HOST}:${COLLECTOR_PORT}`);
  console.error(`[RuntimeScope]   HTTP API:  ${httpProto}://${HOST}:${HTTP_PORT}`);
  console.error(`[RuntimeScope]   Health:    ${httpProto}://${HOST}:${HTTP_PORT}/api/health`);
  console.error(`[RuntimeScope]   Ingest:    POST ${httpProto}://${HOST}:${HTTP_PORT}/api/events`);

  // 8. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('[RuntimeScope] Shutting down...');

    await httpServer.stop();
    collector.stop();
    pmStore?.close();

    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });
}

main().catch((err) => {
  console.error('[RuntimeScope] Fatal error:', err);
  process.exit(1);
});
