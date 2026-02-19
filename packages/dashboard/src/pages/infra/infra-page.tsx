import { useState } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable, Badge, StatusDot } from '@/components/ui';
import { MOCK_DEPLOYS, MOCK_BUILD_STATUS, MOCK_INFRA_OVERVIEW } from '@/mock/infra';
import { useConnected } from '@/hooks/use-connected';
import { formatRelativeTime } from '@/lib/format';

const STATUS_BADGE: Record<string, string> = { ready: 'green', building: 'blue', error: 'red', canceled: 'default' };

export function InfraPage() {
  const [activeTab, setActiveTab] = useState('deploys');
  const connected = useConnected();

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Topbar
        title="Infrastructure"
        tabs={[{ id: 'deploys', label: 'Deploys' }, { id: 'overview', label: 'Overview' }]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        connected={connected}
      />

      <div className="flex-1 overflow-auto">
        {activeTab === 'deploys' && (
          <div>
            {/* Build status cards */}
            <div className="p-5 grid grid-cols-3 gap-4 border-b border-border-default">
              {MOCK_BUILD_STATUS.map((bs) => (
                <div key={bs.platform} className="bg-bg-elevated border border-border-default rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[13px] font-semibold text-text-primary">{bs.platform}</span>
                    <Badge variant={STATUS_BADGE[bs.status] as any} size="sm">{bs.status}</Badge>
                  </div>
                  <p className="text-[12px] text-text-tertiary">{bs.project}</p>
                  <p className="text-[11px] text-text-muted mt-1">Last: {formatRelativeTime(bs.lastDeployed)}</p>
                </div>
              ))}
            </div>

            {/* Deploy history */}
            <DataTable
              columns={[
                { key: 'platform', header: 'Platform', width: '150px' },
                { key: 'status', header: 'Status', width: '100px', render: (row) => <Badge variant={(STATUS_BADGE[row.status as string] || 'default') as any} size="sm">{row.status as string}</Badge> },
                { key: 'branch', header: 'Branch', width: '180px', render: (row) => <span className="font-mono text-[12px] text-text-secondary">{(row.branch as string) || '\u2014'}</span> },
                { key: 'commit', header: 'Commit', width: '80px', render: (row) => <span className="font-mono text-[12px] text-text-muted">{(row.commit as string)?.slice(0, 7) || '\u2014'}</span> },
                { key: 'createdAt', header: 'Created', width: '100px', render: (row) => <span className="text-text-muted text-[12px]">{formatRelativeTime(row.createdAt as number)}</span> },
              ]}
              data={MOCK_DEPLOYS as any}
            />
          </div>
        )}

        {activeTab === 'overview' && (
          <div className="p-5 space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-text-primary mb-3">Platforms</h3>
              <div className="space-y-2">
                {MOCK_INFRA_OVERVIEW.platforms.map((p) => (
                  <div key={p.name} className="flex items-center gap-3 bg-bg-elevated border border-border-default rounded-lg px-4 py-3">
                    <StatusDot color={p.configured ? (p.status === 'ready' ? 'green' : p.status === 'building' ? 'blue' : p.status === 'error' ? 'red' : 'gray') : 'gray'} size="md" />
                    <span className="text-[13px] font-medium text-text-primary flex-1">{p.name}</span>
                    {p.configured ? (
                      <>
                        <span className="text-[12px] text-text-muted">{p.deployCount} deploys</span>
                        {p.lastDeploy && <span className="text-[11px] text-text-muted">{formatRelativeTime(p.lastDeploy)}</span>}
                      </>
                    ) : (
                      <span className="text-[12px] text-text-muted">Not configured</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-text-primary mb-3">Detected from Traffic</h3>
              <div className="flex gap-2">
                {MOCK_INFRA_OVERVIEW.detectedFromTraffic.map((name) => (
                  <Badge key={name} variant="cyan" size="sm">{name}</Badge>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
