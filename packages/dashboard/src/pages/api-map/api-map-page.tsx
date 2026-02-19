import { useState, useMemo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable, DetailPanel, Badge, StatusDot } from '@/components/ui';
import { MOCK_ENDPOINTS, MOCK_ENDPOINT_HEALTH, MOCK_SERVICES } from '@/mock/api-map';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { computeEndpoints, computeEndpointHealth, computeServices } from '@/lib/api-discovery';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';

const METHOD_COLORS: Record<string, string> = { GET: 'green', POST: 'purple', PUT: 'amber', DELETE: 'red', PATCH: 'orange' };

export function ApiMapPage() {
  const [activeTab, setActiveTab] = useState('endpoints');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const connected = useConnected();
  const source = useDataStore((s) => s.source);
  const liveNetwork = useDataStore((s) => s.network);

  const endpoints = useMemo(() => {
    if (source !== 'live' || liveNetwork.length === 0) return MOCK_ENDPOINTS;
    return computeEndpoints(liveNetwork);
  }, [source, liveNetwork]);

  const endpointHealth = useMemo(() => {
    if (source !== 'live' || liveNetwork.length === 0) return MOCK_ENDPOINT_HEALTH;
    return computeEndpointHealth(liveNetwork);
  }, [source, liveNetwork]);

  const services = useMemo(() => {
    if (source !== 'live' || liveNetwork.length === 0) return MOCK_SERVICES;
    return computeServices(liveNetwork);
  }, [source, liveNetwork]);

  const selectedHealth = selectedPath ? endpointHealth.find((h) => `${h.method} ${h.normalizedPath}` === selectedPath) : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Topbar
        title="API Map"
        tabs={[{ id: 'endpoints', label: 'Endpoints' }, { id: 'services', label: 'Services' }]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        connected={connected}
      />

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-auto">
          {activeTab === 'endpoints' && (
            <DataTable
              columns={[
                { key: 'method', header: 'Method', width: '90px', render: (row) => <Badge variant={(METHOD_COLORS[row.method as string] || 'default') as any} size="sm">{row.method as string}</Badge> },
                { key: 'normalizedPath', header: 'Path', render: (row) => <span className="font-mono text-[13px]">{row.normalizedPath as string}</span> },
                { key: 'service', header: 'Service', width: '140px', render: (row) => <span className="text-text-secondary">{row.service as string}</span> },
                { key: 'callCount', header: 'Calls', width: '80px', render: (row) => <span className="tabular-nums">{row.callCount as number}</span> },
                {
                  key: 'auth', header: 'Auth', width: '80px',
                  render: (row) => {
                    const auth = (row.auth as any)?.type || 'none';
                    return <Badge variant={auth === 'none' ? 'default' : 'green'} size="sm">{auth}</Badge>;
                  },
                },
              ]}
              data={endpoints as any}
              onRowClick={(row) => setSelectedPath(`${(row as any).method} ${(row as any).normalizedPath}`)}
              selectedIndex={selectedPath ? endpoints.findIndex((e) => `${e.method} ${e.normalizedPath}` === selectedPath) : undefined}
            />
          )}

          {activeTab === 'services' && (
            <div className="p-5 grid grid-cols-2 gap-4">
              {services.map((svc) => (
                <div key={svc.name} className="bg-bg-elevated border border-border-default rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[15px] font-semibold text-text-primary">{svc.name}</span>
                    <StatusDot color={svc.errorRate > 0.05 ? 'red' : svc.errorRate > 0 ? 'amber' : 'green'} size="md" />
                  </div>
                  <p className="text-[12px] text-text-muted font-mono mb-3">{svc.baseUrl}</p>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div><p className="text-lg font-bold tabular-nums">{svc.endpointCount}</p><p className="text-[10px] text-text-muted">Endpoints</p></div>
                    <div><p className="text-lg font-bold tabular-nums">{svc.totalCalls}</p><p className="text-[10px] text-text-muted">Calls</p></div>
                    <div><p className="text-lg font-bold tabular-nums">{formatDuration(svc.avgLatency)}</p><p className="text-[10px] text-text-muted">Avg Latency</p></div>
                  </div>
                  {svc.detectedPlatform && (
                    <div className="mt-3 pt-3 border-t border-border-muted">
                      <Badge size="sm">{svc.detectedPlatform}</Badge>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <DetailPanel
          open={selectedHealth !== null}
          onClose={() => setSelectedPath(null)}
          title={selectedHealth ? `${selectedHealth.method} ${selectedHealth.normalizedPath}` : ''}
          subtitle={selectedHealth ? selectedHealth.service : ''}
        >
          {selectedHealth && (
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Success Rate', value: `${(selectedHealth.successRate * 100).toFixed(0)}%` },
                  { label: 'Error Rate', value: `${(selectedHealth.errorRate * 100).toFixed(1)}%` },
                  { label: 'Avg Latency', value: formatDuration(selectedHealth.avgLatency) },
                  { label: 'P95 Latency', value: formatDuration(selectedHealth.p95Latency) },
                  { label: 'P50 Latency', value: formatDuration(selectedHealth.p50Latency) },
                  { label: 'Total Calls', value: String(selectedHealth.callCount) },
                ].map((item) => (
                  <div key={item.label} className="bg-bg-elevated rounded-md p-3 border border-border-muted">
                    <p className="text-[11px] text-text-muted">{item.label}</p>
                    <p className="text-[15px] font-bold tabular-nums">{item.value}</p>
                  </div>
                ))}
              </div>
              {Object.keys(selectedHealth.errorCodes).length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">Error Codes</p>
                  <div className="flex gap-2">
                    {Object.entries(selectedHealth.errorCodes).map(([code, count]) => (
                      <Badge key={code} variant="red" size="sm">{code}: {count}x</Badge>
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
