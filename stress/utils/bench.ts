/**
 * Measurement + statistics helpers for the benchmark harness.
 *
 * These are deliberately collector-agnostic: RSS is sampled by PID via `ps`
 * (works for a Node process or a Rust binary), throughput/latency are measured
 * over the wire. The same numbers come out regardless of what language the
 * collector is written in — which is the whole point. The bench is how we
 * answer "is the Rust port at least as fast and leak-free as Node?" with data
 * instead of vibes.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const BENCH_DIR = join(new URL('.', import.meta.url).pathname, '..', '..', 'bench');
export const BASELINE_DIR = join(BENCH_DIR, 'baselines');
export const RESULTS_DIR = join(BENCH_DIR, 'results');

/** Resident set size of a process in MB. 0 if the process is gone. */
export function rssMb(pid: number): number {
  try {
    // RSS in KB on macOS/Linux. `rss=` suppresses the header.
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'rss='], {
      encoding: 'utf-8',
    }).trim();
    return Number(out) / 1024;
  } catch {
    return 0;
  }
}

/** Ordinary-least-squares fit of y = slope·x + intercept, plus R². */
export function linregress(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

/** Percentile of an UNSORTED sample (linear interpolation). p in [0,100]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

// ---- Result schema (one file per bench run; baseline is the blessed copy) ----

export interface ThroughputResult {
  totalEvents: number;
  /** Wall time from first send to all-accepted-and-queryable, ms. */
  drainMs: number;
  /** totalEvents / drainMs * 1000. */
  eventsPerSec: number;
  /** Ingest→queryable latency percentiles, ms, over a sample of marker events. */
  latencyMs: { p50: number; p99: number; max: number };
  dropped: number;
}

export interface SoakResult {
  cycles: number;
  eventsPerCycle: number;
  /** RSS in MB sampled once per cycle, after the eviction window. */
  rssSamples: number[];
  /** OLS slope over ALL cycles, MB/cycle. Inflated by cold-start warmup —
   *  do NOT use this for the leak verdict; use tailSlopeMbPerCycle. */
  slopeMbPerCycle: number;
  /** Fit quality of the full-series slope. */
  r2: number;
  /** OLS slope over the steady-state TAIL (last third of cycles), MB/cycle.
   *  This is the real leak signal: a GC'd process plateaus here (≈0) while a
   *  genuine leak keeps climbing. Warmup ramp is excluded so it can't false-
   *  positive. */
  tailSlopeMbPerCycle: number;
  /** Fit quality of the tail slope. High tail R² + positive tail slope =
   *  confident leak; low R² = noise/plateau. */
  tailR2: number;
  /** Number of cycles in the tail window. */
  tailCycles: number;
  firstRssMb: number;
  lastRssMb: number;
  /** (last-first)/first as a percent — includes warmup, so it reads high even
   *  with no leak. Kept for continuity with the legacy memory-leak scenario. */
  growthPct: number;
  finalSessionMapSize: number;
}

export interface BenchReport {
  collector: string; // label from spawnCollector — "node" | rust binary basename
  schemaVersion: 1;
  /** ISO timestamp of the run. */
  recordedAt: string;
  host: { platform: string; cpus: number; nodeVersion: string };
  throughput: ThroughputResult;
  soak: SoakResult;
}

export function writeReport(report: BenchReport, fileName: string): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, fileName);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}

export function writeBaseline(report: BenchReport): string {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const path = join(BASELINE_DIR, `${report.collector}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}

export function readReport(path: string): BenchReport {
  // Accept: an explicit path, a baseline label ("node"), or a label with
  // extension ("node.json"). Labels resolve under bench/baselines/.
  const candidates = [
    path,
    join(BASELINE_DIR, path),
    join(BASELINE_DIR, `${path}.json`),
  ];
  const resolved = candidates.find((c) => existsSync(c));
  if (!resolved) {
    throw new Error(`No bench report for "${path}" (tried: ${candidates.join(', ')})`);
  }
  return JSON.parse(readFileSync(resolved, 'utf-8')) as BenchReport;
}
