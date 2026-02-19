import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex-1 flex items-center justify-center p-8', className)}>
      <div className="flex flex-col items-center gap-3 text-center max-w-sm">
        {icon && <div className="text-text-muted">{icon}</div>}
        <h2 className="text-[15px] font-semibold text-text-primary">{title}</h2>
        {description && <p className="text-sm text-text-tertiary">{description}</p>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}
