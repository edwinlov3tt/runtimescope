# Feature: Memory-Pressure Governor (degrade-don't-die)

## Status: ⬜ Backlog

## Assessment
- **Phase**: v1.1 (post-Rust-port) — needs design
- **Complexity**: M (OS pressure signals + graceful shedding + hysteresis + tray supervision)
- **Value**: Medium (belt-and-suspenders; the real defense is hard memory bounds, mostly in place)
- **Created**: 2026-05-29

## Description
Keep the collector a good citizen under host memory pressure. **Not** the naive
"system free memory < X → exit" the idea started as — instead:
1. **Degrade, don't die** — under pressure: shrink the ring buffer, flush+evict
   to SQLite, apply backpressure (stop accepting new events). Stay alive minimal.
2. **React to OS memory *pressure*** (macOS `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE`,
   Linux PSI), not a free-bytes threshold (misleading on macOS).
3. **Trigger on our own RSS** (`RUNTIMESCOPE_MAX_RSS`) — "we are the problem" —
   not on system-wide free memory ("the build is busy").
4. **If graceful exit is offered, opt-in + hysteresis** (recover above X+margin
   for N s before restart) and let the **tray supervise the restart** (it
   monitors the collector + has `service stop`/`restart`) — NOT launchd KeepAlive
   (instant-restart → tight loop).

## Why
A monitoring tool must never push the host over the edge. But the bench shows
RuntimeScope is **not** a memory hog (Node ~118MB steady, no leak; Rust lower);
the "50% of memory" fear only materializes via a leak/unbounded structure, whose
real fix is **bounds** (ring-buffer cap + SQLite-handle LRU eviction v0.10.8 +
WAL bounding Phase D — already done). So this governor is defense-in-depth, and
naive auto-exit would do net harm (flapping, data-loss exactly when monitoring
matters, macOS metric misfires). Worth doing, but as the careful shape above.

## Notes
- Full reasoning + the rejected naive design: [`docs/research/0002-memory-storage-governor.md`](../../docs/research/0002-memory-storage-governor.md).
- Likely lands partly in the tray (user-facing toggle + restart supervision) and
  partly in collector-core (pressure listener + shedding).
