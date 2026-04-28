import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { EventStore } from './store.js';
import { ProjectManager } from './project-manager.js';
import { getOrCreateProjectId, resolveProjectId } from './project-id.js';
import type { PmStoreLike } from './project-id.js';
import { SqliteStore } from './sqlite-store.js';
import { isSqliteAvailable } from './sqlite-check.js';
import { Wal } from './wal.js';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { MetricsRegistry, Counter } from './metrics.js';
import { OtelExporter, otelOptionsFromEnv, type OtelExporterOptions } from './otel-exporter.js';

export interface SnapshotResult {
  /** Absolute path to the snapshot directory. */
  path: string;
  /** ISO-like timestamp embedded in the directory name. */
  timestamp: string;
  /** Per-project sizes + event counts. */
  projects: { name: string; sqliteBytes: number; walBytes: number; eventCount: number }[];
  /** Total bytes written across all projects. */
  totalBytes: number;
}
import { AuthManager } from './auth.js';
import { SessionRateLimiter, type RateLimitConfig } from './rate-limiter.js';
import { loadTlsOptions, type TlsConfig } from './tls.js';
import type {
  WSMessage,
  HandshakePayload,
  EventBatchPayload,
  CommandResponse,
  SessionInfoExtended,
  RuntimeEvent,
} from './types.js';

export interface CollectorServerOptions {
  port?: number;
  host?: string;
  bufferSize?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  projectManager?: ProjectManager;
  authManager?: AuthManager;
  rateLimits?: RateLimitConfig;
  tls?: TlsConfig;
  /**
   * Optional OpenTelemetry exporter config. When set (or when
   * `RUNTIMESCOPE_OTEL_ENDPOINT` is in the environment), every event the
   * store accepts is converted into an OTLP signal and shipped to the
   * configured endpoint. Failures are logged but never break ingestion.
   */
  otel?: OtelExporterOptions;
  /**
   * Skip the synchronous startup recovery pass (WAL replay + SQLite warm).
   * The MCP server uses this when an existing healthy collector is already
   * holding port 6768: in that case the in-process collector receives zero
   * SDK events (SDKs talk to the launchd collector instead), so warming
   * 40+ SQLite stores during boot is pure cost — and it pushes the MCP
   * transport-ready time past Claude Code's plugin reconnect timeout.
   * Recovery still runs lazily on the first SDK connection per project.
   */
  skipRecovery?: boolean;
}

interface ClientInfo {
  sessionId: string;
  projectName: string;
  projectId?: string;
  workspaceId?: string;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CollectorServer {
  private wss: WebSocketServer | null = null;
  private store: EventStore;
  private projectManager: ProjectManager | null;
  private authManager: AuthManager | null = null;
  private rateLimiter: SessionRateLimiter;
  private clients: Map<WebSocket, ClientInfo> = new Map();
  private pendingHandshakes: Set<WebSocket> = new Set();
  private pendingCommands: Map<string, PendingCommand> = new Map();
  private sqliteStores: Map<string, SqliteStore> = new Map();
  private wals: Map<string, Wal> = new Map();
  private ready = false;
  private metrics: MetricsRegistry = new MetricsRegistry();
  private startedAt: number = Date.now();
  private counters: {
    eventsTotal: Counter;
    eventsDropped: Counter;
    wsDisconnects: Counter;
  };
  private otelExporter: OtelExporter | null = null;
  private connectCallbacks: ((sessionId: string, projectName: string, projectId?: string) => void)[] = [];
  private disconnectCallbacks: ((sessionId: string, projectName: string, projectId?: string) => void)[] = [];
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private tlsConfig: TlsConfig | null = null;
  private pmStore: PmStoreLike | null = null;

  constructor(options: CollectorServerOptions = {}) {
    this.store = new EventStore(options.bufferSize ?? 10_000);
    this.projectManager = options.projectManager ?? null;
    this.authManager = options.authManager ?? null;
    this.rateLimiter = new SessionRateLimiter(options.rateLimits ?? {});
    this.tlsConfig = options.tls ?? null;

    if (this.projectManager) {
      this.projectManager.ensureGlobalDir();
    }

    // Periodically prune stale rate limiter entries
    if (this.rateLimiter.isEnabled()) {
      this.pruneTimer = setInterval(() => this.rateLimiter.prune(), 60_000);
    }

    // --- Metrics registry ---
    // Counters increment as work happens; gauges read live state at scrape
    // time so we don't risk drift between the counter and the underlying map.
    this.counters = {
      eventsTotal: this.metrics.counter(
        'runtimescope_events_total',
        'Total events accepted by the collector since start.',
        ['type'],
      ),
      eventsDropped: this.metrics.counter(
        'runtimescope_events_dropped_total',
        'Total events dropped before reaching the in-memory store.',
        ['reason'],
      ),
      wsDisconnects: this.metrics.counter(
        'runtimescope_ws_disconnects_total',
        'WebSocket disconnects (clean + abnormal) since start.',
        ['cause'],
      ),
    };

    // Hot path: every event the store accepts increments the per-type counter.
    // Listener errors are swallowed by EventStore.addEvent, so a bad metric
    // can't break ingestion.
    this.store.onEvent((event) => {
      this.counters.eventsTotal.inc(1, { type: event.eventType });
    });

    const uptime = this.metrics.gauge(
      'runtimescope_collector_uptime_seconds',
      'Seconds since the collector process started.',
    );
    uptime.setCollect(() => Math.floor((Date.now() - this.startedAt) / 1000));

    const sessionsConnected = this.metrics.gauge(
      'runtimescope_sessions_connected',
      'SDK sessions currently connected via WebSocket.',
    );
    sessionsConnected.setCollect(
      () => this.store.getSessionInfo().filter((s) => s.isConnected).length,
    );

    const bufferSize = this.metrics.gauge(
      'runtimescope_buffer_size',
      'Events currently held in the in-memory ring buffer.',
    );
    bufferSize.setCollect(() => this.store.eventCount);

    const projectsGauge = this.metrics.gauge(
      'runtimescope_projects',
      'Distinct projects (apps) the collector has seen.',
    );
    projectsGauge.setCollect(() => this.projectManager?.listProjects().length ?? 0);

    const workspacesGauge = this.metrics.gauge(
      'runtimescope_workspaces',
      'Workspaces (multi-tenant containers) registered in PmStore.',
    );
    workspacesGauge.setCollect(() => {
      const pm = this.pmStore as { listWorkspaces?: () => unknown[] } | null;
      return pm?.listWorkspaces ? pm.listWorkspaces().length : 0;
    });

    // --- OpenTelemetry exporter (opt-in) ---
    // Explicit constructor option wins; otherwise fall back to env-vars so
    // operators can configure it at deploy time without code changes.
    const otelOptions = options.otel ?? otelOptionsFromEnv();
    if (otelOptions) {
      this.otelExporter = new OtelExporter(otelOptions);
      this.store.onEvent((event) => {
        // ingest is fire-and-forget — the exporter buffers + flushes on its
        // own timer. Errors are logged inside the exporter, never thrown out.
        this.otelExporter?.ingest(event);
      });
      console.error(
        `[RuntimeScope] OpenTelemetry export enabled → ${otelOptions.endpoint}`,
      );
    }
  }

  /** Public access to the metrics registry — HttpServer renders this at /metrics. */
  getMetricsRegistry(): MetricsRegistry {
    return this.metrics;
  }

  getStore(): EventStore {
    return this.store;
  }

  getPort(): number | null {
    const addr = this.wss?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getProjectManager(): ProjectManager | null {
    return this.projectManager;
  }

  getSqliteStore(projectName: string): SqliteStore | undefined {
    return this.sqliteStores.get(projectName);
  }

  getSqliteStores(): Map<string, SqliteStore> {
    return this.sqliteStores;
  }

  getRateLimiter(): SessionRateLimiter {
    return this.rateLimiter;
  }

  /** Set the PmStore for project ID resolution (called after construction when PmStore is available). */
  setPmStore(pmStore: PmStoreLike | null): void {
    this.pmStore = pmStore;
  }

  onConnect(cb: (sessionId: string, projectName: string, projectId?: string) => void): void {
    this.connectCallbacks.push(cb);
  }

  onDisconnect(cb: (sessionId: string, projectName: string, projectId?: string) => void): void {
    this.disconnectCallbacks.push(cb);
  }

  /** True after start() finishes recovery. False during startup or after stop(). */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Snapshot every project's SQLite DB and WAL into a fresh directory under
   * `<runtimescope-root>/snapshots/<ISO>/`. Atomic via SQLite's `VACUUM INTO`;
   * non-blocking for ongoing event ingestion (the live DB keeps accepting
   * writes during the copy).
   *
   * Returns metadata for the admin endpoint to serialize.
   */
  createSnapshot(): SnapshotResult {
    if (!this.projectManager) {
      throw new Error('Cannot snapshot — no projectManager configured');
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const root = join(this.projectManager.rootDir, 'snapshots', timestamp);
    mkdirSync(root, { recursive: true });

    const projects: SnapshotResult['projects'] = [];
    let totalBytes = 0;

    for (const projectName of this.projectManager.listProjects()) {
      const projectDir = join(root, projectName);
      mkdirSync(projectDir, { recursive: true });

      // SQLite: drain any pending writes first, then VACUUM INTO. Skip if
      // SQLite isn't available for this build.
      let sqliteBytes = 0;
      let eventCount = 0;
      const sqliteStore = this.sqliteStores.get(projectName);
      if (sqliteStore) {
        const sqlitePath = join(projectDir, 'events.db');
        try {
          sqliteBytes = sqliteStore.snapshotTo(sqlitePath);
          eventCount = sqliteStore.getEventCount({ project: projectName });
        } catch (err) {
          console.error(
            `[RuntimeScope] Snapshot of "${projectName}" SQLite failed:`,
            (err as Error).message,
          );
        }
      }

      // WAL: copy active + sealed files alongside the SQLite copy. Even after
      // a clean drain there can be in-flight events that would otherwise be
      // missing from a snapshot taken between WAL appends and SQLite flushes.
      let walBytes = 0;
      const wal = this.wals.get(projectName);
      if (wal) {
        try {
          walBytes = wal.snapshotTo(join(projectDir, 'wal'));
        } catch (err) {
          console.error(
            `[RuntimeScope] Snapshot of "${projectName}" WAL failed:`,
            (err as Error).message,
          );
        }
      }

      projects.push({ name: projectName, sqliteBytes, walBytes, eventCount });
      totalBytes += sqliteBytes + walBytes;
    }

    const manifest = {
      timestamp,
      createdAt: Date.now(),
      collectorVersion: process.env.npm_package_version ?? '0.0.0',
      projects,
      totalBytes,
    };
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));

    return { path: root, timestamp, projects, totalBytes };
  }

  async start(options: CollectorServerOptions = {}): Promise<void> {
    const port = options.port ?? 6767;
    const host = options.host ?? '127.0.0.1';
    const maxRetries = options.maxRetries ?? 5;
    const retryDelayMs = options.retryDelayMs ?? 1000;
    const tls = options.tls ?? this.tlsConfig;

    // Recovery before binding the port: any leftover WAL files from a prior
    // crash are replayed into SqliteStore, and the in-memory ring buffer is
    // warmed with the most recent events per project. New WS connections only
    // start arriving after this completes, so there's no race with incoming
    // events overlapping the warm-up.
    //
    // When skipRecovery is set (MCP server in attach-mode), we bypass this:
    // there's no point opening 40+ SQLite stores when this collector instance
    // will receive zero events. WAL recovery for THIS process's prior crash
    // is moot too (a fresh npx-launched mcp-server has no prior WAL on disk).
    if (!options.skipRecovery) {
      try {
        this.runStartupRecovery();
      } catch (err) {
        console.error('[RuntimeScope] Startup recovery failed (non-fatal):', (err as Error).message);
      }
    }
    this.ready = true;

    return this.tryStart(port, host, maxRetries, retryDelayMs, tls);
  }

  /**
   * On collector startup, for each known project:
   *   1. Replay any sealed/active WAL files into SqliteStore (mirror of the
   *      lazy recovery in `ensureWal`, but proactive — handles the case where
   *      a crashed project never reconnects).
   *   2. Warm the in-memory ring buffer with recent events from SqliteStore so
   *      MCP tools see history immediately, not just events from the next
   *      session that connects.
   *
   * Runs synchronously — better-sqlite3 is sync — so callers can `await
   * collector.start()` and trust the buffer is hot when it returns.
   */
  private runStartupRecovery(): void {
    if (!this.projectManager) return;
    const projects = this.projectManager.listProjects();
    if (projects.length === 0) return;

    let walReplayed = 0;
    let warmed = 0;

    for (const project of projects) {
      // 1. WAL replay (idempotent — duplicates dropped by event_id PK).
      const dir = this.walDirFor(project);
      if (dir) {
        const files = Wal.listRecoveryFiles(dir);
        if (files.length > 0) {
          const sqliteStore = this.ensureSqliteStore(project);
          if (sqliteStore) {
            for (const file of files) {
              const events = Wal.readFile(file);
              for (const ev of events) {
                try { sqliteStore.addEvent(ev, project); } catch { /* ignore */ }
              }
              walReplayed += events.length;
            }
            sqliteStore.flush();
            for (const file of files) Wal.deleteSealed(file);
          }
        }
      }

      // 2. Ring-buffer warm. Cap per-project so a project with millions of
      //    historical events doesn't monopolize the (shared) ring; let the
      //    buffer's natural eviction handle distribution across projects.
      const sqliteStore = this.ensureSqliteStore(project);
      if (sqliteStore) {
        const before = this.store.eventCount;
        this.store.warmFromSqlite(sqliteStore, project, 1000);
        warmed += this.store.eventCount - before;
      }
    }

    if (walReplayed > 0 || warmed > 0) {
      console.error(
        `[RuntimeScope] Recovery: ${walReplayed} WAL events replayed, ${warmed} events warmed into ring buffer.`,
      );
    }
  }

  private tryStart(
    port: number,
    host: string,
    retriesLeft: number,
    retryDelayMs: number,
    tls?: TlsConfig | null
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let wss: WebSocketServer;

      if (tls) {
        // TLS mode: create HTTPS server, then attach WebSocket to it
        const httpsServer = createHttpsServer(loadTlsOptions(tls));
        wss = new WebSocketServer({ server: httpsServer });

        httpsServer.on('listening', () => {
          this.wss = wss;
          this.setupConnectionHandler(wss);
          this.setupPersistentErrorHandler(wss);
          this.startHeartbeat(wss);
          console.error(`[RuntimeScope] Collector listening on wss://${host}:${port}`);
          resolve();
        });

        httpsServer.on('error', (err: NodeJS.ErrnoException) => {
          httpsServer.close();
          this.handleStartError(err, port, host, retriesLeft, retryDelayMs, tls, resolve, reject);
        });

        httpsServer.listen(port, host);
      } else {
        // Plain WS mode (default — backward compatible)
        wss = new WebSocketServer({ port, host });

        wss.on('listening', () => {
          this.wss = wss;
          this.setupConnectionHandler(wss);
          this.setupPersistentErrorHandler(wss);
          this.startHeartbeat(wss);
          console.error(`[RuntimeScope] Collector listening on ws://${host}:${port}`);
          resolve();
        });

        wss.on('error', (err: NodeJS.ErrnoException) => {
          wss.close();
          this.handleStartError(err, port, host, retriesLeft, retryDelayMs, tls, resolve, reject);
        });
      }
    });
  }

  private handleStartError(
    err: NodeJS.ErrnoException,
    port: number,
    host: string,
    retriesLeft: number,
    retryDelayMs: number,
    tls: TlsConfig | null | undefined,
    resolve: () => void,
    reject: (err: Error) => void
  ): void {
    if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
      const nextPort = port + 1;
      console.error(
        `[RuntimeScope] Port ${port} in use, trying ${nextPort}...`
      );
      this.tryStart(nextPort, host, retriesLeft - 1, retryDelayMs, tls)
        .then(resolve)
        .catch(reject);
    } else {
      console.error('[RuntimeScope] WebSocket server error:', err.message);
      reject(err);
    }
  }

  private ensureSqliteStore(projectName: string): SqliteStore | null {
    if (!this.projectManager) return null;
    if (!isSqliteAvailable()) return null;

    let sqliteStore = this.sqliteStores.get(projectName);
    if (!sqliteStore) {
      try {
        this.projectManager.ensureProjectDir(projectName);
        const dbPath = this.projectManager.getProjectDbPath(projectName);
        sqliteStore = new SqliteStore({ dbPath });
        this.sqliteStores.set(projectName, sqliteStore);
        this.store.setSqliteStore(sqliteStore, projectName);
        console.error(`[RuntimeScope] SQLite store opened for project "${projectName}"`);
      } catch (err) {
        console.error(
          `[RuntimeScope] Failed to open SQLite for "${projectName}":`,
          (err as Error).message
        );
        return null;
      }
    }
    return sqliteStore;
  }

  private walDirFor(projectName: string): string | null {
    if (!this.projectManager) return null;
    try {
      this.projectManager.ensureProjectDir(projectName);
      const dbPath = this.projectManager.getProjectDbPath(projectName);
      // Co-locate with the SQLite DB so backups that copy the project dir
      // capture both files. `getProjectDbPath` returns the db file path; the
      // WAL lives in a sibling directory.
      return join(dirname(dbPath), 'wal');
    } catch {
      return null;
    }
  }

  /**
   * Open (or return) the WAL for a project. Every event ingested for this
   * project is first appended + fsync'd here before being pushed to the ring
   * buffer and SqliteStore, so a crash between receipt and SqliteStore flush
   * doesn't lose acknowledged events.
   */
  private ensureWal(projectName: string): Wal | null {
    if (!this.projectManager) return null;
    let wal = this.wals.get(projectName);
    if (wal) return wal;

    const dir = this.walDirFor(projectName);
    if (!dir) return null;
    try {
      // Recover any files left behind by a prior crash before we open a fresh
      // active WAL — otherwise those events would be stuck forever.
      this.recoverWalForProject(projectName, dir);
      wal = new Wal({ dir });
      this.wals.set(projectName, wal);
      return wal;
    } catch (err) {
      console.error(
        `[RuntimeScope] Failed to open WAL for "${projectName}":`,
        (err as Error).message,
      );
      return null;
    }
  }

  /**
   * Replay any sealed or non-empty active WAL files into SqliteStore, then
   * delete them. Called lazily the first time a project's WAL is opened — if
   * the prior collector crashed mid-batch, those events survive in the WAL
   * and we'd otherwise leave them stranded on disk forever.
   */
  private recoverWalForProject(projectName: string, dir: string): void {
    const files = Wal.listRecoveryFiles(dir);
    if (files.length === 0) return;

    const sqliteStore = this.ensureSqliteStore(projectName);
    let replayed = 0;
    for (const file of files) {
      const events = Wal.readFile(file);
      if (events.length === 0) {
        // Empty file — safe to drop.
        Wal.deleteSealed(file);
        continue;
      }
      if (sqliteStore) {
        for (const ev of events) {
          try { sqliteStore.addEvent(ev, projectName); } catch { /* non-fatal */ }
        }
        replayed += events.length;
      }
      // Don't delete the file until SqliteStore has actually committed.
    }
    if (sqliteStore && replayed > 0) {
      sqliteStore.flush();
      // SqliteStore.flush is synchronous — after this returns events are in
      // SQLite. Now safe to drop the WAL files.
      for (const file of files) Wal.deleteSealed(file);
      console.error(
        `[RuntimeScope] WAL recovery: replayed ${replayed} events for "${projectName}"`,
      );
    }
  }

  /**
   * Rotate the project's WAL, flush SqliteStore so the rotated file's events
   * are persisted, then delete the sealed file. Called when the active file
   * has grown past its rotate threshold.
   */
  private checkpointWal(projectName: string, wal: Wal): void {
    const sealed = wal.rotate();
    if (!sealed) return;
    const sqliteStore = this.sqliteStores.get(projectName);
    sqliteStore?.flush();
    // Grace period keeps the file around briefly in case a concurrent reader
    // is still parsing it (nobody does today, but defensive).
    setTimeout(() => Wal.deleteSealed(sealed), 5000).unref();
  }

  /** Catch runtime errors on the WSS so an unhandled error doesn't crash the process */
  private setupPersistentErrorHandler(wss: WebSocketServer): void {
    wss.on('error', (err) => {
      console.error('[RuntimeScope] WebSocket server runtime error:', err.message);
    });
  }

  /** Ping all connected clients every 15s — terminate those that don't respond */
  private startHeartbeat(wss: WebSocketServer): void {
    this.heartbeatTimer = setInterval(() => {
      for (const ws of wss.clients) {
        const ext = ws as WebSocket & { _rsAlive?: boolean };
        if (ext._rsAlive === false) {
          // Missed a heartbeat — terminate dead connection
          ws.terminate();
          continue;
        }
        ext._rsAlive = false;
        ws.ping();
      }
    }, 15_000);
  }

  private setupConnectionHandler(wss: WebSocketServer): void {
    wss.on('connection', (ws) => {
      // Mark alive for heartbeat — pong response resets this
      const ext = ws as WebSocket & { _rsAlive?: boolean };
      ext._rsAlive = true;
      ws.on('pong', () => { ext._rsAlive = true; });
      // If auth is enabled, the connection starts in a pending state.
      // The first message must be a valid handshake with an authToken.
      if (this.authManager?.isEnabled()) {
        this.pendingHandshakes.add(ws);

        // Auto-close if no valid handshake within 5 seconds
        const authTimeout = setTimeout(() => {
          if (this.pendingHandshakes.has(ws)) {
            this.pendingHandshakes.delete(ws);
            try {
              ws.send(JSON.stringify({
                type: 'error',
                payload: { code: 'AUTH_TIMEOUT', message: 'Handshake timeout' },
                timestamp: Date.now(),
              }));
            } catch { /* ignore */ }
            ws.close(4001, 'Authentication timeout');
          }
        }, 5000);

        ws.on('close', () => {
          clearTimeout(authTimeout);
          this.pendingHandshakes.delete(ws);
        });
      }

      ws.on('message', (data) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());
          this.handleMessage(ws, msg);
        } catch {
          console.error('[RuntimeScope] Malformed WebSocket message, ignoring');
        }
      });

      ws.on('close', (code) => {
        // 1000 / 1001 are clean closes; anything else is abnormal. The label
        // lets dashboards alert on spikes in abnormal disconnects.
        const cause = code === 1000 || code === 1001 ? 'clean' : 'abnormal';
        this.counters.wsDisconnects.inc(1, { cause });

        const clientInfo = this.clients.get(ws);
        if (clientInfo) {
          this.store.markDisconnected(clientInfo.sessionId);

          // Update SQLite session record
          const sqliteStore = this.sqliteStores.get(clientInfo.projectName);
          if (sqliteStore) {
            sqliteStore.updateSessionDisconnected(clientInfo.sessionId, Date.now());
          }

          console.error(`[RuntimeScope] Session ${clientInfo.sessionId} disconnected`);

          // Notify disconnect listeners (for session snapshotting)
          for (const cb of this.disconnectCallbacks) {
            try {
              cb(clientInfo.sessionId, clientInfo.projectName, clientInfo.projectId);
            } catch {
              // Don't let listener errors break disconnect handling
            }
          }
        }
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.error('[RuntimeScope] WebSocket client error:', err.message);
      });
    });
  }

  private handleMessage(ws: WebSocket, msg: WSMessage): void {
    switch (msg.type) {
      case 'handshake': {
        const payload = msg.payload as HandshakePayload;

        // Authentication — two layers:
        //   1. Workspace-scoped API keys stored in pmStore. Present when the
        //      token is a `tk_xxx` generated by the workspaces API.
        //   2. Global API keys from ~/.runtimescope/config.json or the
        //      RUNTIMESCOPE_AUTH_TOKEN env var (handled by AuthManager).
        //
        // We accept either. The workspace key also tells us which workspace
        // this session's project should live in, so we record that below.
        let workspaceFromKey: { id: string; slug: string } | null = null;
        if (payload.authToken && this.pmStore?.getWorkspaceByApiKey) {
          try {
            const ws = this.pmStore.getWorkspaceByApiKey(payload.authToken);
            if (ws) workspaceFromKey = { id: ws.id, slug: ws.slug };
          } catch { /* non-fatal — fall through to global auth */ }
        }

        if (this.authManager?.isEnabled() && !workspaceFromKey) {
          if (!this.authManager.isAuthorized(payload.authToken)) {
            try {
              ws.send(JSON.stringify({
                type: 'error',
                payload: { code: 'AUTH_FAILED', message: 'Invalid or missing API key' },
                timestamp: Date.now(),
              }));
            } catch { /* ignore */ }
            ws.close(4001, 'Authentication failed');
            return;
          }
        }
        this.pendingHandshakes.delete(ws);

        const projectName = payload.appName;
        // Auto-generate a projectId if the SDK didn't send one (backwards compat)
        const projectId = payload.projectId
          ?? (this.projectManager ? resolveProjectId(this.projectManager, projectName, this.pmStore) : undefined);

        this.clients.set(ws, {
          sessionId: payload.sessionId,
          projectName,
          projectId,
          workspaceId: workspaceFromKey?.id,
        });

        // If we authenticated via a workspace key, auto-assign this session's
        // project (by runtimeProjectId) to that workspace. New projects land
        // in the key's workspace; existing projects are left alone unless
        // they had no workspace yet.
        if (workspaceFromKey && projectId && this.pmStore?.listProjects && this.pmStore.setProjectWorkspace) {
          try {
            const existing = this.pmStore.listProjects().find(
              (p) => p.runtimeProjectId === projectId,
            );
            if (existing && !existing.workspaceId) {
              this.pmStore.setProjectWorkspace(existing.id, workspaceFromKey.id);
            }
          } catch { /* non-fatal */ }
        }

        // Initialize SQLite for this project
        const sqliteStore = this.ensureSqliteStore(projectName);

        // Save session info to SQLite. Including projectId is required so
        // post-crash recovery can rehydrate the session→projectId map and
        // serve `/api/events/*?project_id=...` queries against warmed data.
        if (sqliteStore) {
          const sessionInfo: SessionInfoExtended = {
            sessionId: payload.sessionId,
            project: projectName,
            appName: payload.appName,
            connectedAt: msg.timestamp,
            sdkVersion: payload.sdkVersion,
            eventCount: 0,
            isConnected: true,
            projectId,
          };
          sqliteStore.saveSession(sessionInfo);
        }

        // Register session in EventStore so /api/projects can list it
        this.store.addEvent({
          eventId: `session-${payload.sessionId}`,
          sessionId: payload.sessionId,
          timestamp: msg.timestamp,
          eventType: 'session',
          appName: payload.appName,
          projectId,
          connectedAt: msg.timestamp,
          sdkVersion: payload.sdkVersion,
        } as RuntimeEvent);

        console.error(
          `[RuntimeScope] Session ${payload.sessionId} connected (${payload.appName} v${payload.sdkVersion})`
        );

        // Notify connect listeners
        for (const cb of this.connectCallbacks) {
          try { cb(payload.sessionId, projectName, projectId); } catch { /* non-fatal */ }
        }
        break;
      }
      case 'event': {
        // Reject events from unauthenticated connections
        if (this.pendingHandshakes.has(ws)) return;

        const clientInfo = this.clients.get(ws);
        const payload = msg.payload as EventBatchPayload;
        if (!Array.isArray(payload.events)) break;

        // Rate-limit first so dropped events don't hit the WAL.
        const accepted: RuntimeEvent[] = [];
        let rateLimited = 0;
        for (const event of payload.events) {
          if (clientInfo && !this.rateLimiter.allow(clientInfo.sessionId)) {
            // Rate limiter rejected — count remaining events in the batch as
            // dropped (we break, so the rest are dropped too).
            rateLimited = payload.events.length - accepted.length;
            break;
          }
          accepted.push(event);
        }
        if (rateLimited > 0) {
          this.counters.eventsDropped.inc(rateLimited, { reason: 'rate_limit' });
        }
        if (accepted.length === 0) break;

        // Durability: write to WAL and fsync once per batch BEFORE we hand the
        // events off to the in-memory store. If the process crashes after this
        // point, recovery will replay the batch into SqliteStore.
        const wal = clientInfo?.projectName ? this.ensureWal(clientInfo.projectName) : null;
        if (wal) {
          try {
            wal.append(accepted);
            wal.commit();
          } catch (err) {
            console.error('[RuntimeScope] WAL append/commit failed:', (err as Error).message);
            this.counters.eventsDropped.inc(accepted.length, { reason: 'wal_backpressure' });
            // Continue — dropping an event is worse than proceeding without the
            // durability guarantee on this one batch.
          }
        }

        for (const event of accepted) {
          this.store.addEvent(event);
        }

        // Rotate if the active file is getting big; checkpoint asynchronously.
        if (wal?.shouldRotate() && clientInfo?.projectName) {
          try {
            this.checkpointWal(clientInfo.projectName, wal);
          } catch (err) {
            console.error('[RuntimeScope] WAL checkpoint failed:', (err as Error).message);
          }
        }
        break;
      }
      case 'command_response': {
        const resp = msg as unknown as CommandResponse;
        const pending = this.pendingCommands.get(resp.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCommands.delete(resp.requestId);
          pending.resolve(resp.payload);
        }
        break;
      }
      case 'heartbeat':
        break;
    }
  }

  /** Find the WebSocket for a given sessionId */
  private findWsBySessionId(sessionId: string): WebSocket | undefined {
    for (const [ws, info] of this.clients) {
      if (info.sessionId === sessionId) return ws;
    }
    return undefined;
  }

  /** Get the first connected session ID (for single-app use) */
  getFirstSessionId(): string | undefined {
    for (const [, info] of this.clients) {
      return info.sessionId;
    }
    return undefined;
  }

  /** Get the project name for a session */
  getProjectForSession(sessionId: string): string | undefined {
    for (const [, info] of this.clients) {
      if (info.sessionId === sessionId) return info.projectName;
    }
    return undefined;
  }

  /** Get all connected session IDs with their project names */
  getConnectedSessions(): { sessionId: string; projectName: string; projectId?: string }[] {
    const sessions: { sessionId: string; projectName: string; projectId?: string }[] = [];
    for (const [, info] of this.clients) {
      sessions.push({ sessionId: info.sessionId, projectName: info.projectName, projectId: info.projectId });
    }
    return sessions;
  }

  /** Send a command to the SDK and await the response */
  sendCommand(
    sessionId: string,
    command: { command: string; requestId: string; params?: Record<string, unknown> },
    timeoutMs = 10_000
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = this.findWsBySessionId(sessionId);
      if (!ws || ws.readyState !== 1 /* OPEN */) {
        reject(new Error(`No active WebSocket for session ${sessionId}`));
        return;
      }

      const timer = setTimeout(() => {
        this.pendingCommands.delete(command.requestId);
        reject(new Error(`Command ${command.command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingCommands.set(command.requestId, { resolve, reject, timer });

      try {
        ws.send(JSON.stringify({
          type: 'command',
          payload: command,
          timestamp: Date.now(),
          sessionId,
        }));
      } catch (err) {
        clearTimeout(timer);
        this.pendingCommands.delete(command.requestId);
        reject(err);
      }
    });
  }

  stop(): void {
    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Stop rate limiter pruning
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    // Notify connected SDKs that the server is restarting — SDK resets backoff for fast reconnect
    if (this.wss) {
      for (const client of this.wss.clients) {
        if (client.readyState === 1 /* OPEN */) {
          try {
            client.send(JSON.stringify({
              type: '__server_restart',
              timestamp: Date.now(),
            }));
          } catch { /* best-effort */ }
        }
      }
    }

    // Drain the OTel exporter before closing storage so any in-flight signals
    // get one last flush attempt. Failures are non-fatal — we're stopping.
    if (this.otelExporter) {
      try {
        // Synchronous-ish fire-and-forget — the close() promise may still
        // resolve after stop() returns, but the timer is already cleared.
        void this.otelExporter.close();
      } catch { /* ignore */ }
      this.otelExporter = null;
    }

    // Close WALs before SqliteStores — one final fsync of any in-flight bytes
    // and a clean rename of the active handle so recovery on next start is a
    // no-op rather than a forced replay of the same events.
    for (const [name, wal] of this.wals) {
      try {
        wal.close();
      } catch {
        // Non-fatal during shutdown — the next start will recover.
        console.error(`[RuntimeScope] WAL close error for "${name}" (non-fatal)`);
      }
    }
    this.wals.clear();

    // Close all SQLite stores
    for (const [name, sqliteStore] of this.sqliteStores) {
      try {
        sqliteStore.close();
        console.error(`[RuntimeScope] SQLite store closed for "${name}"`);
      } catch {
        // Ignore close errors during shutdown
      }
    }
    this.sqliteStores.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
      console.error('[RuntimeScope] Collector stopped');
    }

    this.ready = false;
  }
}
