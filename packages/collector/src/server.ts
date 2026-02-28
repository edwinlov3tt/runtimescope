import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { EventStore } from './store.js';
import { ProjectManager } from './project-manager.js';
import { SqliteStore } from './sqlite-store.js';
import { AuthManager } from './auth.js';
import { SessionRateLimiter, type RateLimitConfig } from './rate-limiter.js';
import { loadTlsOptions, type TlsConfig } from './tls.js';
import type {
  WSMessage,
  HandshakePayload,
  EventBatchPayload,
  CommandResponse,
  SessionInfoExtended,
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
}

interface ClientInfo {
  sessionId: string;
  projectName: string;
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
  private disconnectCallbacks: ((sessionId: string, projectName: string) => void)[] = [];
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private tlsConfig: TlsConfig | null = null;

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

  onDisconnect(cb: (sessionId: string, projectName: string) => void): void {
    this.disconnectCallbacks.push(cb);
  }

  start(options: CollectorServerOptions = {}): Promise<void> {
    const port = options.port ?? 9090;
    const host = options.host ?? '127.0.0.1';
    const maxRetries = options.maxRetries ?? 5;
    const retryDelayMs = options.retryDelayMs ?? 1000;
    const tls = options.tls ?? this.tlsConfig;

    return this.tryStart(port, host, maxRetries, retryDelayMs, tls);
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
      console.error(
        `[RuntimeScope] Port ${port} in use, retrying in ${retryDelayMs}ms (${retriesLeft} attempts left)...`
      );
      setTimeout(() => {
        this.tryStart(port, host, retriesLeft - 1, retryDelayMs, tls)
          .then(resolve)
          .catch(reject);
      }, retryDelayMs);
    } else {
      console.error('[RuntimeScope] WebSocket server error:', err.message);
      reject(err);
    }
  }

  private ensureSqliteStore(projectName: string): SqliteStore | null {
    if (!this.projectManager) return null;

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

  private setupConnectionHandler(wss: WebSocketServer): void {
    wss.on('connection', (ws) => {
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

      ws.on('close', () => {
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
              cb(clientInfo.sessionId, clientInfo.projectName);
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

        // Authenticate if auth is enabled
        if (this.authManager?.isEnabled()) {
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
          this.pendingHandshakes.delete(ws);
        }

        const projectName = payload.appName;

        this.clients.set(ws, {
          sessionId: payload.sessionId,
          projectName,
        });

        // Initialize SQLite for this project
        const sqliteStore = this.ensureSqliteStore(projectName);

        // Save session info to SQLite
        if (sqliteStore) {
          const sessionInfo: SessionInfoExtended = {
            sessionId: payload.sessionId,
            project: projectName,
            appName: payload.appName,
            connectedAt: msg.timestamp,
            sdkVersion: payload.sdkVersion,
            eventCount: 0,
            isConnected: true,
          };
          sqliteStore.saveSession(sessionInfo);
        }

        console.error(
          `[RuntimeScope] Session ${payload.sessionId} connected (${payload.appName} v${payload.sdkVersion})`
        );
        break;
      }
      case 'event': {
        // Reject events from unauthenticated connections
        if (this.pendingHandshakes.has(ws)) return;

        const clientInfo = this.clients.get(ws);
        const payload = msg.payload as EventBatchPayload;
        if (Array.isArray(payload.events)) {
          for (const event of payload.events) {
            // Rate limit per session
            if (clientInfo && !this.rateLimiter.allow(clientInfo.sessionId)) {
              break; // drop remaining events in this batch
            }
            this.store.addEvent(event);
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
    // Stop rate limiter pruning
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

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
  }
}
