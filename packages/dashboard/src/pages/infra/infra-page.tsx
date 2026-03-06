import { useState } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable, Badge } from '@/components/ui';
import { useConnected } from '@/hooks/use-connected';

export function InfraPage() {
  const [activeTab, setActiveTab] = useState('deploys');
  const connected = useConnected();

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar
        title="Infrastructure"
        tabs={[{ id: 'deploys', label: 'Deploys' }, { id: 'overview', label: 'Overview' }]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        connected={connected}
      />

      <div className="flex-1 overflow-auto">
        {activeTab === 'deploys' && (
          <DataTable
            columns={[
              { key: 'platform', header: 'Platform', width: '150px' },
              { key: 'status', header: 'Status', width: '100px', render: (row) => <Badge size="sm">{row.status as string}</Badge> },
              { key: 'branch', header: 'Branch', width: '180px', render: (row) => <span className="font-mono text-[12px] text-text-secondary">{(row.branch as string) || '\u2014'}</span> },
              { key: 'commit', header: 'Commit', width: '80px', render: (row) => <span className="font-mono text-[12px] text-text-muted">{(row.commit as string)?.slice(0, 7) || '\u2014'}</span> },
            ]}
            data={[] as Record<string, unknown>[]}
          />
        )}

        {activeTab === 'overview' && (
          <div className="p-5">
            <p className="text-sm text-text-muted">Connect infrastructure integrations to see deploy and build status.</p>
          </div>
        )}
      </div>
    </div>
  );
}
