import { cn } from '@/lib/cn';
import { StatusDot } from '@/components/ui/status-dot';
import { SearchInput } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';

interface TopbarTab {
  id: string;
  label: string;
}

interface TopbarProps {
  title: string;
  tabs?: TopbarTab[];
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  connected?: boolean;
  showSearch?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
}

export function Topbar({
  title,
  tabs,
  activeTab,
  onTabChange,
  connected = true,
  showSearch = false,
  searchValue,
  onSearchChange,
}: TopbarProps) {
  return (
    <div className="border-b border-border-default">
      {/* Title row */}
      <div className="h-12 flex items-center justify-between px-5">
        <div className="flex items-center gap-6">
          <h1 className="text-[15px] font-semibold text-text-primary">{title}</h1>
          {tabs && (
            <div className="flex items-center gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => onTabChange?.(tab.id)}
                  className={cn(
                    'h-8 px-3 rounded-md text-[13px] font-medium transition-colors cursor-pointer',
                    activeTab === tab.id
                      ? 'bg-bg-elevated text-text-primary'
                      : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </div>
          <div
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium',
              connected
                ? 'border-green-border text-green bg-green-muted'
                : 'border-border-default text-text-muted'
            )}
          >
            <StatusDot color={connected ? 'green' : 'gray'} size="sm" pulse={connected} />
            {connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
      </div>

      {/* Search row */}
      {showSearch && (
        <div className="px-5 pb-3">
          <SearchInput
            value={searchValue}
            onChange={(e) => onSearchChange?.(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
