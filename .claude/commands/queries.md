---
description: Database query audit — slow queries, N+1 patterns, missing indexes
allowed-tools: ["Bash", "Read", "Grep", "Glob"]
---

# Queries — Database Query Audit

Analyze database queries for performance issues: slow queries, N+1 patterns, and missing indexes.

**Usage**: `/queries $ARGUMENTS`

**Examples**:
- `/queries` — full database audit
- `/queries slow` — only show queries >500ms
- `/queries users` — filter to queries on the users table
- `/queries n+1` — only show N+1 patterns

**Requires**: RuntimeScope server-SDK connected with database instrumentation (pg, Prisma, mysql2, or better-sqlite3).

---

## Phase 1: Check Database Data

Run `get_database_connections` to verify a database connection exists.

If no data:

```markdown
No database queries captured. To enable database monitoring:

1. Install the server SDK: `npm install @runtimescope/server-sdk`
2. Instrument your database client:
   ```js
   import { RuntimeScope } from '@runtimescope/server-sdk';
   RuntimeScope.init({ appName: 'my-api', instrumentations: ['pg'] });
   ```
   Supported: `pg`, `prisma`, `mysql2`, `better-sqlite3`, `drizzle`
3. Restart your server and make some requests
```

---

## Phase 2: Query Analysis

Run these tools based on `$ARGUMENTS`:

1. **`get_query_performance`** — Aggregated stats (avg/max/p95 duration, call counts)
2. **`get_query_log`** — Individual queries with SQL, timing, rows returned
   - If `$ARGUMENTS` is `slow`: pass `min_duration_ms: 500`
   - If `$ARGUMENTS` is a table name: pass `table` filter
3. **`suggest_indexes`** — Missing index analysis based on WHERE/ORDER BY columns

---

## Phase 3: Report

```markdown
# Database Query Audit

**Total queries**: X | **Slow (>500ms)**: X | **N+1 detected**: X

## Query Performance Summary
| Pattern | Calls | Avg | p95 | Max | Rows/call |
|---------|-------|-----|-----|-----|-----------|
| SELECT * FROM users WHERE id = ? | 234 | 2ms | 8ms | 45ms | 1 |
| SELECT * FROM products WHERE ... | 12 | 450ms | 1.2s | 3.4s | 5,000 |

## Slow Queries (>500ms)
| Time | SQL | Duration | Rows |
|------|-----|----------|------|
| 14:23:05 | SELECT * FROM products WHERE cat... | 3,420ms | 5,000 |

## N+1 Query Patterns
[If detected:]
```
SELECT * FROM orders WHERE user_id = 1   (3ms)
SELECT * FROM orders WHERE user_id = 2   (2ms)
SELECT * FROM orders WHERE user_id = 3   (4ms)
...47 more identical query patterns

Fix: Use JOIN or IN clause:
SELECT * FROM orders WHERE user_id IN (1, 2, 3, ...)
```

## Missing Indexes
| Table | Column(s) | Query Count | Suggested Index |
|-------|-----------|-------------|----------------|
| products | category_id | 234 | CREATE INDEX idx_products_category ON products(category_id) |

## Recommendations
1. [Most impactful optimization]
2. [Index to add]
3. [Query to rewrite]
```

---

## Phase 4: Code-Level Fixes

For N+1 patterns and slow queries, search the codebase:
- Find the ORM/query code that generates the problematic SQL
- Suggest specific code changes (eager loading, batching, index creation)
- Provide the exact file path and line number
