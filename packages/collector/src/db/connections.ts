import type { DatabaseConnectionConfig } from '../types.js';

// ============================================================
// Database Connection Manager
// Manages connections to local/dev databases for introspection
// ============================================================

export interface ManagedConnection {
  config: DatabaseConnectionConfig;
  client: unknown;
  isHealthy: boolean;
  lastChecked: number;
}

export class ConnectionManager {
  private connections: Map<string, ManagedConnection> = new Map();

  async addConnection(config: DatabaseConnectionConfig): Promise<void> {
    const client = await this.createClient(config);
    this.connections.set(config.id, {
      config,
      client,
      isHealthy: true,
      lastChecked: Date.now(),
    });
  }

  getConnection(id: string): ManagedConnection | undefined {
    return this.connections.get(id);
  }

  listConnections(): { id: string; type: string; label?: string; isHealthy: boolean }[] {
    return Array.from(this.connections.values()).map((c) => ({
      id: c.config.id,
      type: c.config.type,
      label: c.config.label,
      isHealthy: c.isHealthy,
    }));
  }

  async healthCheck(id: string): Promise<boolean> {
    const conn = this.connections.get(id);
    if (!conn) return false;

    try {
      if (conn.config.type === 'postgres') {
        const pg = conn.client as { query: (sql: string) => Promise<unknown> };
        await pg.query('SELECT 1');
      } else if (conn.config.type === 'mysql') {
        const mysql = conn.client as { query: (sql: string) => Promise<unknown> };
        await mysql.query('SELECT 1');
      } else if (conn.config.type === 'sqlite') {
        const db = conn.client as { prepare: (sql: string) => { get: () => unknown } };
        db.prepare('SELECT 1').get();
      }
      conn.isHealthy = true;
    } catch {
      conn.isHealthy = false;
    }

    conn.lastChecked = Date.now();
    return conn.isHealthy;
  }

  async closeConnection(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;

    try {
      if (conn.config.type === 'postgres') {
        await (conn.client as { end: () => Promise<void> }).end();
      } else if (conn.config.type === 'mysql') {
        await (conn.client as { end: () => Promise<void> }).end();
      } else if (conn.config.type === 'sqlite') {
        (conn.client as { close: () => void }).close();
      }
    } catch {
      // Ignore close errors
    }

    this.connections.delete(id);
  }

  async closeAll(): Promise<void> {
    const ids = [...this.connections.keys()];
    for (const id of ids) {
      await this.closeConnection(id);
    }
  }

  // Dynamic require wrapper to avoid TypeScript module resolution at compile time
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  private dynamicRequire(mod: string): unknown {
    try {
      return require(mod);
    } catch {
      throw new Error(`Module '${mod}' not found. Install it: npm install ${mod}`);
    }
  }

  private async createClient(config: DatabaseConnectionConfig): Promise<unknown> {
    switch (config.type) {
      case 'postgres': {
        try {
          const pg = this.dynamicRequire('pg') as { Pool: new (opts: unknown) => { query: (sql: string) => Promise<unknown>; end: () => Promise<void> } };
          const pool = new pg.Pool({ connectionString: config.connectionString });
          await pool.query('SELECT 1');
          return pool;
        } catch (err) {
          throw new Error(`Failed to connect to PostgreSQL: ${(err as Error).message}. Ensure 'pg' is installed.`);
        }
      }
      case 'mysql': {
        try {
          const mysql2 = this.dynamicRequire('mysql2/promise') as { createPool: (uri: string) => { query: (sql: string) => Promise<unknown>; end: () => Promise<void> } };
          const pool = mysql2.createPool(config.connectionString!);
          await pool.query('SELECT 1');
          return pool;
        } catch (err) {
          throw new Error(`Failed to connect to MySQL: ${(err as Error).message}. Ensure 'mysql2' is installed.`);
        }
      }
      case 'sqlite': {
        try {
          const BetterSqlite3 = this.dynamicRequire('better-sqlite3') as new (path: string) => unknown;
          return new BetterSqlite3(config.connectionString!);
        } catch (err) {
          throw new Error(`Failed to open SQLite: ${(err as Error).message}. Ensure 'better-sqlite3' is installed.`);
        }
      }
      default:
        throw new Error(`Unsupported database type: ${config.type}`);
    }
  }
}
