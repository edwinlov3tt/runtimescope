import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { SearchInput } from './input';
import { Badge } from './badge';

export interface FilterPill {
  key: string;
  label: string;
  value: string;
}

interface FilterBarProps {
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  filters?: FilterPill[];
  onRemoveFilter?: (key: string) => void;
  onClearAll?: () => void;
  children?: React.ReactNode;
  className?: string;
}

export function FilterBar({
  search,
  onSearchChange,
  searchPlaceholder = 'Search...',
  filters = [],
  onRemoveFilter,
  onClearAll,
  children,
  className,
}: FilterBarProps) {
  return (
    <div className={cn('flex items-center gap-3 px-5 py-2.5 border-b border-border-default', className)}>
      <div className="w-64 shrink-0">
        <SearchInput
          value={search}
          onChange={(e) => onSearchChange?.(e.target.value)}
          placeholder={searchPlaceholder}
        />
      </div>
      {children}
      {filters.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {filters.map((f) => (
            <Badge key={f.key} variant="brand" size="sm">
              <span>{f.label}: {f.value}</span>
              <button
                onClick={() => onRemoveFilter?.(f.key)}
                className="ml-1 hover:text-brand-light cursor-pointer"
              >
                <X size={10} />
              </button>
            </Badge>
          ))}
          <button
            onClick={onClearAll}
            className="text-[11px] text-text-muted hover:text-text-secondary cursor-pointer"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
