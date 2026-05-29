//! Diagnostics tools: issue detection, QA snapshot, HAR export, session waiting,
//! and the (deferred) buffer-clear. Ported from the TS tools in
//! `packages/mcp-server/src/tools/{issues,qa-check,har,session}.ts`.

use crate::tools::envelope;
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DetectIssuesArgs {
    /// Scope results to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
    /// Only return issues at this severity or above ("high" | "medium" | "low").
    severity_filter: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct QaCheckArgs {
    project_id: Option<String>,
    /// Label for the snapshot (e.g. "after-fix", "pre-deploy", "baseline").
    label: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct HarArgs {
    project_id: Option<String>,
    /// Max entries to include (default 200, max 1000).
    limit: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WaitForSessionArgs {
    project_id: Option<String>,
    /// How long to wait before giving up (informational only in this port).
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ClearEventsArgs {
    project_id: Option<String>,
}

/// A detected issue, mirroring the TS `DetectedIssue` shape.
struct Issue {
    severity: &'static str, // "high" | "medium" | "low"
    pattern: &'static str,
    title: String,
    description: String,
    evidence: Vec<String>,
    suggestion: &'static str,
}

fn severity_rank(s: &str) -> u8 {
    match s {
        "high" => 0,
        "medium" => 1,
        _ => 2,
    }
}

fn str_field<'a>(e: &'a Value, key: &str) -> &'a str {
    e.get(key).and_then(Value::as_str).unwrap_or("")
}

fn num_field(e: &Value, key: &str) -> f64 {
    e.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Run the network + console heuristics over stored events.
/// Ports detectFailedRequests, detectSlowRequests, detectConsoleErrorSpam (count
/// only), and detectHighErrorRate from `collector/src/issue-detector.ts`.
fn detect_issues(network: &[Value], console: &[Value]) -> Vec<Issue> {
    let mut issues: Vec<Issue> = Vec::new();

    // --- Failed requests (HTTP 4xx/5xx), grouped by "status method url" ---
    let mut failed: std::collections::BTreeMap<String, Vec<&Value>> = Default::default();
    for e in network {
        let status = num_field(e, "status");
        if status >= 400.0 {
            let key = format!("{} {} {}", status as i64, str_field(e, "method"), str_field(e, "url"));
            failed.entry(key).or_default().push(e);
        }
    }
    for (key, evts) in &failed {
        let status = num_field(evts[0], "status");
        let is_server = status >= 500.0;
        let evidence: Vec<String> = evts
            .iter()
            .take(3)
            .map(|e| {
                format!(
                    "{} {} → {} ({:.0}ms)",
                    str_field(e, "method"),
                    str_field(e, "url"),
                    num_field(e, "status") as i64,
                    num_field(e, "duration")
                )
            })
            .collect();
        issues.push(Issue {
            severity: if is_server { "high" } else { "medium" },
            pattern: "failed_requests",
            title: format!("Failed request: {key}"),
            description: format!("{} request(s) returned {}", evts.len(), status as i64),
            evidence,
            suggestion: if is_server {
                "Server error — check backend logs for this endpoint"
            } else {
                "Client error — verify the request URL, auth headers, and payload"
            },
        });
    }

    // --- Slow requests (>3s) ---
    let slow: Vec<&Value> = network.iter().filter(|e| num_field(e, "duration") > 3000.0).collect();
    if !slow.is_empty() {
        let slowest = slow
            .iter()
            .max_by(|a, b| {
                num_field(a, "duration")
                    .partial_cmp(&num_field(b, "duration"))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .copied()
            .unwrap_or(slow[0]);
        let evidence: Vec<String> = slow
            .iter()
            .take(5)
            .map(|e| {
                format!(
                    "{} {} → {:.1}s (status {})",
                    str_field(e, "method"),
                    str_field(e, "url"),
                    num_field(e, "duration") / 1000.0,
                    num_field(e, "status") as i64
                )
            })
            .collect();
        issues.push(Issue {
            severity: "medium",
            pattern: "slow_requests",
            title: format!("{} slow network request(s) (>3s)", slow.len()),
            description: format!(
                "Slowest: {} at {:.1}s",
                str_field(slowest, "url"),
                num_field(slowest, "duration") / 1000.0
            ),
            evidence,
            suggestion: "Consider adding loading states, pagination, or caching for these endpoints",
        });
    }

    // --- Console error spam: same message repeated >5 times ---
    let mut grouped: std::collections::BTreeMap<String, Vec<&Value>> = Default::default();
    for e in console {
        if str_field(e, "level") == "error" {
            let msg: String = str_field(e, "message").chars().take(200).collect();
            grouped.entry(msg).or_default().push(e);
        }
    }
    for (msg, evts) in &grouped {
        if evts.len() <= 5 {
            continue;
        }
        let truncated = if msg.chars().count() > 80 {
            format!("{}...", msg.chars().take(80).collect::<String>())
        } else {
            msg.clone()
        };
        issues.push(Issue {
            severity: "medium",
            pattern: "console_error_spam",
            title: format!("Error spam: \"{truncated}\""),
            description: format!(
                "Repeated {} times. This usually indicates a re-render loop or a recurring failed operation.",
                evts.len()
            ),
            evidence: vec![format!("Count: {}", evts.len())],
            suggestion: "Check for re-render loops, retry loops without backoff, or error boundaries that keep re-mounting",
        });
    }

    // --- High console error rate (>30% of >=10 messages) ---
    if console.len() >= 10 {
        let errors = console.iter().filter(|e| str_field(e, "level") == "error").count();
        let rate = errors as f64 / console.len() as f64;
        if rate > 0.3 {
            issues.push(Issue {
                severity: "high",
                pattern: "high_error_rate",
                title: format!("High console error rate: {:.0}%", rate * 100.0),
                description: format!(
                    "{} of {} console messages are errors. This suggests a systemic issue.",
                    errors,
                    console.len()
                ),
                evidence: vec![
                    format!("Error count: {}", errors),
                    format!("Total console messages: {}", console.len()),
                    format!("Error rate: {:.0}%", rate * 100.0),
                ],
                suggestion: "Check for unhandled promise rejections, missing error boundaries, or misconfigured API endpoints",
            });
        }
    }

    issues.sort_by_key(|i| severity_rank(i.severity));
    issues
}

fn issue_to_json(i: &Issue) -> Value {
    json!({
        "severity": i.severity.to_uppercase(),
        "pattern": i.pattern,
        "title": i.title,
        "description": i.description,
        "evidence": i.evidence,
        "suggestion": i.suggestion,
    })
}

#[tool_router(router = diagnostics_router, vis = "pub")]
impl Mcp {
    #[tool(description = "Run all pattern detectors against captured runtime data and return prioritized issues. Detects failed requests, slow requests (>3s), console error spam, and high error rates. Use this first when investigating problems.")]
    async fn detect_issues(
        &self,
        Parameters(args): Parameters<DetectIssuesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let pid = args.project_id.as_deref();
        let network = self.store.events_by_type("network", pid).await;
        let console = self.store.events_by_type("console", pid).await;

        let mut issues = detect_issues(&network, &console);

        // Filter by requested minimum severity (default: include all).
        let threshold = args
            .severity_filter
            .as_deref()
            .map(severity_rank)
            .unwrap_or(2);
        issues.retain(|i| severity_rank(i.severity) <= threshold);

        let high = issues.iter().filter(|i| i.severity == "high").count();
        let medium = issues.iter().filter(|i| i.severity == "medium").count();
        let low = issues.iter().filter(|i| i.severity == "low").count();
        let analyzed = network.len() + console.len();

        let summary = if issues.is_empty() {
            format!("No issues detected. Analyzed {analyzed} events.")
        } else {
            let mut parts = vec![format!("Found {} issue(s):", issues.len())];
            if high > 0 {
                parts.push(format!("{high} HIGH"));
            }
            if medium > 0 {
                parts.push(format!("{medium} MEDIUM"));
            }
            if low > 0 {
                parts.push(format!("{low} LOW"));
            }
            parts.push(format!("Analyzed {analyzed} events."));
            parts.join(" ")
        };

        let data: Vec<Value> = issues.iter().map(issue_to_json).collect();
        let issue_lines: Vec<String> = issues
            .iter()
            .map(|i| format!("[{}] {}", i.severity.to_uppercase(), i.title))
            .collect();

        Ok(envelope(json!({
            "summary": summary,
            "data": data,
            "issues": issue_lines,
            "metadata": { "eventCount": analyzed, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Quick health check — snapshots current event counts per type and runs all issue detectors in one call. Use after making code changes to verify nothing is broken.")]
    async fn runtime_qa_check(
        &self,
        Parameters(args): Parameters<QaCheckArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let pid = args.project_id.as_deref();
        let network = self.store.events_by_type("network", pid).await;
        let console = self.store.events_by_type("console", pid).await;
        let render = self.store.events_by_type("render", pid).await;
        let state = self.store.events_by_type("state", pid).await;
        let performance = self.store.events_by_type("performance", pid).await;
        let database = self.store.events_by_type("database", pid).await;

        let issues = detect_issues(&network, &console);
        let error_count = console.iter().filter(|e| str_field(e, "level") == "error").count();
        let total_events = network.len()
            + console.len()
            + render.len()
            + state.len()
            + performance.len()
            + database.len();

        let high = issues.iter().filter(|i| i.severity == "high").count();
        let medium = issues.iter().filter(|i| i.severity == "medium").count();
        let low = issues.iter().filter(|i| i.severity == "low").count();
        let issues_summary = if issues.is_empty() {
            "No issues detected.".to_string()
        } else {
            format!("{} issue(s): {high} high, {medium} medium, {low} low.", issues.len())
        };

        let label = args.label.clone().unwrap_or_else(|| "qa-check".to_string());
        let summary = format!(
            "QA Check complete. Snapshot \"{label}\". {total_events} events, {error_count} errors. {issues_summary}"
        );

        let data = json!({
            "snapshot": {
                "label": label,
                "metrics": {
                    "totalEvents": total_events,
                    "errorCount": error_count,
                    "counts": {
                        "network": network.len(),
                        "console": console.len(),
                        "render": render.len(),
                        "state": state.len(),
                        "performance": performance.len(),
                        "database": database.len(),
                    },
                },
            },
            "issues": issues.iter().map(issue_to_json).collect::<Vec<_>>(),
            "nextSteps": if issues.is_empty() {
                "All clear! Use compare_sessions later to track regressions."
            } else {
                "Fix the issues above, then run runtime_qa_check again to compare."
            },
        });

        let issue_lines: Vec<String> = issues
            .iter()
            .map(|i| format!("[{}] {}", i.severity.to_uppercase(), i.title))
            .collect();

        Ok(envelope(json!({
            "summary": summary,
            "data": data,
            "issues": issue_lines,
            "metadata": { "eventCount": total_events, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Export captured network requests as a HAR (HTTP Archive) 1.2 JSON file — the format used by browser DevTools and HAR viewers. Includes request/response headers and timing data.")]
    async fn capture_har(
        &self,
        Parameters(args): Parameters<HarArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let all = self.store.events_by_type("network", args.project_id.as_deref()).await;
        let max_limit = args.limit.unwrap_or(200).min(1000) as usize;
        let truncated = all.len() > max_limit;
        let events: Vec<&Value> = all.iter().take(max_limit).collect();

        let entries: Vec<Value> = events
            .iter()
            .map(|e| {
                let duration = num_field(e, "duration");
                let ttfb = num_field(e, "ttfb");
                json!({
                    "time": duration.round() as i64,
                    "request": {
                        "method": str_field(e, "method"),
                        "url": str_field(e, "url"),
                        "httpVersion": "HTTP/1.1",
                        "headers": e.get("requestHeaders").cloned().unwrap_or(json!({})),
                        "queryString": [],
                        "headersSize": -1,
                        "bodySize": num_field(e, "requestBodySize") as i64,
                    },
                    "response": {
                        "status": num_field(e, "status") as i64,
                        "httpVersion": "HTTP/1.1",
                        "headers": e.get("responseHeaders").cloned().unwrap_or(json!({})),
                        "content": {
                            "size": num_field(e, "responseBodySize") as i64,
                            "mimeType": e.get("responseHeaders")
                                .and_then(|h| h.get("content-type"))
                                .and_then(Value::as_str)
                                .unwrap_or("application/octet-stream"),
                        },
                        "headersSize": -1,
                        "bodySize": num_field(e, "responseBodySize") as i64,
                    },
                    "timings": {
                        "send": 0,
                        "wait": ttfb.round() as i64,
                        "receive": (duration - ttfb).max(0.0).round() as i64,
                    },
                })
            })
            .collect();

        let har = json!({
            "log": {
                "version": "1.2",
                "creator": { "name": "RuntimeScope", "version": "0.2.0" },
                "entries": entries,
            }
        });

        let summary = if truncated {
            format!(
                "HAR export: {} request(s) (showing {} of {}). Import into Chrome DevTools or any HAR viewer.",
                events.len(),
                max_limit,
                all.len()
            )
        } else {
            format!(
                "HAR export: {} request(s). Import into Chrome DevTools or any HAR viewer.",
                events.len()
            )
        };

        Ok(envelope(json!({
            "summary": summary,
            "data": har,
            "issues": [],
            "metadata": {
                "eventCount": events.len(),
                "totalCount": all.len(),
                "truncated": truncated,
                "projectId": args.project_id,
            },
        })))
    }

    #[tool(description = "Report the SDK sessions currently known for this project. (This port returns the current snapshot rather than blocking; re-call to re-check.)")]
    async fn wait_for_session(
        &self,
        Parameters(args): Parameters<WaitForSessionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sessions = self.store.sessions().await;
        let filtered: Vec<_> = sessions
            .iter()
            .filter(|s| args.project_id.as_deref().is_none_or(|p| s.project_key() == p))
            .collect();
        let connected: Vec<_> = filtered.iter().filter(|s| s.is_connected).collect();

        let timeout = args.timeout_seconds.unwrap_or(30);
        let first = connected.first();

        let summary = if let Some(s) = first {
            format!(
                "Connected — session {} ({}) is live.",
                &s.session_id.chars().take(8).collect::<String>(),
                s.app_name
            )
        } else {
            format!(
                "No connected session{} right now (saw {} session(s), {} connected). This port does not block; re-call after the app reloads (timeout hint: {}s).",
                args.project_id.as_ref().map(|p| format!(" on project {p}")).unwrap_or_default(),
                filtered.len(),
                connected.len(),
                timeout
            )
        };

        let issues: Vec<String> = if first.is_some() {
            vec![]
        } else if filtered.is_empty() {
            vec!["No SDK ever connected — check: (1) SDK installed? (2) projectId set? (3) app actually running?".to_string()]
        } else {
            vec!["Sessions exist but none are connected right now — reload the app.".to_string()]
        };

        let data = json!({
            "timedOut": first.is_none(),
            "sessions": filtered.len(),
            "connected": connected.len(),
            "firstSession": first.map(|s| json!({
                "sessionId": s.session_id,
                "appName": s.app_name,
                "projectId": s.project_id,
            })),
        });

        Ok(envelope(json!({
            "summary": summary,
            "data": data,
            "issues": issues,
            "metadata": {
                "eventCount": filtered.len(),
                "sessionId": first.map(|s| s.session_id.clone()),
                "projectId": args.project_id,
            },
        })))
    }

    #[tool(description = "Clear all captured events from the buffer. DEFERRED in the Rust collector — the persistent store has no clear operation yet, so this is a no-op.")]
    async fn clear_events(
        &self,
        Parameters(args): Parameters<ClearEventsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "clear_events is deferred in the Rust collector — the persistent SQLite-backed store has no clear operation yet. No events were removed.",
            "data": null,
            "issues": ["clear_events not implemented in the Rust collector (deferred)"],
            "metadata": { "eventCount": 0, "projectId": args.project_id },
        })))
    }
}
