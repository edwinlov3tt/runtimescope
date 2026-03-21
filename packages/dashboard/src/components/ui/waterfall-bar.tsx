import { cn } from '@/lib/cn';

interface WaterfallSegment {
  label: string;
  value: number;
  color: string;
}

interface WaterfallBarProps {
  segments: WaterfallSegment[];
  total: number;
  className?: string;
}

function fmt(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

export function WaterfallBar({ segments, total, className }: WaterfallBarProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="h-5 flex rounded-md overflow-hidden bg-bg-elevated">
        {segments.map((seg) => {
          const pct = total > 0 ? (seg.value / total) * 100 : 0;
          if (pct <= 0) return null;
          return (
            <div
              key={seg.label}
              style={{ width: `${pct}%`, backgroundColor: seg.color }}
              className="h-full relative group"
              title={`${seg.label}: ${fmt(seg.value)}`}
            >
              {pct > 15 && (
                <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-white/80">
                  {fmt(seg.value)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: seg.color }} />
            <span className="text-[11px] text-text-tertiary">{seg.label}</span>
            <span className="text-[11px] text-text-secondary tabular-nums">{fmt(seg.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
