import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface PageLayoutProps {
  /** Filter bar rendered above the main content */
  filterBar?: ReactNode;
  /** Main content area */
  children: ReactNode;
  /** Optional detail panel on the right (380px) */
  detailPanel?: ReactNode;
  className?: string;
}

export function PageLayout({ filterBar, children, detailPanel, className }: PageLayoutProps) {
  return (
    <div className={cn('flex-1 flex flex-col overflow-hidden', className)}>
      {filterBar}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
        {detailPanel}
      </div>
    </div>
  );
}
