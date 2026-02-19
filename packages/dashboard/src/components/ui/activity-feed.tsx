import { cn } from '@/lib/cn';
import { Globe, Terminal, Zap, Layers, Activity, Database, AlertTriangle, type LucideIcon } from 'lucide-react';

const TYPE_ICONS: Record<string, { icon: LucideIcon; color: string }> = {
  network: { icon: Globe, color: 'text-blue' },
  console: { icon: Terminal, color: 'text-amber' },
  render: { icon: Zap, color: 'text-green' },
  state: { icon: Layers, color: 'text-purple' },
  performance: { icon: Activity, color: 'text-cyan' },
  database: { icon: Database, color: 'text-orange' },
  issue: { icon: AlertTriangle, color: 'text-red' },
};

export interface ActivityItem {
  id: string;
  type: string;
  message: string;
  timestamp: number;
  meta?: string;
}

interface ActivityFeedProps {
  items: ActivityItem[];
  className?: string;
}

export function ActivityFeed({ items, className }: ActivityFeedProps) {
  return (
    <div className={cn('divide-y divide-border-muted', className)}>
      {items.map((item) => {
        const typeInfo = TYPE_ICONS[item.type] ?? TYPE_ICONS.network;
        const Icon = typeInfo.icon;
        return (
          <div key={item.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors">
            <Icon size={14} strokeWidth={1.75} className={cn('mt-0.5 shrink-0', typeInfo.color)} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-text-primary truncate">{item.message}</p>
              {item.meta && <p className="text-[11px] text-text-muted truncate">{item.meta}</p>}
            </div>
            <span className="text-[11px] text-text-muted tabular-nums shrink-0">
              {formatRelativeTime(item.timestamp)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
