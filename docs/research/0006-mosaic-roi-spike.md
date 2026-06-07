# Research 0006 — Mosaic ROI spike (handoff brief)

> **Purpose:** validate the owner's **Mosaic** cube engine
> (`github.com/edwinlov3tt/mc-v2`) as the engine for RuntimeScope's analytics
> **ROI / projections / forecast / narrative** layer (slice 3) *before* committing
> [ADR-0013](../decisions/0013-roi-forecasting-on-mosaic.md). This doc is a
> **handoff brief** — another instance can execute it end-to-end and report
> go/no-go. **Time-box: ~half a day.** Spike in scratch space / the Mosaic repo —
> **do NOT add Mosaic as a dependency of `runtimescope` yet.**
>
> Read first: [`../specs/analytics-data-model.md`](../specs/analytics-data-model.md)
> (ROI formula §, "User populations + adoption denominators" §) and
> [ADR-0013](../decisions/0013-roi-forecasting-on-mosaic.md).

## What we already have (don't rebuild)

- **Slice 1-2 shipped:** `analytics.db` store (`analytics_users`/`_pii`/`_roles`/
  `_baselines`/`_baseline_history`/`_baseline_submissions`/`_projections`), SDK
  `identify()` (stamps `anonId` on `custom` events), and **SQL usage rollups**
  (`crates/collector-core/src/analytics_rollups.rs`: active users, adoption,
  DAU/WAU/MAU, per-user, per-feature). These are the **inputs/oracle** for the spike.
- The **ROI formula** (the thing the cube must reproduce):
  `time_saved(event) = (manual_min − tool_min) × (per_item ? meta.count : 1)`,
  `value(event) = time_saved/60 × role.hourly_rate`, rolled up by
  user/feature/role/app/time. The **role rate is the acting user's role rate**
  (join event→anonId→user.role→role.rate), NOT a per-baseline rate (spec caveat).

## The question to answer

**Is Mosaic the right engine for slice 3, and integrated how?** Concretely:
1. Can a Mosaic cube reproduce our ROI value/hours rollups *exactly* (vs the SQL
   oracle) from the same event facts?
2. Do `trace`, `whatif`, fitted-model forecasting, and `mc-narrative` deliver the
   things SQL won't (audit chain, live recompute, projections, insights)?
3. **Sidecar (`mc-daemon`) vs library crate** — effort, latency, build cost?

## Tasks

1. **Build Mosaic + learn the surface.**
   `git clone … mc-v2 && cargo build`; run `mc demo --model crates/mc-model/examples/acme.yaml`,
   then `mc model trace … 'Revenue[Q1]'`, `mc model whatif … --override …`,
   `mc model query … --format json`. Read `CLAUDE.md` + `docs/HANDOFF.md`.

2. **Author the RuntimeScope ROI cube (`roi.yaml`).**
   - Dimensions: `user (anonId)`, `feature (fn)`, `role`, `app`, `time` (day/week/
     quarter hierarchy).
   - Measures: `events`, `time_saved`, `value`, `hours`.
   - Input cells: `baseline.manual_min`, `baseline.tool_min`, `baseline.per_item`,
     `role.hourly_rate` (seed from `analytics_roles` defaults: Coordinator 40,
     Specialist 50, DCM 55, Account Exec 65, Director 85).
   - Rules (YAML formulas): `time_saved = (manual_min − tool_min) * qty`,
     `value = time_saved/60 * hourly_rate`, `hours = time_saved/60`. Decide how
     `qty` (per_item × count) maps to a measure/fact.

3. **Feed facts.** Generate events from the playground (`npm run dev -w playground`,
   call `RuntimeScope.identify()` + `track('geocode', {count: N})`), or synthesize
   a fixture matching `analytics_rollups.rs` test data. Load events as facts into
   the cube (events per `anonId × feature × time`, carrying `count`).

4. **Verify against the SQL oracle.** Pick a fixture, compute `value`/`hours` by
   the SQL formula (or by hand), and assert the cube's consolidated cells match —
   by role, by feature, total. **This is the pass/fail gate.**

5. **Exercise the differentiators:**
   - `trace` a cell (`value[role=Specialist]`) → confirm the dependency chain back
     to baselines/rates/events (the methodology audit trail).
   - `whatif`: change a baseline `manual_min` → confirm value recomputes (the
     baselines-page edit + >20% submission preview).
   - **Forecast:** use a fitted model to project next-quarter hours/value; compare
     to the projections-page need (proj vs actual, % to goal).
   - **Narrative:** render one compare-page insight via `mc-narrative` (e.g.
     "<top app> leads at $Xk; <app> is the only one down −N%").

6. **Integration probe.** Stand up `mc-daemon`; POST facts + GET computed cells
   over its HTTP API; measure round-trip latency + the wiring effort. Separately
   note the **library-crate** cost (build-time/size if `mc-core`+`mc-model` were a
   dep). Recommend sidecar vs library.

## Success criteria (the bar)

- ✅ Cube `value`/`hours` **match the SQL oracle** on the fixture (by role, feature,
  total).
- ✅ `trace` shows the full dependency chain; `whatif` recomputes value.
- ✅ A forecast + a narrative render from the cube.
- ✅ `mc-daemon` round-trip works, with a latency + effort number.
- ✅ A clear **go / no-go** for ADR-0013, and **sidecar vs library** recommendation.

If any of the first three fail or the effort is disproportionate → **no-go**: fall
back to ADR-0013 Alternative 2 (pure-SQL ROI), which ships regardless.

## Deliverables (report back into the repo)

1. `roi.yaml` (the cube model) — attach to this doc or `docs/research/`.
2. A **findings section appended here** (or `0006a-…`): the oracle-match result,
   trace/whatif/forecast/narrative outcomes, the daemon latency/effort, and the
   go/no-go + integration recommendation.
3. If **go:** a thin integration sketch (the `RUNTIMESCOPE_MOSAIC_URL` flag, the
   facts-POST + cells-GET shapes) to seed slice-3 implementation.

## Constraints / guardrails

- **No `runtimescope` dependency on Mosaic during the spike** — scratch dir or the
  Mosaic repo only.
- The **SQL ROI fallback is the default** regardless of outcome — build it first
  (it's also the cube's reference oracle).
- Keep `analytics.db` `baselines`/`roles` as the canonical input source (the cube
  reads from them; don't fork the rate/baseline data into YAML permanently).
