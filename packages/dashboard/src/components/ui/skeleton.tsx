import { cn } from '@/lib/cn';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div className={cn('bg-bg-elevated rounded animate-pulse', className)} />
  );
}

/** Skeleton that mimics a table with rows. */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="px-5 py-4 space-y-3">
      {/* Header row */}
      <div className="flex gap-4 pb-2 border-b border-border-muted">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-16" />
      </div>
      {/* Data rows */}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-4 items-center">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-14" />
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-3.5 w-12" />
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
        <div key={i} className="bg-bg-elevated rounded-lg border border-border-muted p-4 space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-24" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton for a list (console logs, notes, etc.). */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-0">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-3 border-b border-border-muted">
          <Skeleton className="h-3.5 w-3.5 rounded-full shrink-0" />
          <Skeleton className="h-3 w-16 shrink-0" />
          <Skeleton className="h-3.5 flex-1 max-w-[400px]" />
          <Skeleton className="h-3 w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}
