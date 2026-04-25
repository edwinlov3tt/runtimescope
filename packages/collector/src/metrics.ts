/**
 * Minimal Prometheus-compatible metrics registry. Zero dependencies — the
 * exposition format is small enough that pulling in `prom-client` would be
 * heavier than just emitting the text ourselves.
 *
 * Two metric kinds are supported:
 *   - Counter (monotonic) for things like total events, dropped events.
 *   - Gauge (point-in-time) for things like current sessions connected,
 *     ring-buffer occupancy. Gauges accept a `collect` callback so they
 *     compute their value at scrape time rather than tracking state.
 *
 * Spec reference: https://prometheus.io/docs/instrumenting/exposition_formats/
 */

export type LabelValues = Record<string, string>;

interface Sample {
  labels: LabelValues;
  value: number;
}

abstract class Metric {
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
  ) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
      throw new Error(`Invalid metric name "${name}" — must match Prometheus naming rules`);
    }
  }

  abstract type(): 'counter' | 'gauge';
  abstract collect(): Sample[];
}

export class Counter extends Metric {
  private values = new Map<string, Sample>();

  type(): 'counter' { return 'counter'; }

  inc(value: number = 1, labels: LabelValues = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = labelKey(labels, this.labelNames);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.values.set(key, { labels: orderLabels(labels, this.labelNames), value });
    }
  }

  reset(): void {
    this.values.clear();
  }

  collect(): Sample[] {
    return Array.from(this.values.values());
  }
}

export class Gauge extends Metric {
  private values = new Map<string, Sample>();
  private collectFn: (() => Sample[]) | null = null;

  type(): 'gauge' { return 'gauge'; }

  /**
   * Set a fixed value for the given label set. Per the Prometheus spec, gauges
   * may take any numeric value including +Inf / -Inf / NaN — the renderer
   * handles formatting. Only actually-not-a-number inputs (`undefined`, etc.)
   * are silently dropped.
   */
  set(value: number, labels: LabelValues = {}): void {
    if (typeof value !== 'number') return;
    const key = labelKey(labels, this.labelNames);
    this.values.set(key, { labels: orderLabels(labels, this.labelNames), value });
  }

  /**
   * Compute the gauge dynamically at scrape time. Useful for things like
   * "currently-connected sessions" where caching a stale value is wrong.
   * Mutually exclusive with `set()` — last writer wins.
   */
  setCollect(fn: () => number | Sample[]): void {
    this.collectFn = () => {
      const result = fn();
      if (typeof result === 'number') return [{ labels: {}, value: result }];
      return result;
    };
  }

  collect(): Sample[] {
    if (this.collectFn) return this.collectFn();
    return Array.from(this.values.values());
  }
}

export class MetricsRegistry {
  private metrics: Metric[] = [];

  counter(name: string, help: string, labelNames: string[] = []): Counter {
    const c = new Counter(name, help, labelNames);
    this.metrics.push(c);
    return c;
  }

  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    const g = new Gauge(name, help, labelNames);
    this.metrics.push(g);
    return g;
  }

  /** Serialize every registered metric in Prometheus exposition format. */
  render(): string {
    const out: string[] = [];
    for (const metric of this.metrics) {
      out.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
      out.push(`# TYPE ${metric.name} ${metric.type()}`);
      for (const sample of metric.collect()) {
        out.push(formatSample(metric.name, sample));
      }
    }
    // Prometheus requires a trailing newline.
    return out.join('\n') + '\n';
  }
}

// ---------------------------------------------------------------------------
// Helpers — kept private to discourage callers from hand-rolling exposition.
// ---------------------------------------------------------------------------

function labelKey(labels: LabelValues, expected: string[]): string {
  // Stable key for in-memory dedup. Sorted by label name for determinism.
  const ordered = orderLabels(labels, expected);
  const pairs: string[] = [];
  for (const name of Object.keys(ordered).sort()) {
    pairs.push(`${name}=${ordered[name]}`);
  }
  return pairs.join('|');
}

function orderLabels(labels: LabelValues, expected: string[]): LabelValues {
  // Drop unexpected labels and provide stable presence for the rendered output.
  // Strict-mode would throw; we're permissive so a typo on inc() doesn't take
  // down the collector.
  const out: LabelValues = {};
  for (const name of expected) {
    out[name] = labels[name] ?? '';
  }
  return out;
}

function formatSample(name: string, sample: Sample): string {
  const labelPart = renderLabels(sample.labels);
  return `${name}${labelPart} ${formatNumber(sample.value)}`;
}

function renderLabels(labels: LabelValues): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys.sort()) {
    parts.push(`${k}="${escapeLabelValue(labels[k])}"`);
  }
  return `{${parts.join(',')}}`;
}

function escapeLabelValue(v: string): string {
  // Escape backslash, double-quote, and newline per spec.
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  // Integers render without a decimal point — matches prom-client output and
  // avoids surprising users grepping for "events_total 5" not "events_total 5.0".
  if (Number.isInteger(n)) return String(n);
  return n.toString();
}
