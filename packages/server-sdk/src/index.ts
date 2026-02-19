import { ServerTransport } from './transport.js';
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
import type { DatabaseEvent, ServerSdkConfig, ServerRuntimeEvent } from './types.js';
import type { MiddlewareOptions } from './interceptors/middleware.js';

// ============================================================
// RuntimeScope Server SDK
// Instruments server-side database queries, console output,
// errors, HTTP requests, and performance metrics — sends them
// to the RuntimeScope collector via WebSocket
// ============================================================

const SDK_VERSION = '0.3.0';

// Re-export _log for integration modules (lives in utils/log.js to avoid circular deps)
export { _log } from './utils/log.js';

class RuntimeScopeServer {
  private transport: ServerTransport | null = null;
  private sessionId: string = '';
  private config: ServerSdkConfig = {};
  private sampler: Sampler | null = null;
  private restoreFunctions: (() => void)[] = [];

  connect(config: ServerSdkConfig = {}): void {
    this.config = config;
    this.sessionId = config.sessionId ?? generateSessionId();

    const serverUrl = config.serverUrl ?? 'ws://127.0.0.1:9090';

    this.transport = new ServerTransport({
      url: serverUrl,
      sessionId: this.sessionId,
      appName: config.appName ?? 'server-app',
      sdkVersion: SDK_VERSION,
      maxQueueSize: config.maxQueueSize,
    });

    this.transport.connect();

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

    // HTTP request interceptor (default: disabled — opt-in)
    if (config.captureHttp) {
      try {
        this.restoreFunctions.push(
          interceptHttp(emit, this.sessionId, {
            captureBody: config.captureBody,
            maxBodySize: config.maxBodySize,
            redactHeaders: config.redactHeaders,
            // Auto-ignore the collector URL to prevent recursion
            ignoreUrls: [serverUrl.replace('ws://', '').replace('wss://', '')],
            beforeSend: config.beforeSend,
          })
        );
      } catch { /* non-fatal: continue without HTTP capture */ }
    }

    // Performance metrics (default: disabled — opt-in)
    if (config.capturePerformance) {
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
    this.transport?.disconnect();
    this.transport = null;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  private emitEvent(event: ServerRuntimeEvent): void {
    // Apply sampling/rate limiting
    if (this.sampler && !this.sampler.shouldSample(event)) return;

    if (this.config.beforeSend) {
      const filtered = this.config.beforeSend(event);
      if (!filtered) return;
      this.transport?.sendEvent(filtered);
    } else {
      this.transport?.sendEvent(event);
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
