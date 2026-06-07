# ADR-0013: ROI, forecasting & narratives on the Mosaic cube engine

**Status:** `Proposed` — pending the spike in [research 0006](../research/0006-mosaic-roi-spike.md)
**Date:** 2026-06-07
**Deciders:** Edwin (owner) + implementing instance
**Phase:** `Analytics`

---

## Context

[ADR-0012](./0012-analytics-adoption-subsystem.md) defines the analytics
subsystem; [the data-model spec](../specs/analytics-data-model.md) maps the
prototypes to backend data in six slices. **Slice 2 (usage rollups)** shipped as
pure SQL/Rust over the event stream (`analytics_rollups.rs`: active users,
adoption, events, DAU/WAU/MAU, per-user/feature) — counting aggregations where a
cube would be overkill.

**Slice 3 is different.** ROI, projections, and narratives need:
- **value/hours** = `(baseline.manual − tool) × (per_item ? count : 1) / 60 ×
  role.rate`, rolled up by user / feature / role / app / time — a multi-dimensional
  consolidation joining events × baselines × roles.
- **What-if recompute:** editing a baseline or rate must recompute value
  everywhere (the baselines page; the >20% crowd-submission preview).
- **Forecasting:** quarter projections (proj vs actual, % to goal) + forward
  forecasts.
- **Traceability:** "every dollar traces to a logged action" — the KPI
  methodology's entire defensibility argument (`~/kpis/docs/METHODOLOGY.md`).
- **Narratives:** the compare-page insights + the executive summary.

The owner's **Mosaic** engine (`github.com/edwinlov3tt/mc-v2`) does exactly this:
an n-dimensional cube kernel with deterministic consolidation + dirty-tracking,
YAML-authored formulas (`value = time_saved/60 * rate`), fitted models
(`predict`/`calibrate`), time-series ops (`cumsum`/`lag`/`lead`), `trace` /
`whatif` / `sweep`, a narrative template engine (`mc-narrative`), and a service
**daemon** (`mc-daemon`: HTTP API, hot cube cache, crash recovery). RuntimeScope
already has a **sidecar precedent** — the Playwright recon sidecar ([ADR-0007](./0007-playwright-node-sidecar.md)).

Forces: ROI math alone is ~30 lines of SQL — Mosaic earns its keep on the
forecasting + traceability + what-if + narrative cluster, not the base calc. And
the batteries-included default (self-hosted collector, zero extra services) must
keep working without Mosaic present.

## Decision

**Build the ROI / projections / forecast / narrative layer (slice 3) on Mosaic,
integrated as a flag-gated `mc-daemon` sidecar, with a pure-SQL ROI fallback so
the batteries-included default still computes value without Mosaic.** Slice-2
counting stays SQL. **This decision is contingent on the spike (research 0006)
validating effort + fit; if the spike fails the bar, fall back to "pure-SQL ROI,
no Mosaic" (Alternative 2).**

**What we are doing (pending spike):**

- Model the ROI as a **Mosaic cube**: dims `[anonId, feature, role, app, time]`,
  measures `[events, time_saved, value, hours]`, rules authored in YAML; baselines
  + role rates are **input cells**. Consolidation = the per-dimension rollups.
- Integrate via the **`mc-daemon` sidecar** (HTTP): the collector posts facts
  (the event rollup) and reads computed cells. **Flag-gated** (e.g.
  `RUNTIMESCOPE_MOSAIC_URL`); absent ⇒ the collector uses the **SQL ROI fallback**
  (the simple formula, no forecasting/trace/narrative).
- Use **`mc-narrative`** for the compare-page insights + executive summary, and
  Mosaic **fitted models** for projections/forecasts.
- Surface **`trace`** behind the ROI numbers (the methodology defensibility play).

**What we are explicitly NOT doing:**

- **Not** putting the slice-2 counting rollups on Mosaic — they stay SQL.
- **Not** making Mosaic a hard dependency of the collector — batteries-included
  must work without it (SQL fallback).
- **Not** committing before the spike — this ADR stays `Proposed` until research
  0006 reports go/no-go.

## Consequences

**Positive:**
- Declarative ROI model (YAML rules) instead of hand-maintained SQL; consolidation
  + dirty-recompute give the rollups + what-if for free.
- Forecasting, traceability, and narratives — three things SQL won't give us —
  come from one engine the owner already built.
- Sidecar keeps the collector lean and matches the ADR-0007 pattern.

**Negative / accepted trade-offs:**
- Cross-repo coupling to a private engine: a pinned daemon API / version, and
  release coordination. The spike must surface the interface stability.
- The sidecar adds an operational process (mitigated: flag-gated; SQL fallback is
  the zero-dependency default).
- Two ROI code paths (Mosaic + SQL fallback) to keep in agreement — needs a
  differential test (the SQL formula is the reference for the cube on a fixture).

**Reversal cost:** Low-moderate. Flag-gated + SQL fallback means Mosaic can be
removed by unsetting the flag; the analytics.db baselines/roles and the SQL ROI
remain. The sticky part would be any narrative/forecast features that have no SQL
equivalent — those would regress to absent, not broken.

## Alternatives considered

1. **Library crate dep** (`mc-core`/`mc-model`/`mc-narrative` as pinned git deps,
   in-process). No second process, lower latency, but pulls a large engine + its
   deps into `collector-core`, bloats the binary, and couples build/release
   tightly. The spike will compare this against the sidecar (build size/time vs
   round-trip latency); kept as the fallback integration if the daemon proves
   awkward.
2. **Pure-SQL ROI, no Mosaic.** Compute value with the formula in SQL/Rust
   (cross-DB join events × baselines × roles); skip forecasting/trace/narrative or
   hand-roll them. Lowest risk, ships fastest — this is the **fallback if the spike
   fails**, and the always-present default regardless.
3. **External cube/BI (Cube.dev, dbt, Metabase).** Mature, but a heavyweight
   external dependency that breaks batteries-included and self-hosting, and
   forfeits the owner's existing engine + the trace/narrative integration. Rejected.

## Cross-links

- Spike (gates this): [`../research/0006-mosaic-roi-spike.md`](../research/0006-mosaic-roi-spike.md)
- Spec: [`../specs/analytics-data-model.md`](../specs/analytics-data-model.md)
  (ROI formula §, adoption denominators §)
- Builds on: [`./0012-analytics-adoption-subsystem.md`](./0012-analytics-adoption-subsystem.md);
  sidecar precedent [`./0007-playwright-node-sidecar.md`](./0007-playwright-node-sidecar.md)
- Mosaic: `github.com/edwinlov3tt/mc-v2` (`mc-core`, `mc-model`, `mc-narrative`,
  `mc-daemon`).
- Source so far: [`../../crates/collector-core/src/analytics_rollups.rs`](../../crates/collector-core/src/analytics_rollups.rs),
  [`../../crates/collector-core/src/analytics_store.rs`](../../crates/collector-core/src/analytics_store.rs).

## Notes

The analytics.db `baselines`/`roles` tables (slice 1) are the cube's input cells
either way, so they're built regardless of the spike outcome. Build the SQL ROI
fallback first (it's the default + the cube's reference oracle), then layer Mosaic
behind the flag once the spike says go.
