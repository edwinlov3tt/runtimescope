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

---

# Findings (spike executed 2026-06-07)

> **Verdict: GO for ADR-0013.** A Mosaic cube reproduced the ROI `value`/`hours`
> rollups **exactly** against the SQL-formula oracle (14/14), and `trace`,
> `whatif`, a fitted-model forecast, and an `mc-narrative` insight all delivered
> the things SQL won't. The `mc-daemon` round-trip is **sub-millisecond** on
> loopback. **Integration recommendation: `mc-daemon` sidecar (primary), library
> crate as the documented fallback.** The pure-SQL ROI fallback still ships as the
> batteries-included default regardless.
>
> All artifacts are reproducible under [`0006-mosaic-spike/`](./0006-mosaic-spike/):
> `roi.yaml` (the cube), `oracle.py` (the SQL-formula reference + CSV generator),
> `roi.inputs.csv` (facts), plus `roi-forecast.yaml` (forecast) and
> `roi-compare.yaml` + `narratives/` (narrative). Spike worked in `/tmp/mosaic-spike`
> (Mosaic clone + scratch cube); **nothing was added as a `runtimescope` dependency.**

## 0. Setup

- Cloned `github.com/edwinlov3tt/mc-v2`, `cargo build --release` → clean
  (`mc` binary, 56 MB; host Rust 1.95, repo pins 1.78 — built without issue).
  731 tests green per the repo's own HANDOFF.
- Learned the surface: `mc demo`, `mc model {validate,test,query,trace,whatif,
  narrate}`, `mc up/down/status` (daemon). Coord syntax `Dim=Elem,…` for
  `--coord`/golden tests; `--where` is leaf-only with `==`.

## 1. Oracle-match gate — ✅ PASS (14/14)

Fixture (`oracle.py`, mirrors the `analytics_rollups.rs` A/B/C × geocode/export
spine, extended with `count`, `app`, baselines, role rates):

| dim | baseline / rate |
|---|---|
| geocode | manual 8 / tool 2.4 / **per_item** |
| export | manual 15 / tool 5 / per-use |
| Specialist (A,B) | $50/hr · Director (C) | $85/hr |

`oracle.py` computes `value`/`hours` straight from the spec formula; the cube
encodes the **same** numbers as `golden_tests`. `mc model test roi.yaml`:

```
PASS role_specialist_value   expected 171.666667  actual 171.66666666666666
PASS role_director_value     expected  14.166667  actual  14.166666666666666
PASS feature_geocode_value   expected 163.333333  actual 163.33333333333331
PASS feature_export_value    expected  22.5        actual  22.5
PASS app_web_value           expected  92.5        actual  92.5
PASS app_cli_value           expected  93.333333  actual  93.33333333333333
PASS time_{jan,feb,mar}_value …
PASS total_value             expected 185.833333  actual 185.83333333333331
PASS total_hours             expected   3.6        actual   3.5999999999999996
Goldens: 14/14 passed, 0 failed
```

The cube matches the SQL oracle **to f64** by role, feature, app, time, and total.

### Cube design (the part that decides fit)

- Dims `[Scenario, Version, User, Feature, Role, App, Time, Measure]`; each of
  User/Feature/Role/App/Time has an `All_*` consolidation root; Time rolls
  months → `Q1_2026`/`Q2_2026`.
- Input measures `events, items(=Σcount), manual_min, tool_min, per_item,
  hourly_rate`; derived `qty, time_saved, hours, value` via 4 `AllLeaves` rules:
  `qty = per_item*items + (1-per_item)*events`; `time_saved=(manual_min-tool_min)*qty`;
  `hours=time_saved/60`; `value=hours*hourly_rate`.
- **The (user,role) coupling is free:** a user's facts only populate its own
  role's leaves, so the Role rollup sums the right users automatically — the
  spec's "acting user's role rate" caveat falls out of the cube geometry.
- **Empty leaves are free:** the cartesian product has ~200 zero-event leaves;
  they poison to `Null`, and `Sum` consolidation treats `Null` as 0
  (engine-semantics I-Cons-3), so rollups stay exact with no padding.
- **One wrinkle — baseline/rate broadcast.** `manual_min`/`tool_min`/`hourly_rate`
  are per-feature / per-role constants but must sit on every event's leaf, so
  `oracle.py` denormalizes them onto each leaf row at fact-load. Mosaic rules read
  the *current* coordinate (no cross-coordinate `measure@OtherElem` ref was used),
  so this is the simplest correct shape. Consequence for `whatif` on a baseline:
  see §3.

## 2. `trace` — ✅ full audit chain ("every dollar → a logged action")

Leaf `value` trace (`A/geocode/Specialist/web/2026_01 = 46.67`) is the
methodology-defensibility play, intact:

```
value = 46.67
├── hours = 0.933  → time_saved = 56
│       ├── manual_min = 8 (input)
│       ├── tool_min  = 2.4 (input)
│       └── qty = 10  ├── per_item = 1 (input)  ├── items = 10 (input)  └── events = 1 (input)
└── hourly_rate = 50 (input)
```

Tracing the **consolidated** `value[Role=Specialist]=171.67` shows the
`Consolidation × leaves` rollup (every contributing leaf, with empties as `null`).
SQL gives you the number; only the cube gives you the provenance tree.

## 3. `whatif` — ✅ live recompute, no persist

`mc model whatif … --set "…Feature=geocode…Measure=manual_min=12" --show time_saved,hours,value`:

```
Override: 8 → 12
  time_saved  56 → 96   (+40)
  hours       0.933 → 1.6
  value       46.67 → 80 (+33.33)
```

This is the baselines-page edit / >20%-submission preview, computed in-memory.
**Caveat from the broadcast model (§1):** `whatif`/`/write` set *one leaf cell*,
and `whatif --show` reads at the override's coordinate. To preview a baseline edit
across *all* of a feature's usage (the consolidated total), the integration must
either (a) override every leaf of that feature (the `--set` flag is repeatable;
the daemon `/whatif` takes an `overrides[]` array), or (b) post the baseline as a
single per-feature input cell and have the rule read it cross-coordinate (a
Mosaic-side modelling improvement worth one follow-up spike). Option (a) works
today and is what the collector would do.

## 4. Forecast — ✅ renders (4/4), with an honest data caveat

`roi-forecast.yaml`: a `fitted_models` linear trend (`predict("roi_trend",
period_index)`, coefficients least-squares-fit offline in the sklearn-export
style) projects **cumulative** ROI value forward a quarter:

```
proj Apr=273.89  May=343.47  Jun(EOQ2)=413.06   pct_to_goal(@ $400)=103.3%   4/4 golden
```

This is exactly the projections page (proj value, % to goal, variance vs actual).
**Caveat:** fit on 3 months → the *monthly* trend goes negative (one down month);
the cumulative framing is sensible but the real signal is "forecasting needs
accumulated history," which matches the spec's thin-data threshold. The
*mechanism* (fitted model → projection cells, from the cube) is proven.

## 5. Narrative — ✅ compare-page insight renders

`roi-compare.yaml` (per-app current `value` + prior-period `prev_value`, the
Compare page's contract) + an `mc-narrative` template →

```
cli leads ROI value at $93 this period. 1 of 2 apps are down vs the prior period: web.
```

…with structured evidence (`{n_down:1}`) in the JSON output. The engine is
period/element-series based (`current`/`prev`/`max.value.period`,
`names_where(value < prev_value, App)`), which maps cleanly onto the
compare/trends views.

## 6. Integration probe — `mc-daemon` sidecar

Stood up `mc up --workspace … --port 6790 --api-key …` over a one-file
`workspace.yaml`. Bearer-gated `/api/v1/{query,write,trace,whatif,sweep,reload,
health,status,cubes}`.

- **Computed-cell GET** (`POST /query`, `where`+`show`) returns oracle-exact
  cells (`value 185.83 / hours 3.6`).
- **Round-trip latency (loopback, warm, n=20):** **min 0.31 ms · median 0.32 ms ·
  mean 0.34 ms · max 0.47 ms.** Negligible vs an event-rollup SQL query.
- **POST-fact → recompute** (`POST /write` `manual_min` 8→12 → `dirty_count:8,
  revision_after:31` → re-`/query` total → **219.17 / 4.27**, exactly as predicted)
  — dirty-tracking recompute works over the wire.
- `trace` (JSON tree, `schema_version 1.1`) and `whatif` (`overrides[]`, no
  persist) are also exposed over HTTP. Graceful `mc down`; write journal +
  monotonic revision give crash recovery.
- **Wiring effort:** ~30 min — write `workspace.yaml`, `mc up`, then plain JSON
  POSTs. No client SDK needed.

### Sidecar vs library

| | **`mc-daemon` sidecar** | **library crate (`mc-core`+`mc-model`+`mc-narrative`)** |
|---|---|---|
| Build cost | use prebuilt `mc` binary (56 MB, bundles duckdb/tessera) | **8.2 s clean build, 43 crates, no duckdb, ~3 MB rlib** |
| Latency | ~0.3 ms loopback round-trip | in-process (≈0) |
| Coupling | pinned `/api/v1` HTTP contract; separate process | **cross-repo Rust dep + toolchain coupling** (Mosaic pins Rust 1.78 via `rust-toolchain.toml`); release lock-step |
| Ops | one extra process (flag-gated; SQL fallback if absent) | none |
| Precedent | **matches ADR-0007 Playwright sidecar** | — |

**Recommendation: sidecar primary.** The latency is trivial, it matches the
existing sidecar pattern, it keeps the collector's build/toolchain fully
decoupled from Mosaic's (the 1.78 pin vs runtimescope's toolchain is a real
hazard for the library path), and it already ships `query/write/trace/whatif/
reload` over a versioned HTTP API with a journal. The library path is genuinely
cheap (8 s, no native deps) — keep it documented as the fallback if the extra
process ever proves awkward, per ADR-0013 Alternative 1.

## 7. Go decision + what to build (slice 3)

**GO.** All five success-bar items met (oracle 14/14; trace; whatif; forecast +
narrative render; daemon round-trip with a latency + effort number). Build SQL ROI
as the always-on fallback/oracle first, then layer Mosaic behind the flag.

Thin integration sketch to seed slice-3:

- **Flag:** `RUNTIMESCOPE_MOSAIC_URL` (+ `RUNTIMESCOPE_MOSAIC_KEY`). Absent ⇒ SQL
  ROI fallback (no forecast/trace/narrative). Present ⇒ collector posts facts +
  reads cells.
- **Facts POST** (collector → daemon, per `anonId×feature×role×app×time` rollup
  row, baseline+rate denormalized on):
  `POST /api/v1/write {cube:"roi", coord:[Scenario,Version,User,Feature,Role,App,Time,Measure], value}`
  — one call per input measure per leaf, **or** regenerate the cube CSV and
  `POST /api/v1/reload`. *(A batch-ingest endpoint would cut N calls to 1 — worth
  requesting upstream.)*
- **Cells GET:** `POST /api/v1/query {cube:"roi", where:{…dims…}, show:["value","hours"]}`
  → `{results:[{coord, values:{value,hours}}]}` (used directly by
  overview/users/features/roles/compare).
- **Trace** behind the ROI numbers: `POST /api/v1/trace {cube, coord:[…]}`.
- **Baselines/roles** stay canonical in `analytics.db` (slice 1); the collector
  projects them onto the posted facts — the cube does **not** own that data.

### Follow-ups surfaced

1. Per-feature/per-role **single-cell baseline input** (cross-coordinate rule
   read) to make a baseline `whatif` a one-cell edit instead of a per-leaf
   re-broadcast. One small Mosaic-side spike.
2. **Batch fact-ingest** daemon endpoint (vs N `/write` calls or full `/reload`).
3. Forecast quality needs accumulated history; gate the projections UI on the
   spec's thin-data threshold.
4. Minor authoring friction: YAML safe-subset rejects `*` in folded scalars and
   unknown `fitted_models.metadata` keys — document for the slice-3 authors.
