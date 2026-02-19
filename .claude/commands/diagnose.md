---
description: Full-stack health check — issues, API health, query performance, Web Vitals
allowed-tools: ["Bash", "Read", "Grep", "Glob"]
---

# Diagnose — Full-Stack Health Check

Run all diagnostic tools to produce a prioritized report of everything wrong with the running application.

**Requires**: RuntimeScope SDK connected to a running app. If no session is connected, suggest running `/setup` first.

---

## Phase 1: Check Connection

Use `get_session_info` to verify an SDK is connected. If no active session:

```
No RuntimeScope session detected. Connect your app first:
- Run /setup to install the SDK
- Or check that your app is running with the RuntimeScope snippet
```

Report the connected app name, SDK version, and session duration.

---

## Phase 2: Run All Diagnostics

Run these tools in sequence and collect results:

1. **`detect_issues`** — Pattern-based issue detection (failed requests, N+1, error spam, slow queries)
2. **`get_session_info`** — Session health and connection status
3. **`get_api_health`** — Endpoint success rates, latency percentiles, error codes
4. **`get_query_performance`** — Database query stats, N+1 detection, slow query analysis
5. **`get_performance_metrics`** — Web Vitals (LCP, FCP, CLS, TTFB, INP) and server metrics
6. **`get_console_messages`** with `level: "error"` — Runtime errors

---

## Phase 3: Prioritize & Report

Combine all results into a single prioritized report:

```markdown
# Diagnosis Report

**App**: [app name] | **Session**: [session id] | **Duration**: [time]
**Overall Health**: [Good / Warning / Critical]

## Critical Issues
[Issues that need immediate attention — 500s, crashes, data loss risks]

## Performance
| Metric | Value | Rating |
|--------|-------|--------|
| LCP | Xms | Good/Needs Improvement/Poor |
| FCP | Xms | ... |
| CLS | X | ... |
| TTFB | Xms | ... |

## API Health
| Endpoint | Success Rate | p50 | p95 | Issues |
|----------|-------------|-----|-----|--------|
| POST /api/checkout | 94% | 120ms | 890ms | 6% error rate |

## Database
| Metric | Value |
|--------|-------|
| Slow queries (>500ms) | X |
| N+1 patterns detected | X |
| Missing indexes suggested | X |

## Console Errors
[Top 5 most frequent errors with stack traces]

## Recommendations
1. [Most critical fix]
2. [Second priority]
3. [Third priority]
```

---

## Phase 4: Suggest Next Steps

Based on findings, suggest specific commands:

- API issues → "Run `/api /endpoint` for details"
- Render issues → "Run `/renders ComponentName` to investigate"
- Database issues → "Run `/queries slow` for slow query details"
- Network issues → "Run `/network 500` to see failed requests"
