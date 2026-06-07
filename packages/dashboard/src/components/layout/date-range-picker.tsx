/**
 * Date-range picker — lives in the header where the static "Today, Apr 6" pill
 * used to be. Writes the active range to the global app store (`timeRange`),
 * which scopes runtime event reads (via `since_seconds` in use-live-data.ts).
 *
 * v1: preset dropdown (Last 15m / 1h / 24h / 7d / All time). Custom absolute
 * ranges are a documented bonus and not yet exposed here.
 */

import { memo, useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  useAppStore,
  TIME_RANGE_LABELS,
  TIME_RANGE_PILL_LABELS,
  type TimeRangePreset,
} from '@/stores/use-app-store';

// Order shown in the dropdown. Excludes 'custom' (not yet exposed in v1).
const PRESETS: TimeRangePreset[] = ['15m', '1h', '24h', '7d', 'all'];

export const DateRangePicker = memo(function DateRangePicker() {
  const timeRange = useAppStore((s) => s.timeRange);
  const setTimeRange = useAppStore((s) => s.setTimeRange);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [open]);

  const pillLabel = TIME_RANGE_PILL_LABELS[timeRange.preset];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="flex items-center gap-1.5 h-9 px-3 bg-bg-surface border border-border-default rounded-lg text-[12px] font-medium text-text-primary cursor-pointer hover:border-border-hover transition-colors"
      >
        <Calendar size={14} className="text-text-tertiary" />
        <span className="whitespace-nowrap">{pillLabel}</span>
        <ChevronDown size={12} className="text-text-muted" />
      </button>

      {open && (
        <div className="absolute top-[calc(100%+4px)] right-0 w-[220px] bg-bg-surface border border-border-strong rounded-lg shadow-lg z-[100] overflow-hidden">
          <div className="px-3 py-2 border-b border-border-muted">
            <span className="text-[11px] text-text-muted uppercase tracking-wide">Time range</span>
          </div>
          <div className="p-1">
            {PRESETS.map((preset) => {
              const isActive = timeRange.preset === preset;
              return (
                <button
                  key={preset}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTimeRange({ preset });
                    setOpen(false);
                  }}
                  className={cn(
                    'w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-md text-[13px] text-left transition-colors cursor-pointer',
                    isActive ? 'bg-accent-muted text-text-primary' : 'hover:bg-bg-hover text-text-secondary',
                  )}
                >
                  <span>{TIME_RANGE_LABELS[preset]}</span>
                  {isActive && <Check size={14} className="text-accent" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
