import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  EventStore,
  ConnectionManager,
  SchemaIntrospector,
  DataBrowser,
} from '@runtimescope/collector';
import {
  aggregateQueryStats,
  detectN1Queries,
  detectSlowQueries,
  suggestIndexes,
} from '@runtimescope/collector';

export function registerDatabaseTools(
  server: McpServer,
  store: EventStore,
  connectionManager: ConnectionManager,
  schemaIntrospector: SchemaIntrospector,
  dataBrowser: DataBrowser
): void {
  // --- get_query_log ---
  server.tool(
    'get_query_log',
    'Get captured database queries with SQL, timing, rows returned, and source ORM. Requires server-side SDK instrumentation.',
    {
      since_seconds: z.number().optional().describe('Only return queries from the last N seconds'),
      table: z.string().optional().describe('Filter by table name'),
      min_duration_ms: z.number().optional().describe('Only return queries slower than N ms'),
      search: z.string().optional().describe('Search query text'),
    },
    async ({ since_seconds, table, min_duration_ms, search }) => {
      const events = store.getDatabaseEvents({
        sinceSeconds: since_seconds,
        table,
        minDurationMs: min_duration_ms,
        search,
      });

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      const totalDuration = events.reduce((s, e) => s + e.duration, 0);
      const avgDuration = events.length > 0 ? totalDuration / events.length : 0;
      const errorCount = events.filter((e) => e.error).length;

      const issues: string[] = [];
      if (errorCount > 0) issues.push(`${errorCount} query error(s)`);
      const slowCount = events.filter((e) => e.duration > 500).length;
      if (slowCount > 0) issues.push(`${slowCount} slow query/queries (>500ms)`);

      const response = {
        summary: `Found ${events.length} database query/queries${since_seconds ? ` in the last ${since_seconds}s` : ''}. Avg duration: ${avgDuration.toFixed(0)}ms.`,
        data: events.map((e) => ({
          query: e.query.slice(0, 200),
          normalizedQuery: e.normalizedQuery.slice(0, 150),
          duration: `${e.duration.toFixed(0)}ms`,
          operation: e.operation,
          tables: e.tablesAccessed,
          source: e.source,
          rowsReturned: e.rowsReturned ?? null,
          rowsAffected: e.rowsAffected ?? null,
          error: e.error ?? null,
          label: e.label ?? null,
          timestamp: new Date(e.timestamp).toISOString(),
        })),
        issues,
        metadata: {
          timeRange: events.length > 0
            ? { from: events[0].timestamp, to: events[events.length - 1].timestamp }
            : { from: 0, to: 0 },
          eventCount: events.length,
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_query_performance ---
  server.tool(
    'get_query_performance',
    'Get aggregated database query performance stats: avg/max/p95 duration, call counts, N+1 detection, and slow query analysis.',
    {
      since_seconds: z.number().optional().describe('Analyze queries from the last N seconds'),
    },
    async ({ since_seconds }) => {
      const events = store.getDatabaseEvents({ sinceSeconds: since_seconds });
      const stats = aggregateQueryStats(events);
      const n1Issues = detectN1Queries(events);
      const slowIssues = detectSlowQueries(events);

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      const issues: string[] = [
        ...n1Issues.map((i) => i.title),
        ...slowIssues.map((i) => i.title),
      ];

      const response = {
        summary: `Analyzed ${events.length} queries across ${stats.length} unique patterns. ${issues.length} issue(s) found.`,
        data: {
          queryStats: stats.slice(0, 20).map((s) => ({
            pattern: s.normalizedQuery.slice(0, 150),
            tables: s.tables,
            operation: s.operation,
            callCount: s.callCount,
            avgDuration: `${s.avgDuration.toFixed(0)}ms`,
            maxDuration: `${s.maxDuration.toFixed(0)}ms`,
            p95Duration: `${s.p95Duration.toFixed(0)}ms`,
            totalDuration: `${s.totalDuration.toFixed(0)}ms`,
            avgRows: s.avgRowsReturned.toFixed(0),
          })),
          detectedIssues: [...n1Issues, ...slowIssues],
        },
        issues,
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: events.length,
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_schema_map ---
  server.tool(
    'get_schema_map',
    'Get the full database schema: tables, columns, types, foreign keys, and indexes. Requires a configured database connection.',
    {
      connection_id: z.string().optional().describe('Connection ID (defaults to first available)'),
      table: z.string().optional().describe('Introspect a specific table only'),
    },
    async ({ connection_id, table }) => {
      const connections = connectionManager.listConnections();
      if (connections.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: 'No database connections configured.',
            data: null,
            issues: ['Configure a database connection in your project\'s infrastructure config.'],
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      const connId = connection_id ?? connections[0].id;
      const conn = connectionManager.getConnection(connId);
      if (!conn) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: `Connection "${connId}" not found.`,
            data: null,
            issues: [`Available connections: ${connections.map((c) => c.id).join(', ')}`],
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      let schema;
      try {
        schema = await schemaIntrospector.introspect(conn, table);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: `Schema introspection failed: ${(err as Error).message}`,
            data: null,
            issues: [(err as Error).message],
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      const response = {
        summary: `Schema for ${schema.connectionId}: ${schema.tables.length} table(s).`,
        data: schema.tables.map((t) => ({
          name: t.name,
          rowCount: t.rowCount ?? null,
          columns: t.columns.map((c) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            isPrimaryKey: c.isPrimaryKey,
            default: c.defaultValue ?? null,
          })),
          foreignKeys: t.foreignKeys,
          indexes: t.indexes,
        })),
        issues: [] as string[],
        metadata: {
          timeRange: { from: schema.fetchedAt, to: schema.fetchedAt },
          eventCount: schema.tables.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_table_data ---
  server.tool(
    'get_table_data',
    'Read rows from a database table with pagination. Requires a configured database connection.',
    {
      table: z.string().describe('Table name to read'),
      connection_id: z.string().optional().describe('Connection ID'),
      limit: z.number().optional().describe('Max rows (default 50, max 1000)'),
      offset: z.number().optional().describe('Pagination offset'),
      where: z.string().optional().describe('SQL WHERE clause (without WHERE keyword)'),
      order_by: z.string().optional().describe('SQL ORDER BY clause (without ORDER BY keyword)'),
    },
    async ({ table, connection_id, limit, offset, where, order_by }) => {
      const connections = connectionManager.listConnections();
      const connId = connection_id ?? connections[0]?.id;
      if (!connId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: 'No database connections configured.',
            data: null,
            issues: ['Configure a database connection.'],
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      const conn = connectionManager.getConnection(connId);
      if (!conn) {
        return {
          content: [{ type: 'text' as const, text: `Connection "${connId}" not found.` }],
        };
      }

      let result;
      try {
        result = await dataBrowser.read(conn, { table, limit, offset, where, orderBy: order_by });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: `Read failed: ${(err as Error).message}`,
            data: null,
            issues: [(err as Error).message],
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      const response = {
        summary: `${result.rows.length} row(s) from "${table}" (${result.total} total).`,
        data: { rows: result.rows, total: result.total, limit: result.limit, offset: result.offset },
        issues: [] as string[],
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: result.rows.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- modify_table_data ---
  server.tool(
    'modify_table_data',
    'Insert, update, or delete rows in a LOCAL DEV database. Safety guarded: localhost only, WHERE required for update/delete, max 100 affected rows, wrapped in transaction.',
    {
      table: z.string().describe('Table name'),
      operation: z.enum(['insert', 'update', 'delete']).describe('Operation type'),
      connection_id: z.string().optional().describe('Connection ID'),
      data: z.record(z.unknown()).optional().describe('Row data (for insert/update)'),
      where: z.string().optional().describe('WHERE clause (required for update/delete)'),
    },
    async ({ table, operation, connection_id, data, where }) => {
      const connections = connectionManager.listConnections();
      const connId = connection_id ?? connections[0]?.id;
      if (!connId) {
        return {
          content: [{ type: 'text' as const, text: 'No database connections configured.' }],
        };
      }

      const conn = connectionManager.getConnection(connId);
      if (!conn) {
        return {
          content: [{ type: 'text' as const, text: `Connection "${connId}" not found.` }],
        };
      }

      // Safety: require WHERE for update/delete to prevent accidental mass operations
      if ((operation === 'update' || operation === 'delete') && !where) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: `WHERE clause required for ${operation} operations.`,
            data: null,
            issues: [`${operation} without WHERE clause is not allowed`],
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      let result;
      try {
        result = await dataBrowser.write(conn, { table, operation, data, where });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            summary: `Write failed: ${(err as Error).message}`,
            data: null,
            issues: [(err as Error).message],
            metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
          }, null, 2) }],
        };
      }

      const response = {
        summary: result.success
          ? `${operation} on "${table}": ${result.affectedRows} row(s) affected.`
          : `${operation} on "${table}" failed: ${result.error}`,
        data: result,
        issues: result.error ? [result.error] : [],
        metadata: {
          timeRange: { from: Date.now(), to: Date.now() },
          eventCount: result.affectedRows,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_database_connections ---
  server.tool(
    'get_database_connections',
    'List all configured database connections with their health status.',
    {},
    async () => {
      const connections = connectionManager.listConnections();

      const response = {
        summary: `${connections.length} database connection(s) configured.`,
        data: connections,
        issues: connections.filter((c) => !c.isHealthy).map((c) => `Connection "${c.id}" is unhealthy`),
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: connections.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- suggest_indexes ---
  server.tool(
    'suggest_indexes',
    'Analyze captured database queries and suggest missing indexes based on WHERE/ORDER BY columns and query performance.',
    {
      since_seconds: z.number().optional().describe('Analyze queries from the last N seconds'),
    },
    async ({ since_seconds }) => {
      const events = store.getDatabaseEvents({ sinceSeconds: since_seconds });
      const suggestions = suggestIndexes(events);

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      const response = {
        summary: `${suggestions.length} index suggestion(s) based on ${events.length} captured queries.`,
        data: suggestions.map((s) => ({
          table: s.table,
          columns: s.columns,
          reason: s.reason,
          estimatedImpact: s.estimatedImpact,
          queryPattern: s.queryPattern,
          suggestedSQL: `CREATE INDEX idx_${s.table}_${s.columns.join('_')} ON ${s.table}(${s.columns.join(', ')});`,
        })),
        issues: suggestions.filter((s) => s.estimatedImpact === 'high').map((s) => `High-impact index missing on ${s.table}(${s.columns.join(', ')})`),
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: events.length,
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
