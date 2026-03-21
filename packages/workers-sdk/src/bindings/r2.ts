import type { R2BucketBinding, R2Object, R2ObjectBody, R2Objects, DatabaseEvent } from '../types.js';
import { generateId } from '../utils.js';

// ============================================================
// R2 Bucket Wrapper
// Wraps an R2Bucket to capture get/put/delete/list/head operations.
// Events emitted as 'database' type with source: 'r2'.
// ============================================================

type EmitFn = (event: DatabaseEvent) => void;

interface R2InstrumentOptions {
  sessionId: string;
}

/**
 * Wrap an R2 bucket binding to capture operations.
 *
 * @example
 * ```ts
 * const bucket = instrumentR2(env.MY_BUCKET, emit, { sessionId });
 * await bucket.put('file.txt', 'contents');
 * ```
 */
export function instrumentR2(
  bucket: R2BucketBinding,
  emit: EmitFn,
  options: R2InstrumentOptions,
): R2BucketBinding {
  function sanitizeKey(key: string): string {
    const safe = key.length > 200 ? key.slice(0, 200) + '…' : key;
    return safe.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  function emitOp(op: string, key: string, start: number, duration: number, extra: Partial<DatabaseEvent> = {}): void {
    emit({
      eventId: generateId(),
      sessionId: options.sessionId,
      timestamp: start,
      eventType: 'database',
      query: `R2.${op}("${sanitizeKey(key)}")`,
      normalizedQuery: `R2.${op}(?)`,
      duration,
      tablesAccessed: [],
      operation: op === 'get' || op === 'list' || op === 'head' ? 'SELECT' : op === 'put' ? 'INSERT' : op === 'delete' ? 'DELETE' : 'OTHER',
      source: 'r2',
      ...extra,
    });
  }

  return {
    async get(key: string, r2Options?: unknown): Promise<R2ObjectBody | null> {
      const start = Date.now();
      try {
        const result = await bucket.get(key, r2Options);
        emitOp('get', key, start, Date.now() - start, {
          rowsReturned: result !== null ? 1 : 0,
          label: result ? `${result.size} bytes` : undefined,
        });
        return result;
      } catch (err) {
        emitOp('get', key, start, Date.now() - start, { error: (err as Error).message });
        throw err;
      }
    },

    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      r2Options?: unknown,
    ): Promise<R2Object | null> {
      const start = Date.now();
      try {
        const result = await bucket.put(key, value, r2Options);
        emitOp('put', key, start, Date.now() - start, {
          rowsAffected: 1,
          label: result ? `${result.size} bytes` : undefined,
        });
        return result;
      } catch (err) {
        emitOp('put', key, start, Date.now() - start, { error: (err as Error).message });
        throw err;
      }
    },

    async delete(keys: string | string[]): Promise<void> {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const keyLabel = keyList.length === 1 ? keyList[0] : `${keyList.length} keys`;
      const start = Date.now();
      try {
        await bucket.delete(keys);
        emitOp('delete', keyLabel, start, Date.now() - start, { rowsAffected: keyList.length });
      } catch (err) {
        emitOp('delete', keyLabel, start, Date.now() - start, { error: (err as Error).message });
        throw err;
      }
    },

    async list(r2Options?: unknown): Promise<R2Objects> {
      const start = Date.now();
      try {
        const result = await bucket.list(r2Options);
        emitOp('list', '*', start, Date.now() - start, { rowsReturned: result.objects.length });
        return result;
      } catch (err) {
        emitOp('list', '*', start, Date.now() - start, { error: (err as Error).message });
        throw err;
      }
    },

    async head(key: string): Promise<R2Object | null> {
      const start = Date.now();
      try {
        const result = await bucket.head(key);
        emitOp('head', key, start, Date.now() - start, {
          rowsReturned: result !== null ? 1 : 0,
          label: result ? `${result.size} bytes` : undefined,
        });
        return result;
      } catch (err) {
        emitOp('head', key, start, Date.now() - start, { error: (err as Error).message });
        throw err;
      }
    },
  };
}
