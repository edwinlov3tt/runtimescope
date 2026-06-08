// Chart primitives ported from the analytics prototypes' shell.js helpers
// (svgLineChart / donutChart / barChart / funnelChart / heatmap) into typed,
// prop-driven React components. Purely presentational — data comes from props,
// colors from the dashboard CSS tokens (var(--color-*)). No data fetching, no
// mock constants. Lines fill width via a stretched viewBox + non-scaling-stroke;
// axis/legend text is HTML so it never distorts.
import { type ReactNode } from 'react';
import { cn } from '@/lib/cn';

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10;
  return step * p;
}

// ────────────────────────── LineChart ──────────────────────────
export interface LineSeries {
  name: string;
  color: string;
  data: number[];
  dashed?: boolean;
  area?: boolean;
}
interface LineChartProps {
  series: LineSeries[];
  labels: string[];
  height?: number;
  yTicks?: number;
  yMax?: number;
  yFmt?: (v: number) => string | number;
  className?: string;
}

export function LineChart({ series, labels, height = 240, yTicks = 4, yMax, yFmt = (v) => v, className }: LineChartProps) {
  const W = 1000;
  const H = 300;
  const all = series.flatMap((s) => s.data);
  const max = yMax ?? niceMax(Math.max(1, ...all));
  const n = Math.max(1, (labels.length || series[0]?.data.length || 1) - 1);
  const X = (i: number) => (i / n) * W;
  const Y = (v: number) => H - (v / max) * H;

  const gridlines = Array.from({ length: yTicks + 1 }, (_, t) => {
    const gy = (t / yTicks) * H;
    return <line key={t} x1={0} y1={gy} x2={W} y2={gy} stroke="var(--color-border-muted)" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
  });

  const step = Math.max(1, Math.ceil(labels.length / 8));

  return (
    <div className={cn('w-full', className)}>
      {series.length > 0 && (
        <div className="flex flex-wrap gap-3.5 mb-3 px-1">
          {series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
              <span className="w-2.5 h-[3px] rounded-sm shrink-0" style={{ background: s.color, opacity: s.dashed ? 0.55 : 1 }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <div className="w-9 flex flex-col justify-between text-right text-[10px] text-text-muted tabular-nums py-0.5 shrink-0">
          {Array.from({ length: yTicks + 1 }, (_, k) => (
            <span key={k}>{yFmt(Math.round(max - (k / yTicks) * max))}</span>
          ))}
        </div>
        <div className="flex-1 min-w-0" style={{ height }}>
          <svg className="w-full h-full block overflow-visible" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            {gridlines}
            {series.map((s, si) => {
              const d = s.data.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
              const gid = `lc-${si}-${s.name.replace(/\W/g, '')}`;
              return (
                <g key={s.name}>
                  {s.area && (
                    <>
                      <defs>
                        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={s.color} stopOpacity={0.25} />
                          <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <path d={`${d} L${W},${H} L0,${H} Z`} fill={`url(#${gid})`} />
                    </>
                  )}
                  <path d={d} fill="none" stroke={s.color} strokeWidth={1.6} strokeDasharray={s.dashed ? '5 4' : undefined} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <div className="flex justify-between ml-[46px] mt-1.5 text-[10px] text-text-muted">
        {labels.filter((_, i) => i % step === 0 || i === labels.length - 1).map((l, i) => (
          <span key={`${l}-${i}`} className="whitespace-nowrap">{l}</span>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────── DonutChart ──────────────────────────
export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}
interface DonutChartProps {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerVal?: string;
  centerLabel?: string;
  legend?: boolean;
}

export function DonutChart({ segments, size = 130, thickness = 18, centerVal, centerLabel, legend }: DonutChartProps) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  let off = 0;

  const donut = (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--color-bg-overlay)" strokeWidth={thickness} />
        {segments.map((s) => {
          const len = (s.value / total) * c;
          const arc = (
            <circle key={s.label} cx={cx} cy={cx} r={r} fill="none" stroke={s.color} strokeWidth={thickness} strokeDasharray={`${len.toFixed(2)} ${(c - len).toFixed(2)}`} strokeDashoffset={(-off).toFixed(2)} transform={`rotate(-90 ${cx} ${cx})`} />
          );
          off += len;
          return arc;
        })}
      </svg>
      {centerVal && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-[20px] font-bold tabular-nums leading-none">{centerVal}</span>
          {centerLabel && <span className="text-[9px] text-text-muted uppercase tracking-wide mt-0.5">{centerLabel}</span>}
        </div>
      )}
    </div>
  );

  if (!legend) return donut;
  return (
    <div className="flex items-center gap-5">
      {donut}
      <div className="flex flex-col gap-2">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-[11px]">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
            <span className="text-text-secondary flex-1">{s.label}</span>
            <span className="font-mono text-text-tertiary">{Math.round((s.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────── BarChart ──────────────────────────
export interface BarGroup {
  label: string;
  segs: { value: number; color: string }[];
}
interface BarChartProps {
  groups: BarGroup[];
  height?: number;
  max?: number;
  grouped?: boolean;
  yTicks?: number;
  yFmt?: (v: number) => string | number;
  valueFmt?: (v: number) => string;
}

export function BarChart({ groups, height = 200, max, grouped, yTicks = 4, yFmt = (v) => v, valueFmt }: BarChartProps) {
  const totals = groups.map((g) => (grouped ? Math.max(1, ...g.segs.map((s) => s.value)) : g.segs.reduce((a, s) => a + s.value, 0)));
  const m = max ?? niceMax(Math.max(1, ...totals));

  return (
    <div className="w-full">
      <div className="flex gap-2">
        <div className="w-9 flex flex-col justify-between text-right text-[10px] text-text-muted tabular-nums py-0.5 shrink-0">
          {Array.from({ length: yTicks + 1 }, (_, k) => (
            <span key={k}>{yFmt(Math.round(m - (k / yTicks) * m))}</span>
          ))}
        </div>
        <div className="flex-1 min-w-0 relative" style={{ height }}>
          <div className="absolute inset-0 flex flex-col justify-between">
            {Array.from({ length: yTicks + 1 }, (_, k) => (
              <div key={k} className="h-px bg-border-muted" />
            ))}
          </div>
          <div className="absolute inset-0 flex items-end gap-2">
            {groups.map((g) => (
              <div key={g.label} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
                {grouped ? (
                  <div className="flex items-end gap-[3px] w-full justify-center h-full">
                    {g.segs.map((s, i) => (
                      <div key={i} className="flex flex-col items-center justify-end h-full">
                        {valueFmt && <div className="text-[9px] font-mono text-text-muted mb-[3px] whitespace-nowrap">{valueFmt(s.value)}</div>}
                        <div className="w-3.5 rounded-t-[3px]" style={{ height: `${(s.value / m) * 100}%`, background: s.color }} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-end h-full w-full">
                    {valueFmt && <div className="text-[9px] font-mono text-text-muted mb-[3px] whitespace-nowrap">{valueFmt(g.segs.reduce((a, s) => a + s.value, 0))}</div>}
                    <div className="w-[62%] max-w-[34px] flex flex-col-reverse rounded-t-[3px] overflow-hidden" style={{ height: `${(g.segs.reduce((a, s) => a + s.value, 0) / m) * 100}%` }}>
                      {g.segs.map((s, i) => {
                        const t = g.segs.reduce((a, x) => a + x.value, 0) || 1;
                        return <div key={i} className="w-full" style={{ height: `${(s.value / t) * 100}%`, background: s.color }} />;
                      })}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex ml-[46px] mt-1.5">
        {groups.map((g) => (
          <div key={g.label} className="flex-1 text-center text-[10px] text-text-muted truncate">{g.label}</div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────── FunnelChart ──────────────────────────
export interface FunnelStep {
  label: string;
  value: number;
  color?: string;
}
interface FunnelChartProps {
  steps: FunnelStep[];
  onStepClick?: (step: FunnelStep, index: number) => void;
}

export function FunnelChart({ steps, onStepClick }: FunnelChartProps) {
  const first = steps.length ? steps[0].value : 1;
  return (
    <div className="flex flex-col gap-1">
      {steps.map((s, i) => {
        const pct = first > 0 ? Math.round((s.value / first) * 100) : 0;
        const drop = i > 0 && steps[i - 1].value > 0 ? Math.round(((steps[i - 1].value - s.value) / steps[i - 1].value) * 100) : 0;
        const color = s.color || 'var(--color-accent)';
        const clickable = !!onStepClick;
        const Wrapper: 'button' | 'div' = clickable ? 'button' : 'div';
        return (
          <Wrapper
            key={s.label}
            {...(clickable ? { onClick: () => onStepClick(s, i), type: 'button' as const } : {})}
            className={cn('py-0.5 rounded-sm text-left w-full', clickable && 'cursor-pointer hover:bg-bg-hover transition-colors')}
          >
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-xs text-text-secondary">{s.label}</span>
              <span className="text-xs font-mono font-semibold">{s.value.toLocaleString()} · {pct}%</span>
            </div>
            <div className="h-[26px] rounded bg-bg-overlay overflow-hidden">
              <div className="h-full" style={{ width: `${pct}%`, background: color }} />
            </div>
            {i > 0 && drop > 0 && <div className="text-[10px] text-red font-mono mt-1">▼ {drop}% drop-off</div>}
          </Wrapper>
        );
      })}
    </div>
  );
}

// ────────────────────────── Heatmap (cohort retention) ──────────────────────────
export interface HeatmapRow {
  label: string;
  size?: number;
  cells: (number | null)[];
}
interface HeatmapProps {
  rows: HeatmapRow[];
  colLabels: string[];
}

export function Heatmap({ rows, colLabels }: HeatmapProps) {
  return (
    <div>
      <div className="flex flex-col gap-[3px]">
        <div className="flex gap-[3px] items-center">
          <div className="w-[84px] shrink-0" />
          {colLabels.map((c) => (
            <div key={c} className="flex-1 text-center text-[10px] text-text-muted">{c}</div>
          ))}
        </div>
        {rows.map((rw) => (
          <div key={rw.label} className="flex gap-[3px] items-center">
            <div className="w-[84px] shrink-0 text-[11px] text-text-tertiary font-mono">
              {rw.label}
              {rw.size != null && <span className="text-text-muted text-[10px]"> ({rw.size})</span>}
            </div>
            {rw.cells.map((v, i) => {
              if (v == null) return <div key={i} className="flex-1 h-[30px] rounded-[3px] bg-bg-surface" />;
              const a = (0.08 + (v / 100) * 0.85).toFixed(2);
              return (
                <div key={i} className="flex-1 h-[30px] rounded-[3px] flex items-center justify-center text-[10px] font-mono" style={{ background: `rgba(45,212,191,${a})`, color: v >= 45 ? '#06201d' : 'var(--color-text-secondary)' }}>
                  {v}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3 text-[10px] text-text-muted">
        <span>Less</span>
        <span className="w-[120px] h-2 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(45,212,191,0.10), rgba(45,212,191,0.93))' }} />
        <span>More</span>
        <span className="ml-auto font-mono">retention 0–100%</span>
      </div>
    </div>
  );
}

/** Shared rotating palette so multi-series charts get distinct token colors. */
export const CHART_PALETTE = [
  'var(--color-accent)',
  'var(--color-blue)',
  'var(--color-purple)',
  'var(--color-amber)',
  'var(--color-green)',
  'var(--color-cyan)',
  'var(--color-red)',
] as const;

export function paletteAt(i: number): string {
  return CHART_PALETTE[i % CHART_PALETTE.length];
}

/** Small helper for an inline panel section title used across analytics pages. */
export function ChartPanel({ title, right, children, className }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border border-border-strong bg-bg-surface overflow-hidden', className)}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-muted">
        <span className="text-[13px] font-semibold">{title}</span>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
