import { useState, useCallback } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable, Badge, StatusDot, KpiCard } from '@/components/ui';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { cn } from '@/lib/cn';
import { killProcess } from '@/lib/api';
import { Square, Cpu, Radio, Gauge, HardDrive } from 'lucide-react';

export function ProcessesPage() {
  const [activeTab, setActiveTab] = useState('processes');
  const connected = useConnected();
  const processes = useDataStore((s) => s.processes);
  const ports = useDataStore((s) => s.ports);

  const totalCpu = processes.reduce((s, p) => s + (p.cpuPercent ?? 0), 0);
  const totalMem = processes.reduce((s, p) => s + (p.memoryMB ?? 0), 0);
  const orphanCount = processes.filter((p) => p.isOrphaned).length;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar
        tabs={[
          { id: 'processes', label: `Processes (${processes.length})` },
          { id: 'ports', label: `Ports (${ports.length})` },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-5">

          {/* KPI Cards */}
          <div className="grid grid-cols-4 gap-3">
            <KpiCard
              icon={Cpu}
              label="Processes"
              value={String(processes.length)}
              footerLabel={`${orphanCount} orphaned`}
              changeValue={`${processes.length - orphanCount} active`}
              changeDir="neutral"
            />
            <KpiCard
              icon={Radio}
              label="Ports Bound"
              value={String(ports.length)}
              footerLabel="Across all projects"
            />
            <KpiCard
              icon={Gauge}
              label="Total CPU"
              value={totalCpu.toFixed(1)}
              unit="%"
              sparkColor={totalCpu > 50 ? 'var(--color-amber)' : 'var(--color-green)'}
              footerLabel="Combined usage"
            />
            <KpiCard
              icon={HardDrive}
              label="Total Memory"
              value={String(Math.round(totalMem))}
              unit="MB"
              sparkColor={totalMem > 2048 ? 'var(--color-amber)' : 'var(--color-blue)'}
              footerLabel={`${(totalMem / 1024).toFixed(1)} GB total`}
            />
          </div>

          {/* Process / Port tables */}
          <div className="border border-border-strong rounded-lg overflow-hidden bg-bg-surface">
            {activeTab === 'processes' && (
              <DataTable
                columns={[
                  {
                    key: 'type', header: 'Type', width: '100px',
                    render: (row) => <Badge size="sm">{row.type as string}</Badge>,
                  },
                  {
                    key: 'command', header: 'Command', mono: true,
                    render: (row) => (
                      <span className="font-mono text-[12px] text-text-secondary truncate block max-w-[300px]">
                        {row.command as string}
                      </span>
                    ),
                  },
                  {
                    key: 'pid', header: 'PID', width: '70px', mono: true,
                    render: (row) => <span className="tabular-nums text-text-muted">{row.pid as number}</span>,
                  },
                  {
                    key: 'cpuPercent', header: 'CPU', width: '90px', align: 'right',
                    render: (row) => {
                      const cpu = row.cpuPercent as number;
                      const barColor = cpu > 40 ? 'bg-red' : cpu > 20 ? 'bg-amber' : 'bg-green';
                      return (
                        <span className="flex items-center justify-end gap-2">
                          <span className={cn('tabular-nums font-mono text-[12px]', cpu > 40 ? 'text-red' : cpu > 20 ? 'text-amber' : '')}>
                            {cpu.toFixed(1)}%
                          </span>
                          <span className="w-10 h-1 bg-bg-overlay rounded-full overflow-hidden">
                            <span className={cn('block h-full rounded-full', barColor)} style={{ width: `${Math.min(cpu, 100)}%` }} />
                          </span>
                        </span>
                      );
                    },
                  },
                  {
                    key: 'memoryMB', header: 'Memory', width: '90px', align: 'right', mono: true,
                    render: (row) => (
                      <span className={cn('tabular-nums', (row.memoryMB as number) > 300 ? 'text-amber' : '')}>
                        {row.memoryMB as number} MB
                      </span>
                    ),
                  },
                  {
                    key: 'ports', header: 'Ports', width: '100px', mono: true,
                    render: (row) => (
                      <span className="text-text-tertiary tabular-nums">
                        {((row.ports as number[]) || []).join(', ') || '—'}
                      </span>
                    ),
                  },
                  {
                    key: 'isOrphaned', header: 'Status', width: '100px',
                    render: (row) => (row.isOrphaned as boolean)
                      ? <span className="flex items-center gap-1.5"><StatusDot color="red" size="sm" pulse /><span className="text-red text-[12px] font-medium">Orphaned</span></span>
                      : <span className="flex items-center gap-1.5"><StatusDot color="green" size="sm" /><span className="text-green text-[12px] font-medium">Running</span></span>,
                  },
                  {
                    key: 'actions', header: '', width: '50px', sortable: false,
                    render: (row) => (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await killProcess(row.pid as number);
                        }}
                        className="p-1.5 rounded-md hover:bg-red-muted text-text-disabled hover:text-red transition-colors cursor-pointer"
                        title="Kill process"
                      >
                        <Square size={12} />
                      </button>
                    ),
                  },
                ]}
                data={processes as any}
                footer={
                  <>
                    <span>{processes.length} processes &bull; {processes.length - orphanCount} active</span>
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1"><StatusDot color="green" size="sm" /> {processes.length - orphanCount} Running</span>
                      {orphanCount > 0 && <span className="flex items-center gap-1"><StatusDot color="red" size="sm" /> {orphanCount} Orphaned</span>}
                    </div>
                  </>
                }
              />
            )}

            {activeTab === 'ports' && (
              <DataTable
                columns={[
                  {
                    key: 'port', header: 'Port', width: '80px', mono: true,
                    render: (row) => <span className="font-bold text-accent">:{row.port as number}</span>,
                  },
                  {
                    key: 'pid', header: 'PID', width: '70px', mono: true,
                    render: (row) => <span className="text-text-muted">{row.pid as number}</span>,
                  },
                  { key: 'process', header: 'Process' },
                  {
                    key: 'type', header: 'Type', width: '100px',
                    render: (row) => <Badge size="sm">{row.type as string}</Badge>,
                  },
                  {
                    key: 'project', header: 'Project', width: '150px',
                    render: (row) => <span className="text-text-tertiary">{(row.project as string) || '—'}</span>,
                  },
                  {
                    key: 'status', header: 'Status', width: '90px', sortable: false,
                    render: () => (
                      <span className="flex items-center gap-1.5">
                        <StatusDot color="green" size="sm" />
                        <span className="text-green text-[12px] font-medium">Listening</span>
                      </span>
                    ),
                  },
                ]}
                data={ports as any}
                defaultSort={{ key: 'port', direction: 'asc' }}
                footer={<span>{ports.length} ports bound</span>}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
