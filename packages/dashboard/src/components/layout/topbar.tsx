import { cn } from '@/lib/cn';
import { SearchInput } from '@/components/ui/input';

interface TopbarTab {
  id: string;
  label: string;
}

interface TopbarProps {
  title?: string;
  tabs?: TopbarTab[];
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  connected?: boolean;
  showSearch?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  children?: React.ReactNode;
}

export function Topbar({
  title,
  tabs,
  activeTab,
  onTabChange,
  showSearch = false,
  searchValue,
  onSearchChange,
  children,
}: TopbarProps) {
  // If nothing to show, render nothing
  const hasTabs = tabs && tabs.length > 0;
  const hasContent = title || hasTabs || showSearch || children;
  if (!hasContent) return null;

  return (
    <div className="border-b border-border-default shrink-0">
      <div className="flex items-center justify-between px-5 py-2 gap-4 min-h-[44px]">
        <div className="flex items-center gap-4">
          {title && (
            <h2 className="text-[14px] font-semibold text-text-primary">{title}</h2>
          )}
          {hasTabs && (
            <div className="flex items-center gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => onTabChange?.(tab.id)}
                  className={cn(
                    'h-7 px-2.5 rounded-md text-[12px] font-medium transition-colors cursor-pointer',
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

        {/* Right side / children */}
        <div className="flex items-center gap-3">
          {children}
        </div>
      </div>

      {/* Search row */}
      {showSearch && (
        <div className="px-5 pb-2.5">
          <SearchInput
            value={searchValue}
            onChange={(e) => onSearchChange?.(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
