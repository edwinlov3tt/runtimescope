import Database from 'better-sqlite3';
import { renameSync, existsSync } from 'node:fs';
import type {
  RuntimeEvent,
  HistoricalFilter,
  SessionInfoExtended,
  SessionMetrics,
  SessionSnapshot,
  EventType,
} from './types.js';

// ============================================================
// SQLite Persistence Layer
// Uses write buffering for high-throughput event ingestion
// ============================================================

export interface SqliteStoreOptions {
  dbPath: string;
  walMode?: boolean;
  flushIntervalMs?: number;
  batchSize?: number;
}

export class SqliteStore {
  private db: InstanceType<typeof Database>;
  private writeBuffer: { event: RuntimeEvent; project: string }[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly batchSize: number;
  private readonly dbPath: string;

  private static readonly MAX_SNAPSHOTS_PER_SESSION = 50;

  private insertEventStmt!: Database.Statement;
  private insertSessionStmt!: Database.Statement;
  private updateSessionDisconnectedStmt!: Database.Statement;

  constructor(options: SqliteStoreOptions) {
    this.dbPath = options.dbPath;
    this.batchSize = options.batchSize ?? 50;

    this.db = this.openDatabase(options);

    // Start flush timer
    const flushInterval = options.flushIntervalMs ?? 100;
    this.flushTimer = setInterval(() => this.flush(), flushInterval);
  }

  private openDatabase(options: SqliteStoreOptions): InstanceType<typeof Database> {
    try {
      const db = new Database(options.dbPath);
      if (options.walMode !== false) {
        db.pragma('journal_mode = WAL');
      }
      db.pragma('synchronous = NORMAL');

      // Quick integrity check — if this fails, the DB is corrupt
      const check = db.pragma('integrity_check') as { integrity_check: string }[];
      if (check[0]?.integrity_check !== 'ok') {
        throw new Error('Integrity check failed');
      }

      this.createSchema(db);
      this.prepareStatements(db);
      return db;
    } catch (err) {
      // Corruption recovery: rename the bad DB and create a fresh one
      console.error(
        `[RuntimeScope] SQLite database corrupt or unreadable (${(err as Error).message}), recreating...`
      );
      try {
        if (existsSync(options.dbPath)) {
          const backupPath = `${options.dbPath}.corrupt.${Date.now()}`;
          renameSync(options.dbPath, backupPath);
          console.error(`[RuntimeScope] Renamed corrupt DB to ${backupPath}`);
        }
        // Also clean up WAL/SHM files
        for (const suffix of ['-wal', '-shm']) {
          const p = options.dbPath + suffix;
          if (existsSync(p)) {
            renameSync(p, `${p}.corrupt.${Date.now()}`);
          }
        }
      } catch { /* best effort */ }

      const db = new Database(options.dbPath);
      if (options.walMode !== false) {
        db.pragma('journal_mode = WAL');
      }
      db.pragma('synchronous = NORMAL');
      this.createSchema(db);
      this.prepareStatements(db);
      return db;
    }
  }

  private prepareStatements(db: InstanceType<typeof Database>): void {
    this.insertEventStmt = db.prepare(`
      INSERT INTO events (event_id, session_id, project, event_type, timestamp, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.insertSessionStmt = db.prepare(`
      INSERT OR REPLACE INTO sessions (
        session_id, project, app_name, connected_at, sdk_version,
        event_count, is_connected, build_meta
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateSessionDisconnectedStmt = db.prepare(`
      UPDATE sessions SET is_connected = 0, disconnected_at = ? WHERE session_id = ?
    `);
  }

  private createSchema(db?: InstanceType<typeof Database>): void {
    const d = db ?? this.db;
    d.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_type_timestamp ON events(event_type, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        app_name TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        disconnected_at INTEGER,
        sdk_version TEXT NOT NULL,
        event_count INTEGER DEFAULT 0,
        is_connected INTEGER DEFAULT 1,
        build_meta TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);

      CREATE TABLE IF NOT EXISTS session_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        label TEXT,
        metrics TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON session_snapshots(session_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_project ON session_snapshots(project, created_at);
    `);

    // Migrate from old session_metrics table if it exists
    this.migrateSessionMetrics(d);
  }

  // --- Write Operations ---

  addEvent(event: RuntimeEvent, project: string): void {
    this.writeBuffer.push({ event, project });
    if (this.writeBuffer.length >= this.batchSize) {
      this.flush();
    }
  }

  flush(): void {
    if (this.writeBuffer.length === 0) return;

    const batch = this.writeBuffer.splice(0);
    const insertMany = this.db.transaction(() => {
      for (const { event, project } of batch) {
        try {
          this.insertEventStmt.run(
            event.eventId,
            event.sessionId,
            project,
            event.eventType,
            event.timestamp,
            JSON.stringify(event)
          );
        } catch {
          // Ignore duplicate event_id (UNIQUE constraint)
        }
      }
    });

    try {
      insertMany();
    } catch (err) {
      console.error('[RuntimeScope] SQLite flush error:', (err as Error).message);
    }
  }

  saveSession(info: SessionInfoExtended): void {
    this.insertSessionStmt.run(
      info.sessionId,
      info.project,
      info.appName,
      info.connectedAt,
      info.sdkVersion,
      info.eventCount,
      info.isConnected ? 1 : 0,
      info.buildMeta ? JSON.stringify(info.buildMeta) : null
    );
  }

  updateSessionDisconnected(sessionId: string, disconnectedAt: number): void {
    this.updateSessionDisconnectedStmt.run(disconnectedAt, sessionId);
  }

  saveSessionMetrics(sessionId: string, project: string, metrics: unknown, label?: string): void {
    this.db.prepare(`
      INSERT INTO session_snapshots (session_id, project, label, metrics, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, project, label ?? null, JSON.stringify(metrics), Date.now());

    // Enforce retention: keep only the most recent N snapshots per session
    this.pruneSnapshots(sessionId);
  }

  /** Remove oldest snapshots for a session beyond the retention limit */
  private pruneSnapshots(sessionId: string): void {
    const count = (this.db
      .prepare('SELECT COUNT(*) as cnt FROM session_snapshots WHERE session_id = ?')
      .get(sessionId) as { cnt: number }).cnt;

    if (count > SqliteStore.MAX_SNAPSHOTS_PER_SESSION) {
      this.db.prepare(`
        DELETE FROM session_snapshots WHERE id IN (
          SELECT id FROM session_snapshots
          WHERE session_id = ?
          ORDER BY created_at ASC
          LIMIT ?
        )
      `).run(sessionId, count - SqliteStore.MAX_SNAPSHOTS_PER_SESSION);
    }
  }

  // --- Read Operations ---

  getEvents(filter: HistoricalFilter): RuntimeEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.project) {
      conditions.push('project = ?');
      params.push(filter.project);
    }
    if (filter.sessionId) {
      conditions.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.eventTypes && filter.eventTypes.length > 0) {
      const placeholders = filter.eventTypes.map(() => '?').join(', ');
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...filter.eventTypes);
    }
    if (filter.since) {
      conditions.push('timestamp >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      conditions.push('timestamp <= ?');
      params.push(filter.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(filter.limit ?? 1000);
    params.push(filter.offset ?? 0);

    const rows = this.db
      .prepare(`SELECT data FROM events ${where} ORDER BY timestamp ASC LIMIT ? OFFSET ?`)
      .all(...params) as { data: string }[];

    return rows.map((row) => JSON.parse(row.data) as RuntimeEvent);
  }

  getEventCount(filter: HistoricalFilter): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.project) {
      conditions.push('project = ?');
      params.push(filter.project);
    }
    if (filter.sessionId) {
      conditions.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.eventTypes && filter.eventTypes.length > 0) {
      const placeholders = filter.eventTypes.map(() => '?').join(', ');
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...filter.eventTypes);
    }
    if (filter.since) {
      conditions.push('timestamp >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      conditions.push('timestamp <= ?');
      params.push(filter.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM events ${where}`)
      .get(...params) as { count: number };

    return row.count;
  }

  getSessions(project: string, limit = 50): SessionInfoExtended[] {
    const rows = this.db
      .prepare(`
        SELECT session_id, project, app_name, connected_at, disconnected_at,
               sdk_version, event_count, is_connected, build_meta
        FROM sessions
        WHERE project = ?
        ORDER BY connected_at DESC
        LIMIT ?
      `)
      .all(project, limit) as {
        session_id: string;
        project: string;
        app_name: string;
        connected_at: number;
        disconnected_at: number | null;
        sdk_version: string;
        event_count: number;
        is_connected: number;
        build_meta: string | null;
      }[];

    return rows.map((row) => ({
      sessionId: row.session_id,
      project: row.project,
      appName: row.app_name,
      connectedAt: row.connected_at,
      disconnectedAt: row.disconnected_at ?? undefined,
      sdkVersion: row.sdk_version,
      eventCount: row.event_count,
      isConnected: row.is_connected === 1,
      buildMeta: row.build_meta ? JSON.parse(row.build_meta) : undefined,
    }));
  }

  getSessionMetrics(sessionId: string): SessionMetrics | null {
    const row = this.db
      .prepare('SELECT metrics FROM session_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as { metrics: string } | undefined;

    return row ? JSON.parse(row.metrics) as SessionMetrics : null;
  }

  getSessionSnapshots(sessionId: string): SessionSnapshot[] {
    const rows = this.db
      .prepare(`
        SELECT id, session_id, project, label, metrics, created_at
        FROM session_snapshots
        WHERE session_id = ?
        ORDER BY created_at ASC
      `)
      .all(sessionId) as {
        id: number;
        session_id: string;
        project: string;
        label: string | null;
        metrics: string;
        created_at: number;
      }[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      project: row.project,
      label: row.label ?? undefined,
      metrics: JSON.parse(row.metrics) as SessionMetrics,
      createdAt: row.created_at,
    }));
  }

  getSnapshotById(snapshotId: number): SessionSnapshot | null {
    const row = this.db
      .prepare('SELECT id, session_id, project, label, metrics, created_at FROM session_snapshots WHERE id = ?')
      .get(snapshotId) as {
        id: number;
        session_id: string;
        project: string;
        label: string | null;
        metrics: string;
        created_at: number;
      } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      project: row.project,
      label: row.label ?? undefined,
      metrics: JSON.parse(row.metrics) as SessionMetrics,
      createdAt: row.created_at,
    };
  }

  getEventsByType(project: string, eventType: EventType, sinceMs?: number): RuntimeEvent[] {
    const conditions = ['project = ?', 'event_type = ?'];
    const params: unknown[] = [project, eventType];

    if (sinceMs) {
      conditions.push('timestamp >= ?');
      params.push(sinceMs);
    }

    const where = conditions.join(' AND ');
    const rows = this.db
      .prepare(`SELECT data FROM events WHERE ${where} ORDER BY timestamp ASC LIMIT 1000`)
      .all(...params) as { data: string }[];

    return rows.map((row) => JSON.parse(row.data) as RuntimeEvent);
  }

  // --- Migration ---

  private migrateSessionMetrics(db: InstanceType<typeof Database>): void {
    const hasOldTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_metrics'"
    ).get();

    if (hasOldTable) {
      db.exec(`
        INSERT OR IGNORE INTO session_snapshots (session_id, project, label, metrics, created_at)
        SELECT session_id, project, 'auto-disconnect', metrics, created_at
        FROM session_metrics
      `);
      db.exec('DROP TABLE session_metrics');
    }
  }

  // --- Maintenance ---

  deleteOldEvents(beforeTimestamp: number): number {
    const result = this.db
      .prepare('DELETE FROM events WHERE timestamp < ?')
      .run(beforeTimestamp);
    return result.changes;
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(); // Final flush
    this.db.close();
  }
}
