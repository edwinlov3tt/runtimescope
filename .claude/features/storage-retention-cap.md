# Feature: Storage Retention Cap

## Status: ⬜ Backlog

## Assessment
- **Phase**: v1.1 (post-Rust-port)
- **Complexity**: S (bounded delete-oldest on a size/age/disk threshold)
- **Value**: Medium-High
- **Created**: 2026-05-29

## Description
Bound the collector's on-disk footprint: prune oldest events when the SQLite DB
exceeds a configurable size (e.g. `RUNTIMESCOPE_MAX_DB_BYTES`), when events age
past a retention window (`RUNTIMESCOPE_RETENTION_DAYS`), or when free disk drops
below a floor. Eviction is delete-oldest (the ring buffer already caps the
in-memory hot tier; this caps the cold tier).

## Why
This is the low-risk, no-downside half of the owner's "control storage/memory"
idea. Unlike the memory governor, a storage cap has **no flapping, no
data-loss window, no reconnect churn, and no restart-supervision problem** — it
just trims old cold data in place. Standard for any event store. The Rust port
makes it a small, contained addition to the dedicated-DB-owner thread.

## Notes
- Pair with a periodic VACUUM/checkpoint so freed pages return to the OS.
- Surface what was pruned (don't silently truncate — CLAUDE.md "no silent caps").
- See [`docs/research/0002-memory-storage-governor.md`](../../docs/research/0002-memory-storage-governor.md).
