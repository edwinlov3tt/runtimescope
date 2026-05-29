#!/usr/bin/env node
/**
 * RuntimeScope benchmark harness.
 *
 * Measures throughput, ingest→queryable latency, and memory behavior under a
 * soak, then records the numbers to bench/results/ and (optionally) blesses
 * them as the per-collector baseline in bench/baselines/<label>.json.
 *
 * It runs against WHATEVER collector spawnCollector launches — the Node
 * standalone by default, or any binary named in RUNTIMESCOPE_COLLECTOR_CMD.
 * That's the seam that lets us benchmark the Rust port against Node with the
 * exact same code:
 *
 *   # record the Node baseline (commit this)
 *   npm run bench -- --baseline
 *
 *   # later, measure the Rust collector and compare against Node
 *   RUNTIMESCOPE_COLLECTOR_CMD=./target/release/runtimescope-collector npm run bench
 *   npm run bench:compare -- node rust-collector
 *
 * Usage:
 *   npm run bench                       # run, write results, print summary
 *   npm run bench -- --baseline         # also overwrite bench/baselines/<label>.json
 *   npm run bench -- --quick            # smaller event counts / fewer cycles
 *   npm run bench:compare -- A B        # diff two reports (paths or baseline labels)
 *
 * Exit 0 on success; non-zero if a run fails or a compare trips a regression gate.
 */

import { spawnCollector } from './utils/spawn-collector.js';
import { SdkDriver, makeNetEvent } from './utils/sdk-driver.js';
import {
  rssMb,
  linregress,
  percentile,
  writeReport,
  writeBaseline,
  readReport,
  type BenchReport,
  type ThroughputResult,
  type SoakResult,
} from './utils/bench.js';
import { cpus, platform } from 'node:os';

const COLOR = process.stdout.isTTY;
const GREEN = COLOR ? '\x1b[32m' : '';
const RED = COLOR ? '\x1b[31m' : '';
const YELLOW = COLOR ? '\x1b[33m' : '';
const DIM = COLOR ? '\x1b[2m' : '';
const BOLD = COLOR ? '\x1b[1m' : '';
const RESET = COLOR ? '\x1b[0m' : '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull a single integer metric out of the Prometheus text exposition. */
function metric(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? Number(m[1]) : 0;
}

async function fetchMetrics(httpPort: number): Promise<string> {
  return fetch(`http://127.0.0.1:${httpPort}/metrics`).then((r) => r.text());
}

async function acceptedNetwork(httpPort: number): Promise<number> {
  const text = await fetchMetrics(httpPort);
  return metric(text, /^runtimescope_events_total\{type="network"\}\s+(\d+)/m);
}

// ---------------------------------------------------------------- throughput

async function benchThroughput(quick: boolean): Promise<ThroughputResult> {
  const TOTAL = quick ? 20_000 : 100_000;
  const BATCH = 500;
  const PROJECT = 'proj_bench_tput';
  const collector = await spawnCollector({ bufferSize: 10_000 });
  try {
    await collector.ready();
    const driver = new SdkDriver({
      wsPort: collector.wsPort,
      appName: 'bench-tput',
      projectId: PROJECT,
    });
    await driver.connect();
    await sleep(100);

    // ---- ingest→queryable latency: 50 single markers, time each round-trip
    const latencies: number[] = [];
    const LAT_SAMPLES = quick ? 20 : 50;
    for (let i = 0; i < LAT_SAMPLES; i++) {
      const before = await acceptedNetwork(collector.httpPort);
      const t0 = performance.now();
      driver.sendBatch([makeNetEvent(driver.sessionId, 9_000_000 + i)]);
      await driver.flush();
      // Poll metrics until the accepted counter advances past `before`.
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        if ((await acceptedNetwork(collector.httpPort)) > before) break;
        await sleep(2);
      }
      latencies.push(performance.now() - t0);
    }

    // ---- raw send throughput + drain-to-accepted
    const start = performance.now();
    let sent = 0;
    while (sent < TOTAL) {
      const size = Math.min(BATCH, TOTAL - sent);
      const batch: object[] = [];
      for (let i = 0; i < size; i++) batch.push(makeNetEvent(driver.sessionId, sent + i));
      driver.sendBatch(batch);
      sent += size;
    }
    await driver.flush();

    // The marker phase already accepted LAT_SAMPLES network events; drain
    // until the counter reflects the full flood on top of them.
    const target = TOTAL + LAT_SAMPLES;
    const drainDeadline = performance.now() + 30_000;
    while (performance.now() < drainDeadline) {
      if ((await acceptedNetwork(collector.httpPort)) >= target) break;
      await sleep(10);
    }
    const drainMs = performance.now() - start;

    const metricsText = await fetchMetrics(collector.httpPort);
    const accepted = metric(metricsText, /^runtimescope_events_total\{type="network"\}\s+(\d+)/m);
    const droppedLines = metricsText.match(/^runtimescope_events_dropped_total\{[^}]*\}\s+(\d+)/gm) || [];
    const dropped = droppedLines.reduce((s, l) => s + Number(l.split(/\s+/).pop()!), 0);

    await driver.close();

    if (accepted < target) {
      throw new Error(`throughput bench did not fully drain: accepted ${accepted} < ${target}`);
    }

    return {
      totalEvents: TOTAL,
      drainMs,
      eventsPerSec: (TOTAL / drainMs) * 1000,
      latencyMs: {
        p50: percentile(latencies, 50),
        p99: percentile(latencies, 99),
        max: Math.max(...latencies),
      },
      dropped,
    };
  } finally {
    await collector.stop();
  }
}

// ---------------------------------------------------------------------- soak

async function benchSoak(quick: boolean): Promise<SoakResult> {
  const CYCLES = quick ? 12 : 40;
  const EVENTS_PER_CYCLE = 2_000;
  // Tight eviction window so per-project SQLite handles actually close during
  // the run (production default is 5 min). Mirrors the memory-leak scenario.
  const collector = await spawnCollector({
    bufferSize: 10_000,
    sqliteIdleMs: 1_000,
    sqliteSweepMs: 500,
  });
  try {
    await collector.ready();
    const pid = collector.proc.pid!;
    const samples: number[] = [];

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const driver = new SdkDriver({
        wsPort: collector.wsPort,
        appName: `bench-soak-${cycle}`,
        projectId: `proj_bench_soak_${cycle}`,
      });
      await driver.connect();
      const batch: object[] = [];
      for (let i = 0; i < EVENTS_PER_CYCLE; i++) batch.push(makeNetEvent(driver.sessionId, i));
      for (let i = 0; i < batch.length; i += 200) driver.sendBatch(batch.slice(i, i + 200));
      await driver.flush();
      await driver.close();
      // Wait past the idle threshold so this cycle's store is evicted before
      // we sample — otherwise growth reflects still-open handles, not a leak.
      await sleep(1_500);
      samples.push(rssMb(pid));
      process.stdout.write(`${DIM}  soak cycle ${cycle + 1}/${CYCLES}: ${samples[cycle].toFixed(1)} MB${RESET}\r`);
    }
    process.stdout.write('\n');

    const xs = samples.map((_, i) => i);
    const full = linregress(xs, samples);
    const first = samples[0];
    const last = samples[samples.length - 1];

    // Steady-state tail: last third (min 5 cycles). This is where a healthy
    // GC'd process plateaus and a real leak keeps climbing. Fitting the tail
    // alone strips the cold-start warmup ramp that otherwise inflates slope.
    const tailCount = Math.max(5, Math.floor(CYCLES / 3));
    const tail = samples.slice(-tailCount);
    const tailFit = linregress(tail.map((_, i) => i), tail);

    const sessions = (await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/sessions`,
    ).then((r) => r.json())) as { data: unknown[] };

    return {
      cycles: CYCLES,
      eventsPerCycle: EVENTS_PER_CYCLE,
      rssSamples: samples.map((s) => Math.round(s * 10) / 10),
      slopeMbPerCycle: Math.round(full.slope * 1000) / 1000,
      r2: Math.round(full.r2 * 1000) / 1000,
      tailSlopeMbPerCycle: Math.round(tailFit.slope * 1000) / 1000,
      tailR2: Math.round(tailFit.r2 * 1000) / 1000,
      tailCycles: tailCount,
      firstRssMb: Math.round(first * 10) / 10,
      lastRssMb: Math.round(last * 10) / 10,
      growthPct: Math.round(((last - first) / first) * 1000) / 10,
      finalSessionMapSize: sessions.data.length,
    };
  } finally {
    await collector.stop();
  }
}

// ------------------------------------------------------------------- compare

/** Regression gates applied when comparing B against baseline A. */
function compare(a: BenchReport, b: BenchReport): boolean {
  console.log(`\n${BOLD}Compare${RESET}  ${a.collector} ${DIM}(baseline)${RESET}  →  ${b.collector} ${DIM}(candidate)${RESET}`);
  console.log('─'.repeat(64));
  let ok = true;

  const line = (label: string, pass: boolean, detail: string) => {
    if (!pass) ok = false;
    console.log(`  ${pass ? GREEN + '✓' : RED + '✗'}${RESET} ${label.padEnd(34)} ${detail}`);
  };

  // Throughput: candidate must be ≥ 90% of baseline (allow 10% noise).
  const tputRatio = b.throughput.eventsPerSec / a.throughput.eventsPerSec;
  line(
    'throughput ≥ 90% of baseline',
    tputRatio >= 0.9,
    `${b.throughput.eventsPerSec.toFixed(0)}/s vs ${a.throughput.eventsPerSec.toFixed(0)}/s ${DIM}(${(tputRatio * 100).toFixed(0)}%)${RESET}`,
  );

  // p99 latency: candidate must be ≤ 1.5× baseline.
  const latRatio = b.throughput.latencyMs.p99 / Math.max(a.throughput.latencyMs.p99, 0.01);
  line(
    'p99 ingest latency ≤ 1.5× baseline',
    latRatio <= 1.5,
    `${b.throughput.latencyMs.p99.toFixed(1)}ms vs ${a.throughput.latencyMs.p99.toFixed(1)}ms ${DIM}(${latRatio.toFixed(2)}×)${RESET}`,
  );

  // No drops on the candidate.
  line('zero dropped events', b.throughput.dropped === 0, `${b.throughput.dropped} dropped`);

  // Memory: candidate steady-state RSS ≤ 1.25× baseline.
  const memRatio = b.soak.lastRssMb / Math.max(a.soak.lastRssMb, 0.01);
  line(
    'steady-state RSS ≤ 1.25× baseline',
    memRatio <= 1.25,
    `${b.soak.lastRssMb}MB vs ${a.soak.lastRssMb}MB ${DIM}(${memRatio.toFixed(2)}×)${RESET}`,
  );

  // Leak: confident upward drift in the STEADY-STATE TAIL (warmup excluded).
  // A leak is a positive tail slope WITH a good linear fit; a plateau has a
  // near-zero slope and noise has low R².
  const leaking = b.soak.tailSlopeMbPerCycle > 0.5 && b.soak.tailR2 > 0.6;
  line(
    'no leak (steady-state tail)',
    !leaking,
    `tail slope ${b.soak.tailSlopeMbPerCycle}MB/cycle, R²=${b.soak.tailR2} ${DIM}(over last ${b.soak.tailCycles} cycles)${RESET}`,
  );

  console.log('─'.repeat(64));
  console.log(ok ? `${GREEN}${BOLD}✓ candidate within gates${RESET}` : `${RED}${BOLD}✗ candidate regressed${RESET}`);
  return ok;
}

// ----------------------------------------------------------------------- main

async function main(): Promise<void> {
  // Drop any bare `--` separators npm/tsx may leave in argv.
  const args = process.argv.slice(2).filter((a) => a !== '--');

  if (args.includes('--compare')) {
    const rest = args.filter((a) => !a.startsWith('--'));
    if (rest.length !== 2) {
      console.error('Usage: npm run bench:compare -- <baselineA> <candidateB>  (paths or baseline labels)');
      process.exit(2);
    }
    const a = readReport(rest[0]);
    const b = readReport(rest[1]);
    process.exit(compare(a, b) ? 0 : 1);
  }

  const quick = args.includes('--quick');
  const blessBaseline = args.includes('--baseline');

  console.log(`${BOLD}RuntimeScope bench harness${RESET}${quick ? ' (quick)' : ''}`);
  console.log(`Collector under test: ${YELLOW}${process.env.RUNTIMESCOPE_COLLECTOR_CMD ?? 'node (default standalone)'}${RESET}\n`);

  console.log(`${YELLOW}▶${RESET} throughput`);
  const throughput = await benchThroughput(quick);
  console.log(
    `  ${GREEN}✓${RESET} ${throughput.eventsPerSec.toFixed(0)} events/sec  ` +
      `${DIM}drain ${(throughput.drainMs / 1000).toFixed(2)}s, ` +
      `latency p50 ${throughput.latencyMs.p50.toFixed(1)}ms / p99 ${throughput.latencyMs.p99.toFixed(1)}ms, ` +
      `${throughput.dropped} dropped${RESET}`,
  );

  console.log(`\n${YELLOW}▶${RESET} memory soak`);
  const soak = await benchSoak(quick);
  const leakVerdict = soak.tailSlopeMbPerCycle > 0.5 && soak.tailR2 > 0.6
    ? `${RED}LEAK SUSPECTED${RESET}`
    : `${GREEN}no leak${RESET}`;
  console.log(
    `  ${GREEN}✓${RESET} RSS ${soak.firstRssMb}MB → ${soak.lastRssMb}MB over ${soak.cycles} cycles  ` +
      `${DIM}full-series slope ${soak.slopeMbPerCycle}MB/cycle, growth ${soak.growthPct}%${RESET}`,
  );
  console.log(
    `    ${leakVerdict} ${DIM}— steady-state tail (last ${soak.tailCycles}): slope ${soak.tailSlopeMbPerCycle}MB/cycle, R²=${soak.tailR2}${RESET}`,
  );

  // We need a label for the report; spawnCollector exposes it, but both bench
  // phases already tore down their collectors. Re-derive from the same source.
  const label = (process.env.RUNTIMESCOPE_COLLECTOR_CMD?.trim().split(/\s+/)[0].split('/').pop() || 'node').replace(/\.[^.]+$/, '');

  const report: BenchReport = {
    collector: label,
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    host: { platform: platform(), cpus: cpus().length, nodeVersion: process.version },
    throughput,
    soak,
  };

  const stamp = report.recordedAt.replace(/[:.]/g, '-');
  const resultPath = writeReport(report, `${label}-${stamp}.json`);
  console.log(`\n${DIM}results → ${resultPath}${RESET}`);
  if (blessBaseline) {
    const baselinePath = writeBaseline(report);
    console.log(`${GREEN}baseline updated → ${baselinePath}${RESET}`);
  } else {
    console.log(`${DIM}(run with --baseline to bless this as bench/baselines/${label}.json)${RESET}`);
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err);
  process.exit(1);
});
