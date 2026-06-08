// Shared scaffolding for the analytics section pages: a fetch hook, the page
// layout/toolbar, window presets, and small formatters. Keeps each page lean.
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Fetch-on-mount hook. Re-runs when `deps` change. */
export function useAnalytics<T>(fetcher: () => Promise<T | null>, deps: unknown[]): { data: T | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetcher().then((d) => {
      if (alive) {
        setData(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, loading };
}

export function AnalyticsLayout({ toolbar, children }: { toolbar?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {toolbar}
      <div className="flex-1 overflow-auto p-6 space-y-5">{children}</div>
    </div>
  );
}

export function AnalyticsToolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-6 py-2.5 border-b border-border-default shrink-0 gap-3">
      <div className="flex items-center gap-3 min-w-0">{left}</div>
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  );
}

export const WINDOW_OPTIONS: { id: string; label: string }[] = [
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: 'all', label: 'All' },
];

export function WindowPills({
  value,
  onChange,
  options = WINDOW_OPTIONS,
}: {
  value: string;
  onChange: (v: string) => void;
  options?: { id: string; label: string }[];
}) {
  return (
    <div className="inline-flex bg-bg-elevated border border-border-default rounded-md p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            'px-2.5 py-1 text-[11px] font-medium rounded-sm transition-colors cursor-pointer',
            value === o.id ? 'bg-bg-overlay text-text-primary' : 'text-text-tertiary hover:text-text-secondary',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const fmtMoney = (v: number): string => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`);
export const fmtNum = (v: number): string => Math.round(v).toLocaleString();
export const fmtHours = (h: number): string => (h >= 1000 ? `${(h / 1000).toFixed(1)}k` : `${Math.round(h)}`);

export function relTime(ms: number): string {
  if (!ms) return '—';
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Format an epoch-ms bucket start as a short "Mon D" label. */
export function bucketLabel(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
