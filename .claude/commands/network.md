---
description: Network request analysis — failed requests, slow requests, N+1 patterns
allowed-tools: ["Bash", "Read", "Grep", "Glob"]
---

# Network — Request Analysis

Analyze network requests for failures, slow responses, and anti-patterns.

**Usage**: `/network $ARGUMENTS`

**Examples**:
- `/network` — show all network issues
- `/network 500` — filter to 500 errors
- `/network slow` — show requests >1s
- `/network /api/users` — filter to specific endpoint

---

## Phase 1: Gather Network Data

Run `get_network_requests` to get all captured requests.

Apply filters based on `$ARGUMENTS`:
- If a number (e.g., `500`, `404`): filter by `status` code
- If `slow`: only show requests >1000ms
- If a path (e.g., `/api/users`): filter by `url_pattern`
- If empty: show all, highlight issues

---

## Phase 2: Issue Detection

Run `detect_issues` to find network-specific patterns:
- **Failed requests**: 4xx/5xx status codes
- **Slow requests**: >3s response time
- **N+1 patterns**: Multiple similar sequential requests
- **Error rate spikes**: Sudden increase in errors

---

## Phase 3: Report

```markdown
# Network Analysis

**Total requests**: X | **Failed**: X | **Slow (>1s)**: X | **Time window**: Xs

## Failed Requests
| Time | Method | URL | Status | Duration | Error |
|------|--------|-----|--------|----------|-------|
| 14:23:05 | POST | /api/payment | 500 | 234ms | Internal Server Error |

## Slow Requests (>1s)
| Time | Method | URL | Status | Duration |
|------|--------|-----|--------|----------|
| 14:22:58 | GET | /api/products?all=true | 200 | 3,420ms |

## N+1 Patterns
[If detected: show the repeated request pattern and suggest batching]

Example:
```
GET /api/users/1  (12ms)
GET /api/users/2  (15ms)
GET /api/users/3  (11ms)
...47 more similar requests

Suggestion: Batch into GET /api/users?ids=1,2,3,...
```

## Request Summary
| Status Range | Count | % |
|-------------|-------|---|
| 2xx Success | X | X% |
| 3xx Redirect | X | X% |
| 4xx Client Error | X | X% |
| 5xx Server Error | X | X% |

## Recommendations
1. [Fix for most critical issue]
2. [Performance optimization]
```
