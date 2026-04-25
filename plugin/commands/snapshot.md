---
description: Capture a session snapshot — compare before/after code changes, track regressions
allowed-tools: ["Bash", "Read", "Grep", "Glob", "mcp__runtimescope__get_session_info", "mcp__runtimescope__create_session_snapshot", "mcp__runtimescope__get_session_snapshots", "mcp__runtimescope__compare_sessions", "mcp__runtimescope__get_session_history", "mcp__runtimescope__list_projects"]
---

# Snapshot — Session Capture & Comparison

Capture point-in-time snapshots of your running app and compare them to find regressions and improvements.

**Usage**: `/snapshot $ARGUMENTS`

**Examples**:
- `/snapshot` — capture a snapshot of the current session
- `/snapshot before-fix` — capture with a label
- `/snapshot compare` — compare the two most recent snapshots
- `/snapshot list` — list all snapshots for the current session
- `/snapshot history` — show session history with metrics

---

## Route by Arguments

### No arguments or a label → Capture

If `$ARGUMENTS` is empty or looks like a label (not "compare", "list", or "history"):

1. Use `get_session_info` to verify an SDK is connected. If no session:

```
No active session. Connect your app first:
- Run /setup to install the SDK
- Or check that your app is running with the RuntimeScope snippet
```

2. Use `create_session_snapshot` with the label from `$ARGUMENTS` (if provided)

3. Report:

```markdown
## Snapshot Captured

**Session**: [session id] | **Label**: [label or "unlabeled"]
**Events**: X | **Errors**: X | **Endpoints**: X | **Components**: X

Tip: Make your code change, then run `/snapshot after-fix` and `/snapshot compare` to see what changed.
```

---

### `compare` → Compare Snapshots

1. Use `get_session_info` to get the active session ID
2. Use `get_session_snapshots` to list snapshots for this session
3. If fewer than 2 snapshots exist:

```
Need at least 2 snapshots to compare. Capture one with `/snapshot [label]` first.
```

4. If 2+ snapshots exist, use `compare_sessions` with `snapshot_a` and `snapshot_b` set to the last two snapshot IDs

5. Report:

```markdown
## Snapshot Comparison

**Comparing**: [label A or "snapshot #X"] → [label B or "snapshot #Y"]

### Regressions
| Metric | Before | After | Change |
|--------|--------|-------|--------|
| endpoint:GET /api/users | 100ms | 250ms | +150% |

### Improvements
| Metric | Before | After | Change |
|--------|--------|-------|--------|
| component:Header | 25 renders | 10 renders | -60% |

### Summary
- X regression(s), Y improvement(s)
- Error delta: +/-N

### Recommendations
1. [Fix or note based on regressions]
```

---

### `list` → List Snapshots

1. Use `get_session_info` to get the active session ID
2. Use `get_session_snapshots` for the active session

3. Report:

```markdown
## Snapshots for Session [id]

| # | ID | Label | Time | Events | Errors |
|---|-----|-------|------|--------|--------|
| 1 | 42 | before-fix | 2:30 PM | 150 | 3 |
| 2 | 43 | after-fix | 2:45 PM | 180 | 1 |

Use `/snapshot compare` to compare the last two, or use `compare_sessions` with specific snapshot IDs.
```

---

### `history` → Session History

1. Use `get_session_history` to list past sessions with metrics
2. Use `list_projects` if no project is specified

3. Report:

```markdown
## Session History

| Session | App | Time | Events | Errors | Endpoints |
|---------|-----|------|--------|--------|-----------|
| abc123 | my-app | Mar 5, 2:30 PM | 500 | 12 | 8 |
| def456 | my-app | Mar 5, 1:00 PM | 300 | 5 | 6 |

Use `compare_sessions` with two session IDs to compare across sessions.
Use `get_session_snapshots` with a session ID to see snapshots within a session.
```

---

## Automated Snapshots

RuntimeScope automatically captures snapshots:
- **On SDK disconnect** — when your app stops or the page is closed
- **Periodically** — every 5 minutes for long-running sessions (labeled "auto-5m", "auto-10m", etc.)

These appear in `/snapshot list` alongside your manual snapshots.
