import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventStore } from './store.js';
import type { RuntimeEvent } from './types.js';

// ============================================================
// HTTP API Server for Dashboard
// Lightweight REST API + WebSocket real-time event streaming
// Uses Node.js built-in http module (no framework deps)
// ============================================================

export interface HttpServerOptions {
  port?: number;
  host?: string;
}

interface RouteHandler {
  (req: IncomingMessage, res: ServerResponse, params: URLSearchParams): void | Promise<void>;
}

export class HttpServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private store: EventStore;
  private dashboardClients: Set<WebSocket> = new Set();
  private eventListener: ((event: RuntimeEvent) => void) | null = null;
  private routes: Map<string, RouteHandler> = new Map();

  constructor(store: EventStore) {
    this.store = store;
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Health check
    this.routes.set('GET /api/health', (_req, res) => {
      this.json(res, { status: 'ok', timestamp: Date.now() });
    });

    // Sessions
    this.routes.set('GET /api/sessions', (_req, res) => {
      const sessions = this.store.getSessionInfo();
      this.json(res, { data: sessions, count: sessions.length });
    });

    // Network events
    this.routes.set('GET /api/events/network', (_req, res, params) => {
      const events = this.store.getNetworkRequests({
        sinceSeconds: numParam(params, 'since_seconds'),
        urlPattern: params.get('url_pattern') ?? undefined,
        method: params.get('method') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Console events
    this.routes.set('GET /api/events/console', (_req, res, params) => {
      const events = this.store.getConsoleMessages({
        sinceSeconds: numParam(params, 'since_seconds'),
        level: params.get('level') ?? undefined,
        search: params.get('search') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // State events
    this.routes.set('GET /api/events/state', (_req, res, params) => {
      const events = this.store.getStateEvents({
        sinceSeconds: numParam(params, 'since_seconds'),
        storeId: params.get('store_id') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Render events
    this.routes.set('GET /api/events/renders', (_req, res, params) => {
      const events = this.store.getRenderEvents({
        sinceSeconds: numParam(params, 'since_seconds'),
        componentName: params.get('component') ?? undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Performance events
    this.routes.set('GET /api/events/performance', (_req, res, params) => {
      const events = this.store.getPerformanceMetrics({
        sinceSeconds: numParam(params, 'since_seconds'),
        metricName: params.get('metric') ?? undefined,
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
      });
      this.json(res, { data: events, count: events.length });
    });

    // Timeline
    this.routes.set('GET /api/events/timeline', (_req, res, params) => {
      const eventTypes = params.get('event_types')?.split(',') ?? undefined;
      const events = this.store.getEventTimeline({
        sinceSeconds: numParam(params, 'since_seconds'),
        eventTypes: eventTypes as RuntimeEvent['eventType'][] | undefined,
      });
      this.json(res, { data: events, count: events.length });
    });

    // Clear events
    this.routes.set('DELETE /api/events', (_req, res) => {
      const result = this.store.clear();
      this.json(res, result);
    });
  }

  async start(options: HttpServerOptions = {}): Promise<void> {
    const port = options.port ?? parseInt(process.env.RUNTIMESCOPE_HTTP_PORT ?? '9091', 10);
    const host = options.host ?? '127.0.0.1';

    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));

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
        console.error(`[RuntimeScope] HTTP API listening on http://${host}:${port}`);
        resolve();
      });

      server.on('error', (err) => {
        console.error('[RuntimeScope] HTTP server error:', err.message);
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
    // CORS headers for localhost
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
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
