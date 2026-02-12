import { ServerTransport } from './transport.js';
import { generateId, generateSessionId } from './utils/id.js';
import { parseOperation, parseTablesAccessed, normalizeQuery, redactParams } from './utils/sql-parser.js';
import { captureStack } from './utils/stack.js';
import { instrumentPrisma } from './integrations/prisma.js';
import { instrumentPg } from './integrations/pg.js';
import { instrumentKnex } from './integrations/knex.js';
import type { DatabaseEvent, ServerSdkConfig } from './types.js';

// ============================================================
// RuntimeScope Server SDK
// Instruments server-side database queries and sends them
// to the RuntimeScope collector via WebSocket
// ============================================================

const SDK_VERSION = '0.1.0';

class RuntimeScopeServer {
  private transport: ServerTransport | null = null;
  private sessionId: string = '';
  private config: ServerSdkConfig = {};
  private restoreFunctions: (() => void)[] = [];

  connect(config: ServerSdkConfig = {}): void {
    this.config = config;
    this.sessionId = config.sessionId ?? generateSessionId();

    this.transport = new ServerTransport({
      url: config.serverUrl ?? 'ws://127.0.0.1:9090',
      sessionId: this.sessionId,
      appName: config.appName ?? 'server-app',
      sdkVersion: SDK_VERSION,
    });

    this.transport.connect();
  }

  disconnect(): void {
    for (const restore of this.restoreFunctions) {
      try { restore(); } catch { /* ignore */ }
    }
    this.restoreFunctions = [];
    this.transport?.disconnect();
    this.transport = null;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  private emitEvent(event: DatabaseEvent): void {
    this.transport?.sendEvent(event);
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
export type { DatabaseEvent, ServerSdkConfig } from './types.js';
export { generateId, generateSessionId } from './utils/id.js';
export { parseOperation, parseTablesAccessed, normalizeQuery, redactParams } from './utils/sql-parser.js';
