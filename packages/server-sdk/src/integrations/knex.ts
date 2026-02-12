import type { DatabaseEvent } from '../types.js';
import { generateId } from '../utils/id.js';
import { parseOperation, parseTablesAccessed, normalizeQuery, redactParams } from '../utils/sql-parser.js';
import { captureStack } from '../utils/stack.js';

export interface KnexInstrumentOptions {
  sessionId: string;
  captureStackTraces?: boolean;
  redact?: boolean;
  onEvent: (event: DatabaseEvent) => void;
}

/**
 * Instrument a Knex instance to capture database queries.
 * Uses Knex's built-in event system (query, query-response, query-error).
 */
export function instrumentKnex(
  knex: unknown,
  options: KnexInstrumentOptions
): () => void {
  const instance = knex as {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
  };

  const pendingQueries = new Map<string, { query: string; params: unknown[]; start: number }>();

  const onQuery = (data: { __knexQueryUid: string; sql: string; bindings: unknown[] }) => {
    pendingQueries.set(data.__knexQueryUid, {
      query: data.sql,
      params: data.bindings ?? [],
      start: performance.now(),
    });
  };

  const onQueryResponse = (_response: unknown, data: { __knexQueryUid: string; sql: string; bindings: unknown[] }, _builder: unknown) => {
    const pending = pendingQueries.get(data.__knexQueryUid);
    pendingQueries.delete(data.__knexQueryUid);
    const duration = pending ? performance.now() - pending.start : 0;
    const queryText = pending?.query ?? data.sql;
    const params = pending?.params ?? data.bindings;

    const rows = Array.isArray(_response) ? _response.length : undefined;

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
      source: 'knex',
      params: params.length > 0 && options.redact !== false ? redactParams(params) : undefined,
      stackTrace: options.captureStackTraces ? captureStack() : undefined,
    });
  };

  const onQueryError = (error: Error, data: { __knexQueryUid: string; sql: string; bindings: unknown[] }) => {
    const pending = pendingQueries.get(data.__knexQueryUid);
    pendingQueries.delete(data.__knexQueryUid);
    const duration = pending ? performance.now() - pending.start : 0;
    const queryText = pending?.query ?? data.sql;
    const params = pending?.params ?? data.bindings;

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
      source: 'knex',
      error: error.message,
      params: params.length > 0 && options.redact !== false ? redactParams(params) : undefined,
      stackTrace: options.captureStackTraces ? captureStack() : undefined,
    });
  };

  instance.on('query', onQuery as (...args: unknown[]) => void);
  instance.on('query-response', onQueryResponse as (...args: unknown[]) => void);
  instance.on('query-error', onQueryError as (...args: unknown[]) => void);

  return () => {
    instance.removeListener('query', onQuery as (...args: unknown[]) => void);
    instance.removeListener('query-response', onQueryResponse as (...args: unknown[]) => void);
    instance.removeListener('query-error', onQueryError as (...args: unknown[]) => void);
    pendingQueries.clear();
  };
}
