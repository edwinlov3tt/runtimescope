import type { SchemaTable, SchemaColumn, SchemaForeignKey, SchemaIndex, DatabaseSchema } from '../types.js';
import type { ManagedConnection } from './connections.js';

// ============================================================
// Schema Introspector
// Reads database schema from PostgreSQL, MySQL, and SQLite
// ============================================================

export class SchemaIntrospector {
  async introspect(connection: ManagedConnection, tableName?: string): Promise<DatabaseSchema> {
    switch (connection.config.type) {
      case 'postgres':
        return this.introspectPostgres(connection, tableName);
      case 'mysql':
        return this.introspectMysql(connection, tableName);
      case 'sqlite':
        return this.introspectSqlite(connection, tableName);
      default:
        throw new Error(`Unsupported database type: ${connection.config.type}`);
    }
  }

  private async introspectPostgres(conn: ManagedConnection, tableName?: string): Promise<DatabaseSchema> {
    const pg = conn.client as { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

    // Get tables
    const tableFilter = tableName ? `AND table_name = $1` : '';
    const tableParams = tableName ? [tableName] : [];
    const tablesResult = await pg.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ${tableFilter} ORDER BY table_name`,
      tableParams
    );

    const tables: SchemaTable[] = [];

    for (const row of tablesResult.rows) {
      const tName = row.table_name as string;

      // Columns
      const colsResult = await pg.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [tName]
      );

      // Primary keys
      const pkResult = await pg.query(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'`,
        [tName]
      );
      const pkColumns = new Set(pkResult.rows.map((r) => r.column_name as string));

      const columns: SchemaColumn[] = colsResult.rows.map((r) => ({
        name: r.column_name as string,
        type: r.data_type as string,
        nullable: r.is_nullable === 'YES',
        defaultValue: r.column_default as string | undefined,
        isPrimaryKey: pkColumns.has(r.column_name as string),
      }));

      // Foreign keys
      const fkResult = await pg.query(
        `SELECT kcu.column_name, ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
         WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'`,
        [tName]
      );

      const foreignKeys: SchemaForeignKey[] = fkResult.rows.map((r) => ({
        column: r.column_name as string,
        referencedTable: r.referenced_table as string,
        referencedColumn: r.referenced_column as string,
      }));

      // Indexes
      const idxResult = await pg.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 AND schemaname = 'public'`,
        [tName]
      );

      const indexes: SchemaIndex[] = idxResult.rows.map((r) => {
        const indexDef = r.indexdef as string;
        const isUnique = indexDef.includes('UNIQUE');
        // Extract column names from index definition
        const colMatch = indexDef.match(/\(([^)]+)\)/);
        const idxCols = colMatch ? colMatch[1].split(',').map((c) => c.trim().replace(/"/g, '')) : [];
        return {
          name: r.indexname as string,
          columns: idxCols,
          unique: isUnique,
        };
      });

      // Row count estimate
      const countResult = await pg.query(
        `SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = $1`,
        [tName]
      );
      const rowCount = countResult.rows[0]?.estimate as number | undefined;

      tables.push({ name: tName, columns, foreignKeys, indexes, rowCount: rowCount ?? undefined });
    }

    return { connectionId: conn.config.id, tables, fetchedAt: Date.now() };
  }

  private async introspectMysql(conn: ManagedConnection, tableName?: string): Promise<DatabaseSchema> {
    const mysql = conn.client as { query: (sql: string, params?: unknown[]) => Promise<[Record<string, unknown>[]]> };

    const tableFilter = tableName ? `AND table_name = ?` : '';
    const tableParams = tableName ? [tableName] : [];
    const [tableRows] = await mysql.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ${tableFilter} ORDER BY table_name`,
      tableParams
    );

    const tables: SchemaTable[] = [];

    for (const row of tableRows) {
      const tName = row.table_name as string;

      const [colRows] = await mysql.query(
        `SELECT column_name, data_type, is_nullable, column_default, column_key
         FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ?
         ORDER BY ordinal_position`,
        [tName]
      );

      const columns: SchemaColumn[] = (colRows as Record<string, unknown>[]).map((r) => ({
        name: r.column_name as string,
        type: r.data_type as string,
        nullable: r.is_nullable === 'YES',
        defaultValue: r.column_default as string | undefined,
        isPrimaryKey: r.column_key === 'PRI',
      }));

      const [fkRows] = await mysql.query(
        `SELECT column_name, referenced_table_name, referenced_column_name
         FROM information_schema.key_column_usage
         WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL`,
        [tName]
      );

      const foreignKeys: SchemaForeignKey[] = (fkRows as Record<string, unknown>[]).map((r) => ({
        column: r.column_name as string,
        referencedTable: r.referenced_table_name as string,
        referencedColumn: r.referenced_column_name as string,
      }));

      const [idxRows] = await mysql.query(`SHOW INDEX FROM \`${tName}\``);
      const indexMap = new Map<string, { columns: string[]; unique: boolean }>();
      for (const r of idxRows as Record<string, unknown>[]) {
        const name = r.Key_name as string;
        const existing = indexMap.get(name) ?? { columns: [], unique: (r.Non_unique as number) === 0 };
        existing.columns.push(r.Column_name as string);
        indexMap.set(name, existing);
      }

      const indexes: SchemaIndex[] = Array.from(indexMap.entries()).map(([name, data]) => ({
        name,
        columns: data.columns,
        unique: data.unique,
      }));

      tables.push({ name: tName, columns, foreignKeys, indexes });
    }

    return { connectionId: conn.config.id, tables, fetchedAt: Date.now() };
  }

  private async introspectSqlite(conn: ManagedConnection, tableName?: string): Promise<DatabaseSchema> {
    const db = conn.client as {
      prepare: (sql: string) => { all: (...args: unknown[]) => Record<string, unknown>[] };
    };

    let tableNames: string[];
    if (tableName) {
      tableNames = [tableName];
    } else {
      const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
      tableNames = rows.map((r) => r.name as string);
    }

    const tables: SchemaTable[] = [];

    for (const tName of tableNames) {
      const colRows = db.prepare(`PRAGMA table_info("${tName}")`).all();
      const columns: SchemaColumn[] = colRows.map((r) => ({
        name: r.name as string,
        type: r.type as string,
        nullable: (r.notnull as number) === 0,
        defaultValue: r.dflt_value as string | undefined,
        isPrimaryKey: (r.pk as number) > 0,
      }));

      const fkRows = db.prepare(`PRAGMA foreign_key_list("${tName}")`).all();
      const foreignKeys: SchemaForeignKey[] = fkRows.map((r) => ({
        column: r.from as string,
        referencedTable: r.table as string,
        referencedColumn: r.to as string,
      }));

      const idxRows = db.prepare(`PRAGMA index_list("${tName}")`).all();
      const indexes: SchemaIndex[] = idxRows.map((r) => {
        const idxInfoRows = db.prepare(`PRAGMA index_info("${r.name}")`).all();
        return {
          name: r.name as string,
          columns: idxInfoRows.map((ir) => ir.name as string),
          unique: (r.unique as number) === 1,
        };
      });

      // Row count
      const countRow = db.prepare(`SELECT COUNT(*) as count FROM "${tName}"`).all()[0];
      const rowCount = countRow?.count as number | undefined;

      tables.push({ name: tName, columns, foreignKeys, indexes, rowCount });
    }

    return { connectionId: conn.config.id, tables, fetchedAt: Date.now() };
  }
}
