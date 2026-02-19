import type { DatabaseEvent } from '../types.js';
import { generateId } from '../utils/id.js';
import { parseOperation, parseTablesAccessed, normalizeQuery, redactParams } from '../utils/sql-parser.js';
import { captureStack } from '../utils/stack.js';
import { _log } from '../utils/log.js';

export interface BetterSqlite3Options {
  sessionId: string;
  captureStackTraces?: boolean;
  redact?: boolean;
  onEvent: (event: DatabaseEvent) => void;
}

/**
 * Instrument a better-sqlite3 Database instance.
 * Wraps db.prepare() to return instrumented statements whose
 * run(), get(), all(), and iterate() methods emit DatabaseEvents.
 *
 * better-sqlite3 is fully synchronous — no promise handling needed.
 */
export function instrumentBetterSqlite3(
  db: unknown,
  options: BetterSqlite3Options
): () => void {
  const database = db as Record<string, unknown>;
  const originalPrepare = database.prepare as Function | undefined;
  const originalExec = database.exec as Function | undefined;

  if (typeof originalPrepare !== 'function') {
    _log.warn('[RuntimeScope] better-sqlite3 db does not have a prepare method');
    return () => {};
  }

  function emitQuery(
    queryText: string,
    start: number,
    result?: unknown,
    error?: string,
    params?: unknown[]
  ): void {
    const duration = performance.now() - start;
    const rows = Array.isArray(result) ? result.length : undefined;
    const changes = result && typeof result === 'object'
      ? (result as Record<string, unknown>).changes as number | undefined
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
      rowsAffected: changes,
      tablesAccessed: parseTablesAccessed(queryText),
      operation: parseOperation(queryText),
      source: 'better-sqlite3',
      error,
      params: params && options.redact !== false ? redactParams(params) : undefined,
      stackTrace: options.captureStackTraces ? captureStack() : undefined,
    });
  }

  // Wrap db.prepare() to return instrumented statements
  database.prepare = function (sql: string) {
    const stmt = (originalPrepare as Function).call(this, sql);
    const stmtObj = stmt as Record<string, unknown>;

    // Wrap run(), get(), all()
    const methods = ['run', 'get', 'all'] as const;
    for (const method of methods) {
      const original = stmtObj[method] as Function;
      if (typeof original !== 'function') continue;

      stmtObj[method] = function (...args: unknown[]) {
        const start = performance.now();
        try {
          const result = original.apply(this, args);
          emitQuery(sql, start, result, undefined, args);
          return result;
        } catch (err) {
          emitQuery(sql, start, undefined, (err as Error).message, args);
          throw err;
        }
      };
    }

    // Wrap iterate() — returns an iterator
    const originalIterate = stmtObj.iterate as Function | undefined;
    if (typeof originalIterate === 'function') {
      stmtObj.iterate = function (...args: unknown[]) {
        const start = performance.now();
        const iter = originalIterate.apply(this, args);
        let rowCount = 0;

        const originalNext = iter.next.bind(iter);
        let emitted = false;
        iter.next = function () {
          const result = originalNext();
          if (!result.done) rowCount++;
          if (result.done && !emitted) {
            emitted = true;
            emitQuery(sql, start, { length: rowCount }, undefined, args);
          }
          return result;
        };

        return iter;
      };
    }

    return stmt;
  };

  // Wrap db.exec() for raw SQL execution
  if (typeof originalExec === 'function') {
    database.exec = function (sql: string) {
      const start = performance.now();
      try {
        const result = (originalExec as Function).call(this, sql);
        emitQuery(sql, start);
        return result;
      } catch (err) {
        emitQuery(sql, start, undefined, (err as Error).message);
        throw err;
      }
    };
  }

  return () => {
    database.prepare = originalPrepare;
    if (originalExec) database.exec = originalExec;
  };
}
