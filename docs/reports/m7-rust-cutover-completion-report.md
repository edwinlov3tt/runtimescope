# Milestone 7 Completion Report — Rust Cutover

**Project:** RuntimeScope — replace the Node collector/mcp-server/cli with the Rust workspace (Phase Rust-Collector close).
**Operating manual:** [`../../CLAUDE.md`](../../CLAUDE.md)
**Roadmap:** [`../roadmap/rust-collector-milestones.md`](../roadmap/rust-collector-milestones.md) §M7
**Gate findings:** [`../reviews/0003-m7-gate-findings.md`](../reviews/0003-m7-gate-findings.md)
**Rollback tag:** `node-reference-v0.10.13` (the final Node implementation, verified restorable)
**Released as:** v0.11.0 — SDKs + framework integrations on npm; collector/mcp-server/cli as signed Rust binaries (GitHub Release). *npm publish + Node-package deprecation pending (see §6).*

---

## 1. Commands run + outputs (post-cutover, local)

| Command | Purpose | Result |
|---|---|---|
| `cargo build --release --locked` | Rust workspace builds | ✅ clean |
| `cargo clippy --workspace --all-targets --locked` | lint gate | ✅ 0 warnings |
| `cargo test --workspace --locked` | Rust unit gate | ✅ 107 passed |
| `npm test` | remaining JS unit gate | ✅ 126 passed / 0 failed |
| `npm run build -w …` (7 published pkgs) | publishable packages build | ✅ clean |
| conformance (serial, **default = Rust binaries**) | wire-contract parity | ✅ 33/33 files, 132 tests |
| `npm run stress` (default Rust) | stress gate | ✅ 7/7 scenarios |
| `npm run bench:check` (absolute SLO) | perf gate | ✅ within SLO |

CI (`rust.yml`, run 26788781393, pre-deletion commit): build + conformance + bench all green.

## 2. Final test count

**107 Rust unit + 126 JS unit = 233 passed / 0 failed. Conformance 132/132. Stress 7/7.**

| Target | Passed | Notes |
|---|---:|---|
| `crates/*` cargo test | 107 | incl. WAL group-commit, reboot-prune, auth H5, to_period guards |
| JS package unit (`npm test`) | 126 | SDKs + dashboard + integrations (Node mcp-server's 16 suites removed with it) |
| conformance (vs Rust) | 132 | serial; parallel has the GPT #7 port-collision flake |
| stress | 7/7 | flood, concurrent, pathological, auth-fuzz, crash-recovery, memory-leak, framework-smoke |

## 3. What shipped

- **Deleted** `packages/collector`, `packages/mcp-server`, `packages/cli` (135 files). The Rust `crates/` workspace is now the sole collector + MCP server + CLI.
- **Rewired** the harnesses to default to the Rust release binaries; conformance runs vs Rust as the reference (the Node differential ended with the cutover). `RUNTIMESCOPE_COLLECTOR_CMD`/`MCP_CMD` still override.
- **New perf gate**: `bench --check` asserts absolute SLOs (throughput ≥25k ev/s, p99 ≤25ms, RSS ≤60MB, no leak) — there is no live Node baseline to ratio against post-cutover.
- **Workflows**: `publish.yml` now publishes only SDKs + framework integrations; `release-binaries.yml` ships universal signed macOS binaries; `rust.yml` is the conformance + SLO gate.
- **v0.11.0** across the 7 published packages + `SDK_VERSION` (Cargo workspace already 0.11.0).

## 4. How Rust compares to the Node reference (the cutover justification)

| Axis | Node (final 0.10.13) | Rust 0.11.0 | Verdict |
|---|---|---|---|
| wire contract | reference | 132/132 identical | parity |
| throughput | ~38–56k ev/s | 55–63k ev/s | **≥100%** (CI 146%) |
| p99 ingest latency | ~9ms (non-durable RAM ring) | ~2–5ms (durable) | **beats Node** |
| steady-state RSS | ~110MB | ~16MB | **~8× less** |
| crash durability | none (RAM ring) | survives SIGKILL (WAL + replay) | **beyond Node** |

## 5. Deviations / findings (the gate did its job)

Running the gate *before* deletion caught **7 issues conformance (green throughout) never surfaced** — 5 stress divergences (`/metrics` stub, uncapped reads, `eventCount=0`, missing api-keys list + workspace auth gate, missing admin-snapshot), a 3-stage ingest-perf fix (txn batching → group-commit → `fsync`-not-`F_FULLFSYNC`), and the rust-embed dashboard-dist compile dependency that broke fresh checkouts. All fixed; detail in `reviews/0003`. **Durability note:** the WAL now uses `fsync(2)` not macOS `F_FULLFSYNC` — crash-durable (the SIGKILL contract) but not power-loss-fsync'd, matching SQLite's default and exceeding Node's (zero).

## 6. Remaining (outward-facing — operator action)

1. **Push the `v0.11.0` tag** → triggers `publish.yml` (npm) + `release-binaries.yml` (binaries). Requires the `NPM_TOKEN` secret (already configured for prior releases).
2. **Deprecate the Node packages on npm** — needs interactive npm auth:
   ```
   npm deprecate @runtimescope/collector@"<=0.10.13"  "Replaced by the Rust collector in v0.11.0 — install the runtimescope binary."
   npm deprecate @runtimescope/mcp-server@"<=0.10.13" "Replaced by the Rust mcp-server in v0.11.0."
   npm deprecate runtimescope@"<=0.10.13"             "Replaced by the Rust CLI in v0.11.0."
   ```
3. **(Optional) Apple signing secrets** — without `APPLE_CERTIFICATE_BASE64` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY`, release binaries ship unsigned (with a `::notice`).
4. Update `CURRENT_STATE` + `HANDOFF` to Phase SDK-Channel-Migration once npm is published.
