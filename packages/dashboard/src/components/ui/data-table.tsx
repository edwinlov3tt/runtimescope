import { cn } from '@/lib/cn';
import { useState, useMemo, type ReactNode } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

interface Column<T> {
  key: string;
  header: string;
  width?: string;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
}

type SortDirection = 'asc' | 'desc';

interface SortState {
  key: string;
  direction: SortDirection;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T, index: number) => void;
  selectedIndex?: number;
  className?: string;
  emptyMessage?: string;
  defaultSort?: SortState;
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  onRowClick,
  selectedIndex,
  className,
  emptyMessage = 'No data',
  defaultSort,
}: DataTableProps<T>) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null);

  const sortedData = useMemo(() => {
    if (!sort) return data;
    return [...data].sort((a, b) => {
      const aVal = a[sort.key];
      const bVal = b[sort.key];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = typeof aVal === 'number' && typeof bVal === 'number'
        ? aVal - bVal
        : String(aVal).localeCompare(String(bVal));
      return sort.direction === 'asc' ? cmp : -cmp;
    });
  }, [data, sort]);

  const handleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key === key) {
        return prev.direction === 'asc' ? { key, direction: 'desc' } : null;
      }
      return { key, direction: 'asc' };
    });
  };

  return (
    <div className={cn('overflow-auto', className)}>
      <table className="w-full border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-bg-surface border-b border-border-default">
            {columns.map((col) => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={cn(
                  'h-9 px-3 text-left text-[11px] font-medium text-text-muted uppercase tracking-wider',
                  col.sortable !== false && 'cursor-pointer select-none hover:text-text-secondary transition-colors'
                )}
                onClick={() => col.sortable !== false && handleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.header}
                  {sort?.key === col.key && (
                    sort.direction === 'asc'
                      ? <ChevronUp size={12} className="text-text-secondary" />
                      : <ChevronDown size={12} className="text-text-secondary" />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="h-32 text-center text-sm text-text-muted">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sortedData.map((row, i) => (
              <tr
                key={i}
                onClick={() => onRowClick?.(row, i)}
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
                className={cn(
                  'border-b border-border-muted transition-colors cursor-pointer',
                  selectedIndex === i && 'bg-bg-active',
                  hoveredIndex === i && selectedIndex !== i && 'bg-bg-hover'
                )}
              >
                {columns.map((col) => (
                  <td key={col.key} className="h-10 px-3 text-sm text-text-primary">
                    {col.render ? col.render(row) : String(row[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
