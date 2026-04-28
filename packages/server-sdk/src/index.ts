import { ServerTransport } from './transport.js';
import { HttpTransport } from './http-transport.js';
import { generateId, generateSessionId } from './utils/id.js';
import { parseOperation, parseTablesAccessed, normalizeQuery, redactParams } from './utils/sql-parser.js';
import { captureStack } from './utils/stack.js';
import { Sampler } from './sampler.js';
import { instrumentPrisma } from './integrations/prisma.js';
import { instrumentPg } from './integrations/pg.js';
import { instrumentKnex } from './integrations/knex.js';
import { instrumentDrizzle } from './integrations/drizzle.js';
import { instrumentMysql2 } from './integrations/mysql2.js';
import { instrumentBetterSqlite3 } from './integrations/better-sqlite3.js';
import { interceptConsole } from './interceptors/console.js';
import { interceptErrors } from './interceptors/errors.js';
import { interceptHttp } from './interceptors/http.js';
import { startPerfMetrics } from './interceptors/perf-metrics.js';
import { runtimeScopeMiddleware } from './interceptors/middleware.js';
import { parseDsn } from './dsn.js';
import type { DatabaseEvent, ServerSdkConfig, ServerRuntimeEvent } from './types.js';
import type { MiddlewareOptions } from './interceptors/middleware.js';

// ============================================================
// RuntimeScope Server SDK
// Instruments server-side database queries, console output,
// errors, HTTP requests, and performance metrics — sends them
// to the RuntimeScope collector via WebSocket
// ============================================================

const SDK_VERSION = '0.10.3';

// Re-export _log for integration modules (lives in utils/log.js to avoid circular deps)
export { _log } from './utils/log.js';

class RuntimeScopeServer {
  private transport: ServerTransport | null = null;
  private httpTransport: HttpTransport | null = null;
  private sessionId: string = '';
  private config: ServerSdkConfig = {};
  private sampler: Sampler | null = null;
  private restoreFunctions: (() => void)[] = [];

  /** Alias for `connect` — mirrors the browser SDK's init() API */
  init(config: ServerSdkConfig = {}): void {
    return this.connect(config);
  }

  connect(config: ServerSdkConfig = {}): void {
    // DSN resolution: env var → explicit config → individual fields
    const dsnString = config.dsn ?? (typeof process !== 'undefined' ? process.env.RUNTIMESCOPE_DSN : undefined);
    if (dsnString) {
      try {
        const parsed = parseDsn(dsnString);
        config = {
          ...config,
          serverUrl: parsed.wsEndpoint,
          projectId: parsed.projectId,
          httpEndpoint: parsed.httpEndpoint + '/api/events',
          ...(parsed.authToken ? { authToken: parsed.authToken } : {}),
          ...(parsed.appName && !config.appName ? { appName: parsed.appName } : {}),
        };
      } catch {
        // Invalid DSN — continue with individual fields
      }
    }

    // Auto-read .runtimescope/config.json for projectId and appName if not explicitly set
    if (!config.projectId || !config.appName) {
      try {
        const { readFileSync, existsSync } = require('node:fs');
        const { join } = require('node:path');
        const configPath = join(process.cwd(), '.runtimescope', 'config.json');
        if (existsSync(configPath)) {
          const projectConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (!config.projectId && projectConfig.projectId) config.projectId = projectConfig.projectId;
          if (!config.appName && projectConfig.appName) config.appName = projectConfig.appName;
          // Auto-apply capture settings from config
          if (projectConfig.capture) {
            const c = projectConfig.capture;
            if (config.captureConsole === undefined && c.console !== undefined) config.captureConsole = c.console;
            if (config.captureErrors === undefined && c.errors !== undefined) config.captureErrors = c.errors;
            if (config.captureHttp === undefined && c.http !== undefined) config.captureHttp = c.http;
            if (config.capturePerformance === undefined && c.performance !== undefined) config.capturePerformance = c.performance;
            if (config.captureStackTraces === undefined && c.stackTraces !== undefined) config.captureStackTraces = c.stackTraces;
            if (config.captureBody === undefined && c.body !== undefined) config.captureBody = c.body;
          }
        }
      } catch {
        // Config file doesn't exist or is malformed — use explicit config
      }
    }

    // Auto-disable in production if no explicit endpoint configured
    // If NODE_ENV is production and no DSN/serverUrl/endpoint was provided,
    // the SDK is completely inert — no connection attempts, no monkey-patching
    const hasExplicitEndpoint = !!(dsnString || config.serverUrl || config.endpoint || config.httpEndpoint);
    if (!hasExplicitEndpoint) {
      const nodeEnv = typeof process !== 'undefined' ? process.env.NODE_ENV : undefined;
      const isLocalhost = true; // Server SDK defaults to localhost, so always "local" unless endpoint set
      if (nodeEnv === 'production') {
        // Production without explicit endpoint = silent no-op
        return;
      }
    }

    this.config = config;
    this.sessionId = config.sessionId ?? generateSessionId();

    const serverUrl = config.serverUrl ?? config.endpoint ?? 'ws://127.0.0.1:6767';

    if (config.transport === 'http') {
      // HTTP transport for serverless environments (Lambda, Vercel, Cloudflare Workers)
      let httpUrl = config.httpEndpoint;
      if (!httpUrl) {
        const wsUrl = new URL(serverUrl);
        wsUrl.protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
        wsUrl.port = '6768';
        wsUrl.pathname = '/api/events';
        httpUrl = wsUrl.toString();
      }

      this.httpTransport = new HttpTransport({
        url: httpUrl,
        sessionId: this.sessionId,
        appName: config.appName ?? 'server-app',
        sdkVersion: SDK_VERSION,
        authToken: config.authToken,
        projectId: config.projectId,
        maxQueueSize: config.maxQueueSize,
        flushIntervalMs: config.httpFlushIntervalMs,
      });
    } else {
      // Default: WebSocket transport
      this.transport = new ServerTransport({
        url: serverUrl,
        sessionId: this.sessionId,
        appName: config.appName ?? 'server-app',
        sdkVersion: SDK_VERSION,
        authToken: config.authToken,
        projectId: config.projectId,
        maxQueueSize: config.maxQueueSize,
      });

      this.transport.connect();

      // Warn if collector is unreachable after 10 seconds
      const transport = this.transport;
      setTimeout(() => {
        if (transport && !(transport as any).connected) {
          console.debug('[RuntimeScope] Could not connect to collector at %s — is it running?', serverUrl);
        }
      }, 10_000);
    }

    // Set up sampler if rate limiting or sampling is configured
    if (config.sampleRate !== undefined || config.maxEventsPerSecond !== undefined) {
      this.sampler = new Sampler({
        sampleRate: config.sampleRate,
        maxEventsPerSecond: config.maxEventsPerSecond,
      });
    }

    const emit = (event: ServerRuntimeEvent) => this.emitEvent(event);

    // Console interceptor (default: enabled)
    if (config.captureConsole !== false) {
      try {
        this.restoreFunctions.push(
          interceptConsole(emit, this.sessionId, {
            captureStackTraces: config.captureStackTraces,
            beforeSend: config.beforeSend,
          })
        );
      } catch { /* non-fatal: continue without console capture */ }
    }

    // Error interceptor (default: enabled when console is enabled)
    if (config.captureErrors !== false && config.captureConsole !== false) {
      try {
        this.restoreFunctions.push(
          interceptErrors(emit, this.sessionId, {
            beforeSend: config.beforeSend,
          })
        );
      } catch { /* non-fatal: continue without error capture */ }
    }

    // HTTP request interceptor (default: enabled)
    if (config.captureHttp !== false) {
      try {
        this.restoreFunctions.push(
          interceptHttp(emit, this.sessionId, {
            captureBody: config.captureBody,
            maxBodySize: config.maxBodySize,
            redactHeaders: config.redactHeaders,
            // Auto-ignore the collector URL to prevent recursion
            ignoreUrls: [
              serverUrl.replace('ws://', '').replace('wss://', ''),
              ...(config.httpEndpoint ? [config.httpEndpoint.replace(/^https?:\/\//, '')] : []),
            ],
            beforeSend: config.beforeSend,
          })
        );
      } catch { /* non-fatal: continue without HTTP capture */ }
    }

    // Performance metrics (default: enabled)
    if (config.capturePerformance !== false) {
      try {
        this.restoreFunctions.push(
          startPerfMetrics(emit, this.sessionId, {
            intervalMs: config.performanceInterval,
            metrics: config.performanceMetrics,
          })
        );
      } catch { /* non-fatal: continue without performance metrics */ }
    }
  }

  disconnect(): void {
    for (const restore of this.restoreFunctions) {
      try { restore(); } catch { /* ignore */ }
    }
    this.restoreFunctions = [];
    this.sampler = null;
    if (this.httpTransport) {
      this.httpTransport.disconnect();
      this.httpTransport = null;
    }
    this.transport?.disconnect();
    this.transport = null;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  private emitEvent(event: ServerRuntimeEvent): void {
    // Apply sampling/rate limiting
    if (this.sampler && !this.sampler.shouldSample(event)) return;

    const filtered = this.config.beforeSend
      ? this.config.beforeSend(event)
      : event;
    if (!filtered) return;

    if (this.httpTransport) {
      this.httpTransport.sendEvent(filtered);
    } else {
      this.transport?.sendEvent(filtered);
    }
  }

  // --- Express/Connect Middleware ---

  middleware(options?: MiddlewareOptions) {
    return runtimeScopeMiddleware(
      (event) => this.emitEvent(event),
      this.sessionId,
      {
        ...options,
        redactHeaders: options?.redactHeaders ?? this.config.redactHeaders,
        beforeSend: options?.beforeSend ?? this.config.beforeSend,
      }
    );
  }

  // --- ORM Instrumentation ---

  instrumentPrisma(client: unknown): typeof client {
    const restore = instrumentPrisma(client, {
      sessionId: this.sessionId,
      captureStackTraces: this.config.captureStackTraces,
      redact: this.config.redactParams,
      onEvent: (event) => this.emitEvent(event),
    });
    this.restoreFunctions.push(restore);
    return client;
  }

  instrumentPg(pool: unknown): typeof pool {
    const restore = instrumentPg(pool, {
      sessionId: this.sessionId,
      captureStackTraces: this.config.captureStackTraces,
      redact: this.config.redactParams,
      onEvent: (event) => this.emitEvent(event),
    });
    this.restoreFunctions.push(restore);
    return pool;
  }

  instrumentKnex(knex: unknown): typeof knex {
    const restore = instrumentKnex(knex, {
      sessionId: this.sessionId,
      captureStackTraces: this.config.captureStackTraces,
      redact: this.config.redactParams,
      onEvent: (event) => this.emitEvent(event),
    });
    this.restoreFunctions.push(restore);
    return knex;
  }

  instrumentDrizzle(db: unknown): typeof db {
    const restore = instrumentDrizzle(db, {
      sessionId: this.sessionId,
      captureStackTraces: this.config.captureStackTraces,
      redact: this.config.redactParams,
      onEvent: (event) => this.emitEvent(event),
    });
    this.restoreFunctions.push(restore);
    return db;
  }

  instrumentMysql2(pool: unknown): typeof pool {
    const restore = instrumentMysql2(pool, {
      sessionId: this.sessionId,
      captureStackTraces: this.config.captureStackTraces,
      redact: this.config.redactParams,
      onEvent: (event) => this.emitEvent(event),
    });
    this.restoreFunctions.push(restore);
    return pool;
  }

  instrumentBetterSqlite3(db: unknown): typeof db {
    const restore = instrumentBetterSqlite3(db, {
      sessionId: this.sessionId,
      captureStackTraces: this.config.captureStackTraces,
      redact: this.config.redactParams,
      onEvent: (event) => this.emitEvent(event),
    });
    this.restoreFunctions.push(restore);
    return db;
  }

  // --- Generic query capture ---

  async captureQuery<T>(
    fn: () => Promise<T>,
    options?: { label?: string }
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      const duration = performance.now() - start;
      this.emitEvent({
        eventId: generateId(),
        sessionId: this.sessionId,
        timestamp: Date.now(),
        eventType: 'database',
        query: options?.label ?? 'custom query',
        normalizedQuery: options?.label ?? 'custom query',
        duration,
        tablesAccessed: [],
        operation: 'OTHER',
        source: 'generic',
        label: options?.label,
        stackTrace: this.config.captureStackTraces ? captureStack() : undefined,
        rowsReturned: Array.isArray(result) ? result.length : undefined,
      });
      return result;
    } catch (err) {
      const duration = performance.now() - start;
      this.emitEvent({
        eventId: generateId(),
        sessionId: this.sessionId,
        timestamp: Date.now(),
        eventType: 'database',
        query: options?.label ?? 'custom query',
        normalizedQuery: options?.label ?? 'custom query',
        duration,
        tablesAccessed: [],
        operation: 'OTHER',
        source: 'generic',
        label: options?.label,
        error: (err as Error).message,
        stackTrace: this.config.captureStackTraces ? captureStack() : undefined,
      });
      throw err;
    }
  }
}

// Singleton instance
export const RuntimeScope = new RuntimeScopeServer();

// Re-export types and utilities
export type {
  DatabaseEvent,
  ConsoleEvent,
  NetworkEvent,
  PerformanceEvent,
  ServerRuntimeEvent,
  ServerSdkConfig,
  ServerMetricName,
  MetricUnit,
} from './types.js';
export { generateId, generateSessionId } from './utils/id.js';
export { parseOperation, parseTablesAccessed, normalizeQuery, redactParams } from './utils/sql-parser.js';
export { runtimeScopeMiddleware } from './interceptors/middleware.js';
export { runWithContext, getRequestContext, getSessionId } from './context.js';
export { Sampler } from './sampler.js';
export { HttpTransport } from './http-transport.js';
export type { HttpTransportOptions } from './http-transport.js';
export { parseDsn, buildDsn } from './dsn.js';
export type { ParsedDsn } from './dsn.js';
