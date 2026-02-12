import type { DatabaseEvent } from '../types.js';
import { generateId } from '../utils/id.js';
import { parseOperation, parseTablesAccessed, normalizeQuery, redactParams } from '../utils/sql-parser.js';
import { captureStack } from '../utils/stack.js';

export interface PgInstrumentOptions {
  sessionId: string;
  captureStackTraces?: boolean;
  redact?: boolean;
  onEvent: (event: DatabaseEvent) => void;
}

/**
 * Instrument a pg Pool or Client to capture database queries.
 * Wraps the query method to intercept all SQL execution.
 */
export function instrumentPg(
  pool: unknown,
  options: PgInstrumentOptions
): () => void {
  const client = pool as Record<string, unknown>;
  const originalQuery = client.query as Function;

  if (typeof originalQuery !== 'function') {
    console.warn('[RuntimeScope] pg client does not have a query method');
    return () => {};
  }

  client.query = function (...args: unknown[]) {
    const start = performance.now();
    let queryText = '';
    let params: unknown[] | undefined;

    // pg.query supports multiple signatures
    if (typeof args[0] === 'string') {
      queryText = args[0];
      if (Array.isArray(args[1])) params = args[1];
    } else if (typeof args[0] === 'object' && args[0] !== null) {
      const config = args[0] as Record<string, unknown>;
      queryText = (config.text as string) ?? '';
      params = config.values as unknown[] | undefined;
    }

    const result = originalQuery.apply(this, args);

    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>).then((res: unknown) => {
        const duration = performance.now() - start;
        const pgResult = res as { rowCount?: number; rows?: unknown[] };
        options.onEvent({
          eventId: generateId(),
          sessionId: options.sessionId,
          timestamp: Date.now(),
          eventType: 'database',
          query: queryText,
          normalizedQuery: normalizeQuery(queryText),
          duration,
          rowsReturned: pgResult.rows?.length,
          rowsAffected: pgResult.rowCount ?? undefined,
          tablesAccessed: parseTablesAccessed(queryText),
          operation: parseOperation(queryText),
          source: 'pg',
          params: params && options.redact !== false ? redactParams(params) : undefined,
          stackTrace: options.captureStackTraces ? captureStack() : undefined,
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
          source: 'pg',
          error: err.message,
          params: params && options.redact !== false ? redactParams(params) : undefined,
          stackTrace: options.captureStackTraces ? captureStack() : undefined,
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
