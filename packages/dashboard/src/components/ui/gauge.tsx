import { cn } from '@/lib/cn';

type Rating = 'good' | 'needs-improvement' | 'poor';

interface GaugeProps {
  value: number;
  max: number;
  rating: Rating;
  label: string;
  unit?: string;
  className?: string;
}

const RATING_COLORS: Record<Rating, string> = {
  'good': 'var(--color-green)',
  'needs-improvement': 'var(--color-amber)',
  'poor': 'var(--color-red)',
};

export function Gauge({ value, max, rating, label, unit = 'ms', className }: GaugeProps) {
  const pct = Math.min(value / max, 1);
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - pct * 0.75); // 270° arc
  const color = RATING_COLORS[rating];

  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      <div className="relative w-24 h-24">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-[135deg]">
          {/* Track */}
          <circle
            cx="50" cy="50" r={radius}
            fill="none"
            stroke="var(--color-border-default)"
            strokeWidth="6"
            strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
            strokeLinecap="round"
          />
          {/* Value */}
          <circle
            cx="50" cy="50" r={radius}
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            className="transition-all duration-500"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold text-text-primary tabular-nums">{value}</span>
          <span className="text-[10px] text-text-muted">{unit}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[11px] font-medium text-text-secondary">{label}</span>
      </div>
    </div>
  );
}
