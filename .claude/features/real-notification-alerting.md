# Feature: Real Notification / Alerting System

## Status: ⬜ Backlog

## Assessment
- **Phase**: v1.1
- **Complexity**: M (~2-3 days — derive alerts, persist read-state, build "View All")
- **Value**: High
- **Created**: 2026-06-02

## Description
Make the header notification bell real. Today it renders 7 hardcoded
`SAMPLE_NOTIFICATIONS` with a fake unread badge — alerts that reference projects
which don't exist. Replace it with alerts derived from the live event store:
errors, 5xx network responses, slow queries, excessive re-renders, poor Web
Vitals, and N+1 request patterns. Add read/unread persistence and a working
"View All Notifications" view.

## Why
The bell currently fabricates incidents (`TypeError in worker.ts:142`,
`503 on POST /api/deploy/rollback`, projects `flowAI`/`gtm-helper`/…) — the most
misleading dead UI in the dashboard: it looks like a real alert feed. A
monitoring product's notification surface has to reflect actual runtime state or
it actively erodes trust. The detection logic largely already exists.

## Scope

### What It Includes
- Generate alerts from the live store via the existing issue/severity logic
  (`src/lib/issue-detector.ts` client-side, mirrors Rust `detect_issues`).
- Unread/read state with persistence (localStorage at minimum; ideally collector-side).
- Working "View All Notifications" route (currently a dead button — see audit).
- Dedup / rate-limit so a noisy stream doesn't flood the bell.

### What It Doesn't Include
- External delivery (email/Slack/webhooks) — separate future item.
- Per-alert configurable thresholds UI — start with the detector's defaults.

## Technical Notes

### Systems Affected
- `packages/dashboard/src/components/layout/notification-dropdown.tsx` (replace `SAMPLE_NOTIFICATIONS`)
- `packages/dashboard/src/lib/issue-detector.ts` (source of truth for alert generation)
- Possibly `crates/collector-core` if read-state is persisted server-side.

### Dependencies
- **Builds on**: existing `detect_issues` / `issue-detector` patterns and the
  WS-fed `useDataStore` live arrays (already powering the Issues page).
- **Requires**: nothing new — data already flows.

### Rough Approach
Subscribe the bell to the same live store the Issues page uses, run the issue
detector over a rolling window, map issues → notifications (severity, source,
project, timestamp), and track read-state by issue id. Reuse the Issues page's
computation rather than inventing a parallel path.

## Questions / Open Items
- Read-state scope: per-browser (localStorage) or per-collector (survives across clients)?
- Should "View All" be a new page or deep-link into the existing Issues page filtered by time?

---
*Source: dashboard-collector drift audit — `docs/reviews/0004-dashboard-collector-drift.md` (Category 4, finding #10). The dead `SAMPLE_NOTIFICATIONS` UI should be removed/disabled separately from building this.*

*When ready to implement, run `/task real-notification-alerting`.*
