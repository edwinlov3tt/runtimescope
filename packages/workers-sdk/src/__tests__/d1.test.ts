import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { instrumentD1 } from '../bindings/d1.js';
import type { D1DatabaseBinding, D1PreparedStatementBinding, DatabaseEvent } from '../types.js';

beforeEach(() => {
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockD1(): D1DatabaseBinding {
  const mockStmt: D1PreparedStatementBinding = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue({ id: 1, name: 'Alice' }),
    run: vi.fn().mockResolvedValue({
      results: [],
      success: true,
      meta: { duration: 5, rows_read: 0, rows_written: 1, last_row_id: 1, changed_db: true, size_after: 1024, changes: 1 },
    }),
    all: vi.fn().mockResolvedValue({
      results: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
      success: true,
      meta: { duration: 3, rows_read: 2, rows_written: 0, last_row_id: 0, changed_db: false, size_after: 1024, changes: 0 },
    }),
    raw: vi.fn().mockResolvedValue([[1, 'Alice'], [2, 'Bob']]),
  };

  return {
    prepare: vi.fn(() => mockStmt),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue({ count: 5, duration: 10 }),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  };
}

describe('instrumentD1', () => {
  it('should capture SELECT queries via .all()', async () => {
    const events: DatabaseEvent[] = [];
    const emit = (e: DatabaseEvent) => events.push(e);
    const db = mockD1();
    const instrumented = instrumentD1(db, emit, { sessionId: 'test-session' });

    const result = await instrumented.prepare('SELECT * FROM users').all();

    expect(result.results).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('database');
    expect(events[0].source).toBe('d1');
    expect(events[0].operation).toBe('SELECT');
    expect(events[0].query).toBe('SELECT * FROM users');
    expect(events[0].tablesAccessed).toContain('users');
    expect(events[0].rowsReturned).toBe(2);
    expect(events[0].duration).toBeGreaterThanOrEqual(0);
  });

  it('should capture INSERT queries via .run()', async () => {
    const events: DatabaseEvent[] = [];
    const emit = (e: DatabaseEvent) => events.push(e);
    const db = mockD1();
    const instrumented = instrumentD1(db, emit, { sessionId: 'test-session' });

    await instrumented.prepare('INSERT INTO users (name) VALUES (?)').bind('Charlie').run();

    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('INSERT');
    expect(events[0].tablesAccessed).toContain('users');
    expect(events[0].rowsAffected).toBe(1);
  });

  it('should capture .first() queries', async () => {
    const events: DatabaseEvent[] = [];
    const emit = (e: DatabaseEvent) => events.push(e);
    const db = mockD1();
    const instrumented = instrumentD1(db, emit, { sessionId: 'test-session' });

    const result = await instrumented.prepare('SELECT * FROM users WHERE id = 1').first();

    expect(result).toEqual({ id: 1, name: 'Alice' });
    expect(events).toHaveLength(1);
    expect(events[0].rowsReturned).toBe(1);
  });

  it('should capture .exec() calls', async () => {
    const events: DatabaseEvent[] = [];
    const emit = (e: DatabaseEvent) => events.push(e);
    const db = mockD1();
    const instrumented = instrumentD1(db, emit, { sessionId: 'test-session' });

    const result = await instrumented.exec('DROP TABLE temp');

    expect(result.count).toBe(5);
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('OTHER');
    expect(events[0].rowsAffected).toBe(5);
  });

  it('should capture batch operations', async () => {
    const events: DatabaseEvent[] = [];
    const emit = (e: DatabaseEvent) => events.push(e);
    const db = mockD1();
    const instrumented = instrumentD1(db, emit, { sessionId: 'test-session' });

    const stmt1 = db.prepare('INSERT INTO users VALUES (?)');
    const stmt2 = db.prepare('INSERT INTO users VALUES (?)');
    await instrumented.batch([stmt1, stmt2]);

    expect(events).toHaveLength(1);
    expect(events[0].query).toContain('BATCH');
    expect(events[0].query).toContain('2 statements');
  });

  it('should capture errors', async () => {
    const events: DatabaseEvent[] = [];
    const emit = (e: DatabaseEvent) => events.push(e);

    const db = mockD1();
    const mockStmt = db.prepare('SELECT 1') as unknown as { all: ReturnType<typeof vi.fn> };
    mockStmt.all = vi.fn().mockRejectedValue(new Error('D1_ERROR: no such table'));

    const instrumented = instrumentD1(db, emit, { sessionId: 'test-session' });

    await expect(instrumented.prepare('SELECT * FROM missing_table').all()).rejects.toThrow('D1_ERROR');

    expect(events).toHaveLength(1);
    expect(events[0].error).toBe('D1_ERROR: no such table');
  });

  it('should normalize queries', async () => {
    const events: DatabaseEvent[] = [];
    const emit = (e: DatabaseEvent) => events.push(e);
    const db = mockD1();
    const instrumented = instrumentD1(db, emit, { sessionId: 'test-session' });

    await instrumented.prepare("SELECT * FROM users WHERE id = 42 AND name = 'Alice'").all();

    expect(events[0].normalizedQuery).toBe('SELECT * FROM users WHERE id = ? AND name = ?');
  });

  it('should pass through dump() without instrumentation', async () => {
    const events: DatabaseEvent[] = [];
    const emit = (e: DatabaseEvent) => events.push(e);
    const db = mockD1();
    const instrumented = instrumentD1(db, emit, { sessionId: 'test-session' });

    await instrumented.dump();

    expect(events).toHaveLength(0);
    expect(db.dump).toHaveBeenCalled();
  });
});
