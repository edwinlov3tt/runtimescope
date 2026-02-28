import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventStore } from './store.js';
import type { ProcessMonitor } from './engines/process-monitor.js';
import type { RuntimeEvent, DevProcessType } from './types.js';
import { AuthManager } from './auth.js';
import { loadTlsOptions, type TlsConfig } from './tls.js';

// ============================================================
// HTTP API Server for Dashboard
// Lightweight REST API + WebSocket real-time event streaming
// Uses Node.js built-in http module (no framework deps)
// ============================================================

export interface HttpServerOptions {
  port?: number;
  host?: string;
  authManager?: AuthManager;
  allowedOrigins?: string[];
  tls?: TlsConfig;
}

interface RouteHandler {
  (req: IncomingMessage, res: ServerResponse, params: URLSearchParams): void | Promise<void>;
}

export class HttpServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private store: EventStore;
  private processMonitor: ProcessMonitor | null;
  private authManager: AuthManager | null;
  private allowedOrigins: string[] | null;
  private dashboardClients: Set<WebSocket> = new Set();
  private eventListener: ((event: RuntimeEvent) => void) | null = null;
  private routes: Map<string, RouteHandler> = new Map();
  private sdkBundlePath: string | null = null;
  private activePort = 9091;
  private startedAt = Date.now();

  constructor(
    store: EventStore,
    processMonitor?: ProcessMonitor,
    options?: { authManager?: AuthManager; allowedOrigins?: string[] }
  ) {
    this.store = store;
    this.processMonitor = processMonitor ?? null;
    this.authManager = options?.authManager ?? null;
    this.allowedOrigins = options?.allowedOrigins ?? null;
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Health check — always unauthenticated for load balancer probes
    this.routes.set('GET /api/health', (_req, res) => {
      this.json(res, {
        status: 'ok',
        timestamp: Date.now(),
        uptime: Math.floor((Date.now() - this.startedAt) / 1000),
        sessions: this.store.getSessionInfo().filter(s => s.isConnected).length,
        authEnabled: this.authManager?.isEnabled() ?? false,
      });
    });

    // Sessions
    this.routes.set('GET /api/sessions', (_req, res) => {
      const sessions = this.store.getSessionInfo();
      this.json(res, { data: sessions, count: sessions.length });
    });

    // Projects (sessions grouped by appName)
    this.routes.set('GET /api/projects', (_req, res) => {
      const sessions = this.store.getSessionInfo();
      const projectMap = new Map<string, { appName: string; sessions: string[]; isConnected: boolean; eventCount: number }>();

      for (const s of sessions) {
        const existing = projectMap.get(s.appName);
        if (existing) {
          existing.sessions.push(s.sessionId);
          existing.eventCount += s.eventCount;
          if (s.isConnected) existing.isConnected = true;
        } else {
          projectMap.set(s.appName, {
            appName: s.appName,
            sessions: [s.sessionId],
            isConnected: s.isConnected,
            eventCount: s.eventCount,
          });
        }
      }

      const projects = Array.from(projectMap.values());
      this.json(res, { data: projects, count: projects.length });
    });

    // Processes (served from background scan cache — no blocking lsof calls)
    this.routes.set('GET /api/processes', (_req, res, params) => {
      if (!this.processMonitor) {
        this.json(res, { data: [], count: 0 });
        return;
      }
      const type = params.get('type') as DevProcessType | undefined ?? undefined;
      const project = params.get('project') ?? undefined;
      const processes = this.processMonitor.getProcesses({ type, project });
      this.json(res, { data: processes, count: processes.length });
    });

    // Port usage (served from background scan cache)
    this.routes.set('GET /api/ports', (_req, res, params) => {
      if (!this.processMonitor) {
        this.json(res, { data: [], count: 0 });
        return;
      }
      const port = numParam(params, 'port');
      const ports = this.processMonitor.getPortUsage(port);
      this.json(res, { data: ports, count: ports.length });
    });

    // Network events
    this.routes.set('GET /api/events/network', (_req, res, params) => {
      const events = this.store.getNetworkRequests({
        sinceSeconds: numParam(params, 'since_seconds'),
        urlPattern: params.get('url_pattern') ?? undefined,
        method: params.get('method') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Console events
    this.routes.set('GET /api/events/console', (_req, res, params) => {
      const events = this.store.getConsoleMessages({
        sinceSeconds: numParam(params, 'since_seconds'),
        level: params.get('level') ?? undefined,
        search: params.get('search') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // State events
    this.routes.set('GET /api/events/state', (_req, res, params) => {
      const events = this.store.getStateEvents({
        sinceSeconds: numParam(params, 'since_seconds'),
        storeId: params.get('store_id') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Render events
    this.routes.set('GET /api/events/renders', (_req, res, params) => {
      const events = this.store.getRenderEvents({
        sinceSeconds: numParam(params, 'since_seconds'),
        componentName: params.get('component') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Performance events
    this.routes.set('GET /api/events/performance', (_req, res, params) => {
      const events = this.store.getPerformanceMetrics({
        sinceSeconds: numParam(params, 'since_seconds'),
        metricName: params.get('metric') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Database events
    this.routes.set('GET /api/events/database', (_req, res, params) => {
      const events = this.store.getDatabaseEvents({
        sinceSeconds: numParam(params, 'since_seconds'),
        table: params.get('table') ?? undefined,
        minDurationMs: numParam(params, 'min_duration_ms'),
        search: params.get('search') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Timeline
    this.routes.set('GET /api/events/timeline', (_req, res, params) => {
      const eventTypes = params.get('event_types')?.split(',') ?? undefined;
      const events = this.store.getEventTimeline({
        sinceSeconds: numParam(params, 'since_seconds'),
        eventTypes: eventTypes as RuntimeEvent['eventType'][] | undefined,
        sessionId: params.get('session_id') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Clear events
    this.routes.set('DELETE /api/events', (_req, res) => {
      const result = this.store.clear();
      this.json(res, result);
    });
  }

  /**
   * Resolve the SDK IIFE bundle path.
   * Tries multiple locations for monorepo and installed-package scenarios.
   */
  private resolveSdkPath(): string | null {
    if (this.sdkBundlePath) return this.sdkBundlePath;

    const __dir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(__dir, '../../sdk/dist/index.global.js'),          // monorepo: packages/collector/dist -> packages/sdk/dist
      resolve(__dir, '../../../node_modules/@runtimescope/sdk/dist/index.global.js'),  // npm installed
    ];

    for (const p of candidates) {
      if (existsSync(p)) {
        this.sdkBundlePath = p;
        return p;
      }
    }
    return null;
  }

  async start(options: HttpServerOptions = {}): Promise<void> {
    const basePort = options.port ?? parseInt(process.env.RUNTIMESCOPE_HTTP_PORT ?? '9091', 10);
    const host = options.host ?? '127.0.0.1';
    const tls = options.tls;
    const maxRetries = 5;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const port = basePort + attempt;
      try {
        await this.tryStart(port, host, tls);
        return;
      } catch (err) {
        const isAddrInUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
        if (isAddrInUse && attempt < maxRetries) {
          console.error(`[RuntimeScope] HTTP port ${port} in use, trying ${port + 1}...`);
          continue;
        }
        throw err;
      }
    }
  }

  private tryStart(port: number, host: string, tls?: TlsConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (req: IncomingMessage, res: ServerResponse) => this.handleRequest(req, res);
      const server = tls
        ? createHttpsServer(loadTlsOptions(tls), handler)
        : createServer(handler);

      // Set up WebSocket server for real-time event streaming
      this.wss = new WebSocketServer({ server, path: '/api/ws/events' });
      this.wss.on('connection', (ws) => {
        this.dashboardClients.add(ws);
        ws.on('close', () => this.dashboardClients.delete(ws));
        ws.on('error', () => this.dashboardClients.delete(ws));
      });

      // Subscribe to EventStore for real-time broadcasting
      this.eventListener = (event: RuntimeEvent) => this.broadcastEvent(event);
      this.store.onEvent(this.eventListener);

      server.on('listening', () => {
        this.server = server;
        this.activePort = port;
        this.startedAt = Date.now();
        const proto = tls ? 'https' : 'http';
        console.error(`[RuntimeScope] HTTP API listening on ${proto}://${host}:${port}`);
        resolve();
      });

      server.on('error', (err) => {
        // Clean up the WebSocket server on failure
        this.wss?.close();
        this.wss = null;
        if (this.eventListener) {
          this.store.removeEventListener(this.eventListener);
          this.eventListener = null;
        }
        reject(err);
      });

      server.listen(port, host);
    });
  }

  async stop(): Promise<void> {
    if (this.eventListener) {
      this.store.removeEventListener(this.eventListener);
      this.eventListener = null;
    }

    for (const ws of this.dashboardClients) {
      ws.close();
    }
    this.dashboardClients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;
          console.error('[RuntimeScope] HTTP API stopped');
          resolve();
        });
      });
    }
  }

  broadcastEvent(event: RuntimeEvent): void {
    if (this.dashboardClients.size === 0) return;

    const message = JSON.stringify({ type: 'event', data: event });
    for (const ws of this.dashboardClients) {
      if (ws.readyState === 1 /* OPEN */) {
        try {
          ws.send(message);
        } catch {
          this.dashboardClients.delete(ws);
        }
      }
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // CORS headers — use specific origin when configured, wildcard for dev
    this.setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check — skip for health endpoint and static assets
    const isPublic = url.pathname === '/api/health'
      || url.pathname === '/runtimescope.js'
      || url.pathname === '/snippet';

    if (!isPublic && this.authManager?.isEnabled()) {
      const token = AuthManager.extractBearer(req.headers.authorization);
      if (!this.authManager.isAuthorized(token)) {
        this.json(res, { error: 'Unauthorized', code: 'AUTH_FAILED' }, 401);
        return;
      }
    }

    // Serve SDK IIFE bundle — works in any HTML page via <script> tag
    if (req.method === 'GET' && url.pathname === '/runtimescope.js') {
      const sdkPath = this.resolveSdkPath();
      if (sdkPath) {
        const bundle = readFileSync(sdkPath, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'no-cache',
        });
        res.end(bundle);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('SDK bundle not found. Run: npm run build -w packages/sdk');
      }
      return;
    }

    // Serve a ready-to-paste snippet for any tech stack
    if (req.method === 'GET' && url.pathname === '/snippet') {
      const appName = url.searchParams.get('app') || 'my-app';
      const wsPort = process.env.RUNTIMESCOPE_PORT ?? '9090';
      const snippet = `<!-- RuntimeScope SDK — paste before </body> -->
<script src="http://localhost:${this.activePort}/runtimescope.js"></script>
<script>
  RuntimeScope.init({
    appName: '${appName}',
    endpoint: 'ws://localhost:${wsPort}',
  });
</script>`;
      res.writeHead(200, {
        'Content-Type': 'text/plain',
      });
      res.end(snippet);
      return;
    }

    const routeKey = `${req.method} ${url.pathname}`;
    const handler = this.routes.get(routeKey);

    if (handler) {
      try {
        const result = handler(req, res, url.searchParams);
        if (result instanceof Promise) {
          result.catch((err) => {
            this.json(res, { error: (err as Error).message }, 500);
          });
        }
      } catch (err) {
        this.json(res, { error: (err as Error).message }, 500);
      }
    } else {
      this.json(res, { error: 'Not found', path: url.pathname }, 404);
    }
  }

  private setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;

    if (this.allowedOrigins && this.allowedOrigins.length > 0) {
      // Whitelist mode: only allow configured origins
      if (origin && this.allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      // If origin not in whitelist, omit the header (browser blocks the request)
    } else {
      // Default: wildcard for backward compat in local dev
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

function numParam(params: URLSearchParams, key: string): number | undefined {
  const val = params.get(key);
  if (!val) return undefined;
  const num = parseInt(val, 10);
  return isNaN(num) ? undefined : num;
}
