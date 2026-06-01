//! Diagnostics tools: issue detection, QA snapshot, HAR export, session waiting,
//! and the (deferred) buffer-clear. Ported from the TS tools in
//! `packages/mcp-server/src/tools/{issues,qa-check,har,session}.ts`.

use crate::tools::{envelope, iso_ms, now_ms};
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

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

/// HAR reason-phrase for a status code (ports har.ts `statusText`).
fn status_text(status: i64) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}

/// A headers object → HAR `[{name, value}]` pairs.
fn headers_to_pairs(h: Option<&Value>) -> Vec<Value> {
    h.and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(name, value)| json!({ "name": name, "value": value.as_str().unwrap_or("") }))
                .collect()
        })
        .unwrap_or_default()
}

/// Parse a URL's query string into HAR `[{name, value}]` pairs. Mirrors
/// `new URL(url).searchParams` — returns `[]` on an unparseable URL.
fn parse_query_string(url: &str) -> Vec<Value> {
    let Some(q) = url.split_once('?').map(|(_, q)| q) else {
        return Vec::new();
    };
    let q = q.split('#').next().unwrap_or(q);
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            json!({ "name": url_decode(name), "value": url_decode(value) })
        })
        .collect()
}

/// Percent-decoding (+ → space) for query-string keys/values. Decodes into a
/// byte buffer then interprets as UTF-8 (lossy), matching `URLSearchParams` —
/// byte-casting each `%XX` to a `char` would corrupt multi-byte UTF-8 (`%E2%9C%93`).
fn url_decode(s: &str) -> String {
    let src = s.replace('+', " ");
    let b = src.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(byte) = u8::from_str_radix(&src[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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

        // Resolve the session for this project (Node resolveSessionContext: first
        // session whose projectId matches, or the first session overall).
        let sessions = self.store.sessions().await;
        let session = sessions
            .iter()
            .find(|s| pid.is_none_or(|p| s.project_id.as_deref() == Some(p)));
        let Some(session) = session else {
            return Ok(envelope(json!({
                "summary": "No active session found. Connect an SDK first.",
                "data": null,
                "issues": ["No active sessions — connect an SDK with RuntimeScope.init()"],
                "metadata": { "timeRange": { "from": 0, "to": 0 }, "eventCount": 0, "sessionId": null, "projectId": args.project_id },
            })));
        };
        let session_id = session.session_id.clone();
        let app_name = session.app_name.clone();

        // Issue detection runs over the PROJECT's events (Node detectIssues uses
        // store.getAllEvents(.., project_id), not the single session).
        let network_proj = self.store.events_by_type("network", pid).await;
        let console_proj = self.store.events_by_type("console", pid).await;
        let issues = detect_issues(&network_proj, &console_proj);

        // Metrics: port of SessionManager.computeMetrics — over ALL events for the
        // session (every type, so totalEvents includes navigation/ui/custom and the
        // synthetic session connect event), not a fixed type whitelist.
        let etype = |e: &Value| -> String {
            e.get("eventType").and_then(Value::as_str).unwrap_or("").to_string()
        };
        let all_session: Vec<Value> = self
            .store
            .timeline(pid, None, None, None)
            .await
            .into_iter()
            .filter(|e| e.get("sessionId").and_then(Value::as_str) == Some(session_id.as_str()))
            .collect();
        let of = |t: &str| -> Vec<&Value> { all_session.iter().filter(|e| etype(e) == t).collect() };
        let network = of("network");
        let console = of("console");
        let render = of("render");
        let database = of("database");
        let performance = of("performance");

        let total_events = all_session.len();
        let error_count = console.iter().filter(|e| str_field(e, "level") == "error").count()
            + network.iter().filter(|e| num_field(e, "status") >= 400.0).count();
        // queryCount = distinct normalizedQuery.
        let queries: BTreeSet<String> = database
            .iter()
            .map(|e| str_field(e, "normalizedQuery").to_string())
            .collect();
        // componentCount = distinct componentName across each render event's profiles[].
        let mut components: BTreeSet<String> = BTreeSet::new();
        for re in &render {
            if let Some(profiles) = re.get("profiles").and_then(Value::as_array) {
                for p in profiles {
                    if let Some(name) = p.get("componentName").and_then(Value::as_str) {
                        components.insert(name.to_string());
                    }
                }
            }
        }
        // endpointCount = distinct "<method> <url>".
        let endpoints: BTreeSet<String> = network
            .iter()
            .map(|e| format!("{} {}", str_field(e, "method"), str_field(e, "url")))
            .collect();
        // webVitals: keyed by metricName, only entries carrying a rating (browser
        // Web Vitals, not server metrics).
        let mut web_vitals = serde_json::Map::new();
        for pe in &performance {
            let rating = pe.get("rating");
            if rating.is_some_and(|r| !r.is_null()) {
                if let Some(name) = pe.get("metricName").and_then(Value::as_str) {
                    web_vitals.insert(
                        name.to_string(),
                        json!({ "value": pe.get("value").cloned().unwrap_or(Value::Null), "rating": rating.cloned().unwrap_or(Value::Null) }),
                    );
                }
            }
        }

        let created_at = now_ms();
        let label = args.label.clone().unwrap_or_else(|| "qa-check".to_string());
        let metrics = json!({
            "totalEvents": total_events,
            "errorCount": error_count,
            "endpointCount": endpoints.len(),
            "componentCount": components.len(),
            "webVitals": Value::Object(web_vitals.clone()),
            "queryCount": queries.len(),
        });

        // Persist the snapshot so get_session_history / compare can read it back.
        // Surface a persistence failure in the summary instead of claiming "saved".
        let snapshot = self
            .store
            .save_snapshot(session_id.clone(), app_name.clone(), Some(label.clone()), created_at, metrics.clone())
            .await;
        let snapshot_id = *snapshot.as_ref().unwrap_or(&0);
        let snapshot_note = match &snapshot {
            Ok(_) => format!("Snapshot saved as \"{label}\"."),
            Err(e) => format!("⚠ Snapshot NOT persisted ({e})."),
        };

        let high = issues.iter().filter(|i| i.severity == "high").count();
        let medium = issues.iter().filter(|i| i.severity == "medium").count();
        let low = issues.iter().filter(|i| i.severity == "low").count();
        let issues_summary = if issues.is_empty() {
            "No issues detected.".to_string()
        } else {
            format!("{} issue(s): {high} high, {medium} medium, {low} low.", issues.len())
        };
        let metrics_summary = format!(
            "{total_events} events, {error_count} errors, {} endpoints, {} components",
            endpoints.len(),
            components.len()
        );
        let summary = format!(
            "QA Check complete. {snapshot_note} {metrics_summary}. {issues_summary}"
        );

        let data = json!({
            "snapshot": {
                "id": snapshot_id,
                "sessionId": session_id,
                "project": app_name,
                "label": label,
                "createdAt": iso_ms(created_at),
                "metrics": metrics,
            },
            "issues": issues.iter().map(issue_to_json).collect::<Vec<_>>(),
            "nextSteps": if issues.is_empty() {
                "All clear! Use compare_sessions later to track regressions."
            } else {
                "Fix the issues above, then run runtime_qa_check again to compare. Use compare_sessions with the snapshot ID to see what changed."
            },
        });

        let issue_lines: Vec<String> = issues
            .iter()
            .map(|i| format!("[{}] {}", i.severity.to_uppercase(), i.title))
            .collect();

        // metadata.webVitals: a human summary string ("LCP: 4200.0 (good)", joined
        // by ", "), or null when there are none (Node qa-check.ts parity).
        let web_vitals_summary: Value = if web_vitals.is_empty() {
            Value::Null
        } else {
            let parts: Vec<String> = web_vitals
                .iter()
                .map(|(name, v)| {
                    let value = match v.get("value") {
                        Some(Value::Number(n)) => format!("{:.1}", n.as_f64().unwrap_or(0.0)),
                        Some(other) => other.to_string(),
                        None => "0.0".to_string(),
                    };
                    let rating = v.get("rating").and_then(Value::as_str).unwrap_or("");
                    format!("{name}: {value} ({rating})")
                })
                .collect();
            json!(parts.join(", "))
        };

        Ok(envelope(json!({
            "summary": summary,
            "data": data,
            "issues": issue_lines,
            "metadata": {
                "timeRange": { "from": session.connected_at, "to": created_at },
                "eventCount": total_events,
                "sessionId": session_id,
                "projectId": args.project_id,
                "webVitals": web_vitals_summary,
            },
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
                let url = str_field(e, "url");
                let status = num_field(e, "status") as i64;
                let content_type = e
                    .get("responseHeaders")
                    .and_then(|h| h.get("content-type"))
                    .and_then(Value::as_str)
                    .unwrap_or("application/octet-stream");
                let mut request = json!({
                    "method": str_field(e, "method"),
                    "url": url,
                    "httpVersion": "HTTP/1.1",
                    "headers": headers_to_pairs(e.get("requestHeaders")),
                    "queryString": parse_query_string(url),
                    "headersSize": -1,
                    "bodySize": num_field(e, "requestBodySize") as i64,
                });
                // Optional postData (only when a request body was captured).
                if let Some(body) = e.get("requestBody").and_then(Value::as_str) {
                    let mime = e
                        .get("requestHeaders")
                        .and_then(|h| h.get("content-type"))
                        .and_then(Value::as_str)
                        .unwrap_or("application/octet-stream");
                    request["postData"] = json!({ "mimeType": mime, "text": body });
                }
                let mut content = json!({
                    "size": num_field(e, "responseBodySize") as i64,
                    "mimeType": content_type,
                });
                if let Some(body) = e.get("responseBody").and_then(Value::as_str) {
                    content["text"] = json!(body);
                }
                json!({
                    "startedDateTime": iso_ms(num_field(e, "timestamp") as i64),
                    "time": duration.round() as i64,
                    "request": request,
                    "response": {
                        "status": status,
                        "statusText": status_text(status),
                        "httpVersion": "HTTP/1.1",
                        "headers": headers_to_pairs(e.get("responseHeaders")),
                        "content": content,
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

        let ts = |e: &Value| num_field(e, "timestamp") as i64;
        let time_range = if events.is_empty() {
            json!({ "from": 0, "to": 0 })
        } else {
            json!({ "from": ts(events[0]), "to": ts(events[events.len() - 1]) })
        };
        let session_id = self
            .store
            .sessions()
            .await
            .into_iter()
            .find(|s| args.project_id.as_deref().is_none_or(|p| s.project_id.as_deref() == Some(p)))
            .map(|s| s.session_id);

        Ok(envelope(json!({
            "summary": summary,
            "data": har,
            "issues": [],
            "metadata": {
                "timeRange": time_range,
                "eventCount": events.len(),
                "totalCount": all.len(),
                "truncated": truncated,
                "sessionId": session_id,
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
            "metadata": { "deferred": true, "eventCount": 0, "projectId": args.project_id },
        })))
    }
}
