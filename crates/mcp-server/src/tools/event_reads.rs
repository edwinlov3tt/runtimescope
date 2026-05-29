//! Event-read tools — all real store reads over `events_by_type`.
//!
//! Family ported from the TS `console.ts`, `state.ts`, `renders.ts`,
//! `performance.ts`, `timeline.ts`, `errors.ts`, `breadcrumbs.ts`,
//! `custom-events.ts`. Each tool reads one (or a few merged) event type(s),
//! optionally project-scoped, and returns the standard envelope. The key
//! invariants replicated here are event-type selection, project scoping, and
//! the `eventCount`/`projectId` metadata. Heavier TS shaping (source-fetch for
//! errors, full funnel correlation for event flow) is reduced to a Rust-native
//! best-effort over the stored events; capabilities the Rust collector lacks
//! (dev-server source fetch) are noted in the summary rather than performed.

use crate::tools::{envelope, iso_ms, now_ms};
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Map, Value};

/// Web Vitals metric names (browser source); everything else is server-side.
const WEB_VITAL_METRICS: &[&str] = &["LCP", "FCP", "CLS", "TTFB", "FID", "INP"];

fn is_web_vital(name: &str) -> bool {
    WEB_VITAL_METRICS.contains(&name)
}

/// Apply a `since_seconds` window relative to the newest event in the set.
/// Events are newest-first from the store; we keep those within the window.
fn within_window(events: Vec<Value>, since_seconds: Option<f64>) -> Vec<Value> {
    let Some(secs) = since_seconds else {
        return events;
    };
    let Some(newest) = events.first().and_then(|e| e.get("timestamp")).and_then(Value::as_i64) else {
        return events;
    };
    let cutoff = newest - (secs * 1000.0) as i64;
    events
        .into_iter()
        .filter(|e| e.get("timestamp").and_then(Value::as_i64).is_none_or(|t| t >= cutoff))
        .collect()
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConsoleArgs {
    /// Scope results to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
    /// Filter by console level (log, warn, error, info, debug, trace).
    level: Option<String>,
    /// Only return messages from the last N seconds.
    since_seconds: Option<f64>,
    /// Search message text (case-insensitive substring match).
    search: Option<String>,
    /// Max results to return (default 200, max 1000).
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StateArgs {
    project_id: Option<String>,
    /// Filter by store name/ID.
    store_name: Option<String>,
    since_seconds: Option<f64>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RenderArgs {
    project_id: Option<String>,
    /// Filter by component name (substring match).
    component_name: Option<String>,
    since_seconds: Option<f64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PerfArgs {
    project_id: Option<String>,
    /// Filter by specific metric name.
    metric_name: Option<String>,
    /// Filter by metric source: browser (Web Vitals), server, or all.
    source: Option<String>,
    since_seconds: Option<f64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TimelineArgs {
    project_id: Option<String>,
    /// Only return events from the last N seconds (default: 60).
    since_seconds: Option<f64>,
    /// Filter by event types (default: network + console).
    event_types: Option<Vec<String>>,
    /// Max events to return (default 200, max 1000).
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ErrorsArgs {
    project_id: Option<String>,
    since_seconds: Option<f64>,
    /// Whether to fetch source files for context (default true). The Rust
    /// collector does not fetch dev-server source; stack traces are parsed only.
    fetch_source: Option<bool>,
    /// Source lines above/below the error line (default 5). Unused without fetch.
    context_lines: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct BreadcrumbArgs {
    project_id: Option<String>,
    /// How far back to look (default: 60 seconds).
    since_seconds: Option<f64>,
    /// Filter to a specific session.
    session_id: Option<String>,
    /// Minimum breadcrumb level to include (debug, info, warning, error).
    level: Option<String>,
    /// Max breadcrumbs to return (default/max: 200).
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CustomArgs {
    project_id: Option<String>,
    /// Filter by event name (exact match).
    name: Option<String>,
    since_seconds: Option<f64>,
    /// Filter by session ID.
    session_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct EventFlowArgs {
    project_id: Option<String>,
    /// Ordered list of custom event names representing the flow.
    steps: Vec<String>,
    since_seconds: Option<f64>,
    session_id: Option<String>,
}

#[tool_router(router = event_reads_router, vis = "pub")]
impl Mcp {
    #[tool(description = "Get captured console messages (log, warn, error, info, debug, trace) from the running web app. Includes message text, args, and stack traces for errors.")]
    async fn get_console_messages(
        &self,
        Parameters(args): Parameters<ConsoleArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut events = self.store.events_by_type("console", args.project_id.as_deref()).await;
        events = within_window(events, args.since_seconds);

        if let Some(lvl) = &args.level {
            events.retain(|e| e.get("level").and_then(Value::as_str) == Some(lvl.as_str()));
        }
        if let Some(q) = &args.search {
            let ql = q.to_lowercase();
            events.retain(|e| {
                e.get("message")
                    .and_then(Value::as_str)
                    .is_some_and(|m| m.to_lowercase().contains(&ql))
            });
        }

        let total = events.len();
        let max_limit = args.limit.unwrap_or(200).min(1000);
        let truncated = total > max_limit;
        events.truncate(max_limit);

        // Per-level breakdown for the summary.
        let mut level_counts: Map<String, Value> = Map::new();
        for e in &events {
            if let Some(l) = e.get("level").and_then(Value::as_str) {
                let n = level_counts.get(l).and_then(Value::as_u64).unwrap_or(0) + 1;
                level_counts.insert(l.to_string(), json!(n));
            }
        }
        let breakdown = level_counts
            .iter()
            .map(|(l, c)| format!("{c} {l}"))
            .collect::<Vec<_>>()
            .join(", ");

        let data: Vec<Value> = events
            .iter()
            .map(|e| {
                json!({
                    "level": e.get("level"),
                    "message": e.get("message"),
                    "args": e.get("args"),
                    "stackTrace": e.get("stackTrace"),
                    "sourceFile": e.get("sourceFile"),
                    "timestamp": e.get("timestamp"),
                })
            })
            .collect();

        let count = data.len();
        Ok(envelope(json!({
            "summary": format!(
                "Found {count} console message(s){}{}.",
                if truncated { format!(" (showing {max_limit} of {total})") } else { String::new() },
                if breakdown.is_empty() { String::new() } else { format!(". Breakdown: {breakdown}") },
            ),
            "data": data,
            "issues": [],
            "metadata": { "eventCount": count, "totalCount": total, "truncated": truncated, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Get state store snapshots and diffs from Zustand or Redux stores. Shows state changes over time with action history and shallow diffs of which keys changed.")]
    async fn get_state_snapshots(
        &self,
        Parameters(args): Parameters<StateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut events = self.store.events_by_type("state", args.project_id.as_deref()).await;
        events = within_window(events, args.since_seconds);

        if let Some(name) = &args.store_name {
            events.retain(|e| e.get("storeId").and_then(Value::as_str) == Some(name.as_str()));
        }

        let total = events.len();
        let max_limit = args.limit.unwrap_or(200).min(1000);
        let truncated = total > max_limit;
        events.truncate(max_limit);

        // Detect store thrashing (>=10 updates with 10+ inside any 1-second window).
        let mut issues: Vec<String> = Vec::new();
        let mut store_updates: std::collections::HashMap<String, Vec<i64>> = std::collections::HashMap::new();
        for e in &events {
            if e.get("phase").and_then(Value::as_str) != Some("update") {
                continue;
            }
            let sid = e.get("storeId").and_then(Value::as_str).unwrap_or("").to_string();
            let ts = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
            store_updates.entry(sid).or_default().push(ts);
        }
        for (store_id, timestamps) in &store_updates {
            if timestamps.len() < 10 {
                continue;
            }
            for i in 0..=(timestamps.len() - 10) {
                if timestamps[i + 9] - timestamps[i] < 1000 {
                    issues.push(format!(
                        "Store thrashing: \"{store_id}\" had {} updates, 10+ in a 1-second window",
                        timestamps.len()
                    ));
                    break;
                }
            }
        }

        let time_from = events.first().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);
        let time_to = events.last().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);

        let data: Vec<Value> = events
            .iter()
            .map(|e| {
                json!({
                    "storeId": e.get("storeId"),
                    "library": e.get("library"),
                    "phase": e.get("phase"),
                    "state": e.get("state"),
                    "previousState": e.get("previousState").cloned().unwrap_or(Value::Null),
                    "diff": e.get("diff").cloned().unwrap_or(Value::Null),
                    "action": e.get("action").cloned().unwrap_or(Value::Null),
                    "timestamp": iso_ms(e.get("timestamp").and_then(Value::as_i64).unwrap_or(0)),
                })
            })
            .collect();

        let count = data.len();
        Ok(envelope(json!({
            "summary": format!(
                "Found {count} state event(s){}{}{}.",
                if truncated { format!(" (showing {max_limit} of {total})") } else { String::new() },
                args.since_seconds.map(|s| format!(" in the last {s}s")).unwrap_or_default(),
                args.store_name.as_ref().map(|s| format!(" for store \"{s}\"")).unwrap_or_default(),
            ),
            "data": data,
            "issues": issues,
            "metadata": {
                "timeRange": { "from": time_from, "to": time_to },
                "eventCount": count, "totalCount": total, "truncated": truncated, "projectId": args.project_id,
            },
        })))
    }

    #[tool(description = "Get React component render profiles showing render counts, velocity, average duration, and render causes. Flags components re-rendering excessively. Requires captureRenders: true in the SDK config.")]
    async fn get_render_profile(
        &self,
        Parameters(args): Parameters<RenderArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = within_window(
            self.store.events_by_type("render", args.project_id.as_deref()).await,
            args.since_seconds,
        );

        // Merge profiles across snapshots keyed by component name.
        let mut merged: Map<String, Value> = Map::new();
        let mut suspicious: Vec<String> = Vec::new();
        for event in &events {
            let Some(profiles) = event.get("profiles").and_then(Value::as_array) else {
                continue;
            };
            for p in profiles {
                let Some(name) = p.get("componentName").and_then(Value::as_str) else {
                    continue;
                };
                if let Some(filter) = &args.component_name {
                    if !name.contains(filter.as_str()) {
                        continue;
                    }
                }
                let render_count = p.get("renderCount").and_then(Value::as_f64).unwrap_or(0.0);
                let total_duration = p.get("totalDuration").and_then(Value::as_f64).unwrap_or(0.0);
                let velocity = p.get("renderVelocity").and_then(Value::as_f64).unwrap_or(0.0);
                let is_suspicious = p.get("suspicious").and_then(Value::as_bool).unwrap_or(false);

                let entry = merged.entry(name.to_string()).or_insert_with(|| {
                    json!({
                        "componentName": name,
                        "renderCount": 0.0,
                        "totalDuration": 0.0,
                        "renderVelocity": 0.0,
                        "lastRenderPhase": Value::Null,
                        "lastRenderCause": Value::Null,
                        "suspicious": false,
                    })
                });
                let obj = entry.as_object_mut().unwrap();
                let rc = obj["renderCount"].as_f64().unwrap_or(0.0) + render_count;
                let td = obj["totalDuration"].as_f64().unwrap_or(0.0) + total_duration;
                obj.insert("renderCount".into(), json!(rc));
                obj.insert("totalDuration".into(), json!(td));
                obj.insert("avgDuration".into(), json!(if rc > 0.0 { td / rc } else { 0.0 }));
                let v = obj["renderVelocity"].as_f64().unwrap_or(0.0).max(velocity);
                obj.insert("renderVelocity".into(), json!(v));
                obj.insert("lastRenderPhase".into(), p.get("lastRenderPhase").cloned().unwrap_or(Value::Null));
                obj.insert("lastRenderCause".into(), p.get("lastRenderCause").cloned().unwrap_or(Value::Null));
                if is_suspicious {
                    obj.insert("suspicious".into(), json!(true));
                    if !suspicious.iter().any(|s| s == name) {
                        suspicious.push(name.to_string());
                    }
                }
            }
        }

        // Sort by render count descending.
        let mut profiles: Vec<Value> = merged.into_values().collect();
        profiles.sort_by(|a, b| {
            b["renderCount"]
                .as_f64()
                .unwrap_or(0.0)
                .partial_cmp(&a["renderCount"].as_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let total_renders: f64 = profiles.iter().map(|p| p["renderCount"].as_f64().unwrap_or(0.0)).sum();
        let mut issues: Vec<String> = Vec::new();
        if !suspicious.is_empty() {
            issues.push(format!("{} suspicious component(s): {}", suspicious.len(), suspicious.join(", ")));
        }

        let data: Vec<Value> = profiles
            .iter()
            .map(|p| {
                json!({
                    "componentName": p["componentName"],
                    "renderCount": p["renderCount"],
                    "totalDuration": format!("{:.1}ms", p["totalDuration"].as_f64().unwrap_or(0.0)),
                    "avgDuration": format!("{:.1}ms", p.get("avgDuration").and_then(Value::as_f64).unwrap_or(0.0)),
                    "renderVelocity": format!("{:.1}/sec", p["renderVelocity"].as_f64().unwrap_or(0.0)),
                    "lastRenderPhase": p["lastRenderPhase"],
                    "lastRenderCause": p["lastRenderCause"],
                    "suspicious": p["suspicious"],
                })
            })
            .collect();

        let comp_count = data.len();
        Ok(envelope(json!({
            "summary": format!(
                "{comp_count} component(s) tracked, {} total renders. {} suspicious.",
                total_renders as u64, suspicious.len(),
            ),
            "data": data,
            "issues": issues,
            "metadata": { "eventCount": events.len(), "projectId": args.project_id },
        })))
    }

    #[tool(description = "Get performance metrics from browser (Web Vitals: LCP, FCP, CLS, TTFB, FID, INP) and/or server (memory, event loop lag, GC pauses, CPU). Browser metrics include quality ratings.")]
    async fn get_performance_metrics(
        &self,
        Parameters(args): Parameters<PerfArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut events = within_window(
            self.store.events_by_type("performance", args.project_id.as_deref()).await,
            args.since_seconds,
        );

        if let Some(m) = &args.metric_name {
            events.retain(|e| e.get("metricName").and_then(Value::as_str) == Some(m.as_str()));
        }
        let source = args.source.as_deref().unwrap_or("all");
        if source == "browser" {
            events.retain(|e| e.get("metricName").and_then(Value::as_str).is_some_and(is_web_vital));
        } else if source == "server" {
            events.retain(|e| e.get("metricName").and_then(Value::as_str).is_some_and(|n| !is_web_vital(n)));
        }

        let mut issues: Vec<String> = Vec::new();
        let poor: Vec<&str> = events
            .iter()
            .filter(|e| e.get("rating").and_then(Value::as_str) == Some("poor"))
            .filter_map(|e| e.get("metricName").and_then(Value::as_str))
            .collect();
        let needs: Vec<&str> = events
            .iter()
            .filter(|e| e.get("rating").and_then(Value::as_str) == Some("needs-improvement"))
            .filter_map(|e| e.get("metricName").and_then(Value::as_str))
            .collect();
        if !poor.is_empty() {
            issues.push(format!("{} metric(s) rated \"poor\": {}", poor.len(), poor.join(", ")));
        }
        if !needs.is_empty() {
            issues.push(format!("{} metric(s) need improvement: {}", needs.len(), needs.join(", ")));
        }
        let high_memory = events
            .iter()
            .filter(|e| {
                e.get("metricName").and_then(Value::as_str) == Some("memory.heapUsed")
                    && e.get("value").and_then(Value::as_f64).is_some_and(|v| v > 500.0 * 1024.0 * 1024.0)
            })
            .count();
        if high_memory > 0 {
            issues.push(format!("Heap usage exceeded 500MB in {high_memory} sample(s)"));
        }
        let high_event_loop = events
            .iter()
            .filter(|e| {
                e.get("metricName").and_then(Value::as_str) == Some("eventloop.lag.p99")
                    && e.get("value").and_then(Value::as_f64).is_some_and(|v| v > 100.0)
            })
            .count();
        if high_event_loop > 0 {
            issues.push(format!("Event loop p99 lag exceeded 100ms in {high_event_loop} sample(s)"));
        }

        // Latest value per metric name (events are newest-first, so first wins).
        let mut latest: Map<String, Value> = Map::new();
        for e in &events {
            if let Some(name) = e.get("metricName").and_then(Value::as_str) {
                latest.entry(name.to_string()).or_insert_with(|| e.clone());
            }
        }

        let unit_of = |e: &Value| -> String {
            let name = e.get("metricName").and_then(Value::as_str).unwrap_or("");
            e.get("unit")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| if name == "CLS" { "score".into() } else { "ms".into() })
        };
        let format_metric = |e: &Value| -> Value {
            json!({
                "metricName": e.get("metricName"),
                "value": e.get("value"),
                "unit": unit_of(e),
                "rating": e.get("rating").cloned().unwrap_or(Value::Null),
                "element": e.get("element").cloned().unwrap_or(Value::Null),
                "timestamp": iso_ms(e.get("timestamp").and_then(Value::as_i64).unwrap_or(0)),
            })
        };

        let browser: Vec<Value> = latest
            .values()
            .filter(|e| e.get("metricName").and_then(Value::as_str).is_some_and(is_web_vital))
            .map(&format_metric)
            .collect();
        let server: Vec<Value> = latest
            .values()
            .filter(|e| e.get("metricName").and_then(Value::as_str).is_some_and(|n| !is_web_vital(n)))
            .map(&format_metric)
            .collect();

        let all_events: Vec<Value> = events
            .iter()
            .map(|e| {
                json!({
                    "metricName": e.get("metricName"),
                    "value": e.get("value"),
                    "unit": unit_of(e),
                    "rating": e.get("rating").cloned().unwrap_or(Value::Null),
                    "timestamp": iso_ms(e.get("timestamp").and_then(Value::as_i64).unwrap_or(0)),
                })
            })
            .collect();

        let time_from = events.first().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);
        let time_to = events.last().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);

        Ok(envelope(json!({
            "summary": format!(
                "{} unique metric(s) captured ({} browser, {} server). {} poor, {} needs improvement.",
                latest.len(), browser.len(), server.len(), poor.len(), needs.len(),
            ),
            "data": { "browser": browser, "server": server },
            "allEvents": all_events,
            "issues": issues,
            "metadata": {
                "timeRange": { "from": time_from, "to": time_to },
                "eventCount": events.len(), "projectId": args.project_id,
            },
        })))
    }

    #[tool(description = "Get a chronological view of events (network requests, console messages, and more) interleaved by timestamp. Essential for understanding causal chains. Events are oldest-first.")]
    async fn get_event_timeline(
        &self,
        Parameters(args): Parameters<TimelineArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let since_seconds = args.since_seconds.unwrap_or(60.0);
        let max_events = args.limit.unwrap_or(200).min(1000);
        let types: Vec<String> = args
            .event_types
            .unwrap_or_else(|| vec!["network".into(), "console".into()]);

        // Merge the requested event types, then sort chronologically (oldest-first).
        let mut merged: Vec<Value> = Vec::new();
        for t in &types {
            let evs = within_window(
                self.store.events_by_type(t, args.project_id.as_deref()).await,
                Some(since_seconds),
            );
            merged.extend(evs);
        }
        merged.sort_by_key(|e| e.get("timestamp").and_then(Value::as_i64).unwrap_or(0));

        let total_in_window = merged.len();
        // Keep the most recent N if over limit.
        let trimmed: Vec<Value> = if total_in_window > max_events {
            merged[total_in_window - max_events..].to_vec()
        } else {
            merged
        };

        // Type breakdown.
        let mut type_counts: Map<String, Value> = Map::new();
        for e in &trimmed {
            let t = event_type_str(e);
            let n = type_counts.get(&t).and_then(Value::as_u64).unwrap_or(0) + 1;
            type_counts.insert(t, json!(n));
        }
        let breakdown = type_counts
            .iter()
            .map(|(t, c)| format!("{c} {t}"))
            .collect::<Vec<_>>()
            .join(", ");

        let time_from = trimmed.first().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);
        let time_to = trimmed.last().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);

        let data: Vec<Value> = trimmed.iter().map(format_timeline_event).collect();
        let count = data.len();
        Ok(envelope(json!({
            "summary": format!(
                "Timeline: {count} event(s) in the last {since_seconds}s{}. Breakdown: {}.",
                if total_in_window > max_events { format!(" (showing last {max_events} of {total_in_window})") } else { String::new() },
                if breakdown.is_empty() { "none".to_string() } else { breakdown },
            ),
            "data": data,
            "issues": [],
            "metadata": {
                "timeRange": { "from": time_from, "to": time_to },
                "eventCount": count, "totalInWindow": total_in_window, "projectId": args.project_id,
            },
        })))
    }

    #[tool(description = "Get console errors with parsed stack frames. (The Rust collector does not fetch dev-server source files, so surrounding source context is omitted; stack traces are parsed from the captured error.)")]
    async fn get_errors_with_source_context(
        &self,
        Parameters(args): Parameters<ErrorsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = args.context_lines;
        let should_fetch = args.fetch_source != Some(false);
        let mut events = within_window(
            self.store.events_by_type("console", args.project_id.as_deref()).await,
            args.since_seconds,
        );
        events.retain(|e| e.get("level").and_then(Value::as_str) == Some("error"));

        let total = events.len();
        events.truncate(50);

        let mut unique: Vec<String> = Vec::new();
        let data: Vec<Value> = events
            .iter()
            .map(|e| {
                let msg = e.get("message").and_then(Value::as_str).unwrap_or("");
                let key: String = msg.chars().take(100).collect();
                if !unique.iter().any(|u| u == &key) {
                    unique.push(key);
                }
                let frames = e
                    .get("stackTrace")
                    .and_then(Value::as_str)
                    .map(parse_stack_trace)
                    .unwrap_or_default();
                json!({
                    "message": e.get("message"),
                    "timestamp": iso_ms(e.get("timestamp").and_then(Value::as_i64).unwrap_or(0)),
                    "frames": frames,
                })
            })
            .collect();

        let mut issues: Vec<String> = Vec::new();
        if total > 50 {
            issues.push(format!("Showing 50 of {total} errors"));
        }

        let time_from = events.first().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);
        let time_to = events.last().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);

        let count = data.len();
        Ok(envelope(json!({
            "summary": format!(
                "{count} error(s){}, {} unique. {}",
                args.since_seconds.map(|s| format!(" in the last {s}s")).unwrap_or_default(),
                unique.len(),
                if should_fetch { "Source context included." } else { "Source context disabled." },
            ),
            "data": data,
            "issues": issues,
            "metadata": {
                "timeRange": { "from": time_from, "to": time_to },
                "eventCount": count, "projectId": args.project_id,
            },
        })))
    }

    #[tool(description = "Get the chronological trail of user actions, navigation, clicks, console logs, network requests, and state changes leading up to a point in time. The primary debugging-context tool.")]
    async fn get_breadcrumbs(
        &self,
        Parameters(args): Parameters<BreadcrumbArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let since_seconds = args.since_seconds.unwrap_or(60.0);
        let max_items = args.limit.unwrap_or(200).min(200);

        let types = ["navigation", "ui", "console", "network", "state", "custom"];
        let mut merged: Vec<Value> = Vec::new();
        for t in types {
            let mut evs = within_window(
                self.store.events_by_type(t, args.project_id.as_deref()).await,
                Some(since_seconds),
            );
            if let Some(sid) = &args.session_id {
                evs.retain(|e| e.get("sessionId").and_then(Value::as_str) == Some(sid.as_str()));
            }
            merged.extend(evs);
        }
        merged.sort_by_key(|e| e.get("timestamp").and_then(Value::as_i64).unwrap_or(0));

        let anchor = merged
            .last()
            .and_then(|e| e.get("timestamp"))
            .and_then(Value::as_i64)
            .unwrap_or_else(now_ms);

        let mut breadcrumbs: Vec<Value> = Vec::new();
        for e in &merged {
            if let Some(bc) = event_to_breadcrumb(e, anchor) {
                breadcrumbs.push(bc);
            }
        }

        // Apply minimum-level filter.
        if let Some(level) = &args.level {
            let order = |l: &str| match l {
                "debug" => 0,
                "info" => 1,
                "warning" => 2,
                "error" => 3,
                _ => 1,
            };
            let min = order(level);
            breadcrumbs.retain(|bc| {
                order(bc.get("level").and_then(Value::as_str).unwrap_or("info")) >= min
            });
        }

        if breadcrumbs.len() > max_items {
            breadcrumbs = breadcrumbs[breadcrumbs.len() - max_items..].to_vec();
        }

        let last_error = breadcrumbs
            .iter()
            .rev()
            .find(|bc| bc.get("level").and_then(Value::as_str) == Some("error"))
            .and_then(|bc| bc.get("message").and_then(Value::as_str))
            .map(|m| m.chars().take(80).collect::<String>());

        // Per-category counts.
        let mut category_counts: Map<String, Value> = Map::new();
        for bc in &breadcrumbs {
            if let Some(c) = bc.get("category").and_then(Value::as_str) {
                let n = category_counts.get(c).and_then(Value::as_u64).unwrap_or(0) + 1;
                category_counts.insert(c.to_string(), json!(n));
            }
        }

        let time_from = breadcrumbs.first().and_then(|bc| bc.get("relativeMs")).cloned().unwrap_or(json!(0));
        let time_to = breadcrumbs.last().and_then(|bc| bc.get("relativeMs")).cloned().unwrap_or(json!(0));

        let count = breadcrumbs.len();
        Ok(envelope(json!({
            "summary": format!(
                "{count} breadcrumbs over the last {since_seconds}s{}",
                last_error.map(|m| format!(" — last error: \"{m}\"")).unwrap_or_default(),
            ),
            "data": breadcrumbs,
            "metadata": {
                "timeRange": { "from": time_from, "to": time_to },
                "eventCount": count,
                "projectId": args.project_id,
                "anchor": iso_ms(anchor),
                "categoryCounts": category_counts,
            },
        })))
    }

    #[tool(description = "Get custom business/product events tracked via RuntimeScope.track(). Shows the event catalog (unique names with counts) and recent occurrences.")]
    async fn get_custom_events(
        &self,
        Parameters(args): Parameters<CustomArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let since_seconds = args.since_seconds.unwrap_or(300.0);
        let mut events = within_window(
            self.store.events_by_type("custom", args.project_id.as_deref()).await,
            Some(since_seconds),
        );
        if let Some(n) = &args.name {
            events.retain(|e| e.get("name").and_then(Value::as_str) == Some(n.as_str()));
        }
        if let Some(sid) = &args.session_id {
            events.retain(|e| e.get("sessionId").and_then(Value::as_str) == Some(sid.as_str()));
        }

        // Build the catalog: unique event names with counts + latest sample.
        struct CatEntry {
            count: u64,
            last_seen: i64,
            sample: Value,
        }
        let mut catalog: std::collections::HashMap<String, CatEntry> = std::collections::HashMap::new();
        for e in &events {
            let name = e.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let ts = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
            let entry = catalog.entry(name).or_insert(CatEntry {
                count: 0,
                last_seen: 0,
                sample: Value::Null,
            });
            entry.count += 1;
            if ts > entry.last_seen {
                entry.last_seen = ts;
                entry.sample = e.get("properties").cloned().unwrap_or(Value::Null);
            }
        }
        let mut catalog_list: Vec<(String, CatEntry)> = catalog.into_iter().collect();
        catalog_list.sort_by_key(|b| std::cmp::Reverse(b.1.last_seen));
        let catalog_json: Vec<Value> = catalog_list
            .iter()
            .map(|(name, info)| {
                json!({
                    "name": name,
                    "count": info.count,
                    "lastSeen": iso_ms(info.last_seen),
                    "sampleProperties": info.sample,
                })
            })
            .collect();

        let recent: Vec<Value> = events
            .iter()
            .take(100)
            .map(|e| {
                json!({
                    "name": e.get("name"),
                    "timestamp": iso_ms(e.get("timestamp").and_then(Value::as_i64).unwrap_or(0)),
                    "properties": e.get("properties"),
                    "sessionId": e.get("sessionId"),
                })
            })
            .collect();

        // timeRange: events are newest-first => from=oldest(last), to=newest(first).
        let time_from = events.last().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);
        let time_to = events.first().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);

        let count = events.len();
        Ok(envelope(json!({
            "summary": format!(
                "{count} custom event(s) across {} unique event name(s) in the last {since_seconds}s.{}",
                catalog_json.len(),
                args.name.as_ref().map(|n| format!(" Filtered by: \"{n}\".")).unwrap_or_default(),
            ),
            "data": { "catalog": catalog_json, "recentEvents": recent },
            "issues": [],
            "metadata": {
                "timeRange": { "from": time_from, "to": time_to },
                "eventCount": count, "projectId": args.project_id,
            },
        })))
    }

    #[tool(description = "Analyze a user flow as a funnel. Given an ordered list of custom event names (steps), shows how many sessions reached each step and where drop-offs happen.")]
    async fn get_event_flow(
        &self,
        Parameters(args): Parameters<EventFlowArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let since_seconds = args.since_seconds.unwrap_or(3600.0);
        let mut all = within_window(
            self.store.events_by_type("custom", args.project_id.as_deref()).await,
            Some(since_seconds),
        );
        if let Some(sid) = &args.session_id {
            all.retain(|e| e.get("sessionId").and_then(Value::as_str) == Some(sid.as_str()));
        }

        // Group custom events by session, chronological (oldest-first).
        let mut by_session: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
        for e in &all {
            let sid = e.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
            by_session.entry(sid).or_default().push(e.clone());
        }
        for evs in by_session.values_mut() {
            evs.sort_by_key(|e| e.get("timestamp").and_then(Value::as_i64).unwrap_or(0));
        }

        // Correlation telemetry (filtered to error conditions).
        let session_filter = |e: &Value| {
            args.session_id
                .as_deref()
                .is_none_or(|sid| e.get("sessionId").and_then(Value::as_str) == Some(sid))
        };
        let network_errors: Vec<Value> = within_window(
            self.store.events_by_type("network", args.project_id.as_deref()).await,
            Some(since_seconds),
        )
        .into_iter()
        .filter(&session_filter)
        .filter(|e| {
            e.get("status").and_then(Value::as_i64).is_some_and(|s| s >= 400)
                || e.get("errorPhase").is_some_and(|v| !v.is_null())
        })
        .collect();
        let console_errors: Vec<Value> = within_window(
            self.store.events_by_type("console", args.project_id.as_deref()).await,
            Some(since_seconds),
        )
        .into_iter()
        .filter(&session_filter)
        .filter(|e| e.get("level").and_then(Value::as_str) == Some("error"))
        .collect();
        let db_errors: Vec<Value> = within_window(
            self.store.events_by_type("database", args.project_id.as_deref()).await,
            Some(since_seconds),
        )
        .into_iter()
        .filter(&session_filter)
        .filter(|e| e.get("error").is_some_and(|v| !v.is_null()))
        .collect();

        let total_sessions = by_session.len();
        let steps = &args.steps;
        let n = steps.len();

        // Per-step accumulators.
        let mut reached: Vec<u64> = vec![0; n];
        let mut avg_time: Vec<Option<f64>> = vec![None; n];
        let mut net_corr: Vec<Vec<Value>> = vec![Vec::new(); n];
        let mut con_corr: Vec<Vec<Value>> = vec![Vec::new(); n];
        let mut db_corr: Vec<Vec<Value>> = vec![Vec::new(); n];
        let mut completed_flows: Vec<i64> = Vec::new();

        let collect_errors =
            |sid: &str, from_ts: i64, to_ts: i64, net: &mut Vec<Value>, con: &mut Vec<Value>, db: &mut Vec<Value>| {
                for e in &network_errors {
                    let ets = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
                    if e.get("sessionId").and_then(Value::as_str) == Some(sid) && ets >= from_ts && ets <= to_ts {
                        net.push(json!({
                            "url": e.get("url").cloned().unwrap_or(Value::Null),
                            "status": e.get("status").cloned().unwrap_or(Value::Null),
                            "method": e.get("method").cloned().unwrap_or(Value::Null),
                            "timestamp": iso_ms(ets),
                        }));
                    }
                }
                for e in &console_errors {
                    let ets = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
                    if e.get("sessionId").and_then(Value::as_str) == Some(sid) && ets >= from_ts && ets <= to_ts {
                        let msg = e.get("message").and_then(Value::as_str).unwrap_or("");
                        let msg = if msg.chars().count() > 200 {
                            format!("{}...", msg.chars().take(200).collect::<String>())
                        } else {
                            msg.to_string()
                        };
                        con.push(json!({ "message": msg, "timestamp": iso_ms(ets) }));
                    }
                }
                for e in &db_errors {
                    let ets = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
                    if e.get("sessionId").and_then(Value::as_str) == Some(sid) && ets >= from_ts && ets <= to_ts {
                        let q = e.get("query").and_then(Value::as_str).unwrap_or("");
                        let q = if q.chars().count() > 150 {
                            format!("{}...", q.chars().take(150).collect::<String>())
                        } else {
                            q.to_string()
                        };
                        db.push(json!({
                            "query": q,
                            "error": e.get("error").cloned().unwrap_or(Value::Null),
                            "timestamp": iso_ms(ets),
                        }));
                    }
                }
            };

        for (sid, evs) in &by_session {
            let mut prev_time: Option<i64> = None;
            let mut completed_all = true;
            for (i, step) in steps.iter().enumerate() {
                let occ = evs.iter().find(|e| {
                    e.get("name").and_then(Value::as_str) == Some(step.as_str())
                        && prev_time.is_none_or(|pt| e.get("timestamp").and_then(Value::as_i64).unwrap_or(0) >= pt)
                });
                match occ {
                    None => {
                        completed_all = false;
                        if let Some(pt) = prev_time {
                            let gap_end = evs
                                .last()
                                .and_then(|e| e.get("timestamp"))
                                .and_then(Value::as_i64)
                                .unwrap_or_else(now_ms);
                            collect_errors(sid, pt, gap_end, &mut net_corr[i], &mut con_corr[i], &mut db_corr[i]);
                        }
                        break;
                    }
                    Some(e) => {
                        reached[i] += 1;
                        let ots = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
                        if let Some(pt) = prev_time {
                            let delta = (ots - pt) as f64;
                            avg_time[i] = Some(match avg_time[i] {
                                None => delta,
                                Some(prev) => (prev * (reached[i] - 1) as f64 + delta) / reached[i] as f64,
                            });
                            collect_errors(sid, pt, ots, &mut net_corr[i], &mut con_corr[i], &mut db_corr[i]);
                        }
                        prev_time = Some(ots);
                    }
                }
            }
            if completed_all {
                if let Some(pt) = prev_time {
                    if let Some(first) = evs.iter().find(|e| e.get("name").and_then(Value::as_str) == Some(steps[0].as_str())) {
                        let ft = first.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
                        completed_flows.push(pt - ft);
                    }
                }
            }
        }

        // Deduplicate correlated errors (limit 5 per category per step).
        let dedup = |arr: &[Value]| -> Vec<Value> {
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            let mut out: Vec<Value> = Vec::new();
            for item in arr {
                let key = item.to_string();
                if seen.insert(key) {
                    out.push(item.clone());
                    if out.len() >= 5 {
                        break;
                    }
                }
            }
            out
        };
        for i in 0..n {
            net_corr[i] = dedup(&net_corr[i]);
            con_corr[i] = dedup(&con_corr[i]);
            db_corr[i] = dedup(&db_corr[i]);
        }

        let funnel: Vec<Value> = (0..n)
            .map(|i| {
                let curr = reached[i];
                let rate = if i == 0 {
                    if total_sessions > 0 {
                        format!("{:.1}%", (curr as f64 / total_sessions as f64) * 100.0)
                    } else {
                        "0%".to_string()
                    }
                } else if reached[i - 1] > 0 {
                    format!("{:.1}%", (curr as f64 / reached[i - 1] as f64) * 100.0)
                } else {
                    "0%".to_string()
                };
                let avg_from_prev = avg_time[i]
                    .map(|v| Value::String(format!("{}ms", v.round() as i64)))
                    .unwrap_or(Value::Null);
                json!({
                    "step": steps[i],
                    "reached": curr,
                    "conversionRate": rate,
                    "avgTimeFromPrev": avg_from_prev,
                    "errorsBetweenSteps": {
                        "network": net_corr[i].len(),
                        "console": con_corr[i].len(),
                        "database": db_corr[i].len(),
                    },
                    "correlatedErrors": {
                        "networkErrors": net_corr[i],
                        "consoleErrors": con_corr[i],
                        "dbErrors": db_corr[i],
                    },
                })
            })
            .collect();

        let avg_completion: Value = if completed_flows.is_empty() {
            Value::Null
        } else {
            let sum: i64 = completed_flows.iter().sum();
            json!((sum as f64 / completed_flows.len() as f64).round() as i64)
        };

        let mut issues: Vec<String> = Vec::new();
        for i in 1..n {
            let prev = reached[i - 1];
            let curr = reached[i];
            if prev > 0 && (curr as f64 / prev as f64) < 0.5 {
                issues.push(format!(
                    "Major drop-off at \"{}\": only {:.0}% conversion from \"{}\"",
                    steps[i], (curr as f64 / prev as f64) * 100.0, steps[i - 1],
                ));
            }
            let total_errors = net_corr[i].len() + con_corr[i].len() + db_corr[i].len();
            if total_errors > 0 {
                issues.push(format!(
                    "{total_errors} error(s) detected between \"{}\" and \"{}\"",
                    steps[i - 1], steps[i],
                ));
            }
        }

        let completed_count = completed_flows.len();
        let avg_summary = if avg_completion.is_null() {
            String::new()
        } else {
            format!(" Avg completion: {}ms.", avg_completion)
        };
        let time_from = all.last().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);
        let time_to = all.first().and_then(|e| e.get("timestamp")).and_then(Value::as_i64).unwrap_or(0);

        Ok(envelope(json!({
            "summary": format!(
                "Flow analysis: {n} steps, {total_sessions} session(s), {completed_count} completed the full flow.{avg_summary}",
            ),
            "data": {
                "totalSessions": total_sessions,
                "completedFlows": completed_count,
                "avgCompletionTimeMs": avg_completion,
                "funnel": funnel,
            },
            "issues": issues,
            "metadata": {
                "timeRange": { "from": time_from, "to": time_to },
                "eventCount": all.len(), "projectId": args.project_id,
            },
        })))
    }
}

// ---------------------------------------------------------------------------
// Free helpers (module-scoped; not part of the impl).
// ---------------------------------------------------------------------------

/// The event-type discriminant of a stored event (SDK sends `eventType`).
pub(crate) fn event_type_str(e: &Value) -> String {
    e.get("eventType")
        .or_else(|| e.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

/// Shape a single timeline event for output, per event type.
fn format_timeline_event(e: &Value) -> Value {
    let t = event_type_str(e);
    let ts = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
    let base = json!({ "type": t, "timestamp": iso_ms(ts), "relativeMs": 0 });
    let mut obj = base.as_object().unwrap().clone();
    match t.as_str() {
        "network" => {
            let duration = e.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
            let graphql = e
                .get("graphqlOperation")
                .and_then(Value::as_object)
                .map(|g| {
                    format!(
                        "{} {}",
                        g.get("type").and_then(Value::as_str).unwrap_or(""),
                        g.get("name").and_then(Value::as_str).unwrap_or(""),
                    )
                });
            obj.insert("method".into(), e.get("method").cloned().unwrap_or(Value::Null));
            obj.insert("url".into(), e.get("url").cloned().unwrap_or(Value::Null));
            obj.insert("status".into(), e.get("status").cloned().unwrap_or(Value::Null));
            obj.insert("duration".into(), json!(format!("{:.0}ms", duration)));
            obj.insert("graphql".into(), graphql.map(Value::String).unwrap_or(Value::Null));
        }
        "console" => {
            let msg = e.get("message").and_then(Value::as_str).unwrap_or("");
            let msg: String = if msg.chars().count() > 200 {
                format!("{}...", msg.chars().take(200).collect::<String>())
            } else {
                msg.to_string()
            };
            obj.insert("level".into(), e.get("level").cloned().unwrap_or(Value::Null));
            obj.insert("message".into(), json!(msg));
            obj.insert("hasStack".into(), json!(e.get("stackTrace").is_some_and(|v| !v.is_null())));
        }
        "session" => {
            obj.insert("note".into(), json!("SDK session connected"));
        }
        "state" => {
            let action = e
                .get("action")
                .and_then(Value::as_object)
                .and_then(|a| a.get("type").cloned())
                .unwrap_or(Value::Null);
            let changed_keys = e
                .get("diff")
                .and_then(Value::as_object)
                .map(|m| Value::String(m.keys().cloned().collect::<Vec<_>>().join(", ")))
                .unwrap_or(Value::Null);
            obj.insert("storeId".into(), e.get("storeId").cloned().unwrap_or(Value::Null));
            obj.insert("library".into(), e.get("library").cloned().unwrap_or(Value::Null));
            obj.insert("phase".into(), e.get("phase").cloned().unwrap_or(Value::Null));
            obj.insert("action".into(), action);
            obj.insert("changedKeys".into(), changed_keys);
        }
        "render" => {
            let profiles_len = e.get("profiles").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
            let suspicious = e
                .get("suspiciousComponents")
                .and_then(Value::as_array)
                .filter(|a| !a.is_empty())
                .map(|a| {
                    Value::String(
                        a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
                    )
                })
                .unwrap_or(Value::Null);
            obj.insert("totalRenders".into(), e.get("totalRenders").cloned().unwrap_or(Value::Null));
            obj.insert("componentCount".into(), json!(profiles_len));
            obj.insert("suspicious".into(), suspicious);
        }
        "performance" => {
            obj.insert("metric".into(), e.get("metricName").cloned().unwrap_or(Value::Null));
            obj.insert("value".into(), e.get("value").cloned().unwrap_or(Value::Null));
            obj.insert("rating".into(), e.get("rating").cloned().unwrap_or(Value::Null));
            obj.insert("element".into(), e.get("element").cloned().unwrap_or(Value::Null));
        }
        "custom" => {
            obj.insert("name".into(), e.get("name").cloned().unwrap_or(Value::Null));
            obj.insert("properties".into(), e.get("properties").cloned().unwrap_or(Value::Null));
        }
        _ => {}
    }
    Value::Object(obj)
}

/// Convert a stored event into a breadcrumb, or `None` to skip it.
fn event_to_breadcrumb(e: &Value, anchor: i64) -> Option<Value> {
    let ts = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
    let iso = iso_ms(ts);
    let relative = ts - anchor;
    let t = event_type_str(e);
    match t.as_str() {
        "navigation" => {
            let to = e.get("to").and_then(Value::as_str).unwrap_or("");
            let trigger = e.get("trigger").and_then(Value::as_str).unwrap_or("navigate");
            Some(json!({
                "timestamp": iso, "relativeMs": relative, "category": "navigation",
                "level": "info", "message": format!("{trigger}: {to}"),
                "data": { "from": e.get("from").cloned().unwrap_or(Value::Null) },
            }))
        }
        "ui" => {
            let action = e.get("action").and_then(Value::as_str).unwrap_or("");
            let text = e.get("text").and_then(Value::as_str);
            let target = e.get("target").and_then(Value::as_str).unwrap_or("");
            if action == "click" {
                Some(json!({
                    "timestamp": iso, "relativeMs": relative, "category": "ui.click",
                    "level": "info", "message": text.map(|x| format!("Click: {x}")).unwrap_or_else(|| format!("Click: {target}")),
                    "data": { "target": e.get("target").cloned().unwrap_or(Value::Null) },
                }))
            } else {
                let mut bc = json!({
                    "timestamp": iso, "relativeMs": relative, "category": "breadcrumb",
                    "level": "info", "message": text.unwrap_or(target),
                });
                if let Some(d) = e.get("data") {
                    bc.as_object_mut().unwrap().insert("data".into(), d.clone());
                }
                Some(bc)
            }
        }
        "console" => {
            let raw = e.get("level").and_then(Value::as_str).unwrap_or("log");
            let level = match raw {
                "error" => "error",
                "warn" => "warning",
                "debug" | "trace" => "debug",
                _ => "info",
            };
            let msg = e.get("message").and_then(Value::as_str).unwrap_or("");
            let msg: String = msg.chars().take(200).collect();
            let mut bc = json!({
                "timestamp": iso, "relativeMs": relative, "category": format!("console.{raw}"),
                "level": level, "message": msg,
            });
            if e.get("stackTrace").is_some_and(|v| !v.is_null()) {
                bc.as_object_mut().unwrap().insert("data".into(), json!({ "hasStack": true }));
            }
            Some(bc)
        }
        "network" => {
            let status = e.get("status").and_then(Value::as_i64).unwrap_or(0);
            let error_phase = e.get("errorPhase").and_then(Value::as_str);
            let level = if error_phase.is_some() {
                "error"
            } else if status >= 400 {
                "warning"
            } else {
                "info"
            };
            let method = e.get("method").and_then(Value::as_str).unwrap_or("");
            let raw_url = e.get("url").and_then(Value::as_str).unwrap_or("");
            let path = url_pathname(raw_url);
            let outcome = if status != 0 {
                status.to_string()
            } else {
                error_phase.unwrap_or("pending").to_string()
            };
            Some(json!({
                "timestamp": iso, "relativeMs": relative, "category": "http",
                "level": level, "message": format!("{method} {path} → {outcome}"),
                "data": {
                    "duration": e.get("duration").cloned().unwrap_or(Value::Null),
                    "status": e.get("status").cloned().unwrap_or(Value::Null),
                },
            }))
        }
        "state" => {
            let phase = e.get("phase").and_then(Value::as_str).unwrap_or("");
            if phase == "init" {
                return None;
            }
            let store_id = e.get("storeId").and_then(Value::as_str).unwrap_or("");
            let changed_keys = e
                .get("diff")
                .and_then(Value::as_object)
                .map(|m| m.keys().cloned().collect::<Vec<_>>().join(", "))
                .unwrap_or_else(|| "unknown".to_string());
            Some(json!({
                "timestamp": iso, "relativeMs": relative, "category": "state",
                "level": "debug", "message": format!("{store_id}: {changed_keys}"),
                "data": { "library": e.get("library").cloned().unwrap_or(Value::Null) },
            }))
        }
        "custom" => {
            let name = e.get("name").and_then(Value::as_str).unwrap_or("");
            let mut bc = json!({
                "timestamp": iso, "relativeMs": relative, "category": format!("custom.{name}"),
                "level": "info", "message": name,
            });
            if let Some(props) = e.get("properties").filter(|p| !p.is_null()) {
                bc.as_object_mut().unwrap().insert("data".into(), props.clone());
            }
            Some(bc)
        }
        _ => None,
    }
}

/// Extract the pathname from a URL the way `new URL(url, 'http://localhost').pathname` does.
fn url_pathname(url: &str) -> String {
    // Strip scheme://host if present, keep from the first '/' of the path.
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    if url.contains("://") {
        // absolute: path is after the host
        match after_scheme.find('/') {
            Some(idx) => {
                let p = &after_scheme[idx..];
                strip_query_fragment(p)
            }
            None => "/".to_string(),
        }
    } else {
        // relative: prefix with '/' if needed
        let p = if url.starts_with('/') { url.to_string() } else { format!("/{url}") };
        strip_query_fragment(&p)
    }
}

fn strip_query_fragment(p: &str) -> String {
    let end = p.find(['?', '#']).unwrap_or(p.len());
    p[..end].to_string()
}

/// Parse Chrome/V8 and Firefox stack traces into frame objects.
fn parse_stack_trace(stack: &str) -> Vec<Value> {
    let mut frames: Vec<Value> = Vec::new();
    for line in stack.lines() {
        let trimmed = line.trim();
        if let Some(frame) = parse_chrome_frame(trimmed).or_else(|| parse_firefox_frame(trimmed)) {
            frames.push(frame);
        }
    }
    frames
}

/// Chrome/V8: `at functionName (https://file:line:col)` or `at https://file:line:col`.
fn parse_chrome_frame(line: &str) -> Option<Value> {
    let rest = line.strip_prefix("at ")?.trim();
    // Optional "functionName (" prefix; the location is the http(s) url + :line:col.
    let (func, loc) = if let Some(open) = rest.find('(') {
        let func = rest[..open].trim();
        let inner = rest[open + 1..].trim_end_matches(')');
        (func, inner)
    } else {
        ("<anonymous>", rest)
    };
    if !loc.starts_with("http") {
        return None;
    }
    let (file, line_no, col) = split_location(loc)?;
    Some(json!({
        "functionName": if func.is_empty() { "<anonymous>" } else { func },
        "file": file, "line": line_no, "column": col,
    }))
}

/// Firefox: `functionName@https://file:line:col`.
fn parse_firefox_frame(line: &str) -> Option<Value> {
    let at = line.find('@')?;
    let func = &line[..at];
    let loc = &line[at + 1..];
    if !loc.starts_with("http") {
        return None;
    }
    let (file, line_no, col) = split_location(loc)?;
    Some(json!({
        "functionName": if func.is_empty() { "<anonymous>" } else { func },
        "file": file, "line": line_no, "column": col,
    }))
}

/// Split `http...:LINE:COL` into (file, line, col).
fn split_location(loc: &str) -> Option<(String, u32, u32)> {
    let col_sep = loc.rfind(':')?;
    let col: u32 = loc[col_sep + 1..].parse().ok()?;
    let line_part = &loc[..col_sep];
    let line_sep = line_part.rfind(':')?;
    let line_no: u32 = line_part[line_sep + 1..].parse().ok()?;
    let file = line_part[..line_sep].to_string();
    Some((file, line_no, col))
}
