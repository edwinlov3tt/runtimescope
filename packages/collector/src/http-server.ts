import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import type { ProjectManager } from './project-manager.js';
import { getOrCreateProjectId, resolveProjectId } from './project-id.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventStore } from './store.js';
import type { ProcessMonitor } from './engines/process-monitor.js';
import type { RuntimeEvent, DevProcessType } from './types.js';
import { AuthManager } from './auth.js';
import type { SessionRateLimiter } from './rate-limiter.js';
import { loadTlsOptions, type TlsConfig } from './tls.js';
import type { PmStore } from './pm/pm-store.js';
import type { ProjectDiscovery } from './pm/project-discovery.js';
import { createPmRouter } from './pm/pm-routes.js';

// ============================================================
// HTTP API Server for Dashboard
// Lightweight REST API + WebSocket real-time event streaming
// Uses Node.js built-in http module (no framework deps)
// ============================================================

// Collector version — loaded from the package.json sibling to dist/.
// Used by /api/health so clients can detect out-of-date collectors.
const COLLECTOR_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/http-server.js lives in dist/; package.json is one level up
    const pkgJson = readFileSync(resolve(here, '..', 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgJson) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

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

/** Request augmented with the resolved caller — populated by the auth gate in handleRequest. */
export interface AuthedRequest extends IncomingMessage {
  _rsCaller?: { isAdmin: boolean; workspaceId: string | null };
}

export class HttpServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private store: EventStore;
  private processMonitor: ProcessMonitor | null;
  private authManager: AuthManager | null;
  private allowedOrigins: string[] | null;
  private rateLimiter: SessionRateLimiter | null;
  private dashboardClients: Set<WebSocket> = new Set();
  private eventListener: ((event: RuntimeEvent) => void) | null = null;
  private routes: Map<string, RouteHandler> = new Map();
  private pmRouter: ReturnType<typeof createPmRouter> | null = null;
  private sdkBundlePath: string | null = null;
  private activePort = 6768;
  private startedAt = Date.now();
  private connectedSessionsGetter: (() => { sessionId: string; projectName: string }[]) | null = null;
  private pmStore: PmStore | null = null;
  private projectManager: ProjectManager | null = null;

  private isReadyGetter: (() => boolean) | null = null;
  private snapshotFn: (() => { path: string; timestamp: string; projects: { name: string; sqliteBytes: number; walBytes: number; eventCount: number }[]; totalBytes: number }) | null = null;
  private lastSnapshotAt = 0;
  private renderMetricsFn: (() => string) | null = null;

  constructor(
    store: EventStore,
    processMonitor?: ProcessMonitor,
    options?: {
      authManager?: AuthManager;
      allowedOrigins?: string[];
      rateLimiter?: SessionRateLimiter;
      pmStore?: PmStore;
      discovery?: ProjectDiscovery;
      getConnectedSessions?: () => { sessionId: string; projectName: string }[];
      projectManager?: ProjectManager;
      /**
       * Returns true once the collector has finished startup recovery
       * (WAL replay + ring-buffer warm). Drives the `/readyz` probe — load
       * balancers and attach-mode detection should wait for ready before
       * routing traffic.
       */
      isReady?: () => boolean;
      /**
       * Called by `POST /api/v1/admin/snapshot`. Implementations should copy
       * every project's SQLite + WAL into a fresh directory and return a
       * manifest. Admin-only on the route side; rate-limited to prevent
       * snapshot loops.
       */
      createSnapshot?: () => {
        path: string;
        timestamp: string;
        projects: { name: string; sqliteBytes: number; walBytes: number; eventCount: number }[];
        totalBytes: number;
      };
      /**
       * Returns the Prometheus exposition body for `GET /metrics`. Public
       * (no auth) so a Prometheus scraper can hit it without configuring a
       * bearer token — that's the standard pattern. Opt out via the
       * `RUNTIMESCOPE_DISABLE_METRICS=1` env var.
       */
      renderMetrics?: () => string;
    }
  ) {
    this.store = store;
    this.processMonitor = processMonitor ?? null;
    this.authManager = options?.authManager ?? null;
    this.allowedOrigins = options?.allowedOrigins ?? null;
    this.rateLimiter = options?.rateLimiter ?? null;
    this.connectedSessionsGetter = options?.getConnectedSessions ?? null;
    this.pmStore = options?.pmStore ?? null;
    this.projectManager = options?.projectManager ?? null;
    this.isReadyGetter = options?.isReady ?? null;
    this.snapshotFn = options?.createSnapshot ?? null;
    this.renderMetricsFn = options?.renderMetrics ?? null;
    this.registerRoutes();

    // Register PM routes if PM store is available
    if (options?.pmStore && options?.discovery) {
      this.pmRouter = createPmRouter(options.pmStore, options.discovery, {
        json: (res, data, status) => this.json(res, data, status),
        readBody: (req, maxBytes) => this.readBody(req, maxBytes),
        resolveCaller: (req) =>
          (req as AuthedRequest)._rsCaller ?? { isAdmin: !this.authManager?.isEnabled(), workspaceId: null },
      }, (msg) => this.broadcastDevServer(msg));
    }
  }

  private registerRoutes(): void {
    // Liveness probe — process is alive and the HTTP layer is responding.
    // Always unauthenticated for load balancers and orchestrators.
    this.routes.set('GET /api/health', (_req, res) => {
      this.json(res, {
        status: 'ok',
        version: COLLECTOR_VERSION,
        timestamp: Date.now(),
        uptime: Math.floor((Date.now() - this.startedAt) / 1000),
        sessions: this.store.getSessionInfo().filter(s => s.isConnected).length,
        authEnabled: this.authManager?.isEnabled() ?? false,
      });
    });

    // Readiness probe — startup recovery (WAL replay + ring-buffer warm) is
    // complete and the collector is ready to serve queries. Distinct from
    // `/api/health` so orchestrators can avoid routing to a process that's
    // listening but still warming, and so MCP attach-mode detection only
    // returns "yes, attach" when a peer is fully serviceable.
    this.routes.set('GET /readyz', (_req, res) => {
      const ready = this.isReadyGetter ? this.isReadyGetter() : true;
      if (ready) {
        this.json(res, { status: 'ready', timestamp: Date.now() });
      } else {
        this.json(res, { status: 'starting', timestamp: Date.now() }, 503);
      }
    });

    // Prometheus metrics — text exposition format. Public (no auth) so a
    // standard Prometheus scrape config works out of the box. Opt out per
    // deployment via `RUNTIMESCOPE_DISABLE_METRICS=1` (e.g. on a sensitive
    // hosted collector that wants metrics behind a separate sidecar).
    this.routes.set('GET /metrics', (_req, res) => {
      if (process.env.RUNTIMESCOPE_DISABLE_METRICS === '1') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Metrics disabled (RUNTIMESCOPE_DISABLE_METRICS=1).\n');
        return;
      }
      const body = this.renderMetricsFn ? this.renderMetricsFn() : '';
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
    });

    // Snapshot endpoint: atomic SQLite VACUUM INTO + WAL copy for every
    // project, written into `<rootDir>/snapshots/<ISO>/`. Admin only — the
    // raw SQLite files include every event we've ever captured. Rate-limited
    // to one call per minute so a runaway loop can't fill the disk.
    this.routes.set('POST /api/v1/admin/snapshot', (req, res) => {
      if (!this.snapshotFn) {
        this.json(res, { error: 'Snapshot is not available on this collector' }, 501);
        return;
      }
      const caller = (req as AuthedRequest)._rsCaller ?? {
        isAdmin: !this.authManager?.isEnabled(),
        workspaceId: null,
      };
      if (!caller.isAdmin) {
        this.json(res, { error: 'Forbidden: snapshot requires admin' }, 403);
        return;
      }

      const now = Date.now();
      const sinceLast = now - this.lastSnapshotAt;
      const COOLDOWN_MS = 60_000;
      if (sinceLast < COOLDOWN_MS) {
        const retryAfter = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        this.json(
          res,
          { error: 'Snapshot rate-limited', retryAfterSeconds: retryAfter },
          429,
        );
        return;
      }
      this.lastSnapshotAt = now;

      try {
        const result = this.snapshotFn();
        this.json(res, result, 201);
      } catch (err) {
        this.json(res, { error: (err as Error).message }, 500);
      }
    });

    // Sessions
    this.routes.set('GET /api/sessions', (_req, res) => {
      const sessions = this.store.getSessionInfo();
      this.json(res, { data: sessions, count: sessions.length });
    });

    // Projects (sessions grouped by appName, merged with live WS clients)
    this.routes.set('GET /api/projects', (_req, res) => {
      const sessions = this.store.getSessionInfo();
      const projectMap = new Map<string, { appName: string; sessions: string[]; isConnected: boolean; eventCount: number; projectId?: string }>();

      for (const s of sessions) {
        const existing = projectMap.get(s.appName);
        if (existing) {
          existing.sessions.push(s.sessionId);
          existing.eventCount += s.eventCount;
          if (s.isConnected) existing.isConnected = true;
          if (!existing.projectId && s.projectId) existing.projectId = s.projectId;
        } else {
          projectMap.set(s.appName, {
            appName: s.appName,
            sessions: [s.sessionId],
            isConnected: s.isConnected,
            eventCount: s.eventCount,
            projectId: s.projectId,
          });
        }
      }

      // Merge live WebSocket clients (safety net — ensures connected SDKs always appear)
      if (this.connectedSessionsGetter) {
        for (const cs of this.connectedSessionsGetter()) {
          const existing = projectMap.get(cs.projectName);
          if (existing) {
            if (!existing.sessions.includes(cs.sessionId)) {
              existing.sessions.push(cs.sessionId);
            }
            existing.isConnected = true;
          } else {
            projectMap.set(cs.projectName, {
              appName: cs.projectName,
              sessions: [cs.sessionId],
              isConnected: true,
              eventCount: 0,
            });
          }
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

    // Kill a process by PID
    this.routes.set('DELETE /api/processes', async (req, res, params) => {
      if (!this.processMonitor) {
        this.json(res, { error: 'Process monitor not available' }, 500);
        return;
      }
      const pid = numParam(params, 'pid');
      if (!pid) {
        // Try reading from body
        const body = await this.readBody(req, 1024);
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed.pid) {
          this.json(res, { error: 'pid is required' }, 400);
          return;
        }
        const result = this.processMonitor.killProcess(parsed.pid, parsed.signal ?? 'SIGTERM');
        this.json(res, { data: result });
        return;
      }
      const signal = (params.get('signal') as 'SIGTERM' | 'SIGKILL') ?? 'SIGTERM';
      const result = this.processMonitor.killProcess(pid, signal);
      this.json(res, { data: result });
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
    this.routes.set('GET /api/events/network', (req, res, params) => {
      const projectId = this.authorizeProjectIdParam(req, res, params);
      if (projectId === false) return;
      const events = this.store.getNetworkRequests({
        sinceSeconds: numParam(params, 'since_seconds'),
        urlPattern: params.get('url_pattern') ?? undefined,
        method: params.get('method') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
        projectId,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Console events
    this.routes.set('GET /api/events/console', (req, res, params) => {
      const projectId = this.authorizeProjectIdParam(req, res, params);
      if (projectId === false) return;
      const events = this.store.getConsoleMessages({
        sinceSeconds: numParam(params, 'since_seconds'),
        level: params.get('level') ?? undefined,
        search: params.get('search') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
        projectId,
      });
      this.json(res, { data: events, count: events.length });
    });

    // State events
    this.routes.set('GET /api/events/state', (req, res, params) => {
      const projectId = this.authorizeProjectIdParam(req, res, params);
      if (projectId === false) return;
      const events = this.store.getStateEvents({
        sinceSeconds: numParam(params, 'since_seconds'),
        storeId: params.get('store_id') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
        projectId,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Render events
    this.routes.set('GET /api/events/renders', (req, res, params) => {
      const projectId = this.authorizeProjectIdParam(req, res, params);
      if (projectId === false) return;
      const events = this.store.getRenderEvents({
        sinceSeconds: numParam(params, 'since_seconds'),
        componentName: params.get('component') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
        projectId,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Performance events
    this.routes.set('GET /api/events/performance', (req, res, params) => {
      const projectId = this.authorizeProjectIdParam(req, res, params);
      if (projectId === false) return;
      const events = this.store.getPerformanceMetrics({
        sinceSeconds: numParam(params, 'since_seconds'),
        metricName: params.get('metric') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
        projectId,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Database events
    this.routes.set('GET /api/events/database', (req, res, params) => {
      const projectId = this.authorizeProjectIdParam(req, res, params);
      if (projectId === false) return;
      const events = this.store.getDatabaseEvents({
        sinceSeconds: numParam(params, 'since_seconds'),
        table: params.get('table') ?? undefined,
        minDurationMs: numParam(params, 'min_duration_ms'),
        search: params.get('search') ?? undefined,
        sessionId: params.get('session_id') ?? undefined,
        projectId,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Timeline
    this.routes.set('GET /api/events/timeline', (req, res, params) => {
      const projectId = this.authorizeProjectIdParam(req, res, params);
      if (projectId === false) return;
      const eventTypes = params.get('event_types')?.split(',') ?? undefined;
      const events = this.store.getEventTimeline({
        sinceSeconds: numParam(params, 'since_seconds'),
        eventTypes: eventTypes as RuntimeEvent['eventType'][] | undefined,
        sessionId: params.get('session_id') ?? undefined,
        projectId,
      });
      this.json(res, { data: events, count: events.length });
    });

    this.routes.set('GET /api/events/custom', (req, res, params) => {
      const projectId = this.authorizeProjectIdParam(req, res, params);
      if (projectId === false) return;
      const events = this.store.getCustomEvents({
        name: params.get('name') ?? undefined,
        sinceSeconds: numParam(params, 'since_seconds'),
        sessionId: params.get('session_id') ?? undefined,
        projectId,
      });
      this.json(res, { data: events, count: events.length });
    });

    // UI interaction events (clicks, breadcrumbs)
    this.routes.set('GET /api/events/ui', (req, res, params) => {
      const projectId = this.authorizeProjectIdParam(req, res, params);
      if (projectId === false) return;
      const action = params.get('action') as 'click' | 'breadcrumb' | undefined;
      const events = this.store.getUIInteractions({
        action: action ?? undefined,
        sinceSeconds: numParam(params, 'since_seconds'),
        sessionId: params.get('session_id') ?? undefined,
        projectId,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Clear events
    this.routes.set('DELETE /api/events', (_req, res) => {
      const result = this.store.clear();
      this.json(res, result);
    });

    // POST event ingestion — HTTP alternative to WebSocket for serverless environments
    this.routes.set('POST /api/events', async (req, res) => {
      const body = await this.readBody(req, 1_048_576); // 1MB limit
      if (!body) {
        this.json(res, { error: 'Request body required', code: 'EMPTY_BODY' }, 400);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        this.json(res, { error: 'Invalid JSON', code: 'PARSE_ERROR' }, 400);
        return;
      }

      const payload = parsed as {
        sessionId?: string;
        appName?: string;
        sdkVersion?: string;
        projectId?: string;
        events?: unknown[];
      };

      // Auto-generate projectId if SDK didn't send one (backwards compat)
      const projectId = typeof payload.projectId === 'string'
        ? payload.projectId
        : (payload.appName && this.projectManager
          ? resolveProjectId(this.projectManager, payload.appName, this.pmStore)
          : undefined);

      if (!payload.sessionId || !Array.isArray(payload.events) || payload.events.length === 0) {
        this.json(res, {
          error: 'Required: sessionId (string), events (non-empty array)',
          code: 'INVALID_PAYLOAD',
        }, 400);
        return;
      }

      // Auto-register session on first event from this sessionId
      const sessions = this.store.getSessionInfo();
      const knownSession = sessions.find(s => s.sessionId === payload.sessionId);
      if (!knownSession && payload.appName) {
        this.store.addEvent({
          eventId: `session-${payload.sessionId}`,
          sessionId: payload.sessionId,
          timestamp: Date.now(),
          eventType: 'session',
          appName: payload.appName,
          projectId,
          connectedAt: Date.now(),
          sdkVersion: payload.sdkVersion ?? 'http',
        } as RuntimeEvent);

        // Auto-link SDK appName to PM project
        if (this.pmStore) {
          try { this.pmStore.autoLinkApp(payload.appName, projectId); } catch { /* non-fatal */ }
        }

        // If the request came with a workspace-scoped bearer token, assign
        // this project to that workspace (unless it's already in one).
        if (this.pmStore) {
          try {
            const token = AuthManager.extractBearer(req.headers.authorization);
            if (token) {
              const ws = this.pmStore.getWorkspaceByApiKey(token);
              if (ws && projectId) {
                const existing = this.pmStore
                  .listProjects()
                  .find((p) => p.runtimeProjectId === projectId);
                if (existing && !existing.workspaceId) {
                  this.pmStore.setProjectWorkspace(existing.id, ws.id);
                }
              }
            }
          } catch { /* non-fatal */ }
        }
      }

      const VALID_EVENT_TYPES = new Set([
        'network', 'console', 'session', 'state', 'render',
        'dom_snapshot', 'performance', 'database',
        'custom', 'navigation', 'ui',
        'recon_metadata', 'recon_design_tokens', 'recon_fonts',
        'recon_layout_tree', 'recon_accessibility', 'recon_computed_styles',
        'recon_element_snapshot', 'recon_asset_inventory',
      ]);

      let accepted = 0;
      let dropped = 0;
      let rejected = 0;

      for (const raw of payload.events) {
        const event = raw as RuntimeEvent;

        // Validate event shape
        if (!event.eventType || !VALID_EVENT_TYPES.has(event.eventType)) {
          rejected++;
          continue;
        }

        if (!event.eventId) event.eventId = `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (!event.sessionId) event.sessionId = payload.sessionId!;
        if (!event.timestamp) event.timestamp = Date.now();

        if (this.rateLimiter && !this.rateLimiter.allow(payload.sessionId!)) {
          dropped++;
          continue;
        }

        this.store.addEvent(event);
        accepted++;
      }

      this.json(res, { accepted, dropped, rejected, sessionId: payload.sessionId }, accepted > 0 ? 200 : 429);
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

  getPort(): number {
    return this.activePort;
  }

  /**
   * Validate the `project_id` query parameter against the caller's workspace.
   *
   * Returns:
   *   - `string`  — the caller is authorized; pass to store.
   *   - `undefined` — caller is admin and didn't specify a project_id (all projects allowed).
   *   - `false`   — not authorized (a 400 or 403 response has already been written); the handler must return immediately.
   *
   * Callers with a workspace-scoped token MUST provide `project_id`, and it
   * must resolve to a PM project in the caller's workspace. Runtime projectIds
   * without a PM record (never registered via setup_project) fall through to
   * admin-only; workspace-scoped callers get 403.
   */
  private authorizeProjectIdParam(
    req: IncomingMessage,
    res: ServerResponse,
    params: URLSearchParams,
  ): string | undefined | false {
    const caller = (req as AuthedRequest)._rsCaller ?? {
      isAdmin: !this.authManager?.isEnabled(),
      workspaceId: null,
    };
    const projectId = params.get('project_id') ?? undefined;

    if (caller.isAdmin) return projectId;

    if (!projectId) {
      this.json(
        res,
        { error: 'project_id query param is required for workspace-scoped callers' },
        400,
      );
      return false;
    }

    const projectWorkspaceId = this.pmStore?.getWorkspaceIdByRuntimeProjectId(projectId) ?? null;
    if (!projectWorkspaceId) {
      this.json(res, { error: 'Forbidden: project is not registered with any workspace' }, 403);
      return false;
    }
    if (projectWorkspaceId !== caller.workspaceId) {
      this.json(res, { error: 'Forbidden: project belongs to a different workspace' }, 403);
      return false;
    }
    return projectId;
  }

  async start(options: HttpServerOptions = {}): Promise<void> {
    const basePort = options.port ?? parseInt(process.env.RUNTIMESCOPE_HTTP_PORT ?? '6768', 10);
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
      this.wss.on('connection', (ws, req) => {
        // Authenticate WebSocket upgrade requests when auth is enabled
        if (this.authManager?.isEnabled()) {
          const wsUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const token = wsUrl.searchParams.get('token')
            ?? AuthManager.extractBearer(req.headers.authorization);
          if (!this.authManager.isAuthorized(token)) {
            ws.close(4001, 'Authentication required');
            return;
          }
        }
        this.dashboardClients.add(ws);
        ws.on('close', () => this.dashboardClients.delete(ws));
        ws.on('error', () => this.dashboardClients.delete(ws));
      });

      // Subscribe to EventStore for real-time broadcasting
      this.eventListener = (event: RuntimeEvent) => this.broadcastEvent(event);
      this.store.onEvent(this.eventListener);

      server.on('listening', () => {
        this.server = server;
        // Use the actual bound port — `port` may be 0 (random), in which case
        // the OS picked one and `port` itself is meaningless.
        const addr = server.address();
        const boundPort =
          addr && typeof addr === 'object' && typeof addr.port === 'number'
            ? addr.port
            : port;
        this.activePort = boundPort;
        this.startedAt = Date.now();
        const proto = tls ? 'https' : 'http';
        console.error(`[RuntimeScope] HTTP API listening on ${proto}://${host}:${boundPort}`);
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

  broadcastSessionChange(type: 'session_connected' | 'session_disconnected', sessionId: string, appName: string): void {
    if (this.dashboardClients.size === 0) return;
    const message = JSON.stringify({ type, sessionId, appName });
    for (const ws of this.dashboardClients) {
      if (ws.readyState === 1) {
        try { ws.send(message); } catch { this.dashboardClients.delete(ws); }
      }
    }
  }

  private broadcastDevServer(msg: unknown): void {
    if (this.dashboardClients.size === 0) return;

    const message = JSON.stringify(msg);
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

    // Auth check — skip for liveness/readiness probes, Prometheus scrape, and
    // static assets so orchestrators and load balancers don't need credentials
    // to monitor us.
    const isPublic = url.pathname === '/api/health'
      || url.pathname === '/readyz'
      || url.pathname === '/metrics'
      || url.pathname === '/runtimescope.js'
      || url.pathname === '/snippet';

    // Resolve caller identity:
    //   isAdmin    → global AuthManager token, OR auth disabled (local trust mode)
    //   workspaceId → set when a workspace-scoped token (tk_*) authenticated this request
    //   unauthenticated → auth is enabled but no valid token matched → 401
    //
    // Auth is also considered "enabled" if any non-revoked workspace API keys
    // exist. Otherwise the user creates a workspace key expecting it to gate
    // access, but AuthManager.isEnabled() reports false (no global keys) and
    // every request goes through unauthenticated — the H5 bypass.
    const workspaceKeysExist = !!this.pmStore?.hasActiveApiKeys?.();
    const authActive = !!this.authManager?.isEnabled() || workspaceKeysExist;

    const caller: { isAdmin: boolean; workspaceId: string | null } = {
      isAdmin: !authActive,
      workspaceId: null,
    };

    if (!isPublic && authActive) {
      const token = AuthManager.extractBearer(req.headers.authorization);
      // Use `validate()` rather than `isAuthorized()` — the latter returns
      // true when AuthManager is disabled (its "auth off, everything passes"
      // semantics), which would falsely classify a workspace token as a
      // global admin token whenever no global keys are configured. We only
      // want isGlobal=true when there's a real entry in AuthManager's set.
      const isGlobal = !!(token && this.authManager?.validate(token));
      const workspace = token ? this.pmStore?.getWorkspaceByApiKey(token) : null;
      if (!isGlobal && !workspace) {
        this.json(res, { error: 'Unauthorized', code: 'AUTH_FAILED' }, 401);
        return;
      }
      caller.isAdmin = isGlobal;
      caller.workspaceId = workspace?.id ?? null;
    }
    (req as AuthedRequest)._rsCaller = caller;

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
      const appName = (url.searchParams.get('app') || 'my-app').replace(/[^a-zA-Z0-9_-]/g, '');
      const projectId = url.searchParams.get('project_id') || 'proj_xxx';
      const dsn = `runtimescope://${projectId}@localhost:${this.activePort}/${appName}`;
      const snippet = `<!-- RuntimeScope SDK — paste before </body> -->
<script src="http://localhost:${this.activePort}/runtimescope.js"></script>
<script>
  RuntimeScope.init({ dsn: '${dsn}' });
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
      return;
    }

    // Try PM pattern routes (e.g. /api/pm/projects/:id)
    if (this.pmRouter && url.pathname.startsWith('/api/pm/')) {
      const match = this.pmRouter.match(req.method!, url.pathname);
      if (match) {
        // Merge path params into search params
        for (const [k, v] of Object.entries(match.pathParams)) {
          url.searchParams.set(k, v);
        }
        try {
          const result = match.handler(req, res, url.searchParams);
          if (result instanceof Promise) {
            result.catch((err) => {
              this.json(res, { error: (err as Error).message }, 500);
            });
          }
        } catch (err) {
          this.json(res, { error: (err as Error).message }, 500);
        }
        return;
      }
    }

    this.json(res, { error: 'Not found', path: url.pathname }, 404);
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

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  private readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let resolved = false;

      const done = (result: string | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(result);
      };

      // 30s timeout to prevent slow-read DoS
      const timer = setTimeout(() => {
        req.destroy();
        done(null);
      }, 30_000);

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          done(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (size === 0) { done(null); return; }
        done(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', () => done(null));
    });
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
