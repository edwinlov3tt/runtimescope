//! Database tools: query log + performance + index suggestions from captured
//! `database` events. The connection-based introspection tools (schema/table/
//! connections) mirror Node's behavior, which is itself dormant — Node never
//! registers a connection (`ConnectionManager.addConnection` is never called),
//! so every reachable call returns "no connections configured". Live DB
//! introspection (a real driver engine) is unbuilt in BOTH Node and Rust; it's a
//! shared latent gap, not a Rust regression. See docs/audits/0002.

// The connection-introspection tools accept args (for the MCP input schema, via
// schemars' JsonSchema derive) but don't read most of them — the only reachable
// path is "no connections configured", matching Node. Not dead code; the lint
// can't see through the derive.
#![allow(dead_code)]

use crate::tools::{envelope, now_ms};
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::Content, model::CallToolResult, tool, tool_router, ErrorData};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

/// First column after a WHERE clause, with its comparison operator — ported
/// verbatim from `query-monitor.ts` so column extraction matches Node exactly.
fn where_col_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)WHERE\s+.*?["'`]?(\w+)["'`]?\s*(=|>|<|>=|<=|!=|LIKE|IN|IS)\s"#).unwrap())
}

/// Column after an ORDER BY clause.
fn order_col_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)ORDER\s+BY\s+["'`]?(\w+)["'`]?"#).unwrap())
}

/// A suggested index, mirroring Node's `IndexSuggestion`. `columns` is stored
/// SORTED — Node's `columns.sort()` mutates the array in place before storing it.
struct IndexSuggestion {
    table: String,
    columns: Vec<String>,
    reason: String,
    impact: &'static str,
    query_pattern: String,
}

/// Port of `suggestIndexes` (query-monitor.ts): for each query >100ms, parse the
/// WHERE/ORDER-BY columns per table, dedup by (table, sorted-columns), keeping the
/// first occurrence. `events` must be newest-first (matches Node's buffer order).
fn suggest_indexes(events: &[&Value]) -> Vec<IndexSuggestion> {
    let mut out: Vec<IndexSuggestion> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for e in events {
        let dur = num(e, "duration");
        if dur < 100.0 {
            continue;
        }
        let query = e.get("query").and_then(Value::as_str).unwrap_or("");
        let Some(tables) = e.get("tablesAccessed").and_then(Value::as_array) else {
            continue;
        };
        for t in tables {
            let Some(table) = t.as_str() else { continue };
            let mut columns: Vec<String> = Vec::new();
            for c in where_col_re().captures_iter(query) {
                columns.push(c[1].to_string());
            }
            for c in order_col_re().captures_iter(query) {
                columns.push(c[1].to_string());
            }
            if columns.is_empty() {
                continue;
            }
            // Dedup key AND stored columns are sorted (JS `.sort()` mutates).
            columns.sort();
            let key = format!("{table}:{}", columns.join(","));
            if !seen.insert(key) {
                continue;
            }
            let impact = if dur > 1000.0 {
                "high"
            } else if dur > 300.0 {
                "medium"
            } else {
                "low"
            };
            let normalized = e.get("normalizedQuery").and_then(Value::as_str).unwrap_or("");
            out.push(IndexSuggestion {
                table: table.to_string(),
                columns,
                reason: format!("Query taking {}ms uses these columns in WHERE/ORDER BY", dur.round() as i64),
                impact,
                query_pattern: normalized.chars().take(150).collect(),
            });
        }
    }
    out
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct QueryLogArgs {
    /// Scope results to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
    /// Only return queries from the last N seconds.
    since_seconds: Option<f64>,
    /// Filter by table name.
    table: Option<String>,
    /// Only return queries slower than N ms.
    min_duration_ms: Option<f64>,
    /// Search query text.
    search: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct QueryPerfArgs {
    project_id: Option<String>,
    /// Analyze queries from the last N seconds.
    since_seconds: Option<f64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SchemaMapArgs {
    /// Connection ID (defaults to first available).
    connection_id: Option<String>,
    /// Introspect a specific table only.
    table: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TableDataArgs {
    /// Table name to read.
    table: String,
    /// Connection ID.
    connection_id: Option<String>,
    /// Max rows (default 50, max 1000).
    limit: Option<u64>,
    /// Pagination offset.
    offset: Option<u64>,
    /// SQL WHERE clause (without WHERE keyword).
    r#where: Option<String>,
    /// SQL ORDER BY clause (without ORDER BY keyword).
    order_by: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ModifyTableArgs {
    /// Table name.
    table: String,
    /// Operation type: insert, update, or delete.
    operation: String,
    /// Connection ID.
    connection_id: Option<String>,
    /// Row data (for insert/update).
    data: Option<Value>,
    /// WHERE clause (required for update/delete).
    r#where: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DbConnectionsArgs {}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SuggestIndexesArgs {
    project_id: Option<String>,
    /// Analyze queries from the last N seconds.
    since_seconds: Option<f64>,
}

/// f64 reader tolerant of JSON numbers; missing/non-numeric → 0.0.
fn num(e: &Value, key: &str) -> f64 {
    e.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

/// Filter raw `database` events by the optional query-log predicates.
fn matches_filters(e: &Value, args: &QueryLogArgs, now_ms: f64) -> bool {
    if let Some(secs) = args.since_seconds {
        let ts = num(e, "timestamp");
        if ts < now_ms - secs * 1000.0 {
            return false;
        }
    }
    if let Some(min) = args.min_duration_ms {
        if num(e, "duration") < min {
            return false;
        }
    }
    if let Some(table) = &args.table {
        let in_tables = e
            .get("tablesAccessed")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().any(|t| t.as_str() == Some(table.as_str())))
            .unwrap_or(false);
        if !in_tables {
            return false;
        }
    }
    if let Some(search) = &args.search {
        let q = e.get("query").and_then(|v| v.as_str()).unwrap_or("");
        if !q.to_lowercase().contains(&search.to_lowercase()) {
            return false;
        }
    }
    true
}

#[tool_router(router = database_router, vis = "pub")]
impl Mcp {
    #[tool(description = "Get captured database queries with SQL, timing, rows returned, and source ORM. Requires server-side SDK instrumentation.")]
    async fn get_query_log(
        &self,
        Parameters(args): Parameters<QueryLogArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);

        let events = self.store.events_by_type("database", args.project_id.as_deref()).await;
        let filtered: Vec<&Value> = events
            .iter()
            .filter(|e| matches_filters(e, &args, now_ms))
            .collect();

        let count = filtered.len();
        let total_duration: f64 = filtered.iter().map(|e| num(e, "duration")).sum();
        let avg_duration = if count > 0 { total_duration / count as f64 } else { 0.0 };
        let error_count = filtered
            .iter()
            .filter(|e| e.get("error").map(|v| !v.is_null()).unwrap_or(false))
            .count();
        let slow_count = filtered.iter().filter(|e| num(e, "duration") > 500.0).count();

        let mut issues: Vec<String> = Vec::new();
        if error_count > 0 {
            issues.push(format!("{error_count} query error(s)"));
        }
        if slow_count > 0 {
            issues.push(format!("{slow_count} slow query/queries (>500ms)"));
        }

        let data: Vec<Value> = filtered
            .iter()
            .map(|e| {
                let query = e.get("query").and_then(|v| v.as_str()).unwrap_or("");
                let normalized = e.get("normalizedQuery").and_then(|v| v.as_str()).unwrap_or("");
                json!({
                    "query": query.chars().take(200).collect::<String>(),
                    "normalizedQuery": normalized.chars().take(150).collect::<String>(),
                    "duration": format!("{:.0}ms", num(e, "duration")),
                    "operation": e.get("operation"),
                    "tables": e.get("tablesAccessed"),
                    "source": e.get("source"),
                    "rowsReturned": e.get("rowsReturned").cloned().unwrap_or(Value::Null),
                    "rowsAffected": e.get("rowsAffected").cloned().unwrap_or(Value::Null),
                    "error": e.get("error").cloned().unwrap_or(Value::Null),
                    "label": e.get("label").cloned().unwrap_or(Value::Null),
                    "timestamp": crate::tools::iso_ms(num(e, "timestamp") as i64),
                })
            })
            .collect();

        let since_note = args
            .since_seconds
            .map(|s| format!(" in the last {s}s"))
            .unwrap_or_default();

        Ok(envelope(json!({
            "summary": format!(
                "Found {count} database query/queries{since_note}. Avg duration: {avg_duration:.0}ms."
            ),
            "data": data,
            "issues": issues,
            "metadata": { "eventCount": count, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Get aggregated database query performance stats: avg/max/p95 duration, call counts, N+1 detection, and slow query analysis.")]
    async fn get_query_performance(
        &self,
        Parameters(args): Parameters<QueryPerfArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);

        let events = self.store.events_by_type("database", args.project_id.as_deref()).await;
        let events: Vec<&Value> = events
            .iter()
            .filter(|e| {
                args.since_seconds
                    .map(|secs| num(e, "timestamp") >= now_ms - secs * 1000.0)
                    .unwrap_or(true)
            })
            .collect();

        // Aggregate by normalizedQuery pattern.
        use std::collections::BTreeMap;
        struct Agg {
            tables: Value,
            operation: Value,
            durations: Vec<f64>,
            rows: Vec<f64>,
        }
        let mut groups: BTreeMap<String, Agg> = BTreeMap::new();
        for e in &events {
            let pattern = e
                .get("normalizedQuery")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let entry = groups.entry(pattern).or_insert_with(|| Agg {
                tables: e.get("tablesAccessed").cloned().unwrap_or(Value::Null),
                operation: e.get("operation").cloned().unwrap_or(Value::Null),
                durations: Vec::new(),
                rows: Vec::new(),
            });
            entry.durations.push(num(e, "duration"));
            entry
                .rows
                .push(e.get("rowsReturned").and_then(|v| v.as_f64()).unwrap_or(0.0));
        }

        struct Stat {
            pattern: String,
            tables: Value,
            operation: Value,
            call_count: usize,
            avg: f64,
            max: f64,
            p95: f64,
            total: f64,
            avg_rows: f64,
        }
        let mut stats: Vec<Stat> = groups
            .into_iter()
            .map(|(pattern, agg)| {
                let mut durs = agg.durations.clone();
                durs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                let call_count = durs.len();
                let total: f64 = durs.iter().sum();
                let avg = if call_count > 0 { total / call_count as f64 } else { 0.0 };
                let max = durs.last().copied().unwrap_or(0.0);
                let p95 = if call_count > 0 {
                    let idx = ((call_count as f64) * 0.95).ceil() as usize;
                    let idx = idx.saturating_sub(1).min(call_count - 1);
                    durs[idx]
                } else {
                    0.0
                };
                let avg_rows = if !agg.rows.is_empty() {
                    agg.rows.iter().sum::<f64>() / agg.rows.len() as f64
                } else {
                    0.0
                };
                Stat {
                    pattern,
                    tables: agg.tables,
                    operation: agg.operation,
                    call_count,
                    avg,
                    max,
                    p95,
                    total,
                    avg_rows,
                }
            })
            .collect();
        // Highest total duration first.
        stats.sort_by(|a, b| b.total.partial_cmp(&a.total).unwrap_or(std::cmp::Ordering::Equal));

        // N+1 detection: same pattern called many times.
        let mut issues: Vec<String> = Vec::new();
        let mut detected: Vec<Value> = Vec::new();
        for s in &stats {
            if s.call_count >= 10 {
                let title = format!(
                    "Possible N+1: pattern called {} times ({})",
                    s.call_count,
                    s.pattern.chars().take(80).collect::<String>()
                );
                issues.push(title.clone());
                detected.push(json!({
                    "type": "n1_query",
                    "severity": "warning",
                    "title": title,
                    "callCount": s.call_count,
                    "pattern": s.pattern.chars().take(150).collect::<String>(),
                }));
            }
        }
        for s in &stats {
            if s.avg > 500.0 {
                let title = format!(
                    "Slow query: avg {:.0}ms ({})",
                    s.avg,
                    s.pattern.chars().take(80).collect::<String>()
                );
                issues.push(title.clone());
                detected.push(json!({
                    "type": "slow_query",
                    "severity": "warning",
                    "title": title,
                    "avgDuration": s.avg,
                    "pattern": s.pattern.chars().take(150).collect::<String>(),
                }));
            }
        }

        let unique = stats.len();
        let total_events = events.len();
        let query_stats: Vec<Value> = stats
            .iter()
            .take(20)
            .map(|s| {
                json!({
                    "pattern": s.pattern.chars().take(150).collect::<String>(),
                    "tables": s.tables,
                    "operation": s.operation,
                    "callCount": s.call_count,
                    "avgDuration": format!("{:.0}ms", s.avg),
                    "maxDuration": format!("{:.0}ms", s.max),
                    "p95Duration": format!("{:.0}ms", s.p95),
                    "totalDuration": format!("{:.0}ms", s.total),
                    "avgRows": format!("{:.0}", s.avg_rows),
                })
            })
            .collect();

        Ok(envelope(json!({
            "summary": format!(
                "Analyzed {total_events} queries across {unique} unique patterns. {} issue(s) found.",
                issues.len()
            ),
            "data": {
                "queryStats": query_stats,
                "detectedIssues": detected,
            },
            "issues": issues,
            "metadata": { "eventCount": total_events, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Get the full database schema: tables, columns, types, foreign keys, and indexes. Requires a configured database connection.")]
    async fn get_schema_map(
        &self,
        Parameters(_args): Parameters<SchemaMapArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // No connection can be registered (parity with Node, whose ConnectionManager
        // is never fed) → the only reachable response is "no connections configured".
        Ok(envelope(json!({
            "summary": "No database connections configured.",
            "data": null,
            "issues": ["Configure a database connection in your project's infrastructure config."],
            "metadata": { "timeRange": { "from": 0, "to": 0 }, "eventCount": 0, "sessionId": null },
        })))
    }

    #[tool(description = "Read rows from a database table with pagination. Requires a configured database connection.")]
    async fn get_table_data(
        &self,
        Parameters(_args): Parameters<TableDataArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Node's get_table_data no-connection issue text differs from get_schema_map.
        Ok(envelope(json!({
            "summary": "No database connections configured.",
            "data": null,
            "issues": ["Configure a database connection."],
            "metadata": { "timeRange": { "from": 0, "to": 0 }, "eventCount": 0, "sessionId": null },
        })))
    }

    #[tool(description = "Insert, update, or delete rows in a LOCAL DEV database. Safety guarded: localhost only, WHERE required for update/delete, max 100 affected rows, wrapped in transaction.")]
    async fn modify_table_data(
        &self,
        Parameters(_args): Parameters<ModifyTableArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Node returns a RAW string here (not a JSON envelope) on the no-connection
        // path — replicated verbatim for parity.
        Ok(CallToolResult::success(vec![Content::text("No database connections configured.")]))
    }

    #[tool(description = "List all configured database connections with their health status.")]
    async fn get_database_connections(
        &self,
        Parameters(_args): Parameters<DbConnectionsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Mirrors Node: the ConnectionManager is never fed, so the list is empty.
        Ok(envelope(json!({
            "summary": "0 database connection(s) configured.",
            "data": [],
            "issues": [],
            "metadata": { "timeRange": { "from": 0, "to": now_ms() }, "eventCount": 0, "sessionId": null },
        })))
    }

    #[tool(description = "Analyze captured database queries and suggest missing indexes based on WHERE/ORDER BY columns and query performance.")]
    async fn suggest_indexes(
        &self,
        Parameters(args): Parameters<SuggestIndexesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let pid = args.project_id.as_deref();
        let now = now_ms();
        let events = self.store.events_by_type("database", pid).await;
        // Optional sinceSeconds filter (Node: timestamp >= now - secs*1000).
        let cutoff = args.since_seconds.map(|s| now as f64 - s * 1000.0);
        let filtered: Vec<&Value> = events
            .iter()
            .filter(|e| cutoff.is_none_or(|c| num(e, "timestamp") >= c))
            .collect();

        let suggestions = suggest_indexes(&filtered);
        let data: Vec<Value> = suggestions
            .iter()
            .map(|s| {
                json!({
                    "table": s.table,
                    "columns": s.columns,
                    "reason": s.reason,
                    "estimatedImpact": s.impact,
                    "queryPattern": s.query_pattern,
                    "suggestedSQL": format!(
                        "CREATE INDEX idx_{}_{} ON {}({});",
                        s.table, s.columns.join("_"), s.table, s.columns.join(", ")
                    ),
                })
            })
            .collect();
        let issues: Vec<String> = suggestions
            .iter()
            .filter(|s| s.impact == "high")
            .map(|s| format!("High-impact index missing on {}({})", s.table, s.columns.join(", ")))
            .collect();

        // sessionId via resolveSessionContext (first session matching project_id).
        let session_id = self
            .store
            .sessions()
            .await
            .into_iter()
            .find(|s| pid.is_none_or(|p| s.project_id.as_deref() == Some(p)))
            .map(|s| s.session_id);

        Ok(envelope(json!({
            "summary": format!(
                "{} index suggestion(s) based on {} captured queries.",
                suggestions.len(), filtered.len()
            ),
            "data": data,
            "issues": issues,
            "metadata": {
                "timeRange": { "from": 0, "to": now },
                "eventCount": filtered.len(),
                "sessionId": session_id,
                "projectId": args.project_id,
            },
        })))
    }
}
