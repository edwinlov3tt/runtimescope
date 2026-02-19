---
description: Trace a user flow — clear events, reproduce, then analyze the causal chain
allowed-tools: ["Bash", "Read", "Grep", "Glob"]
---

# Trace — User Flow Analysis

Trace a specific user flow by clearing events, asking the user to reproduce, then analyzing the causal chain of network requests, console messages, state changes, and errors.

**Usage**: `/trace $ARGUMENTS`

**Examples**:
- `/trace checkout flow` — trace the checkout process
- `/trace login` — trace authentication
- `/trace page load` — trace initial page load
- `/trace` — general trace (ask what to reproduce)

---

## Phase 1: Prepare

1. Use `clear_events` to reset the event buffer so we get a clean trace
2. Tell the user what to do:

```markdown
## Ready to Trace: $ARGUMENTS

Events cleared. Please reproduce the flow now:
1. Go to your app in the browser
2. Perform the action: **$ARGUMENTS**
3. Come back here and say "done" when finished

I'll analyze everything that happened.
```

If `$ARGUMENTS` is empty, ask: "What flow would you like to trace? (e.g., 'checkout', 'login', 'page load')"

---

## Phase 2: Wait for User

Wait for the user to confirm they've reproduced the flow. They'll say "done", "finished", "ok", etc.

---

## Phase 3: Analyze the Trace

Run these tools to build the full picture:

1. **`get_event_timeline`** — Chronological view of ALL events (network + console + state interleaved)
2. **`detect_issues`** — Any issues detected during the flow
3. **`get_network_requests`** — All API calls made during the flow
4. **`get_console_messages`** — All console output (errors, warnings, logs)
5. **`get_state_snapshots`** (if available) — State changes during the flow

---

## Phase 4: Build the Causal Chain

Analyze the timeline to identify:
- **Trigger**: What initiated the flow
- **API calls**: Requests made, their order, timing, and responses
- **State changes**: How app state evolved
- **Errors**: Any failures and their cascading effects
- **Performance**: Bottlenecks in the flow

```markdown
# Trace: $ARGUMENTS

**Duration**: Xms | **Events**: X | **Errors**: X

## Timeline
| Time | Type | Detail |
|------|------|--------|
| +0ms | network | POST /api/cart → 200 (45ms) |
| +50ms | state | cart.items: [] → [{id: 1}] |
| +52ms | network | GET /api/shipping → 200 (120ms) |
| +180ms | console.error | "Payment failed: card declined" |
| +182ms | network | POST /api/payment → 402 (89ms) |

## Causal Chain
1. User triggered checkout → POST /api/cart
2. Cart updated → triggered shipping lookup
3. Shipping resolved → triggered payment
4. Payment failed with 402 → error logged

## Issues Found
- [Issue 1 with severity]
- [Issue 2 with severity]

## Bottlenecks
- Shipping lookup (120ms) is the slowest step
- Sequential API calls could be parallelized

## Recommendations
1. [Fix or optimization]
2. [Fix or optimization]
```
