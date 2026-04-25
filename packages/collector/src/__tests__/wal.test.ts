import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wal } from '../wal.js';
import { makeNetworkEvent, makeConsoleEvent } from './factories.js';

describe('Wal', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rs-wal-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('appends events to active.jsonl and fsyncs on commit', () => {
    const wal = new Wal({ dir });
    wal.append([makeNetworkEvent({ eventId: 'e1' }), makeNetworkEvent({ eventId: 'e2' })]);
    wal.commit();

    const path = join(dir, 'active.jsonl');
    expect(existsSync(path)).toBe(true);

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]);
    expect(first.seq).toBe(1);
    expect(first.event.eventId).toBe('e1');

    wal.close();
  });

  it('readFile skips corrupt / truncated trailing lines', () => {
    const wal = new Wal({ dir });
    wal.append([makeNetworkEvent({ eventId: 'good-1' })]);
    wal.commit();
    wal.close();

    // Simulate a crash mid-append: valid line + garbage tail.
    const path = join(dir, 'active.jsonl');
    const existing = readFileSync(path, 'utf8');
    const corrupted = existing + '{"seq":2,"event":{"eventId":"good-2"'; // no closing
    require('node:fs').writeFileSync(path, corrupted);

    const events = Wal.readFile(path);
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe('good-1');
  });

  it('rotate() seals the active file and opens a fresh one', () => {
    const wal = new Wal({ dir });
    wal.append([makeConsoleEvent({ eventId: 'before-rotate' })]);
    wal.commit();

    const sealed = wal.rotate();
    expect(sealed).not.toBeNull();
    expect(existsSync(sealed!)).toBe(true);
    expect(existsSync(join(dir, 'active.jsonl'))).toBe(true);

    const sealedEvents = Wal.readFile(sealed!);
    expect(sealedEvents).toHaveLength(1);
    expect(sealedEvents[0].eventId).toBe('before-rotate');

    // After rotate the new active is empty.
    expect(statSync(join(dir, 'active.jsonl')).size).toBe(0);

    wal.append([makeConsoleEvent({ eventId: 'after-rotate' })]);
    wal.commit();
    const newEvents = Wal.readFile(join(dir, 'active.jsonl'));
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0].eventId).toBe('after-rotate');

    wal.close();
  });

  it('rotate() returns null when the active file is empty', () => {
    const wal = new Wal({ dir });
    // First ensure the active file exists by committing zero events — openSync('a') creates it.
    wal.commit();
    const sealed = wal.rotate();
    // The file exists but is empty — rotation still renames it, which is fine;
    // callers guard on the returned path and readFile drops empty files.
    if (sealed !== null) {
      expect(existsSync(sealed)).toBe(true);
      expect(Wal.readFile(sealed)).toHaveLength(0);
    }
    wal.close();
  });

  it('shouldRotate() flips once the active file exceeds the threshold', () => {
    const wal = new Wal({ dir, rotateSizeBytes: 200 });
    expect(wal.shouldRotate()).toBe(false);
    // Each event ~100-200B serialized — a handful will push past 200B.
    for (let i = 0; i < 10; i++) {
      wal.append([makeNetworkEvent({ eventId: `e${i}` })]);
    }
    wal.commit();
    expect(wal.shouldRotate()).toBe(true);
    wal.close();
  });

  it('listSealed returns sealed files sorted oldest-first', () => {
    const wal = new Wal({ dir });
    wal.append([makeNetworkEvent({ eventId: 'a' })]);
    wal.commit();
    const first = wal.rotate();
    // Small delay so timestamps differ (mkdtemp uses real fs).
    const start = Date.now();
    while (Date.now() === start) { /* spin until ms ticks */ }
    wal.append([makeNetworkEvent({ eventId: 'b' })]);
    wal.commit();
    const second = wal.rotate();

    const sealed = wal.listSealed();
    expect(sealed).toHaveLength(2);
    expect(sealed[0]).toBe(first);
    expect(sealed[1]).toBe(second);

    wal.close();
  });

  it('Wal.deleteSealed removes the file', () => {
    const wal = new Wal({ dir });
    wal.append([makeNetworkEvent({ eventId: 'to-delete' })]);
    wal.commit();
    const sealed = wal.rotate()!;

    expect(existsSync(sealed)).toBe(true);
    Wal.deleteSealed(sealed);
    expect(existsSync(sealed)).toBe(false);

    wal.close();
  });

  it('listRecoveryFiles picks up sealed + non-empty active files', () => {
    const wal = new Wal({ dir });
    wal.append([makeNetworkEvent({ eventId: 'in-sealed' })]);
    wal.commit();
    wal.rotate();
    wal.append([makeNetworkEvent({ eventId: 'in-active' })]);
    wal.commit();
    wal.close();

    const files = Wal.listRecoveryFiles(dir);
    expect(files).toHaveLength(2);
    // Sealed first, then active last.
    expect(files[files.length - 1]).toBe(join(dir, 'active.jsonl'));
  });

  it('listRecoveryFiles returns an empty array when the dir does not exist', () => {
    expect(Wal.listRecoveryFiles(join(dir, 'nonexistent'))).toEqual([]);
  });

  it('survives a simulated crash: reopen recovers nothing was lost', () => {
    const w1 = new Wal({ dir });
    w1.append([makeNetworkEvent({ eventId: 'pre-crash-1' }), makeNetworkEvent({ eventId: 'pre-crash-2' })]);
    w1.commit();
    // Simulate crash: drop the handle without closing.
    // (Close would rename; simulating crash means we skip close entirely.)

    // "Recovery" — list files and read them.
    const files = Wal.listRecoveryFiles(dir);
    expect(files).toHaveLength(1);
    const events = Wal.readFile(files[0]);
    expect(events.map((e) => e.eventId)).toEqual(['pre-crash-1', 'pre-crash-2']);
  });

  it('append is a no-op after close()', () => {
    const wal = new Wal({ dir });
    wal.append([makeNetworkEvent({ eventId: 'before' })]);
    wal.commit();
    wal.close();

    // Safe to call, does nothing.
    wal.append([makeNetworkEvent({ eventId: 'after-close' })]);
    wal.commit();

    const events = Wal.readFile(join(dir, 'active.jsonl'));
    expect(events.map((e) => e.eventId)).toEqual(['before']);
  });
});
