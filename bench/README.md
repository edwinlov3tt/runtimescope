# RuntimeScope benchmark harness

Throughput, ingest latency, and memory-soak measurement for the collector —
recorded to JSON so a reimplementation (the Rust collector in Phase
Rust-Collector) can be proven **at least as fast and leak-free as Node** with
data instead of guesswork.

## The core idea: differential testing

The benchmark runs against whatever collector
[`stress/utils/spawn-collector.ts`](../stress/utils/spawn-collector.ts) launches.
By default that's the Node standalone. Set `RUNTIMESCOPE_COLLECTOR_CMD` to any
executable and the **same code** measures that binary instead:

```bash
# 1. Record the Node baseline (commit bench/baselines/node.json)
npm run bench -- --baseline

# 2. Later, in Phase Rust-Collector — measure the Rust binary, same harness:
RUNTIMESCOPE_COLLECTOR_CMD=./target/release/runtimescope-collector npm run bench -- --baseline

# 3. Compare: does Rust meet or beat Node?
npm run bench:compare -- node runtimescope-collector
```

The launched binary must honor `RUNTIMESCOPE_PORT` / `RUNTIMESCOPE_HTTP_PORT` /
`RUNTIMESCOPE_BUFFER_SIZE` and serve `/readyz` — that's part of the locked wire
contract ([`docs/specs/tray-api-surface.md`](../docs/specs/tray-api-surface.md),
and the broader spec coming in Phase Wire-Protocol-Lock). The same seam is what
lets the **entire `stress/` suite** (flood, crash-recovery, memory-leak, …) run
against the Rust collector unchanged — that suite is the *correctness* gate;
this bench is the *performance* gate.

## Commands

| Command | What it does |
|---|---|
| `npm run bench` | Full run (100k-event throughput, 40-cycle soak). Writes `bench/results/<label>-<ts>.json`. |
| `npm run bench -- --baseline` | Same, and blesses `bench/baselines/<label>.json` (the committed reference). |
| `npm run bench:quick` | Smaller counts (20k events, 12 cycles) for a fast smoke. |
| `npm run bench:compare -- A B` | Diff two reports (baseline labels or paths). Exit non-zero if B regresses past the gates. |

## What it measures

### Throughput
- **events/sec** — 100k network events sent over one session, timed from first
  send until `/metrics` reports all accepted (drain-inclusive, not just send-side).
- **ingest→queryable latency** (p50 / p99 / max) — 50 single-event round-trips,
  each timed from send until the `/metrics` accepted counter advances. This is
  the latency a tool actually sees between "event happened" and "event queryable".
- **dropped** — must be 0.

### Memory soak
- 40 cycles of *connect → flood 2k events → disconnect*, sampling RSS (via `ps`,
  so it works for a Node process or a Rust binary) once per cycle after the
  per-project SQLite store's idle-eviction window.
- **full-series slope / growth%** — reported for continuity with the legacy
  `memory-leak` stress scenario, but **not** used for the leak verdict: both are
  inflated by cold-start V8/SQLite warmup and read ~50% even on a healthy process.
- **steady-state tail slope (MB/cycle) + R²** — OLS fit over the last third of
  cycles, *after* warmup. **This is the leak signal.** A GC'd process plateaus
  here (slope ≈ 0); a real leak keeps climbing (slope > 0 with high R²).

## How to read the memory numbers (important)

The Node baseline looks alarming if you only read growth%:

```
RSS 78.9MB → 118.6MB over 40 cycles   full-series slope 0.959MB/cycle, growth 50.3%
  no leak — steady-state tail (last 13): slope 0.454MB/cycle, R²=0.885
```

50% growth, but **no leak**. The RSS trace is a sawtooth: it ramps during V8
heap warmup, drops sharply when a major GC fires (you'll see a cycle where RSS
falls ~35MB), ramps again, then **plateaus** in the back third around 115–118MB.
That plateau is the proof there's no unbounded retention. Fitting one regression
line across warmup + plateau is what produces the misleading 0.96 MB/cycle
full-series slope — which is exactly why the leak verdict uses the **tail** slope
(0.45 MB/cycle, below the 0.5 gate) instead.

This is a heuristic, and the tail still carries a little GC-sawtooth drift, so the
0.5 MB/cycle threshold has a thin margin against Node's own noise. The real
protection isn't the absolute threshold — it's the **differential** comparison:
Rust's allocator is deterministic (no GC sawtooth), so its tail slope should sit
near zero and its steady-state RSS well under Node's. `bench:compare` is where
the verdict that matters gets made.

## Regression gates (`bench:compare A B`)

B (candidate) is measured against A (baseline):

| Gate | Threshold |
|---|---|
| throughput | B ≥ 90% of A |
| p99 ingest latency | B ≤ 1.5× A |
| dropped events | B == 0 |
| steady-state RSS | B ≤ 1.25× A |
| leak | B tail slope ≤ 0.5 MB/cycle **or** tail R² ≤ 0.6 |

For the Rust port the bar is meant to be *cleared comfortably*, not squeaked
past: Rust should beat Node on throughput and memory, not merely stay within 90%.
The gates are the floor, not the goal.

## Files

- `baselines/<label>.json` — **committed.** The blessed reference per collector.
- `results/<label>-<timestamp>.json` — **gitignored.** Every run's raw output.
- Measurement + stats live in [`stress/utils/bench.ts`](../stress/utils/bench.ts);
  the runner is [`stress/bench.ts`](../stress/bench.ts).

> Numbers are host-dependent (the baseline records platform / cpus / node
> version). Re-bless the baseline on the machine you'll compare on, or compare
> only runs taken on the same hardware.
