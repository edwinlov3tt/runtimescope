import { cn } from '@/lib/cn';

interface Tab {
  id: string;
  label: string;
  count?: number;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeTab, onTabChange, className }: TabsProps) {
  return (
    <div className={cn('flex items-center gap-1 border-b border-border-default px-3', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            'relative h-9 px-3 text-[13px] font-medium transition-colors cursor-pointer',
            activeTab === tab.id
              ? 'text-text-primary'
              : 'text-text-tertiary hover:text-text-secondary'
          )}
        >
          <span className="flex items-center gap-1.5">
            {tab.label}
            {tab.count !== undefined && (
              <span className={cn(
                'text-[11px] tabular-nums',
                activeTab === tab.id ? 'text-text-secondary' : 'text-text-muted'
              )}>
                {tab.count}
              </span>
            )}
          </span>
          {activeTab === tab.id && (
            <div className="absolute bottom-0 left-3 right-3 h-0.5 bg-brand rounded-full" />
          )}
        </button>
      ))}
    </div>
  );
}
