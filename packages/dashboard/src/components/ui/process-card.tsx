import { cn } from '@/lib/cn';
import { RefreshCw, Terminal, Square } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface ProcessCardProps {
  name: string;
  type: string;
  icon: LucideIcon;
  iconColor: string;
  iconBg: string;
  pid: number;
  port: number;
  cpu: number;
  memory: number;
  uptime: string;
  status?: 'running' | 'stopped' | 'crashed';
  onRestart?: () => void;
  onLogs?: () => void;
  onStop?: () => void;
}

export function ProcessCard({
  name,
  type,
  icon: Icon,
  iconColor,
  iconBg,
  pid,
  port,
  cpu,
  memory,
  uptime,
  status = 'running',
  onRestart,
  onLogs,
  onStop,
}: ProcessCardProps) {
  const isRunning = status === 'running';

  return (
    <div className="bg-bg-surface border border-border-strong rounded-lg p-4 flex flex-col gap-2.5 transition-colors hover:border-border-hover">
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <div
          className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
          style={{ background: iconBg, color: iconColor }}
        >
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-text-primary truncate">{name}</div>
          <div className="text-[11px] text-text-muted">PID {pid} &bull; :{port}</div>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] font-medium ml-auto">
          <span className={cn(
            'w-1.5 h-1.5 rounded-full shrink-0',
            isRunning ? 'bg-green animate-pulse-dot' : 'bg-red',
          )} />
          <span className={isRunning ? 'text-green' : 'text-red'}>
            {isRunning ? 'Running' : status === 'crashed' ? 'Crashed' : 'Stopped'}
          </span>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-2 border-t border-border-muted pt-2.5">
        <Metric label="CPU" value={`${cpu.toFixed(1)}%`} warn={cpu > 20} />
        <Metric label="Memory" value={`${memory} MB`} warn={memory > 300} />
        <Metric label="Port" value={`:${port}`} accent />
        <Metric label="Uptime" value={uptime} />
      </div>

      {/* Actions */}
      <div className="flex gap-1.5 border-t border-border-muted pt-2.5">
        <ActionBtn icon={RefreshCw} label="Restart" onClick={onRestart} />
        <ActionBtn icon={Terminal} label="Logs" onClick={onLogs} />
        <ActionBtn icon={Square} label="Stop" danger onClick={onStop} />
      </div>
    </div>
  );
}

function Metric({ label, value, warn, accent }: { label: string; value: string; warn?: boolean; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-text-disabled uppercase tracking-wider">{label}</span>
      <span className={cn(
        'text-[13px] font-semibold font-mono tabular-nums',
        warn ? 'text-amber' : accent ? 'text-accent' : 'text-text-primary',
      )}>
        {value}
      </span>
    </div>
  );
}

function ActionBtn({ icon: Icon, label, danger, onClick }: { icon: LucideIcon; label: string; danger?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 flex items-center justify-center gap-1.5 h-[30px] text-[11px] font-medium rounded-md',
        'bg-bg-elevated border border-border-default text-text-tertiary transition-all cursor-pointer',
        danger
          ? 'hover:border-red hover:text-red hover:bg-red-muted'
          : 'hover:border-border-hover hover:text-text-primary',
      )}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}
