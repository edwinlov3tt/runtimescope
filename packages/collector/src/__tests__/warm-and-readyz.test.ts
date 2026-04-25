import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../store.js';
import { SqliteStore } from '../sqlite-store.js';
import { isSqliteAvailable } from '../sqlite-check.js';
import {
  makeNetworkEvent,
  makeConsoleEvent,
  makeSessionEvent,
  resetCounter,
} from './factories.js';

describe('Phase 2: warm-from-sqlite + readiness', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rs-warm-'));
    resetCounter();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it.skipIf(!isSqliteAvailable())('warmFromSqlite loads recent events into the ring buffer', () => {
    const sqlite = new SqliteStore({ dbPath: join(dir, 'a.db') });
    // Persist some events for project "alpha"
    for (let i = 0; i < 5; i++) {
      sqlite.addEvent(makeNetworkEvent({ eventId: `n${i}`, sessionId: 'sess-A' }), 'alpha');
    }
    sqlite.addEvent(makeConsoleEvent({ eventId: 'c1', sessionId: 'sess-A' }), 'alpha');
    sqlite.flush();

    // Fresh in-memory store — empty ring buffer.
    const store = new EventStore(100);
    expect(store.eventCount).toBe(0);

    store.warmFromSqlite(sqlite, 'alpha', 100);

    // 5 network + 1 console = 6 events warmed.
    expect(store.eventCount).toBe(6);

    sqlite.close();
  });

  it.skipIf(!isSqliteAvailable())('warmFromSqlite reconstructs session metadata for warmed sessions', () => {
    const sqlite = new SqliteStore({ dbPath: join(dir, 'b.db') });
    sqlite.addEvent(
      makeSessionEvent({ sessionId: 'sess-recovered', appName: 'my-app', sdkVersion: '0.10.1' }),
      'beta',
    );
    sqlite.addEvent(
      makeNetworkEvent({ sessionId: 'sess-recovered', eventId: 'after-session' }),
      'beta',
    );
    sqlite.flush();

    const store = new EventStore(100);
    store.warmFromSqlite(sqlite, 'beta', 100);

    const sessions = store.getSessionInfo();
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.sessionId).toBe('sess-recovered');
    expect(s.appName).toBe('my-app');
    expect(s.sdkVersion).toBe('0.10.1');
    // Recovered sessions are not currently connected — only a fresh handshake
    // marks a session as live.
    expect(s.isConnected).toBe(false);
    // eventCount should reflect the non-session event we warmed in.
    expect(s.eventCount).toBe(1);

    sqlite.close();
  });

  it.skipIf(!isSqliteAvailable())('warmFromSqlite respects the limit and prefers most-recent events', () => {
    const sqlite = new SqliteStore({ dbPath: join(dir, 'c.db') });
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      sqlite.addEvent(
        makeNetworkEvent({ eventId: `e${i}`, timestamp: now - (20 - i) * 1000 }),
        'gamma',
      );
    }
    sqlite.flush();

    const store = new EventStore(100);
    store.warmFromSqlite(sqlite, 'gamma', 5);

    expect(store.eventCount).toBe(5);
    // Newest 5 events should be e15..e19 (most recent timestamps).
    const all = store.getAllEvents();
    const ids = all.map((e) => e.eventId);
    expect(ids).toEqual(['e15', 'e16', 'e17', 'e18', 'e19']);

    sqlite.close();
  });

  it.skipIf(!isSqliteAvailable())('warmFromSqlite does not write back to SqliteStore (no infinite loop)', () => {
    const sqlite = new SqliteStore({ dbPath: join(dir, 'd.db') });
    sqlite.addEvent(makeNetworkEvent({ eventId: 'only' }), 'delta');
    sqlite.flush();

    const before = sqlite.getEventCount({ project: 'delta' });
    expect(before).toBe(1);

    const store = new EventStore(100);
    store.warmFromSqlite(sqlite, 'delta', 100);
    // Force any pending writes — there should be none.
    sqlite.flush();

    const after = sqlite.getEventCount({ project: 'delta' });
    expect(after).toBe(1);

    sqlite.close();
  });
});

describe('Phase 2: SqliteStore.getRecentEvents', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rs-recent-'));
    resetCounter();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it.skipIf(!isSqliteAvailable())('returns events oldest-first within the requested window', () => {
    const sqlite = new SqliteStore({ dbPath: join(dir, 'r.db') });
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      sqlite.addEvent(
        makeNetworkEvent({ eventId: `n${i}`, timestamp: now - (10 - i) * 1000 }),
        'p',
      );
    }
    sqlite.flush();

    const recent = sqlite.getRecentEvents('p', 3);
    expect(recent).toHaveLength(3);
    // Most recent 3 are n7, n8, n9 — and the helper returns them oldest-first.
    expect(recent.map((e) => e.eventId)).toEqual(['n7', 'n8', 'n9']);

    sqlite.close();
  });

  it.skipIf(!isSqliteAvailable())('scopes to the project filter', () => {
    const sqlite = new SqliteStore({ dbPath: join(dir, 'r2.db') });
    sqlite.addEvent(makeNetworkEvent({ eventId: 'a' }), 'one');
    sqlite.addEvent(makeNetworkEvent({ eventId: 'b' }), 'two');
    sqlite.addEvent(makeNetworkEvent({ eventId: 'c' }), 'one');
    sqlite.flush();

    const r1 = sqlite.getRecentEvents('one', 100);
    const r2 = sqlite.getRecentEvents('two', 100);
    expect(r1.map((e) => e.eventId).sort()).toEqual(['a', 'c']);
    expect(r2.map((e) => e.eventId)).toEqual(['b']);

    sqlite.close();
  });
});
