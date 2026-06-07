# Research 0005 — Analytics & adoption subsystem (port of the `kpis` platform)

> Requested 2026-06-01, after v0.11.0 shipped (Rust is now the implementation;
> the Node collector/mcp-server were deleted in M7). Goal: assess how to bring a
> robust **product-analytics + ROI reporting** system — modelled on the user's
> existing `~/kpis` platform — into RuntimeScope: real end-users, usage/adoption
> data, ROI, and an in-app survey/identity popup. This doc catalogs the `kpis`
> design, maps it onto RuntimeScope's current architecture, and recommends an
> approach + a batteries-vs-BYO posture. A UI prototype lands in parallel under
> [`../ui-update/analytics.html`](../ui-update/analytics.html).
>
> Sources: `~/kpis/{sdk,worker,dashboard,docs}`, `~/kpis/worker/migrations/*.sql`,
> `~/kpis/docs/analytics-integration-feasibility.md`; RuntimeScope
> `packages/sdk/src/index.ts`, `crates/collector-core/src/{event.rs,pm_store.rs,server.rs,command.rs}`.

## TL;DR

- **What's being asked for is a product-analytics *identity layer* on top of
  RuntimeScope's runtime-observability core.** `kpis` tracks the *people who use
  an app*; RuntimeScope tracks *an app's runtime* for developers. That's the one
  framing that drives every decision below.
- **~70% of the plumbing already exists in RS** — event ingest, SQLite
  persistence, projects/workspaces/API keys, three SDKs, an embedded dashboard,
  a `custom` event type, and `RuntimeScope.track()`. The genuinely new work is an
  **identity model**, an **ROI/baseline model**, **adoption rollups**, and a
  **survey UI**.
- **The survey/identity popup is *easier* in RS than in `kpis`** because RS
  already has a server→SDK **bidirectional command channel** (the thing that
  drives `capture_dom_snapshot`). A survey is just a new command.
- **Posture: batteries-included by default, BYO as escape hatches.** Keep the
  self-hosted collector + SQLite + embedded dashboard as the zero-dependency
  default (RS's differentiator); expose a swappable store for self-hosters who
  outgrow SQLite, and an optional Clarity/GA4/GTM bridge for teams already living
  there.

## What the `kpis` system is (architecture)

A product-analytics + ROI platform for internal tools, in four deployable parts:

| Part | Tech | Role |
|---|---|---|
| **SDK** (`sdk/sdk.js`, ~730 LOC) | zero-dep browser JS, served by the Worker as `/sdk.js` | identity prompt, `trackUsage()`, `trackTimed()`, hourly heartbeat, optional Clarity/GA4/GTM bridge |
| **Identity/survey popup** (`sdk/popup.html` + `worker/src/assets-content.js`) | sandboxed `<iframe srcdoc>` + `postMessage` | collects email/role/consent; baseline-estimate survey submissions |
| **Worker API** (`worker/src/index.js`, ~1.68K LOC) | Cloudflare Worker + **D1** (SQLite) | ~30 routes (below) |
| **Dashboard** (`dashboard/`) | Next.js 15 on the Ecme admin template, NextAuth, ApexCharts | pages: home, tools, users, baselines, projections, status, admin |

### The data model (D1 — `worker/migrations/000{1..4}_*.sql`)

- `users` — PII (email, role, `hourly_rate`, `ip_address`, `consent_given`, `preferences`)
- `user_mapping` — anonymized IDs (`USER_A3F7`) so the dashboard never touches PII
- `usage_events` — the event spine: `user_id, tool, function, session_id, metadata(JSON), timestamp`
- `baselines` (+ `baseline_history` + crowdsourced `user_baseline_submissions`) — the ROI engine
- `roles` — role → `hourly_rate`
- `projections` — manager goals (quarterly hours/value targets)
- `clarity_sessions`, `tool_analytics_config` — third-party linkage
- `monitored_apps`, `uptime_checks`, `incidents` — uptime monitoring
- `login_attempts` — dashboard-auth rate limiting

### The two ideas worth stealing wholesale

1. **Anonymization split.** PII lives behind a service-role boundary; the
   dashboard reads only anonymous IDs. Privacy-by-construction, and it's the
   right default for any multi-user analytics product.
2. **ROI as a first-class, editable, *audited* data model.** `baselines` are
   not constants — they're rows with history and crowdsourced submissions:
   `time_saved = (baseline_min − tool_min) × (per_item ? metadata.count : 1)`,
   `value = time_saved × role.hourly_rate`. Plus a "three independent sources"
   credibility play (your DB + Clarity recordings + GA4) for defending the
   numbers to a skeptical manager.

### Worker route surface (the consumer contract, for parity if we port shapes)

`/identify` · `/seen` · `/preferences` · `/track` · `/stats/roi` · `/users/anonymous`
· `/baselines` (GET/PUT) · `/survey/baseline` · `/survey/submissions` · `/projections`
(GET/POST) · `/roles` · `/clarity/session(s)` · `/config/*` · `/admin/users` · `/health`
· `/heartbeat` · `/health/apps|probe|check-all|status|incidents` · `/auth/login|register`.

## What RuntimeScope already has (the 70%)

| `kpis` capability | RuntimeScope today | Gap |
|---|---|---|
| `trackUsage(fn, meta)` | ✅ `RuntimeScope.track(name, props)` → `custom` event (`event.rs:62` VALID_EVENT_TYPES; SDK `index.ts:433`) | none |
| event ingest + durable persist | ✅ collector + rusqlite WAL (`collector.db`) + ring buffer | none |
| projects / workspaces / API keys / sessions | ✅ `pm/` subsystem (`pm.db`, `pm_store.rs`) | none |
| multi-runtime capture | ✅ browser + server + workers SDKs | none |
| embedded dashboard | ✅ self-contained, served on `:6768` (M6/M7) | needs adoption/ROI views |
| **end-user identity** (email/role → anon ID, PII split, consent) | ❌ RS has *sessions*, not *people* | **new — the core addition** |
| **ROI / baselines / value** | ❌ | new data model + aggregation |
| **adoption rollups** (DAU/MAU, retention, funnels, per-feature) | ⚠️ raw `custom`/`ui` events flow; no rollups | aggregation queries + tools + dashboard |
| **survey/identity popup** | ✅ server→SDK command channel (`command.rs`, e.g. `capture_dom_snapshot`) + SDK DOM injection | reuse — see below |
| uptime heartbeat / incidents | ⚠️ health + server-metrics concepts | heartbeat loop + incidents table |
| Clarity/GA4/GTM bridge | ❌ | optional, self-contained |

## Recommended architecture

Build it as a **`pm/`-style analytics subsystem** — the repo already has the
exact pattern: a SQLite store module + collector HTTP routes + MCP tools +
dashboard pages + conformance/integration tests. Concretely:

### Data model (new tables — co-locate in `pm.db` or a sibling `analytics.db`)

- `analytics_users` (PII; restricted) + `analytics_user_mapping` (anon IDs) —
  **keep distinct from `pm_sessions`**: a pm session is a Claude-Code coding
  session; an analytics user is an end-user of the monitored app. Conflating
  them corrupts both (cf. the `projectName`/`projectId` lesson in
  `../specs/rust-collector-patterns.md`).
- Reuse the existing `custom` event stream as the usage spine; add an optional
  `userId`/`anonId` stamp to events emitted after `identify()`.
- `analytics_baselines` (+ history + submissions), `analytics_roles`,
  `analytics_projections` — straight lift from the D1 schema.
- FK discipline: FK is **ON** now (`pm_store.rs` pragma) — mind insert order, or
  don't FK the high-churn event linkage (cf. the dev-server `pm_dev_servers`
  decision in Slice G).

### SDK surface (additive, opt-in)

- `RuntimeScope.identify({ email, role, consent })` → returns/stores an anon ID;
  subsequent `track()` events carry it.
- `track()` already exists — extend its payload, don't replace it.
- Identity/survey popup behind an explicit `enableUserSurvey`/`identify` flag so
  a developer who just wanted runtime diagnostics never ships an end-user-facing
  modal by accident. **This is a new product-facing surface for RS** (today the
  SDK is invisible to end-users) — gate it loudly.

### Read/report surface

- MCP tools: `get_adoption_metrics`, `get_feature_usage`, `get_user_funnel`,
  `get_roi_report` (mirror the envelope `{summary,data,issues,metadata}`).
- HTTP routes for the dashboard to poll (DAU/MAU/retention/funnels are pure SQL
  over the event store; ROI is the baseline join).
- Dashboard pages in the new UI system (see the prototype).

### Survey popup — the detail that makes this compelling

`kpis` mounts a sandboxed `<iframe srcdoc>` and listens for `postMessage`. RS has
the better primitive: the collector already **pushes commands to a connected
SDK** and awaits a response (`command.rs` `CommandHub`, `oneshot`-keyed by
`requestId`; e.g. `capture_dom_snapshot`). A survey is the same shape:

- New command `show_survey` (collector → SDK) carrying a survey schema; the SDK
  renders the sandboxed-iframe popup (reuse `kpis`'s XSS-safe `iframe sandbox` +
  `postMessage`, **not** `innerHTML`) and returns answers over the existing
  command-response channel.
- Payoff: surveys become **triggerable from the dashboard/MCP** ("ask users who
  used feature X this week"), not hardcoded in the app — a real upgrade over
  `kpis`'s static popup. The identity prompt is just the first built-in survey.

## Batteries-included vs bring-your-own — recommendation: **both, layered**

RuntimeScope already *is* batteries-included (self-hosted collector + SQLite +
embedded dashboard, no external accounts) — that's its edge vs
Segment/PostHog/Amplitude. Keep that as the default and add escape hatches:

- **Batteries-included (default):** events → local collector → SQLite → built-in
  dashboard. Zero third-party accounts. Matches RS's existing posture exactly.
- **BYO data (scale path):** let the collector target the client's own
  Postgres/D1/ClickHouse instead of local SQLite when they outgrow it. *`kpis`
  itself made this migration (Supabase → D1)* — design the store seam so the
  medium is swappable (RS already abstracts the store behind a handle).
- **BYO analytics (bridge):** keep the optional Clarity/GA4/GTM fan-out as an
  opt-in config block. Cheap, self-contained, and the "three independent
  sources" credibility argument is genuinely useful.

Net: **don't make clients choose.** Ship batteries-included, document a store
adapter for self-hosters, and a bridge config for GA4/Clarity shops.

## Effort & phasing (slices, not hours — matching the repo's milestone style)

1. **Identity layer** — SDK `identify()` + `analytics_users`/`user_mapping`
   tables + anon-ID stamping on events. (Smallest, unblocks everything.)
2. **Adoption rollups** — aggregation queries + MCP tools + dashboard pages over
   the existing `custom` event stream. (Pure SQL + UI; no new ingest.)
3. **ROI engine** — `baselines`/`roles`/projections + the value formula.
   (Highest value-per-line; near-direct lift from D1.)
4. **Survey/identity popup** — the `show_survey` command + SDK modal + results
   storage. (Leverages the command channel; UI prototype already drafted.)
5. **Uptime + third-party bridges** — optional, last.

## Open questions / decisions for the user

1. **Identity store location** — extend `pm.db`, or a new `analytics.db`?
   (Leaning sibling DB: clean separation, independent backup/retention, no FK
   entanglement with coding-session tables.)
2. **PII boundary** — replicate `kpis`'s service-role split inside a single
   self-hosted process (no Supabase RLS here). Likely: a dedicated admin token
   (like the existing workspace API keys) gates the de-anonymized endpoints.
3. **Roadmap placement** — v0.11.x point release, or a named phase
   (e.g. "Phase Analytics")? It's additive and conformance-isolated, so it
   needn't block other work.
4. **Survey opt-in ergonomics** — config flag name + default-off confirmation,
   given it's the first end-user-facing surface RS would ship.
5. **Dashboard delivery** — the new UI system in `docs/ui-update/` is static
   prototypes; decide the productionization target (embed into the existing
   self-contained dashboard vs a separate analytics view).

## Prototype

A first dashboard prototype in the new UI system (rail + sidebar + tokens) lands
at [`../ui-update/analytics.html`](../ui-update/analytics.html): adoption KPIs
(active users / adoption rate / time saved / value saved), a feature-adoption
table, an anonymized users panel, a survey-results panel, and a survey-composer
modal that demonstrates the `show_survey` flow end-user popup.
