import type { ManagedConnection } from './connections.js';

// ============================================================
// Data Browser
// Paginated reads and guarded writes for local dev databases
// ============================================================

const MAX_AFFECTED_ROWS = 100;

export interface ReadOptions {
  table: string;
  limit?: number;
  offset?: number;
  where?: string;
  orderBy?: string;
}

export interface ReadResult {
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export interface WriteOptions {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  data?: Record<string, unknown>;
  where?: string;
}

export interface WriteResult {
  success: boolean;
  affectedRows: number;
  error?: string;
}

export class DataBrowser {
  async read(connection: ManagedConnection, options: ReadOptions): Promise<ReadResult> {
    const limit = Math.min(options.limit ?? 50, 1000);
    const offset = options.offset ?? 0;

    switch (connection.config.type) {
      case 'postgres':
        return this.readPostgres(connection, options, limit, offset);
      case 'mysql':
        return this.readMysql(connection, options, limit, offset);
      case 'sqlite':
        return this.readSqlite(connection, options, limit, offset);
      default:
        throw new Error(`Unsupported database type: ${connection.config.type}`);
    }
  }

  async write(connection: ManagedConnection, options: WriteOptions): Promise<WriteResult> {
    // Safety guard 1: Only localhost connections
    this.assertLocalhost(connection);

    // Safety guard 2: WHERE required for UPDATE/DELETE
    if ((options.operation === 'update' || options.operation === 'delete') && !options.where) {
      return { success: false, affectedRows: 0, error: 'WHERE clause is required for UPDATE and DELETE operations' };
    }

    switch (connection.config.type) {
      case 'postgres':
        return this.writePostgres(connection, options);
      case 'mysql':
        return this.writeMysql(connection, options);
      case 'sqlite':
        return this.writeSqlite(connection, options);
      default:
        throw new Error(`Unsupported database type: ${connection.config.type}`);
    }
  }

  private assertLocalhost(connection: ManagedConnection): void {
    const connStr = connection.config.connectionString ?? '';
    const isLocal = connStr.includes('localhost') ||
      connStr.includes('127.0.0.1') ||
      connStr.includes('0.0.0.0') ||
      connection.config.type === 'sqlite';

    if (!isLocal) {
      throw new Error('Write operations are only allowed on localhost/local database connections. This safety guard prevents accidental modification of production databases.');
    }
  }

  // --- PostgreSQL ---

  private async readPostgres(conn: ManagedConnection, opts: ReadOptions, limit: number, offset: number): Promise<ReadResult> {
    const pg = conn.client as { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
    const where = opts.where ? `WHERE ${opts.where}` : '';
    const orderBy = opts.orderBy ? `ORDER BY ${opts.orderBy}` : '';

    const countResult = await pg.query(`SELECT COUNT(*) as total FROM "${opts.table}" ${where}`);
    const total = parseInt(countResult.rows[0].total as string, 10);

    const result = await pg.query(`SELECT * FROM "${opts.table}" ${where} ${orderBy} LIMIT ${limit} OFFSET ${offset}`);
    return { rows: result.rows, total, limit, offset };
  }

  private async writePostgres(conn: ManagedConnection, opts: WriteOptions): Promise<WriteResult> {
    const pg = conn.client as { query: (sql: string) => Promise<{ rowCount: number }> };

    try {
      // Safety guard 3: Check affected rows before executing
      if (opts.operation !== 'insert' && opts.where) {
        const countResult = await (pg as unknown as { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> })
          .query(`SELECT COUNT(*) as cnt FROM "${opts.table}" WHERE ${opts.where}`);
        const count = parseInt(countResult.rows[0].cnt as string, 10);
        if (count > MAX_AFFECTED_ROWS) {
          return { success: false, affectedRows: 0, error: `Operation would affect ${count} rows (max ${MAX_AFFECTED_ROWS}). Narrow your WHERE clause.` };
        }
      }

      await pg.query('BEGIN');
      let result: { rowCount: number };

      switch (opts.operation) {
        case 'insert': {
          const cols = Object.keys(opts.data!);
          const vals = Object.values(opts.data!).map((v) => typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v);
          result = await pg.query(`INSERT INTO "${opts.table}" (${cols.join(', ')}) VALUES (${vals.join(', ')})`);
          break;
        }
        case 'update': {
          const sets = Object.entries(opts.data!).map(([k, v]) =>
            `${k} = ${typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v}`
          );
          result = await pg.query(`UPDATE "${opts.table}" SET ${sets.join(', ')} WHERE ${opts.where}`);
          break;
        }
        case 'delete':
          result = await pg.query(`DELETE FROM "${opts.table}" WHERE ${opts.where}`);
          break;
        default:
          throw new Error(`Unknown operation: ${opts.operation}`);
      }

      await pg.query('COMMIT');
      return { success: true, affectedRows: result.rowCount };
    } catch (err) {
      await pg.query('ROLLBACK').catch(() => {});
      return { success: false, affectedRows: 0, error: (err as Error).message };
    }
  }

  // --- MySQL ---

  private async readMysql(conn: ManagedConnection, opts: ReadOptions, limit: number, offset: number): Promise<ReadResult> {
    const mysql = conn.client as { query: (sql: string) => Promise<[Record<string, unknown>[]]> };
    const where = opts.where ? `WHERE ${opts.where}` : '';
    const orderBy = opts.orderBy ? `ORDER BY ${opts.orderBy}` : '';

    const [countRows] = await mysql.query(`SELECT COUNT(*) as total FROM \`${opts.table}\` ${where}`);
    const total = (countRows[0] as Record<string, unknown>).total as number;

    const [rows] = await mysql.query(`SELECT * FROM \`${opts.table}\` ${where} ${orderBy} LIMIT ${limit} OFFSET ${offset}`);
    return { rows: rows as Record<string, unknown>[], total, limit, offset };
  }

  private async writeMysql(conn: ManagedConnection, opts: WriteOptions): Promise<WriteResult> {
    const mysql = conn.client as { query: (sql: string) => Promise<[{ affectedRows: number }]> };

    try {
      if (opts.operation !== 'insert' && opts.where) {
        const [countRows] = await (mysql as unknown as { query: (sql: string) => Promise<[Record<string, unknown>[]]> })
          .query(`SELECT COUNT(*) as cnt FROM \`${opts.table}\` WHERE ${opts.where}`);
        const count = (countRows[0] as Record<string, unknown>).cnt as number;
        if (count > MAX_AFFECTED_ROWS) {
          return { success: false, affectedRows: 0, error: `Operation would affect ${count} rows (max ${MAX_AFFECTED_ROWS}).` };
        }
      }

      await mysql.query('START TRANSACTION');
      let result: [{ affectedRows: number }];

      switch (opts.operation) {
        case 'insert': {
          const cols = Object.keys(opts.data!);
          const vals = Object.values(opts.data!).map((v) => typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v);
          result = await mysql.query(`INSERT INTO \`${opts.table}\` (${cols.join(', ')}) VALUES (${vals.join(', ')})`);
          break;
        }
        case 'update': {
          const sets = Object.entries(opts.data!).map(([k, v]) =>
            `\`${k}\` = ${typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v}`
          );
          result = await mysql.query(`UPDATE \`${opts.table}\` SET ${sets.join(', ')} WHERE ${opts.where}`);
          break;
        }
        case 'delete':
          result = await mysql.query(`DELETE FROM \`${opts.table}\` WHERE ${opts.where}`);
          break;
        default:
          throw new Error(`Unknown operation: ${opts.operation}`);
      }

      await mysql.query('COMMIT');
      return { success: true, affectedRows: result[0].affectedRows };
    } catch (err) {
      await mysql.query('ROLLBACK').catch(() => {});
      return { success: false, affectedRows: 0, error: (err as Error).message };
    }
  }

  // --- SQLite ---

  private async readSqlite(conn: ManagedConnection, opts: ReadOptions, limit: number, offset: number): Promise<ReadResult> {
    const db = conn.client as { prepare: (sql: string) => { all: () => Record<string, unknown>[]; get: () => Record<string, unknown> } };
    const where = opts.where ? `WHERE ${opts.where}` : '';
    const orderBy = opts.orderBy ? `ORDER BY ${opts.orderBy}` : '';

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM "${opts.table}" ${where}`).get();
    const total = countRow.total as number;

    const rows = db.prepare(`SELECT * FROM "${opts.table}" ${where} ${orderBy} LIMIT ${limit} OFFSET ${offset}`).all();
    return { rows, total, limit, offset };
  }

  private async writeSqlite(conn: ManagedConnection, opts: WriteOptions): Promise<WriteResult> {
    const db = conn.client as {
      prepare: (sql: string) => { run: () => { changes: number }; get: () => Record<string, unknown> };
      exec: (sql: string) => void;
    };

    try {
      if (opts.operation !== 'insert' && opts.where) {
        const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM "${opts.table}" WHERE ${opts.where}`).get();
        const count = countRow.cnt as number;
        if (count > MAX_AFFECTED_ROWS) {
          return { success: false, affectedRows: 0, error: `Operation would affect ${count} rows (max ${MAX_AFFECTED_ROWS}).` };
        }
      }

      db.exec('BEGIN');
      let changes: number;

      switch (opts.operation) {
        case 'insert': {
          const cols = Object.keys(opts.data!);
          const vals = Object.values(opts.data!).map((v) => typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v);
          const result = db.prepare(`INSERT INTO "${opts.table}" (${cols.join(', ')}) VALUES (${vals.join(', ')})`).run();
          changes = result.changes;
          break;
        }
        case 'update': {
          const sets = Object.entries(opts.data!).map(([k, v]) =>
            `"${k}" = ${typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v}`
          );
          const result = db.prepare(`UPDATE "${opts.table}" SET ${sets.join(', ')} WHERE ${opts.where}`).run();
          changes = result.changes;
          break;
        }
        case 'delete': {
          const result = db.prepare(`DELETE FROM "${opts.table}" WHERE ${opts.where}`).run();
          changes = result.changes;
          break;
        }
        default:
          throw new Error(`Unknown operation: ${opts.operation}`);
      }

      db.exec('COMMIT');
      return { success: true, affectedRows: changes };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      return { success: false, affectedRows: 0, error: (err as Error).message };
    }
  }
}
