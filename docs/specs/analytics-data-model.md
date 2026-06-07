# Spec — Analytics subsystem data model (what the prototypes need)

> Companion to [ADR-0012](../decisions/0012-analytics-adoption-subsystem.md) and
> [research 0005](../research/0005-analytics-adoption-subsystem.md). Derived by
> reading every prototype in [`../ui-update/analytics*.html`](../ui-update/)
> (overview, users, features, baselines, projections, status, admin, trends,
> compare) and cataloguing the data each view renders. This is the contract the
> backend (collector tables + HTTP routes + MCP tools) must satisfy to render the
> real UI with live data — no mock arrays.

> **Tenancy:** single-org by design — workspace keys are organizational, not
> per-project read isolation; ROI baselines/role-rates are global (one methodology
> per deployment); only *surveys* are workspace-scoped. See ADR-0012 §"Tenancy model
> (and its limits)" for the accepted limitation + the future isolation slice.

## Core entities (analytics.db — sibling of pm.db, ADR-0012)

| Entity | Fields (from the prototypes) | Notes |
|---|---|---|
| **user** (anon) | `anon_id` (e.g. `A3F7`), `role`, `consent` (bool), `first_seen`, `last_seen` | dashboard reads ONLY this (no PII) |
| **user_pii** (restricted) | `anon_id` → `email`, `ip`, … | admin-token only; the de-anon join (admin page) |
| **role** | `role`, `hourly_rate` ($/hr) | rates: Coordinator 40, Specialist 50, DCM 55, Account Exec 65, Director 85 |
| **baseline** | `fn`, `manual_min`, `tool_min`, `per_item` (bool), `rate` (display approx — see §Baselines), `uses`, `source` (`admin`\|`crowd`), `updated_at` | + `baseline_history` + crowd `baseline_submissions`. `updated_by` is backend-added — the prototype only shows a relative `updated` time. |
| **projection** | `quarter`, `proj_hours`, `proj_value`, `actual_hours`, `actual_value` | variance/pct derived |
| **survey** | def (title, prompt, options/scale) + `survey_responses` (option → count, NPS) | rendered via the `show_survey` command channel |
| **monitored_app** | `id`, `name`, `url`, `state` (up\|degraded\|down), `uptime_pct`, `resp_ms`, `last_check` | + `uptime_checks` (strip history) + `incidents` — slice 5 |

The **usage event** spine is the existing `custom` event (`collector.db`), stamped
after `identify()` with `anonId` + a `feature` (the event name/"function") + `app`
+ optional `count` metadata. All rollups below are SQL over that stream joined to
the tables above — not new stored aggregates.

## User populations + adoption denominators (read this before computing `adoption %`)

Three **distinct** sets — do not conflate them. The prototypes are loose here: the
Trends funnel labels 459 as **"Identified"** while the Adoption KPI labels the same
459 as **"invited"**. Treat them as one outer set for now, but **name it
consistently** (recommend `invited`):

- **invited / identified** (e.g. **459**) — everyone the SDK has seen / `identify()`-ed.
  The funnel's first step AND the overall-adoption denominator.
- **active / activated** (e.g. **312** = MAU) — used ≥1 feature in the window.
- **feature users** — distinct users of a single feature.

Two different ratios fall out, with **different denominators**:

- **Overall adoption = active / invited** → 312 / 459 = **68%** (Overview + Trends
  "Adoption %" KPI).
- **Feature adoption = feature_users / active** → e.g. 248 / 312 = **79%** (Features
  page + Overview per-feature column). It is **NOT** `feature_users / invited`
  (248/459 = 54% would be wrong).

## Per-view data requirements

### Overview (`analytics.html`) — the hub
- **KPI cards:** Active Users, Adoption % (= active / invited), Hours Saved (hrs), Value Saved ($).
- **Value by Role:** per role → `users`, `hours`, `value = hours × rate`, color.
- **Recent identifies (live):** stream of `{anon_id, role, ts}` — feed off the
  `session_connected`/identify events over the dashboard WS.
- **Feature adoption table:** per feature → users, events, adoption %, time saved,
  value, trend sparkline (mirrors the Features page).
- **Survey results:** NPS score + segment split; per-option `{label, pct, count}`.
- **Survey composer → end-user popup:** builds a survey def; "send" = a
  `show_survey` command to connected SDKs (ADR-0012 slice 4).

### Users (`analytics-users.html`)
- **KPI pool (swappable):** Total Users, New Users, Avg Value/User, Hours Saved,
  Consent Rate, Active Today (DAU), Avg Sessions — each `{value, sparkData[], change}`.
- **User table:** `anon_id, role, sessions, events, value, hours, last_seen, consent`.
- **User detail:** `top` features `[[feature, score]]`, recent `evs`
  `[[feature, color, relTime]]`, first/last seen, rate, features count.
- **Drill-down filters:** `?role=`, `?feature=`, `?seg=` (activated / repeat≥N
  sessions / power=weekly-active) → all server-filterable.

### Features (`analytics-features.html`)
- Per feature: `feature, app, users, events, adoption %, time_saved, value, trend`,
  status class (core/growing/niche by adoption).

### Trends (`analytics-trends.html`)
- 12-bucket time series (configurable 7d/30d/12w/12mo) for **users** (MAU/WAU/DAU
  series), **events** (volume), **value** (cumulative). Annotations: deploy
  **vlines** (version markers) + a value-goal **hline**. → needs day-bucketed
  rollups (distinct anon_id per window for DAU/WAU/MAU) + a deploys source.

### Compare (`analytics-compare.html`)
- Period KPIs **current vs previous**: Active Users, Events, Value Saved (+hours),
  Adoption. Per-**app** and per-**role** aggregates: `users, events, value (+prev),
  hours, share`, 12-pt trend. → grouped rollups with a prior-period comparison.

### Baselines (`analytics-baselines.html`)
- Table: `fn, manual_min, tool_min, per_item, saved/use, value, source, updated`.
- Crowd **submissions** panel; flag when a submission diverges >20% from the
  official baseline (research 0005). Editable (PUT) with history.

### Projections (`analytics-projections.html`)
- Per quarter: `proj_hours, actual_hours, proj_value, actual_value` → variance, %.

### Status (`analytics-status.html`) — slice 5
- Monitored apps: `name, url, uptime %, resp ms, last check, state`, uptime strip;
  incidents list.

### Admin (`analytics-admin.html`) — restricted
- De-anon table: `anon_id, email, role, rate, ip, consent, first_seen, last_seen`.
  **Admin-token gated** (the PII boundary).

## ROI formula (baselines + roles + events) — research 0005
```
time_saved(event) = (baseline.manual_min − baseline.tool_min) × (per_item ? meta.count : 1)
value(event)      = (time_saved / 60) × role.hourly_rate
```
Roll up by user / feature / role / app / time bucket for every view above.

**Hours saved** is the canonical time metric: `hours = Σ time_saved(event) / 60`,
rolled up the same way as value. ⚠ The prototypes' mock hours are **illustrative and
do not reconcile across pages** (APP Σ≈1,241h, ROLE Σ≈1,887h, headline ≈1,840h) —
the real rollup derives one consistent number from the event stream.

## Proposed surface (mirrors pm/)

**HTTP (dashboard):** `/api/analytics/overview`, `/users` (+`/{anonId}`),
`/features`, `/roles`, `/trends?metric=&window=`, `/compare?by=app|role&period=`,
`/baselines` (GET/PUT) + `/baselines/submissions` (POST), `/projections`
(GET/POST), `/status` (slice 5), `/admin/users` (admin-token), `/surveys`
(GET/POST) + `/surveys/{id}/responses`.

**MCP tools** (envelope `{summary,data,issues,metadata}`): `get_adoption_metrics`,
`get_feature_usage`, `get_user_funnel`, `get_roi_report`.

**SDK:** `identify({email, role, consent})` → anon id; existing `track(name, props)`
stamped with the anon id; `show_survey` command (slice 4).

## Additional props (round 2 — full read of all 8 sub-prototypes)

Things the first pass missed, by page. These are the data the real views need.

### Cross-cutting (every page)
- **KPI cards carry a `sparkData[]`** (≈6-pt mini-series) + `change`/`changeDir`
  (up/down/neutral) + `footerLabel`/`footerExtra` — not just a current value. So
  every KPI needs a short trend series + a prior-period delta, not a scalar.
- **Swappable KPI rows:** each page defines a *pool* of ~6-7 metrics; the `⋯`
  menu swaps which 4 show. → KPI endpoints return the whole pool, not 4 fixed.
- **Window + scope filters everywhere:** date presets — a per-page subset of
  `7d/30d/90d/12w/12mo/all` (Overview/Features: 7d/30d/90d/All; Trends: 7d/30d/12w/12mo;
  Compare uses current/prior period chips, not presets) + app/category pills (`?app=`)
  + the existing `?role=/feature=/seg=` drill-downs.
  Every aggregate endpoint takes a window + optional app/role/feature filter.
- **Explicit UI states:** loading / **empty** ("once your app calls
  `RuntimeScope.identify()`…") / **thin** ("meaningful around ~50 users") / error.
  The envelope should distinguish *no data* from *too little data* (a thin-data
  threshold) so the UI can show the right state.
- **CSV export** on most pages (trends, compare, users, features, projections) —
  support server-side CSV or document client-side from the JSON.
- **Annotations + goals:** charts render deploy **vlines** (version markers, e.g.
  `v2.0` at a week index) and goal **hlines** (`MAU goal 300`, `$100k goal`). Need
  a deploys/annotations source + configurable goals per metric.

### Trends — additional charts (each its own data shape)
- **Event Mix donut:** event counts **by eventType** (custom/track, ui, network,
  console, error) + total.
- **Events by Feature / week:** stacked weekly series — top-N features + `other`.
- **Activation funnel:** `Identified → Activated (used a feature) → Repeat (≥2
  sessions) → Power user (weekly active)` with counts + drill links (`?seg=`).
  **Overall-adoption denominator = invited/identified (459)**, numerator = activated
  (312). This is the *overall* adoption ratio — distinct from **feature adoption**
  (denominator = active 312; see "User populations" above). The prototype labels 459
  "Identified" here but "invited" on the KPI — same set; pick one name.
- **Cohort retention heatmap:** per signup-week cohort → `size` + `W0..W6` % still
  active (triangular; null for future weeks).
- KPIs: MAU, DAU, **WAU/MAU stickiness**, **Events/day (7-day avg)**, Adoption
  (% of invited), Value, Hours.

### Compare — prior-period machinery
- Three modes: **Period** (current vs prior), **Apps**, **Roles**.
- Needs **two windows** (current + prior, e.g. "May 30d" → "Apr 30d") and returns
  both: per-entity `users/events/value/hours` **plus** prior-period counters —
  **apps** carry `prevUsers/prevEvents/prevValue` (`usersP/eventsP/prevValueK`), but
  **roles carry only `prevValue`** (`prevValueK`; the roles table deltas value only,
  no prev users/events). Derived client-side: top-by-value, most-improved (ratio,
  filtered to meaningful volume ≥$5k), declining (`value < prev`), share-of-total, ranked.
- Per-mode CSV columns differ (period: `*_cur/_prev`; entity: `valueK/prevValueK`).

### Users — additions
- **Per-user "Survey" button** → a *targeted* `show_survey` to one `anon_id`
  (slice 4 must support targeting, not just broadcast).
- Detail field **"Value attributed"** (the user's ROI sum), `top` features with
  per-feature score, recent `evs` with relative time.

### Features — additions
- Per feature: **`perUse`** (avg time/use, e.g. `2.4m`), **`dau[]`** (daily usage,
  ~10d), **`topUsers` `[[anon_id, uses]]`**, **`status`** (core/growing/niche by
  adoption threshold), `app`, `trend[]`, `color`.
- **Feature adoption % = feature users / ACTIVE users** (≈312, NOT invited 459 —
  e.g. 248/312 = 79%; 248/459 = 54% would be wrong). App-filter pills.
- Detail links: top users → `users?feature=`, baseline → `baselines` (feature
  surfaces its own baseline: manual→tool, per-item).

### Baselines — the ROI editing surface
- **Crowdsourced submissions:** `{fn, anon_id, est_manual_min, current}` with a
  **>20% divergence flag**; per-submission **Accept / Dismiss** mutations.
- **Per-baseline history timeline** (`title, desc, time` — the audit trail UI).
- **`uses` count** per baseline (from events); **confirmed/locked** state
  (`Confirmed 6/8`); **avg time saved weighted by uses** KPI.
- Actions: New baseline, inline edit manual/tool (PUT), per-item toggle.
- ⚠ **Rate source:** the baseline page multiplies by a single per-`fn` `rate`, but
  canonical ROI sums **per event by the acting user's role rate**. Treat the
  per-fn rate as a display approximation; the real `get_roi_report` joins each
  event's user → role → rate.

### Projections — additions
- New-projection form: `quarter, proj_hours, proj_value, **notes**` (+ `set_by`,
  e.g. Director). **Actuals are computed LIVE** from baselines × usage for the
  quarter window — *not* stored/entered. (Revisit `analytics_projections.actual_*`:
  treat as a derived cache or drop; the prototype states "no manual entry".)
- KPIs: Target Hours, Actual Hours (% of goal), Projected/Actual Value, % to Goal,
  Value Variance (actual − projected).

### Admin — the PII gate specifics
- Dedicated **`X-Admin-Key`** header (separate from the workspace bearer) — the
  reveal/de-anon gate.
- **Admin login audit:** count, failed count, rate-limited (a `login_attempts`
  table) — surfaced as an "Admin Logins" KPI.
- **PII export is consented-only** (the export button filters to `consent = true`).

### Status (slice 5) — monitoring mechanics
- **`monitored_apps`:** `id, name, url, state (up|degraded|down), uptime_pct,
  resp_ms, last_check`, + an **SDK hourly heartbeat** (last heartbeat + missed
  count) AND an **active probe every 60s** (hits the app URL/`/heartbeat`).
- **`uptime_checks`:** 60-day daily status strip (0 up / 1 degraded / 2 down).
- **`incidents`:** `app, status (ongoing|resolved), started, duration, type`
  (e.g. "No heartbeat (3 missed)", "Slow response (512ms > 400ms)", "503 on
  /heartbeat", "Deploy lock"), severity.
- Thresholds: slow response **>400ms → degraded**; **N missed heartbeats → down**.
- Actions: "Check all now" (force probe), "Monitor app" (add). KPIs: Apps
  Monitored (+healthy), Overall Uptime (90-day), Active Incidents (down/degraded),
  Avg Response (healthy only), Healthy N/total, Incidents (30d, resolved).

## Slice plan (ADR-0012)
1. **Identity** — `analytics.db` + `analytics_users`/`_pii`/`_roles`, SDK
   `identify()`, anon-id stamping. Unblocks everything.
2. **Adoption rollups** — users/features/roles/trends/compare endpoints + MCP
   tools (pure SQL over the event stream). Renders overview, users, features,
   trends, compare.
3. **ROI engine** — baselines (+history+submissions) + projections + the value
   formula. Renders baselines, projections, and the $ in every view.
4. **Survey** — `show_survey` command + composer + responses. Renders survey UI.
5. **Uptime** — monitored apps + checks + incidents. Renders status.
6. **Admin/PII** — de-anon endpoints behind an admin token; the Clarity/GA4 bridge.
