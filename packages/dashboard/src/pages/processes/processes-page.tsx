import { useState, useCallback } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable, Badge, StatusDot } from '@/components/ui';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { cn } from '@/lib/cn';
import { killProcess } from '@/lib/api';
import { Square } from 'lucide-react';

export function ProcessesPage() {
  const [activeTab, setActiveTab] = useState('processes');
  const connected = useConnected();
  const liveProcesses = useDataStore((s) => s.processes);
  const livePorts = useDataStore((s) => s.ports);

  const processes = liveProcesses;
  const ports = livePorts;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar
        title="Processes"
        tabs={[{ id: 'processes', label: 'Processes' }, { id: 'ports', label: 'Ports' }]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        connected={connected}
      />

      <div className="flex-1 overflow-auto">
        {activeTab === 'processes' && (
          <DataTable
            columns={[
              { key: 'type', header: 'Type', width: '100px', render: (row) => <Badge size="sm">{row.type as string}</Badge> },
              { key: 'command', header: 'Command', render: (row) => <span className="font-mono text-[12px] text-text-secondary truncate block max-w-[300px]">{row.command as string}</span> },
              { key: 'pid', header: 'PID', width: '70px', render: (row) => <span className="tabular-nums text-text-muted">{row.pid as number}</span> },
              { key: 'cpuPercent', header: 'CPU%', width: '80px', render: (row) => <span className={cn('tabular-nums', (row.cpuPercent as number) > 20 ? 'text-amber' : (row.cpuPercent as number) > 40 ? 'text-red' : '')}>{(row.cpuPercent as number).toFixed(1)}%</span> },
              { key: 'memoryMB', header: 'Memory', width: '90px', render: (row) => <span className={cn('tabular-nums', (row.memoryMB as number) > 300 ? 'text-amber' : '')}>{row.memoryMB as number} MB</span> },
              { key: 'ports', header: 'Ports', width: '100px', render: (row) => <span className="text-text-tertiary tabular-nums">{((row.ports as number[]) || []).join(', ')}</span> },
              {
                key: 'isOrphaned', header: 'Status', width: '90px',
                render: (row) => (row.isOrphaned as boolean)
                  ? <span className="flex items-center gap-1.5"><StatusDot color="red" size="sm" pulse /><span className="text-red text-[12px]">Orphaned</span></span>
                  : <span className="flex items-center gap-1.5"><StatusDot color="green" size="sm" /><span className="text-green text-[12px]">Running</span></span>,
              },
              {
                key: 'actions', header: '', width: '60px',
                render: (row) => (
                  <button
                    type="button"
                    onClick={async () => {
                      await killProcess(row.pid as number);
                    }}
                    className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-red transition-colors cursor-pointer"
                    title="Kill process"
                  >
                    <Square size={12} />
                  </button>
                ),
              },
            ]}
            data={processes as any}
          />
        )}

        {activeTab === 'ports' && (
          <DataTable
            columns={[
              { key: 'port', header: 'Port', width: '80px', render: (row) => <span className="tabular-nums font-bold">{row.port as number}</span> },
              { key: 'pid', header: 'PID', width: '70px', render: (row) => <span className="tabular-nums text-text-muted">{row.pid as number}</span> },
              { key: 'process', header: 'Process', render: (row) => <span className="text-text-secondary">{row.process as string}</span> },
              { key: 'type', header: 'Type', width: '100px', render: (row) => <Badge size="sm">{row.type as string}</Badge> },
              { key: 'project', header: 'Project', width: '150px', render: (row) => <span className="text-text-tertiary">{(row.project as string) || '\u2014'}</span> },
            ]}
            data={ports as any}
            defaultSort={{ key: 'port', direction: 'asc' }}
          />
        )}
      </div>
    </div>
  );
}
