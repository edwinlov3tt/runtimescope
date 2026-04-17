import { cn } from '@/lib/cn';
import { Sparkline } from '@/components/ui/sparkline';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Legacy MetricCard (simple version — still used by some pages)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// KpiCard — three-strip design (header + body + footer)
// ---------------------------------------------------------------------------

interface KpiCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  unit?: string;
  prefix?: string;
  sparkColor?: string;
  sparkData?: number[];
  footerLabel?: string;
  changeValue?: string;
  changeDir?: 'up' | 'down' | 'neutral';
  footerExtra?: string;
}

export function KpiCard({
  icon: Icon,
  label,
  value,
  unit,
  prefix,
  sparkColor = 'var(--color-blue)',
  sparkData,
  footerLabel,
  changeValue,
  changeDir = 'neutral',
  footerExtra,
}: KpiCardProps) {
  const ChangeIcon = changeDir === 'up' ? TrendingUp : changeDir === 'down' ? TrendingDown : Minus;

  return (
    <div className="bg-bg-surface border border-border-strong rounded-lg overflow-hidden transition-colors hover:border-border-hover">
      {/* Header strip */}
      <div className="flex items-center gap-2 px-3.5 py-2.5 bg-bg-base border-b border-border-muted">
        <Icon size={18} className="text-text-muted shrink-0" />
        <span className="text-[12px] font-semibold text-text-secondary flex-1 truncate">{label}</span>
      </div>

      {/* Body — value + sparkline */}
      <div className="flex items-end justify-between gap-3 px-3.5 py-3.5">
        <div className="flex items-baseline gap-1">
          {prefix && <span className="text-sm text-text-tertiary">{prefix}</span>}
          <span className="text-[28px] font-bold tabular-nums leading-none tracking-tight">{value}</span>
          {unit && <span className="text-sm text-text-tertiary">{unit}</span>}
        </div>
        {sparkData && sparkData.length > 1 && (
          <div className="w-[120px] h-8 shrink-0 opacity-85 hover:opacity-100 transition-opacity">
            <Sparkline data={sparkData} color={sparkColor} height={32} />
          </div>
        )}
      </div>

      {/* Footer strip */}
      <div className="flex items-center gap-1.5 px-3.5 py-2 border-t border-border-muted text-[11px] font-medium text-text-muted">
        <span className="flex-1">{footerLabel}</span>
        {changeValue && (
          <span className={cn(
            'inline-flex items-center gap-1 font-semibold',
            changeDir === 'up' ? 'text-green' : changeDir === 'down' ? 'text-red' : 'text-text-tertiary',
          )}>
            <ChangeIcon size={11} />
            {changeValue}
          </span>
        )}
        {footerExtra && <span className="text-text-muted ml-0.5">{footerExtra}</span>}
      </div>
    </div>
  );
}
