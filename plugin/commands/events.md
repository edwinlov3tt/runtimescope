---
description: Set up custom event tracking — define events, add tracking calls, analyze funnels
allowed-tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob"]
---

# Events — Custom Event Tracking

Set up and analyze custom business/product event tracking with RuntimeScope. Define key events, add `RuntimeScope.track()` calls, and analyze user flows with funnel analysis.

**Usage**: `/events $ARGUMENTS`

**Examples**:
- `/events setup` — set up events for the current project
- `/events add signup` — add a tracking call for a signup event
- `/events flow signup > onboarding > first_action` — analyze a funnel
- `/events list` — show all tracked events
- `/events` — interactive mode (ask what to do)

---

## Route by Arguments

- If `$ARGUMENTS` contains "setup" → Phase 1 (Setup)
- If `$ARGUMENTS` contains "add" → Phase 2 (Add Event)
- If `$ARGUMENTS` contains "flow" → Phase 3 (Funnel Analysis)
- If `$ARGUMENTS` contains "list" or "catalog" → Phase 4 (Event Catalog)
- If `$ARGUMENTS` is empty → ask what they want to do

---

## Phase 1: Setup — Define Events for a Project

Help the user define the key events they want to track.

1. Scan the project to understand the app:

```bash
# Look for existing track() calls
grep -r "RuntimeScope.track\|\.track(" src/ --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" -l 2>/dev/null
```

2. Ask the user what key moments matter:

```markdown
## Custom Event Tracking Setup

RuntimeScope can track key business events in your app. These are the moments that matter — user actions, conversions, and milestones.

**What kind of events do you want to track?** Some common patterns:

| Pattern | Example Events |
|---------|---------------|
| **Onboarding** | `signup`, `verify_email`, `complete_profile`, `first_action` |
| **E-commerce** | `view_product`, `add_to_cart`, `start_checkout`, `purchase` |
| **Content** | `create_draft`, `publish`, `share`, `receive_feedback` |
| **SaaS** | `create_project`, `invite_team`, `configure_settings`, `first_output` |
| **AI/Generation** | `submit_prompt`, `generation_complete`, `copy_output`, `export` |

Tell me your key events and I'll add the tracking calls.
```

3. Once the user defines events, proceed to Phase 2 for each one.

---

## Phase 2: Add a Tracking Call

Add `RuntimeScope.track()` to the codebase for a specific event.

1. Find the right location in the code:

```bash
# Search for handlers, buttons, form submissions related to the event
grep -rn "onClick\|onSubmit\|handleSubmit\|handle.*Click\|async function" src/ --include="*.ts" --include="*.tsx" -l | head -20
```

2. Determine the best insertion point (after the action succeeds, not before):
   - After a successful API response
   - After state is updated
   - In the success callback, not the try block

3. Add the tracking call:

```typescript
// After the action succeeds
RuntimeScope.track('event_name', {
  // Include relevant properties
  propertyKey: value,
});
```

4. Make sure RuntimeScope is imported:

```typescript
import RuntimeScope from '@runtimescope/sdk';
```

**Properties guidelines**:
- Include IDs that help segment (plan type, user role, content type)
- Include quantities (item count, word count, price)
- Include timing (duration, step number)
- Do NOT include PII (emails, names, passwords)

---

## Phase 3: Funnel Analysis

Analyze a sequence of events as a conversion funnel.

Parse the flow from `$ARGUMENTS` — events separated by `>`, `→`, `->`, or commas.

Example: `/events flow signup > onboarding > first_project > invite_team`

1. Use `get_event_flow` to analyze the funnel:

Call the MCP tool with:
- `steps`: the ordered list of event names
- `since_seconds`: 86400 (last 24h, or ask the user for a time range)

2. Present the results:

```markdown
## Flow Analysis: [step1] → [step2] → [step3]

**Time Range**: Last 24 hours | **Sessions Analyzed**: X

### Funnel
| Step | Sessions | Conversion | Drop-off |
|------|----------|------------|----------|
| signup | 150 | 100% | — |
| onboarding | 120 | 80% | 20% |
| first_project | 45 | 37.5% | 62.5% |
| invite_team | 12 | 26.7% | 73.3% |

### Drop-off Analysis

**Biggest drop: onboarding → first_project (62.5% lost)**

Correlated errors between these steps:
- 3 sessions hit `POST /api/projects → 500` (server error)
- 2 sessions had console error: "TypeError: Cannot read property 'id' of null"
- 1 session had a slow query: `INSERT INTO projects` (2.3s)

### Recommendations
1. [Fix based on correlated errors]
2. [UX improvement based on drop-off patterns]
```

3. If no events found, suggest the user run `/events setup` first.

---

## Phase 4: Event Catalog

Show all custom events being tracked.

1. Use `get_custom_events` to fetch the catalog:

Call the MCP tool with:
- `since_seconds`: 3600 (last hour, or 86400 for last 24h)

2. Present the catalog:

```markdown
## Event Catalog

**Time Range**: Last hour | **Total Events**: X | **Unique Types**: Y

| Event | Count | Last Seen | Sample Properties |
|-------|-------|-----------|-------------------|
| `signup` | 45 | 2m ago | `{plan: "pro", source: "google"}` |
| `create_project` | 32 | 5m ago | `{type: "blank", name: "..."}` |
| `generate_output` | 128 | 30s ago | `{model: "gpt-4", tokens: 1500}` |

### Quick Actions
- `/events flow signup > create_project > generate_output` — analyze this as a funnel
- `/events add [event_name]` — add a new tracking call
```

---

## Notes

- `RuntimeScope.track()` is a no-op if the SDK isn't connected — safe to leave in production
- Events flow through the same pipeline as all other telemetry (network, console, state)
- The `get_event_flow` tool automatically correlates network errors, console errors, and database errors between funnel steps
- Events appear in the dashboard under the **Events** tab with filtering, flow builder, and funnel visualization
- Each event carries `sessionId` for per-user analysis and `timestamp` for ordering
