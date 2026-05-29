//! Core tools: network reads + the DOM-snapshot command-channel tool.

use crate::tools::envelope;
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// ms epoch → ISO-8601 with millis + `Z`, matching JS `new Date(ms).toISOString()`.
fn iso_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct NetArgs {
    /// Scope results to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
    /// Only requests from the last N seconds.
    since_seconds: Option<i64>,
    /// Filter by URL substring.
    url_pattern: Option<String>,
    /// Filter by exact HTTP status code.
    status: Option<i64>,
    /// Filter by HTTP method (case-insensitive).
    method: Option<String>,
    /// Max rows (default 200, capped at 1000).
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DomArgs {
    project_id: Option<String>,
    max_size: Option<u64>,
}

#[tool_router(router = core_router, vis = "pub")]
impl Mcp {
    #[tool(description = "Get captured network (fetch) requests from the running web app. Returns URL, method, status, timing, and optional GraphQL operation info.")]
    async fn get_network_requests(
        &self,
        Parameters(args): Parameters<NetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // events_by_type returns newest-first.
        let mut all = self.store.events_by_type("network", args.project_id.as_deref()).await;

        if let Some(s) = args.since_seconds {
            let cutoff = now_ms() - s * 1000;
            all.retain(|e| e.get("timestamp").and_then(Value::as_i64).is_none_or(|t| t >= cutoff));
        }
        if let Some(m) = &args.method {
            let want = m.to_ascii_uppercase();
            all.retain(|e| {
                e.get("method").and_then(Value::as_str).is_some_and(|x| x.to_ascii_uppercase() == want)
            });
        }
        if let Some(st) = args.status {
            all.retain(|e| e.get("status").and_then(Value::as_i64) == Some(st));
        }
        if let Some(p) = &args.url_pattern {
            all.retain(|e| e.get("url").and_then(Value::as_str).is_some_and(|u| u.contains(p.as_str())));
        }

        let total = all.len();
        let max = args.limit.unwrap_or(200).min(1000);
        let truncated = total > max;
        all.truncate(max);
        let events = all;

        let dur = |e: &Value| e.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        let ts = |e: &Value| e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);

        let data: Vec<Value> = events
            .iter()
            .map(|e| {
                json!({
                    "url": e.get("url"),
                    "method": e.get("method"),
                    "status": e.get("status"),
                    "duration": format!("{}ms", dur(e).round() as i64),
                    "ttfb": format!("{}ms", e.get("ttfb").and_then(Value::as_f64).unwrap_or(0.0).round() as i64),
                    "requestBodySize": e.get("requestBodySize"),
                    "responseBodySize": e.get("responseBodySize"),
                    "graphqlOperation": e.get("graphqlOperation").cloned().unwrap_or(Value::Null),
                    "timestamp": iso_ms(ts(e)),
                })
            })
            .collect();

        // Issues: failed (4xx/5xx), slow (>3s), and N+1 (same method+url >5× within 2s).
        let failed = events.iter().filter(|e| e.get("status").and_then(Value::as_i64).is_some_and(|s| s >= 400)).count();
        let slow = events.iter().filter(|e| dur(e) > 3000.0).count();
        let mut issues: Vec<String> = Vec::new();
        if failed > 0 {
            issues.push(format!("{failed} failed request(s) (4xx/5xx)"));
        }
        if slow > 0 {
            issues.push(format!("{slow} slow request(s) (>3s)"));
        }
        let mut url_counts: HashMap<String, (usize, i64, i64)> = HashMap::new();
        for e in &events {
            let key = format!("{} {}", e.get("method").and_then(Value::as_str).unwrap_or(""), e.get("url").and_then(Value::as_str).unwrap_or(""));
            let t = ts(e);
            let entry = url_counts.entry(key).or_insert((0, t, t));
            entry.0 += 1;
            entry.1 = entry.1.min(t);
            entry.2 = entry.2.max(t);
        }
        for (key, (count, first, last)) in &url_counts {
            if *count > 5 && (last - first) < 2000 {
                issues.push(format!("Possible N+1: {key} called {count} times in {:.1}s", (last - first) as f64 / 1000.0));
            }
        }

        // timeRange from raw timestamps (events are newest-first).
        let time_range = if events.is_empty() {
            json!({ "from": 0, "to": 0 })
        } else {
            json!({ "from": ts(events.last().unwrap()), "to": ts(&events[0]) })
        };
        let avg = if events.is_empty() {
            0
        } else {
            (events.iter().map(dur).sum::<f64>() / events.len() as f64).round() as i64
        };
        let count = events.len();
        let summary = format!(
            "Found {count} network request(s){}{}. Average duration: {avg}ms.",
            if truncated { format!(" (showing {max} of {total})") } else { String::new() },
            args.since_seconds.map(|s| format!(" in the last {s}s")).unwrap_or_default(),
        );

        Ok(envelope(json!({
            "summary": summary,
            "data": data,
            "issues": issues,
            "metadata": {
                "timeRange": time_range,
                "eventCount": count,
                "totalCount": total,
                "truncated": truncated,
                "projectId": args.project_id,
            },
        })))
    }

    #[tool(description = "Capture a live DOM snapshot from the connected SDK (server→SDK command channel).")]
    async fn get_dom_snapshot(
        &self,
        Parameters(args): Parameters<DomArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let session = self
            .store
            .sessions()
            .await
            .into_iter()
            .find(|s| s.is_connected && args.project_id.as_deref().is_none_or(|p| s.project_key() == p));

        let Some(session) = session else {
            return Ok(envelope(json!({
                "summary": "No active SDK session connected. Ensure the SDK is running in the browser.",
                "data": null,
                "issues": ["No active session"],
                "metadata": { "eventCount": 0, "sessionId": null, "projectId": args.project_id },
            })));
        };

        let params = json!({ "maxSize": args.max_size.unwrap_or(500_000) });
        match self.hub.send_command(&session.session_id, "capture_dom_snapshot", params).await {
            Ok(payload) => Ok(envelope(json!({
                "summary": "DOM snapshot captured.",
                "data": payload,
                "issues": [],
                "metadata": { "eventCount": 1, "sessionId": session.session_id, "projectId": args.project_id },
            }))),
            Err(e) => Ok(envelope(json!({
                "summary": format!("Failed to capture DOM snapshot: {e}"),
                "data": null,
                "issues": [e],
                "metadata": { "eventCount": 0, "sessionId": session.session_id, "projectId": args.project_id },
            }))),
        }
    }
}
