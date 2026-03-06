import { useState } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable } from '@/components/ui';
import { useConnected } from '@/hooks/use-connected';
import { cn } from '@/lib/cn';

export function SessionsPage() {
  const [activeTab, setActiveTab] = useState('history');
  const connected = useConnected();

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar
        title="Sessions"
        tabs={[{ id: 'history', label: 'History' }, { id: 'compare', label: 'Compare' }]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        connected={connected}
      />

      <div className="flex-1 overflow-auto">
        {activeTab === 'history' && (
          <DataTable
            columns={[
              { key: 'sessionId', header: 'Session', width: '120px', render: (row) => <span className="font-mono text-[12px]">{row.sessionId as string}</span> },
              { key: 'project', header: 'Project', width: '100px' },
              { key: 'totalEvents', header: 'Events', width: '80px', render: (row) => <span className="tabular-nums">{row.totalEvents as number}</span> },
              { key: 'errorCount', header: 'Errors', width: '80px', render: (row) => { const c = row.errorCount as number; return <span className={cn('tabular-nums', c > 5 ? 'text-red' : c > 0 ? 'text-amber' : 'text-text-muted')}>{c}</span>; } },
            ]}
            data={[] as Record<string, unknown>[]}
          />
        )}

        {activeTab === 'compare' && (
          <div className="p-5 space-y-6 max-w-4xl mx-auto w-full">
            <p className="text-sm text-text-muted">Connect two sessions with the SDK to compare them.</p>
          </div>
        )}
      </div>
    </div>
  );
}
