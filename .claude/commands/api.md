---
description: API health report — endpoints, latency, errors, service map
allowed-tools: ["Bash", "Read", "Grep", "Glob"]
---

# API — API Health Report

Comprehensive API analysis: discover all endpoints, check health metrics, map external services, and identify issues.

**Usage**: `/api $ARGUMENTS`

**Examples**:
- `/api` — full API overview
- `/api /checkout` — focus on checkout endpoint
- `/api slow` — only show slow endpoints
- `/api errors` — only show failing endpoints

---

## Phase 1: Discover APIs

Run `get_api_catalog` to discover all endpoints the app communicates with.

If `$ARGUMENTS` contains a path (starts with `/`), use it as an endpoint filter for subsequent tools.

If no network data:

```markdown
No API traffic captured yet. Make sure:
1. The RuntimeScope SDK is connected (run `/setup` if needed)
2. Your app has made some API calls (interact with it in the browser)
3. Run `/api` again
```

---

## Phase 2: Health Check

Run `get_api_health` to get per-endpoint metrics. If `$ARGUMENTS` is an endpoint path, filter to that endpoint.

Collect:
- Success rate per endpoint
- Latency percentiles (p50, p95)
- Error codes and rates
- Request volume

---

## Phase 3: Service Map

Run `get_service_map` to understand the topology of external services (Supabase, Stripe, your own API, etc.).

---

## Phase 4: Report

```markdown
# API Health Report

**Total endpoints**: X | **Total requests**: X | **Overall success rate**: X%

## Service Map
| Service | Endpoints | Calls | Avg Latency | Status |
|---------|-----------|-------|-------------|--------|
| Your API (localhost:3000) | 12 | 234 | 45ms | Healthy |
| Supabase | 5 | 89 | 120ms | Warning |
| Stripe | 2 | 12 | 340ms | Healthy |

## Endpoint Health
| Method | Endpoint | Calls | Success | p50 | p95 | Issues |
|--------|----------|-------|---------|-----|-----|--------|
| POST | /api/checkout | 45 | 93% | 120ms | 890ms | 3 × 500 |
| GET | /api/products | 120 | 100% | 25ms | 80ms | — |

## Issues
### Failed Requests
[List endpoints with <95% success rate, with error codes]

### Slow Endpoints (p95 > 1s)
[List slow endpoints with latency breakdown]

### N+1 Patterns
[If detected: sequence of similar requests that should be batched]

## Recommendations
1. [Most impactful fix]
2. [Second priority]
```

---

## Phase 5: Deep Dive (if filtered)

If `$ARGUMENTS` specified an endpoint, also run:
- `get_network_requests` filtered to that URL pattern — show individual request details
- Show request/response headers, timing breakdown, and any error bodies
