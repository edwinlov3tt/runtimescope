# Spec — Analytics subsystem data model (what the prototypes need)

> Companion to [ADR-0012](../decisions/0012-analytics-adoption-subsystem.md) and
> [research 0005](../research/0005-analytics-adoption-subsystem.md). Derived by
> reading every prototype in [`../ui-update/analytics*.html`](../ui-update/)
> (overview, users, features, baselines, projections, status, admin, trends,
> compare) and cataloguing the data each view renders. This is the contract the
> backend (collector tables + HTTP routes + MCP tools) must satisfy to render the
> real UI with live data — no mock arrays.

## Core entities (analytics.db — sibling of pm.db, ADR-0012)

| Entity | Fields (from the prototypes) | Notes |
|---|---|---|
| **user** (anon) | `anon_id` (e.g. `A3F7`), `role`, `consent` (bool), `first_seen`, `last_seen` | dashboard reads ONLY this (no PII) |
| **user_pii** (restricted) | `anon_id` → `email`, `ip`, … | admin-token only; the de-anon join (admin page) |
| **role** | `role`, `hourly_rate` ($/hr) | rates: Coordinator 40, Specialist 50, DCM 55, Account Exec 65, Director 85 |
| **baseline** | `fn`, `manual_min`, `tool_min`, `per_item` (bool), `source` (`admin`\|`crowd`), `updated_at`, `updated_by` | + `baseline_history` + crowd `baseline_submissions` |
| **projection** | `quarter`, `proj_hours`, `proj_value`, `actual_hours`, `actual_value` | variance/pct derived |
| **survey** | def (title, prompt, options/scale) + `survey_responses` (option → count, NPS) | rendered via the `show_survey` command channel |
| **monitored_app** | `id`, `name`, `url`, `state` (up\|degraded\|down), `uptime_pct`, `resp_ms`, `last_check` | + `uptime_checks` (strip history) + `incidents` — slice 5 |

The **usage event** spine is the existing `custom` event (`collector.db`), stamped
after `identify()` with `anonId` + a `feature` (the event name/"function") + `app`
+ optional `count` metadata. All rollups below are SQL over that stream joined to
the tables above — not new stored aggregates.

## Per-view data requirements

### Overview (`analytics.html`) — the hub
- **KPI cards:** Active Users, Adoption %, Time Saved (hrs), Value Saved ($).
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
