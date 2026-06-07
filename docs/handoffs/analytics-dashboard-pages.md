# Handoff — Analytics dashboard pages (prototypes → real React/Vite dashboard)

> **Goal:** convert the 9 static analytics prototypes in
> [`../ui-update/analytics*.html`](../ui-update/) into **real React pages** inside
> the production dashboard (`packages/dashboard`, Vite) that ships *embedded* with
> the collector (vendored by `build.rs` → served at `/dashboard`). The HTML files
> were design prototypes with **mock data + an isolated shell**; the real pages
> fetch the **live analytics endpoints** and reuse the dashboard's own components.
>
> **Read alongside this doc:** [`../specs/analytics-data-model.md`](../specs/analytics-data-model.md)
> — the data contract (every view → the data it needs, ROI formula, adoption
> denominators). That doc + this one are the full brief.

## The 9 prototypes → target pages

Create under `packages/dashboard/src/pages/analytics/<name>-page.tsx`, register in
`components/layout/page-router.tsx` (the `RUNTIME_PAGES` map, lazy import), and add
nav entries (see "Nav" below). Each row lists the **live endpoint(s)** and the
**not-yet-wired** bits to stub with a TODO.

| Prototype | Page | Live endpoints (exist now) | Not wired → TODO |
|---|---|---|---|
| `analytics.html` (hub) | `analytics-overview` | `GET /api/analytics/overview`, `/features`, `/roles`; recent-identifies via the live WS / `/users` | value-by-role $ & value-saved (3a, landing); survey panel + composer (`TODO(analytics-survey)`) |
| `analytics-users.html` | `analytics-users` | `GET /api/analytics/users` (+ `/users/{anonId}`); drill `?role=&feature=&seg=` | per-user `value`/`hours` $ (3a); per-user "Survey" button (`TODO(analytics-survey)`); KPI spark series (`TODO(analytics-kpi-spark)`) |
| `analytics-features.html` | `analytics-features` | `GET /api/analytics/features`, `/feature-trends` (daily series) | per-feature `value`/`timeSaved` $ (3a); feature-detail **top users** (`TODO(analytics-feature-topusers)` — not in `/features` yet) |
| `analytics-trends.html` | `analytics-trends` | `GET /api/analytics/trends`, `/feature-trends`, `/event-mix`, `/funnel`, `/cohorts` | cumulative-**value** series (3a); deploy/goal annotations (`TODO(analytics-annotations)`) |
| `analytics-compare.html` | `analytics-compare` | `GET /api/analytics/compare?by=role` and `?by=app` | `value`/`prevValue` $ (3a); the narrative "insight" line (`TODO(analytics-3b)` — Mosaic) |
| `analytics-baselines.html` | `analytics-baselines` | **3a (landing):** `GET/PUT /api/analytics/baselines`, `POST /baselines/submissions` + accept/dismiss, history | nothing extra once 3a lands; until then `TODO(analytics-3a)` |
| `analytics-projections.html` | `analytics-projections` | **3a (landing):** `GET/POST /api/analytics/projections` (targets; actuals live-derived) | forecast / forward projection (`TODO(analytics-3b)` — Mosaic fitted model) |
| `analytics-status.html` | `analytics-status` | **none** | whole page — uptime/incidents (`TODO(analytics-status)` — slice 5, no backend) |
| `analytics-admin.html` | `analytics-admin` | **none** (only anon reads exist) | de-anon table via `X-Admin-Key` (`TODO(analytics-admin)` — slice 6, no backend) |

**Endpoint envelopes:** list endpoints return `{ data: [...], count }`; singletons
return `{ data: {...} }`. All are auth-gated — see "Data layer" below. Exact field
shapes are in the spec + the handlers (`crates/collector-core/src/server.rs`,
`analytics_rollups.rs`).

## Data layer (how to fetch)

- Add analytics fetchers to **`packages/dashboard/src/lib/api.ts`** using the
  existing `get<T>(path, params)` helper — it already attaches the auth bearer
  (`authHeaders()`) and routes 401 → the login gate (`use-auth-store`). Don't
  hand-roll `fetch`.
- Reads return `{ data }` — `get<T>` unwraps `data` for list endpoints. For the
  object endpoints (`/overview`, `/funnel`, `/users/{id}`) add a small `getOne<T>`
  or read `.data` directly (mirror `pm-api.ts`).
- Windowed endpoints take `?window=7d|30d|90d|12w|12mo|all` (+ `?project_id=`,
  `?buckets=`, `?top=`, `?weeks=`). Respect the per-page presets in the spec.

## Reuse the dashboard's own UI (don't re-import the prototype shell)

- **Layout/nav/tokens already exist** — the real dashboard shares the prototypes'
  design language. Use `components/layout/*`, the CSS tokens in `index.css`, and
  the primitives in **`components/ui/`** (`gauge`, `sparkline`, `metric-card`,
  `data-table`, `filter-bar`, `badge`, `activity-feed`, `status-dot`, `tabs`,
  `empty-state`, `skeleton`, `export-button`, …). Do **not** copy `tokens.css` /
  `shell.js`.
- **Charts the prototypes use but the dashboard lacks** — `svgLineChart`,
  `donutChart`, `barChart`, `funnelChart`, `heatmap` (in `docs/ui-update/shell.js`).
  Port these into `components/ui/` as React components (`LineChart`, `DonutChart`,
  `BarChart`, `FunnelChart`, `Heatmap`) so all pages share them. `Sparkline` +
  `Gauge` already exist.
- **Swappable KPI rows:** the prototypes' `renderKpiRow` + `⋯` metric-swap →
  build a `<KpiRow pool={…} active={[…]} />` over the existing `MetricCard`. Note
  KPI cards want a `sparkData[]` + delta; the endpoints return scalars today →
  `TODO(analytics-kpi-spark)` (stub the spark from `/trends` buckets or omit).

## Nav

`components/layout/rail.tsx` defines the rail groups (`RUNTIME_RAIL_ITEMS`, etc.).
Add an **Analytics** section (its own rail group or a sub-context like the runtime
view) with the 8 sub-pages (overview/users/features/trends/compare/baselines/
projections + the two stubbed: status/admin). Wire the ids into `RUNTIME_PAGES`
in `page-router.tsx`. Mirror how the runtime sub-tabs work (`activeTab`/
`activeView` in `use-app-store`).

## TODO convention (greppable)

For anything the UI shows that has **no backend yet**, render a clear empty/
"coming soon" state **and** drop a tagged comment so we can grep:

```tsx
// TODO(analytics-3b): forecast line — no backend (ADR-0013 Mosaic sidecar, not wired)
// TODO(analytics-survey): survey results/composer — slice 4 not built
// TODO(analytics-status): uptime/incidents — slice 5, no endpoints
// TODO(analytics-admin): de-anon table needs X-Admin-Key — slice 6 not built
// TODO(analytics-3a): $ value/hours — landing in slice 3a (SQL ROI), wire when live
// TODO(analytics-feature-topusers): /features doesn't return per-feature top users yet
// TODO(analytics-kpi-spark): KPI sparkData/delta not returned by endpoints yet
// TODO(analytics-annotations): deploy vlines / goal hlines source not built
```

**Tag taxonomy** (so `grep -rn "TODO(analytics-" packages/dashboard` lists the gaps):
`analytics-3a` (ROI, landing soon) · `analytics-3b` (Mosaic forecast/trace/
narrative) · `analytics-survey` (slice 4) · `analytics-status` (slice 5) ·
`analytics-admin` (slice 6) · `analytics-feature-topusers` · `analytics-kpi-spark`
· `analytics-annotations`. Don't invent silent placeholders — every fake/absent
value gets a tag + a visible empty state.

## Guardrails / done criteria

- **No mock data in shipped components** (the drift detector flags it):
  `node scripts/detect-ui-drift.mjs` must stay green, and every `/api/...` you call
  must be a real route (the wired ones above are; stubbed pages call nothing).
- `npm run build -w packages/dashboard` clean (tsc + vite). The dashboard is
  embedded by `build.rs`, so a `cargo install --path crates/cli` re-embeds it.
- Auth: pages must work both with auth off (local) and on (the login gate handles
  the token; just use `api.ts`).
- Keep PII off the client: the admin de-anon page is the *only* one that would
  ever show email/ip, and its backend doesn't exist yet — stub it.

## Status of the backend (so you know what's real)

- **Live now (slices 1-2):** identify, roles, overview, users (+detail), features,
  trends, feature-trends, event-mix, cohorts, funnel, compare (role+app) — all
  **usage** metrics, no `$`.
- **Landing now (slice 3a, in progress):** `$` value/hours across those, plus
  baselines (GET/PUT + submissions + history) + projections. Wire these as they
  merge (grep `TODO(analytics-3a)`).
- **Not built:** Mosaic forecast/trace/narrative (3b, ADR-0013), surveys (slice 4),
  uptime/status (slice 5), admin de-anon (slice 6).
