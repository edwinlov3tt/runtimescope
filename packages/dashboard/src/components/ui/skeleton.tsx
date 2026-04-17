import { cn } from '@/lib/cn';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div className={cn('bg-bg-elevated rounded animate-pulse', className)} />
  );
}

/** Skeleton that mimics a full-width data table with realistic column proportions. */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="w-full">
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-default">
        <Skeleton className="h-3 w-[15%]" />
        <Skeleton className="h-3 w-[8%]" />
        <Skeleton className="h-3 w-[10%]" />
        <Skeleton className="h-3 w-[35%]" />
        <Skeleton className="h-3 w-[10%]" />
        <Skeleton className="h-3 w-[8%]" />
      </div>
      {/* Data rows */}
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 px-4 py-3 border-b border-border-muted"
          style={{ opacity: 1 - i * 0.08 }}
        >
          <Skeleton className="h-3.5 w-[15%]" />
          <Skeleton className="h-3.5 w-[8%]" />
          <Skeleton className="h-3.5 w-[10%]" />
          <Skeleton className={cn('h-3.5', i % 3 === 0 ? 'w-[30%]' : i % 3 === 1 ? 'w-[25%]' : 'w-[35%]')} />
          <Skeleton className="h-3.5 w-[10%]" />
          <Skeleton className="h-3.5 w-[8%]" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton that mimics metric cards in a grid. */
export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-5">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bg-bg-elevated rounded-lg border border-border-muted p-4 space-y-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-28" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton for a list layout (console logs, breadcrumbs, etc.). */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="w-full">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 px-4 py-3 border-b border-border-muted"
          style={{ opacity: 1 - i * 0.08 }}
        >
          <Skeleton className="h-2.5 w-2.5 rounded-full shrink-0" />
          <Skeleton className="h-3 w-[60px] shrink-0" />
          <Skeleton className={cn('h-3.5 flex-1', i % 3 === 0 ? 'max-w-[60%]' : i % 3 === 1 ? 'max-w-[45%]' : 'max-w-[70%]')} />
          <Skeleton className="h-3 w-[80px] shrink-0 ml-auto" />
        </div>
      ))}
    </div>
  );
}
