import { useState, useMemo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable, DetailPanel, Badge, CodeBlock, FilterBar } from '@/components/ui';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { formatDuration, formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { DatabaseEvent } from '@/lib/runtime-types';

// ── Client-side aggregation (mirrors collector's query-monitor.ts) ────

interface QueryStats {
  normalizedQuery: string;
  tables: string[];
  operation: string;
  callCount: number;
  avgDuration: number;
  maxDuration: number;
  p95Duration: number;
  totalDuration: number;
  avgRows: number;
}

interface TableInfo {
  name: string;
  operations: { SELECT: number; INSERT: number; UPDATE: number; DELETE: number; OTHER: number };
  totalQueries: number;
  avgDuration: number;
  columns: string[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * (p / 100)) - 1;
  return sorted[Math.max(0, idx)];
}

function aggregateStats(events: DatabaseEvent[]): QueryStats[] {
  const groups = new Map<string, DatabaseEvent[]>();
  for (const e of events) {
    const group = groups.get(e.normalizedQuery) ?? [];
    group.push(e);
    groups.set(e.normalizedQuery, group);
  }

  const stats: QueryStats[] = [];
  for (const [nq, group] of groups) {
    const durations = group.map((e) => e.duration).sort((a, b) => a - b);
    const total = durations.reduce((s, d) => s + d, 0);
    const tables = new Set<string>();
    for (const e of group) for (const t of e.tablesAccessed) tables.add(t);
    const rows = group.filter((e) => e.rowsReturned != null).map((e) => e.rowsReturned!);

    stats.push({
      normalizedQuery: nq,
      tables: [...tables],
      operation: group[0].operation,
      callCount: group.length,
      avgDuration: total / group.length,
      maxDuration: Math.max(...durations),
      p95Duration: percentile(durations, 95),
      totalDuration: total,
      avgRows: rows.length > 0 ? rows.reduce((s, r) => s + r, 0) / rows.length : 0,
    });
  }

  return stats.sort((a, b) => b.totalDuration - a.totalDuration);
}

function buildSchema(events: DatabaseEvent[]): TableInfo[] {
  const tableMap = new Map<string, TableInfo>();

  for (const e of events) {
    for (const table of e.tablesAccessed) {
      let info = tableMap.get(table);
      if (!info) {
        info = {
          name: table,
          operations: { SELECT: 0, INSERT: 0, UPDATE: 0, DELETE: 0, OTHER: 0 },
          totalQueries: 0,
          avgDuration: 0,
          columns: [],
        };
        tableMap.set(table, info);
      }
      info.totalQueries++;
      const op = e.operation in info.operations ? e.operation : 'OTHER';
      info.operations[op as keyof typeof info.operations]++;
    }
  }

  // Compute avg duration per table
  for (const [table, info] of tableMap) {
    const tableEvents = events.filter((e) => e.tablesAccessed.includes(table));
    const total = tableEvents.reduce((s, e) => s + e.duration, 0);
    info.avgDuration = tableEvents.length > 0 ? total / tableEvents.length : 0;

    // Extract column names from queries (best effort)
    const colSet = new Set<string>();
    for (const e of tableEvents) {
      const colRe = /(?:WHERE|AND|OR|SET|ON)\s+["'`]?(\w+)["'`]?\s*(?:=|>|<|!=|LIKE|IN|IS)/gi;
      let m: RegExpExecArray | null;
      while ((m = colRe.exec(e.query)) !== null) {
        const col = m[1].toLowerCase();
        if (!['select', 'from', 'where', 'and', 'or', 'not', 'null', 'true', 'false'].includes(col)) {
          colSet.add(m[1]);
        }
      }
    }
    info.columns = [...colSet].sort();
  }

  return [...tableMap.values()].sort((a, b) => b.totalQueries - a.totalQueries);
}

const OP_VARIANT: Record<string, 'blue' | 'green' | 'red' | 'amber' | 'purple'> = {
  SELECT: 'blue',
  INSERT: 'green',
  DELETE: 'red',
  UPDATE: 'amber',
  OTHER: 'purple',
};

// ── Component ─────────────────────────────────────────────────

export function DatabasePage() {
  const [activeTab, setActiveTab] = useState('queries');
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [opFilter, setOpFilter] = useState<string | null>(null);
  const connected = useConnected();
  const queries = useDataStore((s) => s.database);

  // Filtered queries
  const filtered = useMemo(() => {
    let data = queries;
    if (opFilter) data = data.filter((q) => q.operation === opFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((d) => d.query.toLowerCase().includes(q) || d.tablesAccessed.some((t) => t.toLowerCase().includes(q)));
    }
    return data;
  }, [queries, opFilter, search]);

  // Performance stats
  const perfStats = useMemo(() => aggregateStats(queries), [queries]);

  // Schema from observed queries
  const schema = useMemo(() => buildSchema(queries), [queries]);

  const selectedQuery = activeTab === 'queries' && detailIndex !== null ? filtered[detailIndex] : null;
  const selectedPerf = activeTab === 'performance' && detailIndex !== null ? perfStats[detailIndex] : null;
  const selectedTable = activeTab === 'schema' && detailIndex !== null ? schema[detailIndex] : null;

  // Summary stats
  const totalQueries = queries.length;
  const avgDuration = totalQueries > 0 ? queries.reduce((s, q) => s + q.duration, 0) / totalQueries : 0;
  const slowCount = queries.filter((q) => q.duration > 500).length;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar
        title="Database"
        tabs={[
          { id: 'queries', label: 'Queries' },
          { id: 'performance', label: 'Performance' },
          { id: 'schema', label: 'Schema' },
        ]}
        activeTab={activeTab}
        onTabChange={(t) => { setActiveTab(t); setDetailIndex(null); setSearch(''); setOpFilter(null); }}
        connected={connected}
      />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {activeTab === 'queries' && (
            <FilterBar
              search={search}
              onSearchChange={setSearch}
              searchPlaceholder="Filter by query or table..."
            >
              <div className="flex items-center gap-2">
                {['SELECT', 'INSERT', 'UPDATE', 'DELETE'].map((op) => (
                  <button
                    key={op}
                    onClick={() => setOpFilter(opFilter === op ? null : op)}
                    className={cn(
                      'px-2 py-0.5 rounded text-[11px] font-medium transition-colors',
                      opFilter === op
                        ? 'bg-brand/15 text-brand'
                        : 'text-text-muted hover:text-text-secondary',
                    )}
                  >
                    {op}
                  </button>
                ))}
                <span className="text-xs text-text-muted ml-2">
                  {filtered.length} queries
                  {slowCount > 0 && <span className="text-amber ml-1">({slowCount} slow)</span>}
                </span>
              </div>
            </FilterBar>
          )}

          {activeTab === 'performance' && (
            <FilterBar search="" onSearchChange={() => {}} searchPlaceholder="">
              <div className="flex items-center gap-3 text-xs text-text-muted">
                <span>{perfStats.length} patterns</span>
                <span>{formatNumber(totalQueries)} total queries</span>
                <span>Avg {formatDuration(avgDuration)}</span>
              </div>
            </FilterBar>
          )}

          <div className="flex-1 overflow-auto">
            {activeTab === 'queries' && (
              <DataTable
                columns={[
                  {
                    key: 'query',
                    header: 'Query',
                    render: (row) => (
                      <span className="font-mono text-[12px] text-text-secondary truncate block max-w-[400px]">
                        {row.query as string}
                      </span>
                    ),
                  },
                  {
                    key: 'duration',
                    header: 'Duration',
                    width: '100px',
                    render: (row) => (
                      <span className={cn('tabular-nums', (row.duration as number) > 500 ? 'text-red' : (row.duration as number) > 100 ? 'text-amber' : '')}>
                        {formatDuration(row.duration as number)}
                      </span>
                    ),
                  },
                  {
                    key: 'operation',
                    header: 'Op',
                    width: '80px',
                    render: (row) => (
                      <Badge variant={OP_VARIANT[row.operation as string] ?? 'purple'} size="sm">
                        {row.operation as string}
                      </Badge>
                    ),
                  },
                  {
                    key: 'rows',
                    header: 'Rows',
                    width: '70px',
                    render: (row) => {
                      const r = row as unknown as DatabaseEvent;
                      return <span className="tabular-nums">{r.rowsReturned ?? r.rowsAffected ?? '\u2014'}</span>;
                    },
                  },
                  {
                    key: 'tables',
                    header: 'Tables',
                    width: '120px',
                    render: (row) => {
                      const tables = (row as unknown as DatabaseEvent).tablesAccessed;
                      return <span className="text-text-muted text-xs truncate block max-w-[100px]">{tables.join(', ') || '\u2014'}</span>;
                    },
                  },
                  {
                    key: 'source',
                    header: 'Source',
                    width: '80px',
                    render: (row) => <span className="text-text-muted text-xs">{row.source as string}</span>,
                  },
                ]}
                data={filtered as unknown as Record<string, unknown>[]}
                selectedIndex={detailIndex ?? undefined}
                onRowClick={(_, i) => setDetailIndex(i)}
              />
            )}

            {activeTab === 'performance' && (
              <DataTable
                columns={[
                  {
                    key: 'normalizedQuery',
                    header: 'Query Pattern',
                    render: (row) => (
                      <span className="font-mono text-[12px] text-text-secondary truncate block max-w-[350px]">
                        {row.normalizedQuery as string}
                      </span>
                    ),
                  },
                  {
                    key: 'callCount',
                    header: 'Calls',
                    width: '70px',
                    render: (row) => (
                      <span className={cn('tabular-nums', (row.callCount as number) > 50 ? 'text-amber' : '')}>
                        {row.callCount as number}
                      </span>
                    ),
                  },
                  {
                    key: 'avgDuration',
                    header: 'Avg',
                    width: '80px',
                    render: (row) => <span className="tabular-nums">{formatDuration(row.avgDuration as number)}</span>,
                  },
                  {
                    key: 'p95Duration',
                    header: 'P95',
                    width: '80px',
                    render: (row) => (
                      <span className={cn('tabular-nums', (row.p95Duration as number) > 500 ? 'text-red' : (row.p95Duration as number) > 200 ? 'text-amber' : '')}>
                        {formatDuration(row.p95Duration as number)}
                      </span>
                    ),
                  },
                  {
                    key: 'maxDuration',
                    header: 'Max',
                    width: '80px',
                    render: (row) => (
                      <span className={cn('tabular-nums', (row.maxDuration as number) > 500 ? 'text-red' : (row.maxDuration as number) > 200 ? 'text-amber' : '')}>
                        {formatDuration(row.maxDuration as number)}
                      </span>
                    ),
                  },
                  {
                    key: 'operation',
                    header: 'Op',
                    width: '80px',
                    render: (row) => (
                      <Badge variant={OP_VARIANT[row.operation as string] ?? 'purple'} size="sm">
                        {row.operation as string}
                      </Badge>
                    ),
                  },
                  {
                    key: 'totalDuration',
                    header: 'Total',
                    width: '80px',
                    render: (row) => <span className="tabular-nums text-text-muted">{formatDuration(row.totalDuration as number)}</span>,
                  },
                ]}
                data={perfStats as unknown as Record<string, unknown>[]}
                selectedIndex={detailIndex ?? undefined}
                onRowClick={(_, i) => setDetailIndex(i)}
              />
            )}

            {activeTab === 'schema' && (
              <DataTable
                columns={[
                  {
                    key: 'name',
                    header: 'Table',
                    width: '180px',
                    render: (row) => (
                      <span className="font-mono text-[13px] font-medium text-text-primary">{row.name as string}</span>
                    ),
                  },
                  {
                    key: 'totalQueries',
                    header: 'Queries',
                    width: '80px',
                    render: (row) => <span className="tabular-nums">{formatNumber(row.totalQueries as number)}</span>,
                  },
                  {
                    key: 'select',
                    header: 'SEL',
                    width: '60px',
                    render: (row) => {
                      const ops = (row as unknown as TableInfo).operations;
                      return <span className="tabular-nums text-blue">{ops.SELECT || '\u2014'}</span>;
                    },
                  },
                  {
                    key: 'insert',
                    header: 'INS',
                    width: '60px',
                    render: (row) => {
                      const ops = (row as unknown as TableInfo).operations;
                      return <span className="tabular-nums text-green">{ops.INSERT || '\u2014'}</span>;
                    },
                  },
                  {
                    key: 'update',
                    header: 'UPD',
                    width: '60px',
                    render: (row) => {
                      const ops = (row as unknown as TableInfo).operations;
                      return <span className="tabular-nums text-amber">{ops.UPDATE || '\u2014'}</span>;
                    },
                  },
                  {
                    key: 'delete',
                    header: 'DEL',
                    width: '60px',
                    render: (row) => {
                      const ops = (row as unknown as TableInfo).operations;
                      return <span className="tabular-nums text-red">{ops.DELETE || '\u2014'}</span>;
                    },
                  },
                  {
                    key: 'avgDuration',
                    header: 'Avg',
                    width: '80px',
                    render: (row) => <span className="tabular-nums">{formatDuration(row.avgDuration as number)}</span>,
                  },
                ]}
                data={schema as unknown as Record<string, unknown>[]}
                selectedIndex={detailIndex ?? undefined}
                onRowClick={(_, i) => setDetailIndex(i)}
              />
            )}
          </div>
        </div>

        {/* Detail panels */}
        <DetailPanel
          open={selectedQuery !== null}
          onClose={() => setDetailIndex(null)}
          title={selectedQuery ? (selectedQuery.label || selectedQuery.operation) : ''}
          subtitle={selectedQuery ? `${formatDuration(selectedQuery.duration)} · ${selectedQuery.source}` : ''}
        >
          {selectedQuery && (
            <div className="p-4 space-y-4">
              <div>
                <SectionLabel>SQL Query</SectionLabel>
                <CodeBlock language="sql">{selectedQuery.query}</CodeBlock>
              </div>
              {selectedQuery.normalizedQuery !== selectedQuery.query && (
                <div>
                  <SectionLabel>Normalized</SectionLabel>
                  <CodeBlock language="sql">{selectedQuery.normalizedQuery}</CodeBlock>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Duration" value={formatDuration(selectedQuery.duration)} warn={selectedQuery.duration > 500} />
                <StatCard label="Rows" value={String(selectedQuery.rowsReturned ?? selectedQuery.rowsAffected ?? '\u2014')} />
                <StatCard label="Tables" value={selectedQuery.tablesAccessed.join(', ') || '\u2014'} />
                <StatCard label="Source" value={selectedQuery.source} />
              </div>
              {selectedQuery.params && (
                <div>
                  <SectionLabel>Parameters</SectionLabel>
                  <CodeBlock language="json">{selectedQuery.params}</CodeBlock>
                </div>
              )}
              {selectedQuery.stackTrace && (
                <div>
                  <SectionLabel>Stack Trace</SectionLabel>
                  <pre className="text-[11px] font-mono text-text-muted whitespace-pre-wrap break-all bg-bg-elevated rounded-md p-3 max-h-48 overflow-auto">
                    {selectedQuery.stackTrace}
                  </pre>
                </div>
              )}
              {selectedQuery.error && (
                <div className="bg-red/5 border border-red/20 rounded-md p-3">
                  <SectionLabel>Error</SectionLabel>
                  <p className="text-sm text-red">{selectedQuery.error}</p>
                </div>
              )}
            </div>
          )}
        </DetailPanel>

        <DetailPanel
          open={selectedPerf !== null}
          onClose={() => setDetailIndex(null)}
          title={selectedPerf ? `${selectedPerf.operation} Pattern` : ''}
          subtitle={selectedPerf ? `${selectedPerf.callCount} calls · ${formatDuration(selectedPerf.totalDuration)} total` : ''}
        >
          {selectedPerf && (
            <div className="p-4 space-y-4">
              <div>
                <SectionLabel>Query Pattern</SectionLabel>
                <CodeBlock language="sql">{selectedPerf.normalizedQuery}</CodeBlock>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Calls" value={formatNumber(selectedPerf.callCount)} warn={selectedPerf.callCount > 50} />
                <StatCard label="Avg Duration" value={formatDuration(selectedPerf.avgDuration)} warn={selectedPerf.avgDuration > 200} />
                <StatCard label="P95 Duration" value={formatDuration(selectedPerf.p95Duration)} warn={selectedPerf.p95Duration > 500} />
                <StatCard label="Max Duration" value={formatDuration(selectedPerf.maxDuration)} warn={selectedPerf.maxDuration > 500} />
                <StatCard label="Total Time" value={formatDuration(selectedPerf.totalDuration)} />
                <StatCard label="Avg Rows" value={selectedPerf.avgRows > 0 ? selectedPerf.avgRows.toFixed(0) : '\u2014'} />
              </div>
              {selectedPerf.tables.length > 0 && (
                <div>
                  <SectionLabel>Tables Accessed</SectionLabel>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {selectedPerf.tables.map((t) => (
                      <Badge key={t} size="sm">{t}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DetailPanel>

        <DetailPanel
          open={selectedTable !== null}
          onClose={() => setDetailIndex(null)}
          title={selectedTable ? selectedTable.name : ''}
          subtitle={selectedTable ? `${formatNumber(selectedTable.totalQueries)} queries · Avg ${formatDuration(selectedTable.avgDuration)}` : ''}
        >
          {selectedTable && (
            <div className="p-4 space-y-4">
              <div>
                <SectionLabel>Operation Breakdown</SectionLabel>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <StatCard label="SELECT" value={String(selectedTable.operations.SELECT)} />
                  <StatCard label="INSERT" value={String(selectedTable.operations.INSERT)} />
                  <StatCard label="UPDATE" value={String(selectedTable.operations.UPDATE)} />
                  <StatCard label="DELETE" value={String(selectedTable.operations.DELETE)} />
                </div>
              </div>

              <div>
                <SectionLabel>Query Mix</SectionLabel>
                <div className="flex h-3 rounded-full overflow-hidden mt-2">
                  {Object.entries(selectedTable.operations)
                    .filter(([, count]) => count > 0)
                    .map(([op, count]) => {
                      const pct = (count / selectedTable.totalQueries) * 100;
                      const colors: Record<string, string> = {
                        SELECT: 'bg-blue', INSERT: 'bg-green', UPDATE: 'bg-amber', DELETE: 'bg-red', OTHER: 'bg-purple',
                      };
                      return (
                        <div
                          key={op}
                          className={cn(colors[op] ?? 'bg-text-muted', 'transition-all')}
                          style={{ width: `${pct}%` }}
                          title={`${op}: ${count} (${pct.toFixed(0)}%)`}
                        />
                      );
                    })}
                </div>
                <div className="flex gap-3 mt-2 text-[11px] text-text-muted">
                  {Object.entries(selectedTable.operations)
                    .filter(([, count]) => count > 0)
                    .map(([op, count]) => (
                      <span key={op}>{op} {count}</span>
                    ))}
                </div>
              </div>

              {selectedTable.columns.length > 0 && (
                <div>
                  <SectionLabel>Observed Columns</SectionLabel>
                  <p className="text-[11px] text-text-muted mb-2">Columns seen in WHERE/SET clauses</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedTable.columns.map((col) => (
                      <span key={col} className="font-mono text-xs px-2 py-0.5 rounded bg-bg-elevated text-text-secondary">
                        {col}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">{children}</p>
  );
}

function StatCard({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className={cn('text-[15px] font-bold tabular-nums', warn && 'text-amber')}>{value}</p>
    </div>
  );
}
