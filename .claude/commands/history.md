---
description: Historical event query — list projects, query past events from SQLite
allowed-tools: ["Bash", "Read", "Grep", "Glob"]
---

# History — Historical Event Query

Query past events from SQLite persistent storage. Access data beyond the in-memory buffer (last 10K events) — up to 30 days of history per project.

**Usage**: `/history $ARGUMENTS`

**Examples**:
- `/history` — list all projects with historical data
- `/history my-app` — show recent events for my-app
- `/history my-app 7d` — events from the last 7 days
- `/history my-app errors` — only error events
- `/history my-app 2h network` — network events from last 2 hours

---

## Phase 1: Parse Arguments

Extract from `$ARGUMENTS`:
- **Project name**: first word (if not a time/type keyword)
- **Time range**: relative time like `2h`, `7d`, `30m`, or ISO date
- **Event type filter**: `network`, `console`, `state`, `render`, `performance`, `database`, `errors`

If `$ARGUMENTS` is empty, run `list_projects` to show all available projects.

---

## Phase 2: List Projects (if no project specified)

Run `list_projects` to show what's available:

```markdown
## Available Projects

| Project | Events | Sessions | Active | Last Activity |
|---------|--------|----------|--------|---------------|
| my-app | 12,456 | 34 | Yes | 5 min ago |
| dashboard | 3,201 | 12 | No | 2 hours ago |

**Retention**: 30 days (configure with RUNTIMESCOPE_RETENTION_DAYS)

Query a project: `/history [project-name]` or `/history [project-name] [time-range]`
```

---

## Phase 3: Query Events (if project specified)

Run `get_historical_events` with:
- `project`: the project name
- `since`: the time range (if provided)
- `event_types`: filter (if provided, map `errors` → `['console']` with level filter)
- `limit`: 200
- `offset`: 0

---

## Phase 4: Report

```markdown
# History: [project name]

**Time range**: [since] → now | **Total events**: X | **Showing**: X

## Event Breakdown
| Type | Count |
|------|-------|
| network | X |
| console | X |
| state | X |
| render | X |
| database | X |

## Recent Events
| Time | Type | Summary |
|------|------|---------|
| 14:23:05 | network | POST /api/checkout → 200 (45ms) |
| 14:23:04 | console | [error] Payment validation failed |
| 14:23:03 | state | cart.total: 0 → 49.99 |

## Sessions
| Session | Connected | Duration | Events |
|---------|-----------|----------|--------|
| sess-abc | 2h ago | 45min | 1,234 |
| sess-def | 5h ago | 20min | 456 |

[If more events available]: Use `offset` parameter to paginate.
```
