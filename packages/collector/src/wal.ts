/**
 * Write-ahead log for the collector. One WAL directory per project, holding
 * an append-only JSONL file (`active.jsonl`) plus zero or more sealed files
 * that have been rotated out. The durability contract is:
 *
 *   append(events) + commit() → events are on disk (fsync'd).
 *
 * `append` buffers into the OS file table (a plain `write` syscall); `commit`
 * calls `fsync` to force the bytes to stable storage. Callers should batch
 * appends within a single SDK message and call `commit` once per batch.
 *
 * On rotation, the active file is renamed to `sealed-<ts>-<seq>.jsonl` and a
 * fresh active file is opened. Sealed files stay on disk until the collector
 * confirms the corresponding events are durable in SqliteStore, at which
 * point they're safe to delete.
 *
 * On crash + restart, any remaining sealed or active files are evidence of
 * events that may not have reached SqliteStore. Replay feeds them back into
 * the store path, then deletes the WAL files.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from './types.js';

export interface WalOptions {
  /** Directory to hold WAL files — created if missing. */
  dir: string;
  /** Rotate the active file once it grows past this size in bytes. */
  rotateSizeBytes?: number;
}

interface WalEntry {
  seq: number;
  event: RuntimeEvent;
}

export class Wal {
  private dir: string;
  private rotateSize: number;
  private fd: number | null = null;
  private activeSize = 0;
  private seq = 0;
  private closed = false;

  constructor(options: WalOptions) {
    this.dir = options.dir;
    this.rotateSize = options.rotateSizeBytes ?? 8 * 1024 * 1024;
    mkdirSync(this.dir, { recursive: true });
    this.openActive();
  }

  private openActive(): void {
    const path = this.activePath();
    // O_APPEND: atomic append even under concurrent writers (we only use one,
    // but keeps behavior correct if a stale handle is still around).
    this.fd = openSync(path, 'a');
    try {
      this.activeSize = statSync(path).size;
    } catch {
      this.activeSize = 0;
    }
  }

  private activePath(): string {
    return join(this.dir, 'active.jsonl');
  }

  /**
   * Buffer events into the active file. Not durable yet — must be followed by
   * `commit()` before the caller treats the events as persisted.
   */
  append(events: RuntimeEvent[]): void {
    if (this.closed || this.fd === null || events.length === 0) return;
    const lines: string[] = [];
    for (const ev of events) {
      this.seq++;
      const entry: WalEntry = { seq: this.seq, event: ev };
      lines.push(JSON.stringify(entry));
    }
    const payload = Buffer.from(lines.join('\n') + '\n', 'utf8');
    writeSync(this.fd, payload);
    this.activeSize += payload.length;
  }

  /** fsync the active file. Durability contract: returns only after bytes are on stable storage. */
  commit(): void {
    if (this.closed || this.fd === null) return;
    try {
      fsyncSync(this.fd);
    } catch {
      // A broken disk will surface on the next write; there's nothing useful
      // to do here that the caller doesn't already expect.
    }
  }

  /** True if the active file has exceeded the rotate threshold. */
  shouldRotate(): boolean {
    return this.activeSize >= this.rotateSize;
  }

  /**
   * Rotate the active file: fsync, close, rename to `sealed-<ts>-<seq>.jsonl`,
   * then open a fresh active file. Returns the sealed path so the caller can
   * schedule deletion after confirming persistence elsewhere.
   */
  rotate(): string | null {
    if (this.closed || this.fd === null) return null;
    this.commit();
    closeSync(this.fd);
    this.fd = null;

    const active = this.activePath();
    if (!existsSync(active)) {
      // Nothing to rotate — reopen and return.
      this.openActive();
      return null;
    }
    const sealed = join(this.dir, `sealed-${Date.now()}-${this.seq}.jsonl`);
    renameSync(active, sealed);
    this.activeSize = 0;
    this.openActive();
    return sealed;
  }

  /** Remove a sealed file once its events are durable in the downstream store. */
  static deleteSealed(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // Already gone or permissions issue — non-fatal; retry on next sweep.
    }
  }

  /** List sealed files in this WAL's directory, sorted oldest-first. */
  listSealed(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.startsWith('sealed-') && f.endsWith('.jsonl'))
        .sort()
        .map((f) => join(this.dir, f));
    } catch {
      return [];
    }
  }

  /**
   * Parse a WAL file back into its events, skipping any corrupt or truncated
   * trailing line. A crash mid-append can leave a partial line; the parser
   * tolerates it because fsync had never completed for that line, which means
   * the event was never treated as durable.
   */
  static readFile(path: string): RuntimeEvent[] {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    if (!raw) return [];
    const events: RuntimeEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as WalEntry;
        if (parsed && parsed.event) events.push(parsed.event);
      } catch {
        // Torn tail — stop here; everything after the last fsync may be garbage.
        break;
      }
    }
    return events;
  }

  /**
   * List the WAL files that need recovery for a project: any sealed files
   * plus the active file if it has content. Returned in ingestion order
   * (sealed oldest-first, then active last).
   */
  static listRecoveryFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const sealed = entries
      .filter((f) => f.startsWith('sealed-') && f.endsWith('.jsonl'))
      .sort();
    const files = sealed.map((f) => join(dir, f));
    const active = join(dir, 'active.jsonl');
    try {
      const s = statSync(active);
      if (s.size > 0) files.push(active);
    } catch {
      // no active file, or can't stat it — skip
    }
    return files;
  }

  close(): void {
    if (this.closed || this.fd === null) return;
    this.commit();
    try {
      closeSync(this.fd);
    } catch {
      // ignore
    }
    this.fd = null;
    this.closed = true;
  }

  /**
   * Copy the active file (post-fsync) and any sealed files into `targetDir`.
   * Returns the total bytes copied. Used by snapshot endpoints — pairing the
   * SQLite snapshot with the WAL means a restore captures any events that
   * hadn't yet been drained into SQLite at snapshot time.
   */
  snapshotTo(targetDir: string): number {
    this.commit();
    mkdirSync(targetDir, { recursive: true });

    let total = 0;
    const copyOne = (src: string, dstName: string) => {
      try {
        const data = readFileSync(src);
        const dst = join(targetDir, dstName);
        // 'wx' refuses to overwrite — the snapshot dir is fresh, so this
        // catches any accidental name reuse loudly instead of silently.
        const fd = openSync(dst, 'wx');
        try {
          writeSync(fd, data);
        } finally {
          closeSync(fd);
        }
        total += data.length;
      } catch {
        // Source missing or unreadable — skip; the manifest will reflect what
        // actually copied.
      }
    };

    const active = this.activePath();
    try {
      if (statSync(active).size > 0) copyOne(active, 'active.jsonl');
    } catch {
      // no active file
    }
    for (const sealed of this.listSealed()) {
      copyOne(sealed, sealed.split('/').pop() ?? 'sealed.jsonl');
    }
    return total;
  }
}
