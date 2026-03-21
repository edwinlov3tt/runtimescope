import type { KVNamespaceBinding, DatabaseEvent } from '../types.js';
import { generateId } from '../utils.js';

// ============================================================
// KV Namespace Wrapper
// Wraps a KVNamespace to capture get/put/delete/list operations.
// Events emitted as 'database' type with source: 'kv'.
// ============================================================

type EmitFn = (event: DatabaseEvent) => void;

interface KVInstrumentOptions {
  sessionId: string;
}

/**
 * Wrap a KV namespace binding to capture operations.
 *
 * @example
 * ```ts
 * const kv = instrumentKV(env.MY_KV, emit, { sessionId });
 * await kv.put('key', 'value');
 * ```
 */
export function instrumentKV(
  kv: KVNamespaceBinding,
  emit: EmitFn,
  options: KVInstrumentOptions,
): KVNamespaceBinding {
  function sanitizeKey(key: string): string {
    // Truncate and escape quotes/newlines to prevent malformed query strings
    const safe = key.length > 200 ? key.slice(0, 200) + '…' : key;
    return safe.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  function emitOp(op: string, key: string, start: number, duration: number, extra: Partial<DatabaseEvent> = {}): void {
    emit({
      eventId: generateId(),
      sessionId: options.sessionId,
      timestamp: start,
      eventType: 'database',
      query: `KV.${op}("${sanitizeKey(key)}")`,
      normalizedQuery: `KV.${op}(?)`,
      duration,
      tablesAccessed: [],
      operation: op === 'get' || op === 'getWithMetadata' || op === 'list' ? 'SELECT' : op === 'put' ? 'INSERT' : op === 'delete' ? 'DELETE' : 'OTHER',
      source: 'kv',
      ...extra,
    });
  }

  return {
    async get(key: string, kvOptions?: unknown): Promise<string | null> {
      const start = Date.now();
      try {
        const result = await kv.get(key, kvOptions);
        emitOp('get', key, start, Date.now() - start, { rowsReturned: result !== null ? 1 : 0 });
        return result;
      } catch (err) {
        emitOp('get', key, start, Date.now() - start, { error: (err as Error).message });
        throw err;
      }
    },

    async getWithMetadata<M = unknown>(key: string, kvOptions?: unknown): Promise<{ value: string | null; metadata: M | null }> {
      const start = Date.now();
      try {
        const result = await kv.getWithMetadata<M>(key, kvOptions);
        emitOp('getWithMetadata', key, start, Date.now() - start, { rowsReturned: result.value !== null ? 1 : 0 });
        return result;
      } catch (err) {
        emitOp('getWithMetadata', key, start, Date.now() - start, { error: (err as Error).message });
        throw err;
      }
    },

    async put(key: string, value: string | ReadableStream | ArrayBuffer, kvOptions?: unknown): Promise<void> {
      const start = Date.now();
      try {
        await kv.put(key, value, kvOptions);
        emitOp('put', key, start, Date.now() - start, { rowsAffected: 1 });
      } catch (err) {
        emitOp('put', key, start, Date.now() - start, { error: (err as Error).message });
        throw err;
      }
    },

    async delete(key: string): Promise<void> {
      const start = Date.now();
      try {
        await kv.delete(key);
        emitOp('delete', key, start, Date.now() - start, { rowsAffected: 1 });
      } catch (err) {
        emitOp('delete', key, start, Date.now() - start, { error: (err as Error).message });
        throw err;
      }
    },

    async list(kvOptions?: unknown): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
      const start = Date.now();
      try {
        const result = await kv.list(kvOptions);
        emitOp('list', '*', start, Date.now() - start, { rowsReturned: result.keys.length });
        return result;
      } catch (err) {
        emitOp('list', '*', start, Date.now() - start, { error: (err as Error).message });
        throw err;
      }
    },
  };
}
