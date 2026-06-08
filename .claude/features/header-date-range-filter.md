# Feature: Header Date-Range Filter

## Status: ⬜ Backlog

## Assessment
- **Phase**: v1.1
- **Complexity**: S-M (~1-2 days — picker + plumb into existing query params)
- **Value**: Medium
- **Created**: 2026-06-02

## Description
Replace the hardcoded `"Today, Apr 6"` date pill in the header
(`header.tsx:190-193`) — a literal string with no picker and no state — with a
real date-range selector that scopes the dashboard's event and session queries.

## Why
The pill looks like a working global time filter but does nothing (and is stale —
the literal is wrong). Time-scoping is a core expectation for any observability
dashboard, and the backends already support it, so this is mostly UI plumbing.

## Scope

### What It Includes
- A date-range picker (presets: Last 15m / 1h / 24h / 7d + custom range) replacing the pill.
- Plumb the selection into event reads via `since_seconds` and into PM endpoints
  via `start_date`/`end_date` (both already supported server-side).
- Persist the active range across navigation; reflect it in the URL ideally.

### What It Doesn't Include
- Per-page independent time ranges (start with one global range).
- Live "follow tail" vs. fixed-window toggle — can come later.

## Technical Notes

### Systems Affected
- `packages/dashboard/src/components/layout/header.tsx` (replace the static pill)
- `packages/dashboard/src/lib/api.ts` (event reads already take `since_seconds`)
- `packages/dashboard/src/lib/pm-api.ts` (PM endpoints already take `start_date`/`end_date`)
- `src/hooks/use-live-data.ts` + relevant stores (thread the range through fetchers)

### Dependencies
- **Builds on**: the event-read API's `since_seconds` filter (`server.rs apply_filters`)
  and the PM endpoints' `start_date`/`end_date` params — already implemented.
- **Requires**: a shared "active time range" store slice the fetchers read from.

### Rough Approach
Add a `timeRange` slice to the app store; the picker writes to it; `use-live-data`
and the PM fetchers read it and convert to `since_seconds` / `start_date`+`end_date`.
WS live-append still applies (new events stream in within the active window).

## Questions / Open Items
- For WS-fed live pages, does the range only filter the initial fetch, or also
  drop incoming live events older than the window?
- Single global range vs. per-section — confirm the simpler global model is acceptable for v1.

---
*Source: dashboard-collector drift audit — `docs/reviews/0004-dashboard-collector-drift.md` (Category 4, finding #12). The hardcoded "Today, Apr 6" pill should be removed/disabled separately from building this.*

*When ready to implement, run `/task header-date-range-filter`.*
