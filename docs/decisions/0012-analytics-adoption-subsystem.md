# ADR-0012: Analytics & adoption subsystem (port of the `kpis` platform)

**Status:** `Proposed`
**Date:** 2026-06-02
**Deciders:** Edwin (owner) + implementing instance
**Phase:** `Analytics`

---

## Context

RuntimeScope today tracks *an app's runtime for developers*. The user's `~/kpis`
platform tracks *the people who use an app* — product analytics + ROI for internal
marketing tools: usage events → anonymized identity → baselines/role-rates → a
leadership dashboard showing hours saved, value saved, and adoption. The ask is to
bring that capability into RuntimeScope **with anonymized data**.

This decision operationalizes [research 0005](../research/0005-analytics-adoption-subsystem.md),
which catalogs the `kpis` design and maps it onto RS. Key facts from that research,
re-verified this turn:

- **~70% of the plumbing already exists.** The `custom` event type
  (`crates/collector-core/src/event.rs:64`), `RuntimeScope.track(name, props)`
  (`packages/sdk/src/index.ts:433`), and `get_custom_events`
  (`crates/mcp-server/src/tools/event_reads.rs:732`) are present. A `kpis`
  "usage event" *is* an RS custom event.
- The genuinely new work is an **identity model**, an **ROI/baseline model**,
  **adoption rollups**, and a **survey/identity popup**.
- RS has a **better survey primitive** than `kpis`: the server→SDK command
  channel (`command.rs` `CommandHub`, used by `capture_dom_snapshot`) — a survey
  is just a new command.
- The `kpis` ideas worth stealing wholesale: the **anonymization split** (PII
  behind a service-role boundary; dashboard sees only anon IDs like `USER_A3F7`)
  and **ROI as a first-class, audited, editable data model** (versioned baselines
  + crowdsourced submissions).

Two hard constraints from the repo's own discipline: keep distinct domain concepts
distinct (the `projectId`/`projectName` lesson), and mind FK insert order
(`pm_store.rs` has FK ON).

## Decision

**Build product-analytics + ROI as a `pm/`-style subsystem** — a SQLite store
module + collector HTTP routes + MCP tools + dashboard pages + tests — with a
strict PII/anon split, batteries-included by default and BYO store/bridge as
escape hatches.

**What we are doing:**

- **Identity layer (slice 1, unblocks everything).** `RuntimeScope.identify({email,
  role, consent})` → returns/stores an **anonymous ID**; subsequent `track()`
  events carry it. PII (`analytics_users`) lives in a **restricted** table; the
  dashboard reads only `analytics_user_mapping` anon IDs. De-anonymized endpoints
  are gated by a **dedicated admin token** (reusing the workspace-API-key
  mechanism). Consent is captured before any user-level tracking.
- **Store location: a sibling `analytics.db`** (not `pm.db`) — clean separation,
  independent backup/retention, no FK entanglement with coding-session tables.
  **`analytics_users` is kept distinct from `pm_sessions`** (end-user of the
  monitored app ≠ Claude coding session) — conflating them corrupts both.
- **Adoption rollups (slice 2).** DAU/MAU, retention, funnels, per-feature usage
  — pure SQL over the existing `custom`/`ui` event stream. Exposed as MCP tools
  (`get_adoption_metrics`, `get_feature_usage`, `get_user_funnel`,
  `get_roi_report`) using the standard `{summary,data,issues,metadata}` envelope,
  plus HTTP routes for the dashboard.
- **ROI engine (slice 3).** `analytics_baselines` (+ history + crowdsourced
  submissions), `analytics_roles`, `analytics_projections`. Formula lifted from
  `kpis`: `time_saved = (baseline_min − tool_min) × (per_item ? count : 1)`,
  `value = time_saved × role.hourly_rate`. Baselines are versioned/audited;
  user-submitted estimates diverging >20% from the official baseline are flagged.
- **Survey/identity popup (slice 4).** A new `show_survey` command (collector →
  SDK) carrying a survey schema; the SDK renders a **sandboxed `<iframe srcdoc>`**
  (XSS-safe `postMessage`, never `innerHTML`) and returns answers over the
  existing command-response channel. The identity prompt is the first built-in
  survey. Surveys become triggerable from the dashboard/MCP.
- **Posture: batteries-included default + escape hatches.** Default = events →
  local collector → SQLite → embedded dashboard (zero third-party accounts,
  RS's edge). Add a **swappable store seam** (Postgres/ClickHouse for self-hosters
  who outgrow SQLite — `kpis` itself made the Supabase→D1 jump) and an **optional
  GA4/Clarity/GTM bridge** (the "three independent sources" credibility play).
- **Gate the end-user-facing surface loudly.** The survey/identity popup is the
  first thing RS would render to an app's *end users* — it ships behind an
  explicit, default-off `enableUserSurvey`/`identify` flag.

**What we are explicitly NOT doing:**

- **Not** extending `pm.db` or reusing `pm_sessions` for end-users.
- **Not** making any third-party (GA4/Clarity) mandatory.
- **Not** adopting ClickHouse now — SQLite default, seam for later (see ADR-0010
  for the matching scale trade-off).
- **Not** shipping the survey popup on by default.

## Consequences

**Positive:**

- A defensible, anonymized product-analytics + ROI view reusing ~70% of RS.
- Privacy-by-construction (PII behind an admin boundary, consent-first).
- The survey-via-command-channel is a genuine upgrade over `kpis`'s static popup.
- Conformance-isolated and additive — needn't block other work.

**Negative / accepted trade-offs:**

- RS gains its **first end-user-facing surface** — a new product/legal posture
  (consent, PII handling) that must be done carefully.
- New subsystem = new store, tables, tools, dashboard pages, and tests to
  maintain. Largest of the three ADRs by effort.
- The store seam adds an abstraction the single-SQLite default doesn't strictly
  need yet — justified by the scale escape hatch.

**Reversal cost:** Moderate. The subsystem is isolated (`analytics.db`, opt-in SDK
calls, gated UI), so it can be shipped behind flags and pulled. The **identity/PII
schema and anon-ID scheme are the sticky parts** — once real PII and consent
records exist, migrations must be careful. Get the PII boundary right first.

## Alternatives considered

1. **Extend `pm.db` / reuse `pm_sessions`.** Fewer files, but entangles end-users
   with coding sessions and risks the `projectId`/`projectName`-style corruption.
   Rejected for a sibling `analytics.db`.
2. **External analytics only (just bridge to GA4/PostHog/Amplitude).** Drops the
   build cost, but kills the batteries-included, self-hosted edge that
   differentiates RS, and forfeits the audited-ROI model. Rejected as the
   default; kept as an optional bridge.
3. **ClickHouse from day one.** Right for high-volume public products; wrong for
   the internal-tools target and against RS's single-binary posture. Rejected now;
   reachable via the store seam.
4. **Static identity popup (copy `kpis` as-is).** Works, but ignores RS's command
   channel. Rejected in favor of the dashboard/MCP-triggerable `show_survey`.

## Cross-links

- Operationalizes: [`../research/0005-analytics-adoption-subsystem.md`](../research/0005-analytics-adoption-subsystem.md).
- UI prototypes: [`../ui-update/analytics.html`](../ui-update/analytics.html) (+
  `analytics-users/features/baselines/projections/status/admin.html`).
- Related ADRs: [`./0010-self-hosted-deployment-topology.md`](./0010-self-hosted-deployment-topology.md)
  (store seam / scale posture shared), [`./0009-pm-subsystem-in-v0.11.0.md`](./0009-pm-subsystem-in-v0.11.0.md)
  (the subsystem pattern this mirrors).
- Source primitives: [`../../crates/collector-core/src/event.rs`](../../crates/collector-core/src/event.rs)
  (`custom`), [`../../crates/collector-core/src/command.rs`](../../crates/collector-core/src/command.rs)
  (command channel), [`../../packages/sdk/src/index.ts`](../../packages/sdk/src/index.ts) (`track`).
- External model: `~/kpis/{sdk,worker,dashboard,docs}`,
  `~/kpis/docs/METHODOLOGY.md` (ROI formula, role rates, baseline governance).

## Notes

Phasing (slices, matching the repo's milestone style): **1** identity →
**2** adoption rollups → **3** ROI engine → **4** survey popup → **5** uptime +
third-party bridges. Slice 1 is the smallest and unblocks the rest. This is a
**named phase**, not a point patch — decide its roadmap placement (open question
below) before starting slice 2.
