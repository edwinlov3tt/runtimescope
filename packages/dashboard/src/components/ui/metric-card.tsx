import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

interface MetricCardProps {
  label: string;
  value: string | number;
  suffix?: string;
  change?: { value: number; label?: string };
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function MetricCard({ label, value, suffix, change, icon, className, children }: MetricCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border-default bg-bg-elevated p-5',
        'transition-colors hover:border-border-strong',
        className
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-text-tertiary">{label}</span>
        {icon && <span className="text-text-muted">{icon}</span>}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-bold text-text-primary tracking-tight">{value}</span>
        {suffix && <span className="text-sm text-text-tertiary">{suffix}</span>}
      </div>
      {change && (
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className={cn(
              'text-xs font-medium',
              change.value > 0 ? 'text-green' : change.value < 0 ? 'text-red' : 'text-text-tertiary'
            )}
          >
            {change.value > 0 ? '+' : ''}{change.value}%
          </span>
          {change.label && (
            <span className="text-xs text-text-muted">{change.label}</span>
          )}
        </div>
      )}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
