// Swappable KPI row — ports the prototypes' renderKpiRow + ⋯ metric-swap over
// the dashboard's existing KpiCard. Each slot shows one metric from `pool`; the
// ⋯ menu swaps it. NOTE: the analytics endpoints return scalar KPIs (no
// sparkData/delta) today, so cards render without a spark/change until those
// land — TODO(analytics-kpi-spark): backfill `sparkData`/`changeValue` from the
// /trends buckets once exposed.
import { useState } from 'react';
import { KpiCard } from './metric-card';
import { MoreHorizontal, Check } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface KpiSpec {
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

interface KpiRowProps {
  /** All available metrics, keyed by a stable id. */
  pool: Record<string, KpiSpec>;
  /** Which keys are shown initially (one per slot). */
  active: string[];
  className?: string;
}

export function KpiRow({ pool, active: initial, className }: KpiRowProps) {
  const [active, setActive] = useState<string[]>(initial);
  const [openSlot, setOpenSlot] = useState<number | null>(null);
  const keys = Object.keys(pool);

  return (
    <div className={cn('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3', className)}>
      {active.map((key, slot) => {
        const spec = pool[key];
        if (!spec) return null;
        return (
          <div key={slot} className="relative">
            <KpiCard {...spec} />
            <button
              type="button"
              className="absolute top-2.5 right-2.5 text-text-disabled hover:text-text-tertiary transition-colors cursor-pointer"
              onClick={() => setOpenSlot(openSlot === slot ? null : slot)}
              aria-label="Swap metric"
            >
              <MoreHorizontal size={16} />
            </button>
            {openSlot === slot && (
              <>
                <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpenSlot(null)} aria-label="Close menu" />
                <div className="absolute top-7 right-2 z-50 min-w-[184px] bg-bg-overlay border border-border-strong rounded-md shadow-lg p-1">
                  {keys.map((k) => {
                    const Icon = pool[k].icon;
                    const isActive = k === key;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => {
                          setActive((a) => a.map((x, i) => (i === slot ? k : x)));
                          setOpenSlot(null);
                        }}
                        className={cn(
                          'flex items-center gap-2 w-full px-2.5 py-1.5 text-[12px] rounded-sm text-left whitespace-nowrap cursor-pointer hover:bg-bg-hover',
                          isActive ? 'text-accent' : 'text-text-secondary hover:text-text-primary',
                        )}
                      >
                        <Icon size={13} />
                        <span className="flex-1">{pool[k].label}</span>
                        {isActive && <Check size={12} />}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
