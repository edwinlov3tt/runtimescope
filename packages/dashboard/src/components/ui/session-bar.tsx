import { cn } from '@/lib/cn';
import type { LucideIcon } from 'lucide-react';
import { Wifi, Package, Clock, HardDrive } from 'lucide-react';

interface SessionBarItem {
  icon: LucideIcon;
  label: string;
  value: string;
  valueClassName?: string;
}

interface SessionBarProps {
  connected?: boolean;
  items?: SessionBarItem[];
  className?: string;
}

export function SessionBar({ connected = true, items, className }: SessionBarProps) {
  const defaultItems: SessionBarItem[] = items ?? [
    { icon: Wifi, label: 'Session', value: 'a06af01e' },
    { icon: Package, label: 'SDK', value: 'v0.9.3' },
    { icon: Clock, label: 'Uptime', value: '0m 0s' },
    { icon: HardDrive, label: 'Events', value: '0' },
  ];

  return (
    <div className={cn(
      'flex items-center gap-4 px-3.5 py-2.5 bg-bg-surface border border-border-default rounded-md text-[12px]',
      className,
    )}>
      {/* Connected badge */}
      <div className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-semibold',
        connected
          ? 'bg-green-muted border border-green-border text-green'
          : 'bg-bg-overlay border border-border-default text-text-muted',
      )}>
        <span className={cn(
          'w-1.5 h-1.5 rounded-full',
          connected ? 'bg-green animate-pulse-dot' : 'bg-text-muted',
        )} />
        {connected ? 'Connected' : 'Disconnected'}
      </div>

      {defaultItems.map((item, i) => {
        const Icon = item.icon;
        return (
          <div key={i} className="contents">
            <span className="w-px h-3.5 bg-border-muted" />
            <div className="flex items-center gap-1.5 text-text-muted">
              <Icon size={13} />
              {item.label}
              <span className={cn('text-text-secondary font-mono font-medium', item.valueClassName)}>
                {item.value}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
