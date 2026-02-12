import type { DatabaseEvent, DatabaseSource } from '../types.js';
import { generateId } from '../utils/id.js';
import { parseOperation, parseTablesAccessed, normalizeQuery, redactParams } from '../utils/sql-parser.js';
import { captureStack } from '../utils/stack.js';

export interface PrismaInstrumentOptions {
  sessionId: string;
  captureStackTraces?: boolean;
  redact?: boolean;
  onEvent: (event: DatabaseEvent) => void;
}

/**
 * Instrument a Prisma client to capture database queries.
 * Supports both Prisma v4 ($on) and v5+ ($extends).
 * Returns a restore function to remove instrumentation.
 */
export function instrumentPrisma(
  client: unknown,
  options: PrismaInstrumentOptions
): () => void {
  const prisma = client as Record<string, unknown>;
  const source: DatabaseSource = 'prisma';

  // Try v5+ $extends approach first
  if (typeof prisma.$extends === 'function') {
    // $extends returns a new client, so we monkey-patch query methods
    // For v5, we use the middleware-like $allOperations
    try {
      const extended = (prisma.$extends as Function)({
        query: {
          $allOperations({ operation, model, args, query }: {
            operation: string;
            model: string;
            args: unknown;
            query: (args: unknown) => Promise<unknown>;
          }) {
            const start = performance.now();
            return (query as Function)(args).then((result: unknown) => {
              const duration = performance.now() - start;
              const queryStr = `prisma.${model}.${operation}(${JSON.stringify(args).slice(0, 200)})`;
              options.onEvent({
                eventId: generateId(),
                sessionId: options.sessionId,
                timestamp: Date.now(),
                eventType: 'database',
                query: queryStr,
                normalizedQuery: `prisma.${model}.${operation}(?)`,
                duration,
                tablesAccessed: model ? [model.toLowerCase()] : [],
                operation: mapPrismaOperation(operation),
                source,
                stackTrace: options.captureStackTraces ? captureStack() : undefined,
                rowsReturned: Array.isArray(result) ? result.length : undefined,
              });
              return result;
            }).catch((err: Error) => {
              const duration = performance.now() - start;
              const queryStr = `prisma.${model}.${operation}(${JSON.stringify(args).slice(0, 200)})`;
              options.onEvent({
                eventId: generateId(),
                sessionId: options.sessionId,
                timestamp: Date.now(),
                eventType: 'database',
                query: queryStr,
                normalizedQuery: `prisma.${model}.${operation}(?)`,
                duration,
                tablesAccessed: model ? [model.toLowerCase()] : [],
                operation: mapPrismaOperation(operation),
                source,
                error: err.message,
                stackTrace: options.captureStackTraces ? captureStack() : undefined,
              });
              throw err;
            });
          },
        },
      });
      // Copy the extended client's methods back (this is a best-effort approach)
      Object.assign(prisma, extended);
      return () => {
        // $extends creates a new client; there's no clean undo for v5
      };
    } catch {
      // Fall through to $on approach
    }
  }

  // v4 approach: $on('query')
  if (typeof prisma.$on === 'function') {
    (prisma.$on as Function)('query', (e: {
      query: string;
      params: string;
      duration: number;
      target: string;
    }) => {
      options.onEvent({
        eventId: generateId(),
        sessionId: options.sessionId,
        timestamp: Date.now(),
        eventType: 'database',
        query: e.query,
        normalizedQuery: normalizeQuery(e.query),
        duration: e.duration,
        tablesAccessed: parseTablesAccessed(e.query),
        operation: parseOperation(e.query),
        source,
        params: options.redact !== false ? redactParams(JSON.parse(e.params || '[]')) : e.params,
        stackTrace: options.captureStackTraces ? captureStack() : undefined,
      });
    });
    return () => {
      // $on doesn't provide a clean unsubscribe for v4
    };
  }

  console.warn('[RuntimeScope] Prisma client does not support $on or $extends');
  return () => {};
}

function mapPrismaOperation(op: string): DatabaseEvent['operation'] {
  const lower = op.toLowerCase();
  if (lower.includes('find') || lower === 'aggregate' || lower === 'count' || lower === 'groupby') return 'SELECT';
  if (lower.includes('create') || lower === 'createMany') return 'INSERT';
  if (lower.includes('update') || lower === 'upsert') return 'UPDATE';
  if (lower.includes('delete')) return 'DELETE';
  return 'OTHER';
}
