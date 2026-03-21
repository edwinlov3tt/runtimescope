import { useState, useMemo, useCallback } from 'react';
import { Topbar } from '@/components/layout/topbar';
import {
  DataTable,
  FilterBar,
  DetailPanel,
  Badge,
  StatusDot,
  Tabs,
  WaterfallBar,
} from '@/components/ui';
import { ResponseViewer } from '@/components/ui/response-viewer';
import { ExportButton } from '@/components/ui/export-button';
import { TableSkeleton } from '@/components/ui/skeleton';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { useKeyboardNav } from '@/hooks/use-keyboard-nav';
import {
  formatDuration,
  formatBytes,
  getStatusColor,
} from '@/lib/format';
import type { NetworkEvent } from '@/lib/runtime-types';

const STATUS_TEXT: Record<string, string> = {
  green: 'text-green',
  blue: 'text-blue',
  amber: 'text-amber',
  red: 'text-red',
};

const METHOD_VARIANT: Record<string, 'green' | 'purple' | 'amber' | 'red' | 'orange'> = {
  GET: 'green',
  POST: 'purple',
  PUT: 'amber',
  DELETE: 'red',
  PATCH: 'orange',
};

function getRequestName(req: NetworkEvent): string {
  if (req.graphqlOperation) return req.graphqlOperation.name;
  try {
    const path = new URL(req.url).pathname;
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
  } catch {
    return req.url;
  }
}

const COLUMNS = [
  {
    key: 'name',
    header: 'Name',
    width: '180px',
    render: (row: Record<string, unknown>) => (
      <span className="font-medium truncate block max-w-[160px]">
        {getRequestName(row as unknown as NetworkEvent)}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: '80px',
    render: (row: Record<string, unknown>) => {
      const color = getStatusColor(row.status as number);
      return (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot color={color} size="sm" />
          <span className={STATUS_TEXT[color]}>
            {row.status as number}
          </span>
        </span>
      );
    },
  },
  {
    key: 'method',
    header: 'Method',
    width: '90px',
    render: (row: Record<string, unknown>) => {
      const method = row.method as string;
      const variant = METHOD_VARIANT[method] ?? 'default';
      return (
        <Badge variant={variant as any} size="sm">
          {method}
        </Badge>
      );
    },
  },
  {
    key: 'url',
    header: 'URL',
    render: (row: Record<string, unknown>) => (
      <span className="text-text-secondary truncate block max-w-[300px] font-mono text-xs">
        {row.url as string}
      </span>
    ),
  },
  {
    key: 'duration',
    header: 'Duration',
    width: '100px',
    render: (row: Record<string, unknown>) => (
      <span className="tabular-nums">
        {formatDuration(row.duration as number)}
      </span>
    ),
  },
  {
    key: 'size',
    header: 'Size',
    width: '80px',
    render: (row: Record<string, unknown>) => (
      <span className="tabular-nums text-text-tertiary">
        {formatBytes(row.responseBodySize as number)}
      </span>
    ),
  },
];

export function NetworkPage() {
  const [activeTab, setActiveTab] = useState('all');
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState('headers');
  const [search, setSearch] = useState('');
  const connected = useConnected();
  const liveNetwork = useDataStore((s) => s.network);
  const initialLoadDone = useDataStore((s) => s.initialLoadDone);
  const allData = liveNetwork;

  const filtered = useMemo(() => {
    let data = allData;
    if (activeTab === 'fetch')
      data = data.filter((r) => r.source === 'fetch' && !r.graphqlOperation);
    if (activeTab === 'xhr') data = data.filter((r) => r.source === 'xhr');
    if (activeTab === 'graphql')
      data = data.filter((r) => r.graphqlOperation);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (r) =>
          r.url.toLowerCase().includes(q) ||
          getRequestName(r).toLowerCase().includes(q)
      );
    }
    return data;
  }, [activeTab, search, allData]);

  const { selectedIndex, setSelectedIndex } = useKeyboardNav({
    itemCount: filtered.length,
    onSelect: (i) => setDetailIndex(i),
    onDeselect: () => setDetailIndex(null),
  });

  const selectedRow = detailIndex !== null ? filtered[detailIndex] : null;

  const handleRowClick = useCallback((_: unknown, i: number) => setDetailIndex(i), []);
  const handleDetailClose = useCallback(() => setDetailIndex(null), []);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar
        title="Network"
        tabs={[
          { id: 'all', label: 'All' },
          { id: 'fetch', label: 'Fetch' },
          { id: 'xhr', label: 'XHR' },
          { id: 'graphql', label: 'GraphQL' },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        connected={connected}
      />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Filter by URL or name..."
          >
            <ExportButton data={filtered as unknown as Record<string, unknown>[]} filename="network-events" />
          </FilterBar>
          <div className="flex-1 overflow-auto">
            {!initialLoadDone && allData.length === 0 ? (
              <TableSkeleton rows={10} />
            ) : (
            <DataTable
              columns={COLUMNS}
              data={filtered as any}
              selectedIndex={detailIndex ?? selectedIndex}
              onRowClick={handleRowClick}
            />
            )}
          </div>
        </div>

        <DetailPanel
          open={selectedRow !== null}
          onClose={handleDetailClose}
          title={selectedRow ? getRequestName(selectedRow) : ''}
          subtitle={
            selectedRow
              ? `${selectedRow.method} ${selectedRow.status} \u00B7 ${formatDuration(selectedRow.duration)}`
              : ''
          }
        >
          {selectedRow && (
            <div className="flex flex-col flex-1 min-h-0">
              <Tabs
                tabs={[
                  { id: 'headers', label: 'Headers' },
                  { id: 'request', label: 'Request' },
                  { id: 'response', label: 'Response' },
                  { id: 'timing', label: 'Timing' },
                ]}
                activeTab={detailTab}
                onTabChange={setDetailTab}
              />
              <div className={cn(
                'p-4 flex-1 min-h-0',
                (detailTab === 'request' || detailTab === 'response') ? 'flex flex-col' : '',
              )}>
                {detailTab === 'headers' && (
                  <div className="space-y-4">
                    <div>
                      <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">
                        Request Headers
                      </h4>
                      <div className="space-y-1">
                        {Object.entries(selectedRow.requestHeaders).map(
                          ([k, v]) => (
                            <div
                              key={k}
                              className="flex gap-2 text-[13px] font-mono"
                            >
                              <span className="text-brand shrink-0">
                                {k}:
                              </span>
                              <span className="text-text-secondary truncate">
                                {v}
                              </span>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                    <div>
                      <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">
                        Response Headers
                      </h4>
                      <div className="space-y-1">
                        {Object.entries(selectedRow.responseHeaders).map(
                          ([k, v]) => (
                            <div
                              key={k}
                              className="flex gap-2 text-[13px] font-mono"
                            >
                              <span className="text-brand shrink-0">
                                {k}:
                              </span>
                              <span className="text-text-secondary truncate">
                                {v}
                              </span>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {detailTab === 'request' && (
                  <div className="flex flex-col flex-1 min-h-0">
                    {selectedRow.requestBody ? (
                      <ResponseViewer
                        content={selectedRow.requestBody}
                        label="Request"
                        filename={`request-${getRequestName(selectedRow)}`}
                      />
                    ) : (
                      <div className="space-y-2">
                        <p className="text-sm text-text-muted">No request body captured</p>
                        <p className="text-xs text-text-tertiary">
                          Enable body capture in your SDK config:
                          <code className="ml-1 px-1.5 py-0.5 bg-bg-elevated rounded text-text-secondary">captureBody: true</code>
                        </p>
                      </div>
                    )}
                  </div>
                )}
                {detailTab === 'response' && (
                  <div className="flex flex-col flex-1 min-h-0">
                    {selectedRow.responseBody ? (
                      <ResponseViewer
                        content={selectedRow.responseBody}
                        label="Response"
                        filename={`response-${getRequestName(selectedRow)}`}
                      />
                    ) : (
                      <div className="space-y-2">
                        <p className="text-sm text-text-muted">No response body captured</p>
                        <p className="text-xs text-text-tertiary">
                          Enable body capture in your SDK config:
                          <code className="ml-1 px-1.5 py-0.5 bg-bg-elevated rounded text-text-secondary">captureBody: true</code>
                        </p>
                      </div>
                    )}
                  </div>
                )}
                {detailTab === 'timing' && (
                  <div className="space-y-4">
                    <WaterfallBar
                      segments={[
                        {
                          label: 'TTFB',
                          value: selectedRow.ttfb,
                          color: 'var(--color-blue)',
                        },
                        {
                          label: 'Download',
                          value: selectedRow.duration - selectedRow.ttfb,
                          color: 'var(--color-green)',
                        },
                      ]}
                      total={selectedRow.duration}
                    />
                    <div className="text-sm text-text-secondary">
                      Total:{' '}
                      <span className="text-text-primary font-medium">
                        {formatDuration(selectedRow.duration)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </DetailPanel>
      </div>
    </div>
  );
}
