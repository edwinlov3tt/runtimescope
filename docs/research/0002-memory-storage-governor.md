# Resource self-governance — storage cap (build it) vs. memory auto-exit (don't, as proposed)

**Status:** `active`
**Created:** 2026-05-29
**Last touched:** 2026-05-29
**Spans phases:** post-Rust-Collector hardening (v1.1)

---

## Conclusion (one sentence)

A monitoring tool must never push its host over the edge, but the right way to honor that is **hard bounds + a low-risk storage retention cap + a degrade-don't-die memory governor that reacts to OS *pressure* and our own RSS** — **not** the naive "system free memory < X → auto-exit (+restart)" the idea started as, which would net-harm via flapping, a data-loss window exactly when monitoring matters, and misleading free-memory metrics on macOS.

## Why this matters

RuntimeScope runs as a long-lived background daemon on the owner's primary machine. The instinct ("don't let it eat 50% of memory") is correct as a *principle*. But the mechanism determines whether it helps or hurts, and the obvious mechanism (kill-on-low-memory) is the harmful one.

## Evidence

- **It isn't actually a memory hog.** `bench/baselines/node.json`: Node plateaus ~118MB steady, no leak (sawtooth-then-plateau). Rust will be lower/flatter (no GC). The "50% of memory" scenario only arises from a leak or unbounded structure.
- **Bounds already address the real risk.** Ring-buffer cap (`RUNTIMESCOPE_BUFFER_SIZE`); per-project SQLite-handle LRU eviction (v0.10.8, fixed a ~100MB baseline on the 44-project machine); WAL bounding (audit Phase D — truncate after each batch's SQLite commit). In-memory is bounded; SQLite is on-disk.
- **Naive auto-exit harms:**
  - *Flapping* — memory hovering near the threshold → exit→restart→exit (CPU, SQLite reopen, WAL replay, SDK reconnect churn) — worse than steady use.
  - *Goes dark when it matters* — high memory ≈ heavy build/test, the moment you'd want the data; the SDK offline queue caps at 1K.
  - *macOS "free memory" is misleading* — the OS uses nearly all RAM for cache; the real signal is memory *pressure* (`DISPATCH_SOURCE_TYPE_MEMORYPRESSURE`), not free bytes.
  - *Restart supervision* — a process can't revive itself; launchd `KeepAlive` would instant-restart (tight loop). The tray (separate process, already monitors the collector, has `service stop`/`restart`) is the right supervisor.

## The decision

Split the idea into two features with very different risk profiles:

1. **Storage retention cap — build it ([feature](../../.claude/features/storage-retention-cap.md)).** Prune oldest events on a size/age/disk threshold. No flapping, no data-loss window, no reconnect churn — just bounded cold storage. Low-risk, standard.
2. **Memory-pressure governor — v1.1, careful shape ([feature](../../.claude/features/memory-pressure-governor.md)).** Degrade-don't-die (shrink buffer / flush / backpressure), react to OS *pressure* not free-bytes, trigger on *our own* RSS (`RUNTIMESCOPE_MAX_RSS`) not system free, opt-in graceful-exit with hysteresis, tray-supervised restart.

## Where it shows up / will show up

- Bounds today: [`packages/collector/src/store.ts`](../../packages/collector/src/store.ts) (ring buffer, LRU eviction), Rust `crates/collector-core/src/{store,wal}.rs` (WAL bounding).
- Future: the storage cap lands in the Rust dedicated-DB-owner thread; the memory governor splits across `collector-core` (pressure listener + shedding) and the tray (toggle + restart supervision).

## Timing

Both are **post-launch (v1.1) hardening**, not launch blockers — the existing bounds keep the baseline modest. The Rust port makes both easier (lower baseline, deterministic memory, real OS-pressure APIs via crates).
