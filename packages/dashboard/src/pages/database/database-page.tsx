import { useState } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable, DetailPanel, Badge, CodeBlock, Tabs } from '@/components/ui';
import { MOCK_DATABASE, MOCK_QUERY_STATS, MOCK_SCHEMA } from '@/mock/database';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ChevronRight } from 'lucide-react';

export function DatabasePage() {
  const [activeTab, setActiveTab] = useState('queries');
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const connected = useConnected();
  const source = useDataStore((s) => s.source);
  const liveDatabase = useDataStore((s) => s.database);
  const queries = source === 'live' ? liveDatabase : MOCK_DATABASE;

  const selectedQuery = activeTab === 'queries' && detailIndex !== null ? queries[detailIndex] : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Topbar
        title="Database"
        tabs={[{ id: 'queries', label: 'Queries' }, { id: 'performance', label: 'Performance' }, { id: 'schema', label: 'Schema' }]}
        activeTab={activeTab}
        onTabChange={(t) => { setActiveTab(t); setDetailIndex(null); }}
        connected={connected}
      />

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-auto">
          {activeTab === 'queries' && (
            <DataTable
              columns={[
                { key: 'query', header: 'Query', render: (row) => <span className="font-mono text-[12px] text-text-secondary truncate block max-w-[400px]">{row.query as string}</span> },
                { key: 'duration', header: 'Duration', width: '100px', render: (row) => <span className={cn('tabular-nums', (row.duration as number) > 100 ? 'text-amber' : '')}>{formatDuration(row.duration as number)}</span> },
                { key: 'operation', header: 'Op', width: '80px', render: (row) => <Badge variant={row.operation === 'SELECT' ? 'blue' : row.operation === 'INSERT' ? 'green' : row.operation === 'DELETE' ? 'red' : 'amber'} size="sm">{row.operation as string}</Badge> },
                { key: 'rowsReturned', header: 'Rows', width: '70px', render: (row) => <span className="tabular-nums">{(row.rowsReturned ?? row.rowsAffected ?? '-') as any}</span> },
                { key: 'source', header: 'Source', width: '80px', render: (row) => <span className="text-text-tertiary">{row.source as string}</span> },
              ]}
              data={queries as any}
              selectedIndex={detailIndex ?? undefined}
              onRowClick={(_, i) => setDetailIndex(i)}
            />
          )}

          {activeTab === 'performance' && (
            <DataTable
              columns={[
                { key: 'normalizedQuery', header: 'Pattern', render: (row) => <span className="font-mono text-[12px] text-text-secondary truncate block max-w-[350px]">{row.normalizedQuery as string}</span> },
                { key: 'callCount', header: 'Calls', width: '70px', render: (row) => <span className="tabular-nums">{row.callCount as number}</span> },
                { key: 'avgDuration', header: 'Avg', width: '80px', render: (row) => <span className="tabular-nums">{formatDuration(row.avgDuration as number)}</span> },
                { key: 'p95Duration', header: 'P95', width: '80px', render: (row) => <span className="tabular-nums">{formatDuration(row.p95Duration as number)}</span> },
                { key: 'maxDuration', header: 'Max', width: '80px', render: (row) => <span className={cn('tabular-nums', (row.maxDuration as number) > 200 ? 'text-amber' : '')}>{formatDuration(row.maxDuration as number)}</span> },
                { key: 'operation', header: 'Op', width: '80px', render: (row) => <Badge variant="blue" size="sm">{row.operation as string}</Badge> },
              ]}
              data={MOCK_QUERY_STATS as any}
              defaultSort={{ key: 'avgDuration', direction: 'desc' }}
            />
          )}

          {activeTab === 'schema' && (
            <div className="p-5 space-y-2">
              {MOCK_SCHEMA.map((table) => (
                <div key={table.name} className="border border-border-default rounded-lg overflow-hidden">
                  <button
                    onClick={() => setExpandedTable(expandedTable === table.name ? null : table.name)}
                    className="w-full flex items-center gap-2 px-4 py-3 bg-bg-elevated hover:bg-bg-hover transition-colors cursor-pointer"
                  >
                    <ChevronRight size={14} className={cn('text-text-muted transition-transform', expandedTable === table.name && 'rotate-90')} />
                    <span className="text-[13px] font-semibold text-text-primary">{table.name}</span>
                    <span className="text-[11px] text-text-muted ml-auto">{table.columns.length} columns{table.rowCount ? ` · ${table.rowCount.toLocaleString()} rows` : ''}</span>
                  </button>
                  {expandedTable === table.name && (
                    <div className="px-4 pb-3 space-y-3">
                      <table className="w-full text-[12px]">
                        <thead>
                          <tr className="text-text-muted border-b border-border-muted">
                            <th className="text-left py-1.5 px-2 font-medium">Column</th>
                            <th className="text-left py-1.5 px-2 font-medium">Type</th>
                            <th className="text-left py-1.5 px-2 font-medium">Nullable</th>
                            <th className="text-left py-1.5 px-2 font-medium">Default</th>
                          </tr>
                        </thead>
                        <tbody>
                          {table.columns.map((col) => (
                            <tr key={col.name} className="border-b border-border-muted">
                              <td className="py-1.5 px-2 font-mono text-text-primary">
                                {col.isPrimaryKey && <span className="text-amber mr-1">PK</span>}
                                {col.name}
                              </td>
                              <td className="py-1.5 px-2 font-mono text-text-tertiary">{col.type}</td>
                              <td className="py-1.5 px-2">{col.nullable ? <span className="text-text-muted">yes</span> : <span className="text-text-secondary">no</span>}</td>
                              <td className="py-1.5 px-2 font-mono text-text-muted">{col.defaultValue || '\u2014'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {table.foreignKeys.length > 0 && (
                        <div>
                          <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Foreign Keys</p>
                          {table.foreignKeys.map((fk) => (
                            <p key={fk.column} className="text-[12px] font-mono text-text-tertiary">{fk.column} &rarr; {fk.referencedTable}.{fk.referencedColumn}</p>
                          ))}
                        </div>
                      )}
                      {table.indexes.length > 0 && (
                        <div>
                          <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Indexes</p>
                          {table.indexes.map((idx) => (
                            <div key={idx.name} className="flex items-center gap-2 text-[12px]">
                              <span className="font-mono text-text-tertiary">{idx.name}</span>
                              {idx.unique && <Badge size="sm" variant="green">unique</Badge>}
                              <span className="text-text-muted">({idx.columns.join(', ')})</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <DetailPanel
          open={selectedQuery !== null}
          onClose={() => setDetailIndex(null)}
          title={selectedQuery ? (selectedQuery.label || selectedQuery.operation) : ''}
          subtitle={selectedQuery ? `${formatDuration(selectedQuery.duration)} \u00b7 ${selectedQuery.source}` : ''}
        >
          {selectedQuery && (
            <div className="p-4 space-y-4">
              <div>
                <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">SQL Query</p>
                <CodeBlock language="sql">{selectedQuery.query}</CodeBlock>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
                  <p className="text-[11px] text-text-muted">Duration</p>
                  <p className="text-[15px] font-bold tabular-nums">{formatDuration(selectedQuery.duration)}</p>
                </div>
                <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
                  <p className="text-[11px] text-text-muted">Rows</p>
                  <p className="text-[15px] font-bold tabular-nums">{selectedQuery.rowsReturned ?? selectedQuery.rowsAffected ?? '\u2014'}</p>
                </div>
              </div>
              {selectedQuery.error && (
                <div className="bg-red-muted border border-red-border rounded-md p-3">
                  <p className="text-sm text-red">{selectedQuery.error}</p>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>
    </div>
  );
}
