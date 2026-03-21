import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { instrumentKV } from '../bindings/kv.js';
import type { KVNamespaceBinding, DatabaseEvent } from '../types.js';

beforeEach(() => {
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockKV(): KVNamespaceBinding {
  return {
    get: vi.fn().mockResolvedValue('value-data'),
    getWithMetadata: vi.fn().mockResolvedValue({ value: 'val', metadata: { ttl: 60 } }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [{ name: 'a' }, { name: 'b' }], list_complete: true }),
  };
}

describe('instrumentKV', () => {
  it('should capture get operations', async () => {
    const events: DatabaseEvent[] = [];
    const kv = mockKV();
    const instrumented = instrumentKV(kv, (e) => events.push(e), { sessionId: 'sess-1' });

    const result = await instrumented.get('my-key');

    expect(result).toBe('value-data');
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('kv');
    expect(events[0].operation).toBe('SELECT');
    expect(events[0].query).toContain('KV.get');
    expect(events[0].query).toContain('my-key');
    expect(events[0].rowsReturned).toBe(1);
  });

  it('should capture get returning null', async () => {
    const events: DatabaseEvent[] = [];
    const kv = mockKV();
    (kv.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const instrumented = instrumentKV(kv, (e) => events.push(e), { sessionId: 'sess-1' });

    await instrumented.get('missing');

    expect(events[0].rowsReturned).toBe(0);
  });

  it('should capture put operations', async () => {
    const events: DatabaseEvent[] = [];
    const kv = mockKV();
    const instrumented = instrumentKV(kv, (e) => events.push(e), { sessionId: 'sess-1' });

    await instrumented.put('key', 'value');

    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('INSERT');
    expect(events[0].rowsAffected).toBe(1);
  });

  it('should capture delete operations', async () => {
    const events: DatabaseEvent[] = [];
    const kv = mockKV();
    const instrumented = instrumentKV(kv, (e) => events.push(e), { sessionId: 'sess-1' });

    await instrumented.delete('old-key');

    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('DELETE');
    expect(events[0].rowsAffected).toBe(1);
  });

  it('should capture list operations with row count', async () => {
    const events: DatabaseEvent[] = [];
    const kv = mockKV();
    const instrumented = instrumentKV(kv, (e) => events.push(e), { sessionId: 'sess-1' });

    const result = await instrumented.list();

    expect(result.keys).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('SELECT');
    expect(events[0].rowsReturned).toBe(2);
  });

  it('should capture getWithMetadata operations', async () => {
    const events: DatabaseEvent[] = [];
    const kv = mockKV();
    const instrumented = instrumentKV(kv, (e) => events.push(e), { sessionId: 'sess-1' });

    const result = await instrumented.getWithMetadata('meta-key');

    expect(result.value).toBe('val');
    expect(result.metadata).toEqual({ ttl: 60 });
    expect(events).toHaveLength(1);
    expect(events[0].rowsReturned).toBe(1);
  });

  it('should capture errors and re-throw', async () => {
    const events: DatabaseEvent[] = [];
    const kv = mockKV();
    (kv.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('KV error'));
    const instrumented = instrumentKV(kv, (e) => events.push(e), { sessionId: 'sess-1' });

    await expect(instrumented.get('bad-key')).rejects.toThrow('KV error');
    expect(events).toHaveLength(1);
    expect(events[0].error).toBe('KV error');
  });

  it('should sanitize keys with special characters', async () => {
    const events: DatabaseEvent[] = [];
    const kv = mockKV();
    const instrumented = instrumentKV(kv, (e) => events.push(e), { sessionId: 'sess-1' });

    await instrumented.get('key"with\nnewline');

    expect(events[0].query).toContain('key\\"with\\nnewline');
    expect(events[0].query).not.toContain('\n');
  });

  it('should truncate very long keys', async () => {
    const events: DatabaseEvent[] = [];
    const kv = mockKV();
    const instrumented = instrumentKV(kv, (e) => events.push(e), { sessionId: 'sess-1' });

    const longKey = 'x'.repeat(300);
    await instrumented.get(longKey);

    expect(events[0].query.length).toBeLessThan(300);
    expect(events[0].query).toContain('…');
  });
});
