# M7 Gate Findings — RuntimeScope Rust port

**Run date:** 2026-06-01. **Trigger:** kicking off M7 (the irreversible cutover that deletes the Node
reference). Per the audit discipline, the full gate was run *before* deleting anything.

**Verdict: the gate caught 6 real issues that conformance never surfaced.** This is the payoff of the
"green must mean the contract holds" rule — conformance (132/132) was green the whole time, yet the stress
+ bench gates exposed missing functionality and a perf regression. All six are now fixed; the gate is green.

## How the gate is run

```bash
cargo build --release
# Conformance (serial avoids the GPT #7 port-collision flake):
npx vitest run --config tests/conformance/vitest.config.ts --no-file-parallelism            # Node
RUNTIMESCOPE_COLLECTOR_CMD=…/collector-server RUNTIMESCOPE_MCP_CMD=…/mcp-server  npx vitest … # Rust
# Stress (7 scenarios):
npm run stress                                                # Node baseline
RUNTIMESCOPE_COLLECTOR_CMD=…/collector-server npm run stress  # Rust candidate
# Bench (record each, then compare):
npm run bench ; RUNTIMESCOPE_COLLECTOR_CMD=…/collector-server npm run bench
npm run bench:compare -- bench/results/node-*.json bench/results/collector-server-*.json
```

## Starting state

| Gate | Node | Rust (before) |
|------|------|---------------|
| conformance | 33/33 | 33/33 ✅ |
| stress | **7/7** | **3/7** ❌ |
| bench:compare | — (baseline) | **4/5 gates** ❌ (throughput 41%) |

## Findings & fixes

### Stress: 5 divergences in surfaces conformance didn't cover (commit `15d3ed0`)

1. **`/metrics` was a 2-line stub** (`runtimescope_up 1`). Flood read `runtimescope_events_total{type="network"}` → 0.
   Fixed: real Prometheus exposition — per-type cumulative `events_total` counters, `buffer_size`,
   `sessions_connected`, `uptime` gauges; `RUNTIMESCOPE_DISABLE_METRICS=1` → 404 parity.

2. **`GET /api/events/{type}` ignored `RUNTIMESCOPE_BUFFER_SIZE`.** `store.rs` had explicitly deferred the
   ring-buffer hot tier ("a later refinement") and queried SQLite directly → returned all 20 000 (cap 5 000).
   Fixed (user's M7 decision — *query-cap over durable store*): the read API + `buffer_size` gauge present
   only the newest `cap` rows (Node's ring window) while SQLite keeps full history. Observably identical to
   Node; keeps Rust's durability superset.

3. **`/api/sessions` `eventCount` hardcoded `0`.** Fixed: filled per session from SQLite (one grouped query).

4. **`GET /api/pm/workspaces/{id}/api-keys` (list) unrouted → 405**, then the scenario's `.json()` on the
   empty body threw. Fixed: added the route with the masked Node shape (`key:""` + `keyPrefix`/`keyLast4`)
   **and the full workspace-aware auth gate** — `resolve_caller` mirrors Node's `handleRequest`: auth flips
   active when **any** workspace key exists (`PmStore::has_active_api_keys`, the H5 fix), and a workspace
   `tk_` token authenticates as its workspace. Added `AuthManager::validate` (matches a *real global* token
   regardless of `enabled` — unlike `authorized()`'s "off → everything passes", which would misclassify a
   workspace token as admin — the H5 trap; unit-tested).

5. **`POST /api/v1/admin/snapshot` unrouted → 404** (a non-admin workspace token should get **403**).
   Fixed: ported as a **real `VACUUM INTO` backup** (not a stub) — admin-only (403 otherwise), 60s cooldown
   (429 + `Retry-After`), Node-shaped result.

### Bench: ingest throughput regression (commit `67a4934`)

6. **Ingest perf** — three iterations, each durability-neutral:
   - **41% of Node** (23k vs 56k ev/s) — the insert loop ran **one implicit SQLite transaction per event**
     (~20k tiny commits) + re-parsed the INSERT. Fixed: one `unchecked_transaction()` per batch +
     `prepare_cached`. → **100% of Node** (`67a4934`).
   - **CI p99 2.49× → still 1.80×** after a **WAL group-commit** (drain queued AddBatch, one fsync for the
     whole group) — helped throughput but the p99 metric is 50 *single-marker* round-trips, which don't
     coalesce, so p99 = the cost of one durable write (`90228ec`).
   - **CI p99 1.80× → 0.26×** — the single-write cost was macOS `F_FULLFSYNC` (`File::sync_all`). The
     crash-recovery contract is SIGKILL, which plain `fsync(2)` survives; `F_FULLFSYNC` only adds power-loss
     durability (which SQLite NORMAL/FULL doesn't promise on macOS, and Node never had). `Wal::commit` →
     `fsync` (`fc9b2e2`). → **p99 2.4ms vs Node 9.3ms (0.26×), throughput 146%.**

### Standing up the CI gate exposed a 7th issue (commit `98eabe1`)

`collector-core` embeds `packages/dashboard/dist/` via `rust-embed` (`debug-embed` = compile-time, every
profile), but that folder is a gitignored build artifact — so a **fresh checkout couldn't compile** ("folder
does not exist"). It only built locally on a stale `dist/`. Had been silently reding `rust.yml`. Fixed with
a `build.rs` that `create_dir_all`s the folder (empty → 404 until the SPA is built; the dashboard-embed
conformance spec gates that the *real* dashboard shipped). The `conformance` + release jobs build the real
dashboard before cargo.

## Ending state — gate GREEN IN CI (run 26788781393)

| Gate | Result |
|------|--------|
| `rust.yml` build / clippy / test | ✅ (107 tests) |
| conformance (serial, vs Rust, in CI) | ✅ **132/132** |
| bench:compare (in CI) | ✅ **5/5** — throughput **146%**, p99 **0.26×** (2.4ms vs 9.3ms), RSS **0.13×**, no leak, 0 drops |
| stress (local, both ways) | ✅ **7/7** |
| durability conformance (SIGKILL+restart) | ✅ |

Net: Rust **beats Node on throughput AND p99, uses ~8× less memory, and is crash-durable** (Node's ring is
RAM-only) — the "beyond-Node" goal exceeded, with every contract held.

## Remaining before the irreversible cutover

1. ~~Signed-binary release workflow + conformance/bench gate in CI~~ — ✅ done, green in CI.
2. **Tag the Node packages immediately before deletion** (the git-tag rollback the roadmap requires).
3. **Independent confirmation** of this gate + the `0002` remediation ledger (the irreversible-delete gate).
4. Then: delete `packages/collector|mcp-server|cli`, v0.11.0, deprecate Node on npm, completion report.
