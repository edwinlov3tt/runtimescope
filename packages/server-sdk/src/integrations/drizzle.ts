import type { DatabaseEvent } from '../types.js';
import { generateId } from '../utils/id.js';
import { parseOperation, parseTablesAccessed, normalizeQuery, redactParams } from '../utils/sql-parser.js';
import { captureStack } from '../utils/stack.js';
import { _log } from '../utils/log.js';

export interface DrizzleInstrumentOptions {
  sessionId: string;
  captureStackTraces?: boolean;
  redact?: boolean;
  onEvent: (event: DatabaseEvent) => void;
}

/**
 * Instrument a Drizzle ORM database instance.
 * Wraps the session's execute method to capture query timing and results.
 * Falls back to wrapping the underlying driver's query method if execute
 * is not available.
 */
export function instrumentDrizzle(
  db: unknown,
  options: DrizzleInstrumentOptions
): () => void {
  const drizzleDb = db as Record<string, unknown>;

  // Drizzle stores internals under db._ (session, schema, etc.)
  const internals = drizzleDb._ as Record<string, unknown> | undefined;
  if (!internals) {
    _log.warn('[RuntimeScope] Drizzle db does not have internals (_). Cannot instrument.');
    return () => {};
  }

  const session = internals.session as Record<string, unknown> | undefined;
  if (!session) {
    _log.warn('[RuntimeScope] Drizzle db does not have a session. Cannot instrument.');
    return () => {};
  }

  // Strategy: wrap session.execute() which runs the actual SQL
  const originalExecute = session.execute as Function | undefined;

  if (typeof originalExecute === 'function') {
    session.execute = function (this: unknown, queryOrSql: unknown) {
      const start = performance.now();
      let queryText = '';
      let params: unknown[] | undefined;

      // Drizzle passes a query object with sql and params properties
      if (queryOrSql && typeof queryOrSql === 'object') {
        const q = queryOrSql as Record<string, unknown>;
        queryText = (q.sql as string) ?? (q.query as string) ?? String(queryOrSql);
        params = q.params as unknown[] | undefined;
      } else if (typeof queryOrSql === 'string') {
        queryText = queryOrSql;
      }

      const stack = options.captureStackTraces ? captureStack() : undefined;

      const result = originalExecute.apply(this, arguments);

      // Handle promise (async queries)
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).then((res: unknown) => {
          const duration = performance.now() - start;
          const rows = Array.isArray(res) ? res.length : undefined;

          options.onEvent({
            eventId: generateId(),
            sessionId: options.sessionId,
            timestamp: Date.now(),
            eventType: 'database',
            query: queryText,
            normalizedQuery: normalizeQuery(queryText),
            duration,
            rowsReturned: rows,
            tablesAccessed: parseTablesAccessed(queryText),
            operation: parseOperation(queryText),
            source: 'drizzle',
            params: params && options.redact !== false ? redactParams(params) : undefined,
            stackTrace: stack,
          });
          return res;
        }).catch((err: Error) => {
          const duration = performance.now() - start;
          options.onEvent({
            eventId: generateId(),
            sessionId: options.sessionId,
            timestamp: Date.now(),
            eventType: 'database',
            query: queryText,
            normalizedQuery: normalizeQuery(queryText),
            duration,
            tablesAccessed: parseTablesAccessed(queryText),
            operation: parseOperation(queryText),
            source: 'drizzle',
            error: err.message,
            params: params && options.redact !== false ? redactParams(params) : undefined,
            stackTrace: stack,
          });
          throw err;
        });
      }

      return result;
    };

    return () => {
      session.execute = originalExecute;
    };
  }

  // Fallback: instrument the underlying client's query method
  const client = (session as Record<string, unknown>).client as Record<string, unknown> | undefined;
  const originalQuery = client?.query as Function | undefined;

  if (client && typeof originalQuery === 'function') {
    client.query = function (this: unknown, ...args: unknown[]) {
      const start = performance.now();
      const queryText = typeof args[0] === 'string' ? args[0] : '';
      const params = Array.isArray(args[1]) ? args[1] : undefined;
      const stack = options.captureStackTraces ? captureStack() : undefined;

      const result = originalQuery.apply(this, args);

      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).then((res: unknown) => {
          const duration = performance.now() - start;
          options.onEvent({
            eventId: generateId(),
            sessionId: options.sessionId,
            timestamp: Date.now(),
            eventType: 'database',
            query: queryText,
            normalizedQuery: normalizeQuery(queryText),
            duration,
            rowsReturned: Array.isArray(res) ? res.length : undefined,
            tablesAccessed: parseTablesAccessed(queryText),
            operation: parseOperation(queryText),
            source: 'drizzle',
            params: params && options.redact !== false ? redactParams(params) : undefined,
            stackTrace: stack,
          });
          return res;
        }).catch((err: Error) => {
          const duration = performance.now() - start;
          options.onEvent({
            eventId: generateId(),
            sessionId: options.sessionId,
            timestamp: Date.now(),
            eventType: 'database',
            query: queryText,
            normalizedQuery: normalizeQuery(queryText),
            duration,
            tablesAccessed: parseTablesAccessed(queryText),
            operation: parseOperation(queryText),
            source: 'drizzle',
            error: err.message,
            params: params && options.redact !== false ? redactParams(params) : undefined,
            stackTrace: stack,
          });
          throw err;
        });
      }

      return result;
    };

    return () => {
      client.query = originalQuery;
    };
  }

  _log.warn('[RuntimeScope] Drizzle db has no instrumentable execute or query method.');
  return () => {};
}
