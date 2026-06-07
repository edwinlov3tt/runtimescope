# ADR-0014: Headless surveys (in-app micro-surveys, app-rendered)

- Status: Accepted
- Date: 2026-06-07
- Context: ADR-0012 analytics subsystem, slice 4. Companion spec:
  [`docs/specs/analytics-data-model.md`](../specs/analytics-data-model.md) (§ Surveys).
  Pattern reference: the `~/kpis` SDK (host app pushes its own user identity into
  `/identify`; baseline survey via `/survey/baseline`).

## Decision

Ship **headless** in-app surveys: the collector stores survey **definitions**
(questions + targeting) and serves them as JSON; **the application renders its own
survey UI with its own design** and POSTs responses back. No prescribed popup, no
iframe — RuntimeScope is the data + targeting layer, the app owns presentation.

Surveys are **registered to a workspace** (the existing pm workspace + `tk_` API
key tenancy). End-users see them addressed **by `projectId`** (a project belongs to
a workspace), so the browser never needs a workspace secret.

Responses tie to a user via the **`anonId`** from `identify()` (which already maps
to the app's `email`/`role`), plus an optional **`externalId`** the app supplies
(its own DB user id / UUID) so survey results join straight back to the app's user
table.

### Why headless (not a default widget)

The explicit requirement is that apps build their own survey components in their own
design. A prescribed widget would fight that. The headless API is also strictly more
general — a default widget can be layered on later as pure SDK sugar over the same
endpoints (non-goal for v1).

## Data model (`analytics.db`)

```sql
analytics_surveys(
  id, workspace_id, name, status TEXT,           -- draft|active|inactive
  questions TEXT,                                 -- JSON [{id,type,label,options?,required?}]
  targeting TEXT,                                 -- JSON {roles?, feature?, minUses?, samplePct?}
  created_at, updated_at)
analytics_survey_responses(
  id, survey_id, anon_id, external_id, answers TEXT, submitted_at)   -- answers JSON {qid: value}
analytics_survey_dismissals(survey_id, anon_id, dismissed_at)
-- analytics_users gains: external_id TEXT  (set via identify; denormalized onto responses)
```

**Question types (v1):** `rating` (1–5), `single`, `multi`, `text` (short),
`textarea` (large), `number`. (NPS intentionally omitted; a `rating` covers CSAT.)

**Targeting (v1, all optional, AND-combined):**
- **active + once-per-user** — `status=active`, and suppress for any `anonId` that
  already answered (a response row) or dismissed.
- **role** — `roles: [..]` matched against the user's `identify()` role.
- **feature-usage trigger** — `feature` + `minUses`: show only after the user has
  ≥ `minUses` `custom` events named `feature` (drives contextual baseline/CSAT, à la
  the kpis baseline prompt).
- **sampling %** — `samplePct`: deterministically include a stable subset
  (hash(anonId+surveyId) % 100 < samplePct) so a user's eligibility is stable across
  fetches, not re-rolled each poll.

## Endpoints

**Admin — workspace-`tk_`-key gated** (server-side / dashboard; key → workspace via
`pm.get_workspace_by_api_key`; global-admin token ⇒ default workspace or body
`workspaceId`):
- `POST /api/analytics/surveys` `{name, questions, targeting, status, projectScope?}`
- `GET /api/analytics/surveys` — the caller's workspace surveys + response counts
- `PUT /api/analytics/surveys/{id}` · `DELETE /api/analytics/surveys/{id}`
- `GET /api/analytics/surveys/{id}/responses`

**End-user — `projectId`-scoped, browser-safe, ingest-rate-limited** (no secret):
- `GET /api/analytics/surveys/active?anonId=&projectId=` → eligible survey
  definitions (targeting evaluated server-side; answered/dismissed filtered out)
- `POST /api/analytics/surveys/{id}/responses` `{anonId, externalId?, answers}`
- `POST /api/analytics/surveys/{id}/dismiss` `{anonId}`

`identify()` gains an optional `externalId` (persisted on `analytics_users`); the
response POST may also pass one (overrides), else it's resolved from the user row.

## Identity / privacy

The end-user endpoints never return PII. `externalId` is app-owned and is **not**
PII unless the app makes it so — it lives alongside the anon record and on
responses, queryable only through the admin/de-anon path (slice 6), not the
anonymized reads. Consent: surveys are an explicit user interaction; storing a
response the user chose to submit is consistent with the consent model (no IP, no
new PII beyond what `identify()` already governs).

## SDK (browser)

- `identify({ …, externalId })` — passthrough to the existing identify call.
- `getActiveSurveys()` → fetches `…/surveys/active` for the current `anonId` +
  `projectId`; returns definitions for the app to render.
- `submitSurveyResponse(surveyId, answers)` / `dismissSurvey(surveyId)`.

The SDK is transport only — it does **not** render anything (headless).

## Consequences

- Apps get full design control; RuntimeScope owns targeting + storage + the ROI/
  adoption join (a survey response is attributable to a role/feature cohort).
- The `projectId → workspace` map (pm_projects) is the registration boundary; a
  project with no workspace falls to the default workspace.
- Deterministic sampling keeps a user's eligibility stable (no flicker on re-poll).
- Non-goals (v1): default/themeable widget, scheduling/expiry windows, branching
  logic, response export UI — all layerable later (tagged `TODO(analytics-survey-*)`).
```
