import type {
  D1DatabaseBinding,
  D1PreparedStatementBinding,
  D1Result,
  D1ExecResult,
  DatabaseEvent,
} from '../types.js';
import { generateId } from '../utils.js';

// ============================================================
// D1 Binding Wrapper
// Wraps a D1Database to capture SQL queries, timing, and results.
// Events emitted as 'database' type with source: 'd1'.
// ============================================================

type EmitFn = (event: DatabaseEvent) => void;

interface D1InstrumentOptions {
  sessionId: string;
}

/**
 * Wrap a D1 database binding to capture queries.
 *
 * @example
 * ```ts
 * const db = instrumentD1(env.DB, transport.sessionId);
 * const results = await db.prepare('SELECT * FROM users').all();
 * ```
 */
export function instrumentD1(
  db: D1DatabaseBinding,
  emit: EmitFn,
  options: D1InstrumentOptions,
): D1DatabaseBinding {
  return {
    prepare(query: string): D1PreparedStatementBinding {
      const stmt = db.prepare(query);
      return instrumentStatement(stmt, query, emit, options);
    },

    async batch<T = unknown>(statements: D1PreparedStatementBinding[]): Promise<D1Result<T>[]> {
      const start = Date.now();
      try {
        const results = await db.batch<T>(statements);
        const duration = Date.now() - start;
        emit({
          eventId: generateId(),
          sessionId: options.sessionId,
          timestamp: start,
          eventType: 'database',
          query: `BATCH (${statements.length} statements)`,
          normalizedQuery: 'BATCH',
          duration,
          tablesAccessed: [],
          operation: 'OTHER',
          source: 'd1',
          rowsReturned: results.reduce((sum, r) => sum + (r.results?.length ?? 0), 0),
        });
        return results;
      } catch (err) {
        const duration = Date.now() - start;
        emit({
          eventId: generateId(),
          sessionId: options.sessionId,
          timestamp: start,
          eventType: 'database',
          query: `BATCH (${statements.length} statements)`,
          normalizedQuery: 'BATCH',
          duration,
          tablesAccessed: [],
          operation: 'OTHER',
          source: 'd1',
          error: (err as Error).message,
        });
        throw err;
      }
    },

    async exec(query: string): Promise<D1ExecResult> {
      const start = Date.now();
      try {
        const result = await db.exec(query);
        emit({
          eventId: generateId(),
          sessionId: options.sessionId,
          timestamp: start,
          eventType: 'database',
          query,
          normalizedQuery: normalizeD1Query(query),
          duration: result.duration,
          tablesAccessed: extractTables(query),
          operation: parseOp(query),
          source: 'd1',
          rowsAffected: result.count,
        });
        return result;
      } catch (err) {
        const duration = Date.now() - start;
        emit({
          eventId: generateId(),
          sessionId: options.sessionId,
          timestamp: start,
          eventType: 'database',
          query,
          normalizedQuery: normalizeD1Query(query),
          duration,
          tablesAccessed: extractTables(query),
          operation: parseOp(query),
          source: 'd1',
          error: (err as Error).message,
        });
        throw err;
      }
    },

    dump(): Promise<ArrayBuffer> {
      return db.dump();
    },
  };
}

function instrumentStatement(
  stmt: D1PreparedStatementBinding,
  query: string,
  emit: EmitFn,
  options: D1InstrumentOptions,
): D1PreparedStatementBinding {
  const op = parseOp(query);
  const tables = extractTables(query);
  const normalized = normalizeD1Query(query);

  function makeEvent(start: number, duration: number, extra: Partial<DatabaseEvent> = {}): DatabaseEvent {
    return {
      eventId: generateId(),
      sessionId: options.sessionId,
      timestamp: start,
      eventType: 'database',
      query,
      normalizedQuery: normalized,
      duration,
      tablesAccessed: tables,
      operation: op,
      source: 'd1',
      ...extra,
    };
  }

  async function wrapAsync<T>(fn: () => Promise<T>, start: number, getExtra?: (result: T) => Partial<DatabaseEvent>): Promise<T> {
    try {
      const result = await fn();
      const duration = Date.now() - start;
      emit(makeEvent(start, duration, getExtra?.(result)));
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      emit(makeEvent(start, duration, { error: (err as Error).message }));
      throw err;
    }
  }

  return {
    bind(...values: unknown[]): D1PreparedStatementBinding {
      const bound = stmt.bind(...values);
      return instrumentStatement(bound, query, emit, options);
    },

    first<T = unknown>(colName?: string): Promise<T | null> {
      const start = Date.now();
      return wrapAsync(
        () => stmt.first<T>(colName),
        start,
        (result) => ({ rowsReturned: result !== null ? 1 : 0 }),
      );
    },

    run<T = unknown>(): Promise<D1Result<T>> {
      const start = Date.now();
      return wrapAsync(
        () => stmt.run<T>(),
        start,
        (result) => ({
          rowsAffected: result.meta?.changes,
          duration: result.meta?.duration ?? (Date.now() - start),
        }),
      );
    },

    all<T = unknown>(): Promise<D1Result<T>> {
      const start = Date.now();
      return wrapAsync(
        () => stmt.all<T>(),
        start,
        (result) => ({
          rowsReturned: result.results?.length ?? 0,
          duration: result.meta?.duration ?? (Date.now() - start),
        }),
      );
    },

    raw<T = unknown>(rawOptions?: { columnNames?: boolean }): Promise<T[]> {
      const start = Date.now();
      return wrapAsync(
        () => stmt.raw<T>(rawOptions),
        start,
        (result) => ({ rowsReturned: result.length }),
      );
    },
  };
}

// --- SQL Parsing Helpers (lightweight, no dependencies) ---

function parseOp(query: string): DatabaseEvent['operation'] {
  const trimmed = query.trimStart().toUpperCase();
  if (trimmed.startsWith('SELECT')) return 'SELECT';
  if (trimmed.startsWith('INSERT')) return 'INSERT';
  if (trimmed.startsWith('UPDATE')) return 'UPDATE';
  if (trimmed.startsWith('DELETE')) return 'DELETE';
  return 'OTHER';
}

function extractTables(query: string): string[] {
  const tables: string[] = [];
  const fromMatch = query.match(/\bFROM\s+(\w+)/i);
  if (fromMatch) tables.push(fromMatch[1]);
  const intoMatch = query.match(/\bINTO\s+(\w+)/i);
  if (intoMatch) tables.push(intoMatch[1]);
  const updateMatch = query.match(/\bUPDATE\s+(\w+)/i);
  if (updateMatch) tables.push(updateMatch[1]);
  const joinMatches = query.matchAll(/\bJOIN\s+(\w+)/gi);
  for (const m of joinMatches) tables.push(m[1]);
  return [...new Set(tables)];
}

function normalizeD1Query(query: string): string {
  return query
    .replace(/'[^']*'/g, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}
