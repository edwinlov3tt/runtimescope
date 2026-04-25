import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CollectorServer,
  HttpServer,
  EventStore,
  SqliteStore,
  Wal,
  AuthManager,
  ProjectManager,
  isSqliteAvailable,
} from '../index.js';
import { makeNetworkEvent } from './factories.js';

describe('Phase 3: SqliteStore.snapshotTo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rs-snap-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it.skipIf(!isSqliteAvailable())('writes a self-contained DB copy via VACUUM INTO', () => {
    const src = new SqliteStore({ dbPath: join(dir, 'src.db') });
    for (let i = 0; i < 5; i++) {
      src.addEvent(makeNetworkEvent({ eventId: `e${i}` }), 'p');
    }
    src.flush();

    const snapshotPath = join(dir, 'snapshot.db');
    const bytes = src.snapshotTo(snapshotPath);
    expect(bytes).toBeGreaterThan(0);
    expect(existsSync(snapshotPath)).toBe(true);

    // The snapshot is a real SQLite DB — open it and verify the same events.
    const snap = new SqliteStore({ dbPath: snapshotPath });
    const recovered = snap.getEvents({ project: 'p' });
    expect(recovered).toHaveLength(5);
    snap.close();

    src.close();
  });

  it.skipIf(!isSqliteAvailable())('refuses to overwrite an existing target file', () => {
    const src = new SqliteStore({ dbPath: join(dir, 'src.db') });
    src.addEvent(makeNetworkEvent({ eventId: 'a' }), 'p');
    src.flush();

    const target = join(dir, 'existing.db');
    src.snapshotTo(target);
    expect(() => src.snapshotTo(target)).toThrow();

    src.close();
  });
});

describe('Phase 3: Wal.snapshotTo', () => {
  let dir: string;
  let snapDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rs-walsnap-src-'));
    snapDir = mkdtempSync(join(tmpdir(), 'rs-walsnap-dst-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(snapDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('copies active.jsonl into the target dir', () => {
    const wal = new Wal({ dir });
    wal.append([makeNetworkEvent({ eventId: 'in-active' })]);
    wal.commit();

    const target = join(snapDir, 'wal');
    const bytes = wal.snapshotTo(target);
    expect(bytes).toBeGreaterThan(0);
    expect(existsSync(join(target, 'active.jsonl'))).toBe(true);

    const events = Wal.readFile(join(target, 'active.jsonl'));
    expect(events.map((e) => e.eventId)).toEqual(['in-active']);

    wal.close();
  });

  it('copies sealed files alongside the active file', () => {
    const wal = new Wal({ dir });
    wal.append([makeNetworkEvent({ eventId: 'sealed-1' })]);
    wal.commit();
    wal.rotate();
    wal.append([makeNetworkEvent({ eventId: 'still-active' })]);
    wal.commit();

    wal.snapshotTo(join(snapDir, 'wal'));
    const files = readdirSync(join(snapDir, 'wal')).sort();
    expect(files.length).toBe(2);
    expect(files).toContain('active.jsonl');
    expect(files.some((f) => f.startsWith('sealed-'))).toBe(true);

    wal.close();
  });

  it('does not copy an empty active file (no useless artifact)', () => {
    const wal = new Wal({ dir });
    // No appends — active file exists but is empty.
    wal.snapshotTo(join(snapDir, 'wal'));
    const files = existsSync(join(snapDir, 'wal'))
      ? readdirSync(join(snapDir, 'wal'))
      : [];
    expect(files).toEqual([]);
    wal.close();
  });
});

describe('Phase 3: CollectorServer.createSnapshot', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'rs-collector-snap-'));
  });

  afterEach(() => {
    try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it.skipIf(!isSqliteAvailable())('writes per-project SQLite + WAL + manifest into a fresh dir', async () => {
    const projectManager = new ProjectManager(rootDir);
    projectManager.ensureGlobalDir();

    const collector = new CollectorServer({ bufferSize: 100, projectManager });
    await collector.start({ port: 0, maxRetries: 0 });

    // Force a project + persist some events through the SqliteStore + WAL.
    projectManager.ensureProjectDir('alpha');
    const dbPath = projectManager.getProjectDbPath('alpha');
    const sqliteStore = new SqliteStore({ dbPath });
    sqliteStore.addEvent(makeNetworkEvent({ eventId: 'persisted-1' }), 'alpha');
    sqliteStore.addEvent(makeNetworkEvent({ eventId: 'persisted-2' }), 'alpha');
    sqliteStore.flush();
    // Plug the SqliteStore into the collector so createSnapshot picks it up.
    (collector as unknown as { sqliteStores: Map<string, SqliteStore> })
      .sqliteStores.set('alpha', sqliteStore);

    // Pre-create a WAL with an unflushed entry so the snapshot proves both
    // tiers are captured.
    const walDir = join(rootDir, 'projects', 'alpha', 'wal');
    const wal = new Wal({ dir: walDir });
    wal.append([makeNetworkEvent({ eventId: 'in-wal' })]);
    wal.commit();
    (collector as unknown as { wals: Map<string, Wal> }).wals.set('alpha', wal);

    const result = collector.createSnapshot();
    expect(existsSync(result.path)).toBe(true);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].name).toBe('alpha');
    expect(result.projects[0].sqliteBytes).toBeGreaterThan(0);
    expect(result.projects[0].walBytes).toBeGreaterThan(0);
    expect(result.projects[0].eventCount).toBe(2);
    expect(result.totalBytes).toBeGreaterThan(0);

    // Manifest is written.
    const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8'));
    expect(manifest.projects[0].name).toBe('alpha');

    // SQLite snapshot is openable + correct.
    const snap = new SqliteStore({ dbPath: join(result.path, 'alpha', 'events.db') });
    expect(snap.getEvents({ project: 'alpha' }).map((e) => e.eventId).sort()).toEqual([
      'persisted-1',
      'persisted-2',
    ]);
    snap.close();

    // WAL snapshot includes the un-flushed event.
    const walSnap = Wal.readFile(join(result.path, 'alpha', 'wal', 'active.jsonl'));
    expect(walSnap.map((e) => e.eventId)).toEqual(['in-wal']);

    sqliteStore.close();
    wal.close();
    collector.stop();
  });

  it('throws when projectManager is not configured', () => {
    const collector = new CollectorServer({ bufferSize: 100 });
    expect(() => collector.createSnapshot()).toThrow(/projectManager/);
  });
});

describe('Phase 3: POST /api/v1/admin/snapshot', () => {
  let httpServer: HttpServer | null = null;

  afterEach(async () => {
    try { await httpServer?.stop(); } catch { /* ignore */ }
    httpServer = null;
    await new Promise((r) => setTimeout(r, 30));
  });

  it('rejects non-admin callers with 403', async () => {
    const store = new EventStore(100);
    httpServer = new HttpServer(store, undefined, {
      authManager: new AuthManager({ enabled: true, apiKeys: [{ key: 'k_admin', label: 'a' }] }),
      createSnapshot: () => ({
        path: '/tmp/x',
        timestamp: 't',
        projects: [],
        totalBytes: 0,
      }),
    });
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    // No bearer token at all → 401 first.
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/v1/admin/snapshot`, { method: 'POST' });
    expect(noAuth.status).toBe(401);

    // Valid (admin) token → 201.
    const adminRes = await fetch(`http://127.0.0.1:${port}/api/v1/admin/snapshot`, {
      method: 'POST',
      headers: { authorization: 'Bearer k_admin' },
    });
    expect(adminRes.status).toBe(201);
  });

  it('returns 501 when the collector does not provide createSnapshot', async () => {
    const store = new EventStore(100);
    httpServer = new HttpServer(store, undefined, {
      // No createSnapshot — auth disabled so caller is admin by default.
    });
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/snapshot`, { method: 'POST' });
    expect(res.status).toBe(501);
  });

  it('rate-limits successive snapshots with 429 + Retry-After', async () => {
    const store = new EventStore(100);
    httpServer = new HttpServer(store, undefined, {
      createSnapshot: () => ({
        path: '/tmp/snap',
        timestamp: 't',
        projects: [],
        totalBytes: 0,
      }),
    });
    await httpServer.start({ port: 0 });
    const port = httpServer.getPort();

    const first = await fetch(`http://127.0.0.1:${port}/api/v1/admin/snapshot`, { method: 'POST' });
    expect(first.status).toBe(201);

    const second = await fetch(`http://127.0.0.1:${port}/api/v1/admin/snapshot`, { method: 'POST' });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
    const body = await second.json();
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });
});
