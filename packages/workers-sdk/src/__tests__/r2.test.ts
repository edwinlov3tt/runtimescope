import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { instrumentR2 } from '../bindings/r2.js';
import type { R2BucketBinding, R2Object, R2ObjectBody, DatabaseEvent } from '../types.js';

beforeEach(() => {
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeR2Object(key: string, size: number): R2Object {
  return { key, size, etag: 'abc', httpEtag: '"abc"', uploaded: new Date() };
}

function makeR2Body(key: string, size: number): R2ObjectBody {
  return {
    ...makeR2Object(key, size),
    body: new ReadableStream(),
    bodyUsed: false,
    arrayBuffer: vi.fn(),
    text: vi.fn(),
    json: vi.fn(),
    blob: vi.fn(),
  } as unknown as R2ObjectBody;
}

function mockR2(): R2BucketBinding {
  return {
    get: vi.fn().mockResolvedValue(makeR2Body('file.txt', 1024)),
    put: vi.fn().mockResolvedValue(makeR2Object('file.txt', 1024)),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({
      objects: [makeR2Object('a.txt', 100), makeR2Object('b.txt', 200)],
      truncated: false,
      delimitedPrefixes: [],
    }),
    head: vi.fn().mockResolvedValue(makeR2Object('file.txt', 1024)),
  };
}

describe('instrumentR2', () => {
  it('should capture get operations with size', async () => {
    const events: DatabaseEvent[] = [];
    const bucket = mockR2();
    const instrumented = instrumentR2(bucket, (e) => events.push(e), { sessionId: 'sess-1' });

    const result = await instrumented.get('file.txt');

    expect(result).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('r2');
    expect(events[0].operation).toBe('SELECT');
    expect(events[0].query).toContain('R2.get');
    expect(events[0].label).toBe('1024 bytes');
    expect(events[0].rowsReturned).toBe(1);
  });

  it('should capture get returning null', async () => {
    const events: DatabaseEvent[] = [];
    const bucket = mockR2();
    (bucket.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const instrumented = instrumentR2(bucket, (e) => events.push(e), { sessionId: 'sess-1' });

    const result = await instrumented.get('missing.txt');

    expect(result).toBeNull();
    expect(events[0].rowsReturned).toBe(0);
    expect(events[0].label).toBeUndefined();
  });

  it('should capture put operations', async () => {
    const events: DatabaseEvent[] = [];
    const bucket = mockR2();
    const instrumented = instrumentR2(bucket, (e) => events.push(e), { sessionId: 'sess-1' });

    await instrumented.put('upload.txt', 'file contents');

    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('INSERT');
    expect(events[0].rowsAffected).toBe(1);
    expect(events[0].label).toBe('1024 bytes');
  });

  it('should capture single-key delete', async () => {
    const events: DatabaseEvent[] = [];
    const bucket = mockR2();
    const instrumented = instrumentR2(bucket, (e) => events.push(e), { sessionId: 'sess-1' });

    await instrumented.delete('old.txt');

    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('DELETE');
    expect(events[0].rowsAffected).toBe(1);
  });

  it('should capture batch delete with count', async () => {
    const events: DatabaseEvent[] = [];
    const bucket = mockR2();
    const instrumented = instrumentR2(bucket, (e) => events.push(e), { sessionId: 'sess-1' });

    await instrumented.delete(['a.txt', 'b.txt', 'c.txt']);

    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('DELETE');
    expect(events[0].rowsAffected).toBe(3);
    expect(events[0].query).toContain('3 keys');
  });

  it('should capture list operations', async () => {
    const events: DatabaseEvent[] = [];
    const bucket = mockR2();
    const instrumented = instrumentR2(bucket, (e) => events.push(e), { sessionId: 'sess-1' });

    const result = await instrumented.list();

    expect(result.objects).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('SELECT');
    expect(events[0].rowsReturned).toBe(2);
  });

  it('should capture head operations', async () => {
    const events: DatabaseEvent[] = [];
    const bucket = mockR2();
    const instrumented = instrumentR2(bucket, (e) => events.push(e), { sessionId: 'sess-1' });

    const result = await instrumented.head('file.txt');

    expect(result).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('SELECT');
    expect(events[0].label).toBe('1024 bytes');
  });

  it('should capture errors and re-throw', async () => {
    const events: DatabaseEvent[] = [];
    const bucket = mockR2();
    (bucket.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('R2 error'));
    const instrumented = instrumentR2(bucket, (e) => events.push(e), { sessionId: 'sess-1' });

    await expect(instrumented.get('bad.txt')).rejects.toThrow('R2 error');
    expect(events).toHaveLength(1);
    expect(events[0].error).toBe('R2 error');
  });

  it('should sanitize keys with special characters', async () => {
    const events: DatabaseEvent[] = [];
    const bucket = mockR2();
    const instrumented = instrumentR2(bucket, (e) => events.push(e), { sessionId: 'sess-1' });

    await instrumented.get('path/"file"\nname');

    expect(events[0].query).toContain('path/\\"file\\"\\nname');
  });
});
