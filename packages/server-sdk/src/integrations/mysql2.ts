import type { DatabaseEvent } from '../types.js';
import { generateId } from '../utils/id.js';
import { parseOperation, parseTablesAccessed, normalizeQuery, redactParams } from '../utils/sql-parser.js';
import { captureStack } from '../utils/stack.js';
import { _log } from '../utils/log.js';

export interface Mysql2InstrumentOptions {
  sessionId: string;
  captureStackTraces?: boolean;
  redact?: boolean;
  onEvent: (event: DatabaseEvent) => void;
}

/**
 * Instrument a mysql2 Pool or Connection to capture database queries.
 * Wraps query() and execute() methods.
 */
export function instrumentMysql2(
  pool: unknown,
  options: Mysql2InstrumentOptions
): () => void {
  const client = pool as Record<string, unknown>;
  const originalQuery = client.query as Function | undefined;
  const originalExecute = client.execute as Function | undefined;

  if (typeof originalQuery !== 'function') {
    _log.warn('[RuntimeScope] mysql2 client does not have a query method');
    return () => {};
  }

  function wrapMethod(original: Function, methodName: string): Function {
    return function (this: unknown, ...args: unknown[]) {
      const start = performance.now();
      let queryText = '';
      let params: unknown[] | undefined;

      // mysql2 supports: query(sql), query(sql, values), query(options), query(options, values)
      if (typeof args[0] === 'string') {
        queryText = args[0];
        if (Array.isArray(args[1])) params = args[1];
      } else if (typeof args[0] === 'object' && args[0] !== null) {
        const config = args[0] as Record<string, unknown>;
        queryText = (config.sql as string) ?? '';
        params = config.values as unknown[] | undefined;
        if (!params && Array.isArray(args[1])) params = args[1];
      }

      // Find callback (last function argument)
      const lastArg = args[args.length - 1];
      const hasCallback = typeof lastArg === 'function';

      if (hasCallback) {
        // Callback style
        const cb = lastArg as (...cbArgs: unknown[]) => void;
        args[args.length - 1] = function (err: Error | null, results: unknown, fields: unknown) {
          const duration = performance.now() - start;
          const rows = Array.isArray(results) ? results.length : undefined;
          const affectedRows = results && typeof results === 'object'
            ? (results as Record<string, unknown>).affectedRows as number | undefined
            : undefined;

          options.onEvent({
            eventId: generateId(),
            sessionId: options.sessionId,
            timestamp: Date.now(),
            eventType: 'database',
            query: queryText,
            normalizedQuery: normalizeQuery(queryText),
            duration,
            rowsReturned: rows,
            rowsAffected: affectedRows,
            tablesAccessed: parseTablesAccessed(queryText),
            operation: parseOperation(queryText),
            source: 'mysql2',
            error: err?.message,
            params: params && options.redact !== false ? redactParams(params) : undefined,
            stackTrace: options.captureStackTraces ? captureStack() : undefined,
          });

          cb(err, results, fields);
        };
        return original.apply(this, args);
      }

      // Promise style (mysql2/promise)
      const result = original.apply(this, args);

      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).then((res: unknown) => {
          const duration = performance.now() - start;
          const resultArr = Array.isArray(res) ? res : [res];
          const rows = Array.isArray(resultArr[0]) ? resultArr[0].length : undefined;
          const affectedRows = resultArr[0] && typeof resultArr[0] === 'object'
            ? (resultArr[0] as Record<string, unknown>).affectedRows as number | undefined
            : undefined;

          options.onEvent({
            eventId: generateId(),
            sessionId: options.sessionId,
            timestamp: Date.now(),
            eventType: 'database',
            query: queryText,
            normalizedQuery: normalizeQuery(queryText),
            duration,
            rowsReturned: rows,
            rowsAffected: affectedRows,
            tablesAccessed: parseTablesAccessed(queryText),
            operation: parseOperation(queryText),
            source: 'mysql2',
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
            source: 'mysql2',
            error: err.message,
            params: params && options.redact !== false ? redactParams(params) : undefined,
            stackTrace: options.captureStackTraces ? captureStack() : undefined,
          });
          throw err;
        });
      }

      return result;
    };
  }

  client.query = wrapMethod(originalQuery, 'query');
  if (typeof originalExecute === 'function') {
    client.execute = wrapMethod(originalExecute, 'execute');
  }

  return () => {
    client.query = originalQuery;
    if (originalExecute) client.execute = originalExecute;
  };
}
