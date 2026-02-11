# RuntimeScope MCP Tools Reference

6 tools available. All tools return a consistent JSON envelope:

```json
{
  "summary": "Human-readable summary of results",
  "data": [ /* structured event data */ ],
  "issues": [ /* any detected anti-patterns */ ],
  "metadata": {
    "timeRange": { "from": 1234567890, "to": 1234567920 },
    "eventCount": 847,
    "sessionId": "abc-123"
  }
}
```

---

## detect_issues

**Start here.** Runs all pattern detectors against captured runtime data and returns prioritized issues.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | all events | Analyze events from the last N seconds |
| `severity_filter` | `"high"` \| `"medium"` \| `"low"` | all | Only return issues at this severity or above |

**Detected Patterns:**

| Pattern | Trigger | Severity |
|---------|---------|----------|
| Failed requests | HTTP 4xx/5xx responses | HIGH (5xx) / MEDIUM (4xx) |
| Slow requests | Duration > 3 seconds | MEDIUM |
| N+1 requests | Same endpoint called > 5 times within 2 seconds | MEDIUM |
| Console error spam | Same error message repeated > 5 times in 10 seconds | MEDIUM |
| High error rate | > 30% of console messages are errors | HIGH |

Each issue includes `evidence` (specific data points) and `suggestion` (what to fix).

**Example prompt:** *"My app feels slow. Run detect_issues and tell me what's wrong."*

---

## get_event_timeline

Chronological view of ALL events (network + console) interleaved by timestamp. Essential for understanding causal chains.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | 60 | Only return events from the last N seconds |
| `event_types` | array of `"network"` \| `"console"` \| `"session"` | all | Filter by event type |
| `limit` | number | 200 (max 1000) | Max events to return |

Events are returned in chronological order (oldest first), so you can trace sequences like: API call failed → error logged → retry fired → another error.

**Example prompt:** *"Show me the event timeline from the last 30 seconds so I can see what happened in order."*

---

## get_network_requests

All captured fetch requests with URL, method, status, timing, headers, body sizes, and GraphQL operation detection.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_seconds` | number | all | Only return requests from the last N seconds |
| `url_pattern` | string | none | Filter by URL substring match |
| `status` | number | none | Filter by HTTP status code |
| `method` | string | none | Filter by HTTP method (GET, POST, etc.) |

**Inline issue detection:** Flags failed requests (4xx/5xx), slow requests (>3s), and N+1 patterns.

**Example prompt:** *"Show me all failed API requests in the last 60 seconds."*

---

## get_console_messages

Captured console output (log, warn, error, info, debug, trace) with message text, serialized args, and stack traces for errors.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `level` | `"log"` \| `"warn"` \| `"error"` \| `"info"` \| `"debug"` \| `"trace"` | all | Filter by console level |
| `since_seconds` | number | all | Only return messages from the last N seconds |
| `search` | string | none | Search message text (case-insensitive substring match) |

**Inline issue detection:** Flags error spam (same error >5x in 10s).

**Example prompt:** *"Show me all console errors from the last 2 minutes."*

---

## get_session_info

Check if the SDK is connected and see overall event statistics.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *(none)* | — | — | — |

Returns connected sessions with app name, SDK version, connection time, event count, and connection status.

**Example prompt:** *"Is the RuntimeScope SDK connected to my app?"*

---

## clear_events

Reset the event buffer to start a fresh capture.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *(none)* | — | — | — |

Clears all events from the 10,000-event ring buffer. Sessions are preserved but event counts reset to 0.

**Example prompt:** *"Clear all events so I can do a clean test of this workflow."*

---

## Recommended Workflow

1. **Check connection:** `get_session_info` — verify the SDK is connected
2. **Clear slate:** `clear_events` — start fresh before reproducing the issue
3. **Reproduce the issue** in the browser
4. **Detect issues:** `detect_issues` — get prioritized problems with evidence and fix suggestions
5. **Dig deeper:** `get_event_timeline` — trace the causal chain in chronological order
6. **Investigate specifics:** `get_network_requests` or `get_console_messages` with filters

## SDK Data Captured

| Category | What It Captures |
|----------|------------------|
| Network | URL, method, status, headers (redacted), request/response body size, duration, TTFB, GraphQL operation name |
| Console | Level, message text, serialized args, stack trace (errors/trace only) |
| Session | App name, SDK version, connection time |

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `RUNTIMESCOPE_PORT` | 9090 | WebSocket collector port |
| `RUNTIMESCOPE_BUFFER_SIZE` | 10000 | Max events in ring buffer |
