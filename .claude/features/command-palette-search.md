# Feature: Global Search / Command Palette (⌘K)

## Status: ⬜ Backlog

## Assessment
- **Phase**: v1.1
- **Complexity**: M (~2 days — palette UI, global key handler, search index)
- **Value**: Medium-High
- **Created**: 2026-06-02

## Description
Build a real command palette behind ⌘K. The header (`header.tsx:180-186`)
already shows a search box styled with a `⌘K` hint, but it's purely decorative —
no input, no handler, and **no ⌘K key listener exists anywhere** (the `'k'` case
in `use-keyboard-nav.ts` is unrelated vim-style list navigation). Wire a global
⌘K handler that opens a palette to search events, errors, and routes, and to
jump to pages and projects.

## Why
The affordance is already advertised in the UI, so users press ⌘K and nothing
happens. A command palette is the natural fast-navigation primitive for a
multi-page, multi-project dashboard and removes a visible broken promise.

## Scope

### What It Includes
- Global `⌘K` / `Ctrl+K` keydown handler that opens the palette.
- Fuzzy search across: pages/tabs, projects/workspaces, and recent events/errors/routes.
- Keyboard-driven selection (reuse `use-keyboard-nav` j/k/Enter/Esc) and navigation on select.
- Replace the decorative header search `<div>` with the palette trigger.

### What It Doesn't Include
- Server-side full-text search — start with what's already in the live store + nav registry.
- Saved searches / search history (future polish).

## Technical Notes

### Systems Affected
- `packages/dashboard/src/components/layout/header.tsx` (decorative search box → trigger)
- `packages/dashboard/src/hooks/use-keyboard-nav.ts` (or a new `use-command-palette` hook)
- A new palette component + a nav/route registry to enumerate jump targets.
- Reads `useDataStore` for event/error/route matches and the app/PM stores for projects.

### Dependencies
- **Builds on**: the existing nav structure (`page-router.tsx`, rail/sidebar) and live `useDataStore`.
- **Requires**: a small searchable index of nav targets (can be derived from the router config).

### Rough Approach
Add a top-level keydown listener (guarded against input focus) that toggles a
modal palette. Index static nav targets + projects up front; query the live
store for dynamic matches (recent errors/routes). Selecting an item dispatches
the same navigation actions the sidebar uses.

## Questions / Open Items
- Scope of v1: nav + projects only, or include event/error search from the start?
- Use a dependency (e.g. `cmdk`) or hand-roll to keep the zero-ish-dep dashboard lean?

---
*Source: dashboard-collector drift audit — `docs/reviews/0004-dashboard-collector-drift.md` (Category 4, finding #12). The decorative ⌘K box should be removed/relabeled separately from building this.*

*When ready to implement, run `/task command-palette-search`.*
