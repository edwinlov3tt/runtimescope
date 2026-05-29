//! API Discovery tools — analyze captured `network` events to derive an endpoint
//! catalog, per-endpoint health, a service topology map, generated documentation,
//! and a cross-session diff. Ports `packages/mcp-server/src/tools/api-discovery.ts`
//! (and the slice of `collector/src/engines/api-discovery.ts` it relies on),
//! simplified to a self-contained pass over the stored network events.

use crate::tools::envelope;
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

// --- Arg structs ---

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ApiCatalogArgs {
    /// Scope results to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
    /// Filter by service name (e.g. "Supabase", "Your API").
    service: Option<String>,
    /// Only show endpoints with at least N calls.
    min_calls: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ApiHealthArgs {
    project_id: Option<String>,
    /// Filter by endpoint path substring.
    endpoint: Option<String>,
    /// Only consider requests from the last N seconds.
    since_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ApiDocsArgs {
    project_id: Option<String>,
    /// Generate docs for a specific service only.
    service: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ServiceMapArgs {
    project_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ApiChangesArgs {
    project_id: Option<String>,
    /// First session ID.
    session_a: String,
    /// Second session ID.
    session_b: String,
}

// --- URL / service / auth helpers (ported from the engine) ---

fn is_numeric(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && parts.iter().all(|p| is_hex(p))
}

/// Replace high-cardinality path segments (ids, hashes) with `:id` so endpoints
/// that differ only by a resource id collapse into one normalized path.
fn normalize_segment(seg: &str) -> String {
    if is_uuid(seg) || is_numeric(seg) {
        return ":id".to_string();
    }
    // Mongo-style 24-char hex id, or long hex/alnum hashes.
    if seg.len() == 24 && is_hex(seg) {
        return ":id".to_string();
    }
    let alnum = !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_alphanumeric());
    if alnum && seg.len() >= 16 {
        return ":id".to_string();
    }
    if seg.len() >= 8 && is_hex(seg) {
        return ":id".to_string();
    }
    seg.to_string()
}

/// Parse `scheme://host[:port]/path...` into (origin, host, normalized-path).
/// Falls back to ("unknown", "unknown", raw-url) on anything unparseable.
fn normalize_url(url: &str) -> (String, String, String) {
    let scheme_end = match url.find("://") {
        Some(i) => i + 3,
        None => return ("unknown".into(), "unknown".into(), url.to_string()),
    };
    let scheme = &url[..url.find("://").unwrap()];
    let rest = &url[scheme_end..];
    let (authority, path_and_q) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return ("unknown".into(), "unknown".into(), url.to_string());
    }
    let origin = format!("{scheme}://{authority}");
    // Strip userinfo + port to get the bare hostname.
    let host_part = authority.rsplit('@').next().unwrap_or(authority);
    let hostname = host_part.split(':').next().unwrap_or(host_part).to_string();
    // Drop the query string, then normalize each path segment.
    let path = path_and_q.split(['?', '#']).next().unwrap_or(path_and_q);
    let normalized: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(normalize_segment)
        .collect();
    (origin, hostname, format!("/{}", normalized.join("/")))
}

const SERVICE_PATTERNS: &[(&str, &str)] = &[
    (".supabase.co", "Supabase"),
    (".workers.dev", "Cloudflare Workers"),
    (".vercel.app", "Vercel"),
    ("api.stripe.com", "Stripe"),
    (".railway.app", "Railway"),
    (".netlify.app", "Netlify"),
    (".fly.dev", "Fly.io"),
    (".render.com", "Render"),
    ("api.github.com", "GitHub API"),
    ("api.openai.com", "OpenAI"),
    ("api.anthropic.com", "Anthropic"),
    (".clerk.dev", "Clerk"),
    (".auth0.com", "Auth0"),
    (".firebaseio.com", "Firebase"),
    (".firebaseapp.com", "Firebase"),
    (".amazonaws.com", "AWS"),
    (".googleapis.com", "Google APIs"),
];

fn detect_service(hostname: &str) -> String {
    if hostname == "localhost" || hostname == "127.0.0.1" {
        return "Your API".to_string();
    }
    for (suffix, name) in SERVICE_PATTERNS {
        // Patterns that begin with '.' are host suffixes; the rest are exact hosts.
        let matched = if let Some(bare) = suffix.strip_prefix('.') {
            hostname.ends_with(suffix) || hostname == bare
        } else {
            hostname == *suffix
        };
        if matched {
            return name.to_string();
        }
    }
    // Derive a registrable-ish name: api.example.com -> example.com
    let parts: Vec<&str> = hostname.split('.').collect();
    if parts.len() >= 2 {
        return parts[parts.len() - 2..].join(".");
    }
    hostname.to_string()
}

/// Best-effort platform tag for a service name (null when unrecognized).
fn detect_platform(service: &str) -> Option<&'static str> {
    match service {
        "Supabase" => Some("supabase"),
        "Cloudflare Workers" => Some("cloudflare"),
        "Vercel" => Some("vercel"),
        "Stripe" => Some("stripe"),
        "Railway" => Some("railway"),
        "Netlify" => Some("netlify"),
        "Fly.io" => Some("fly"),
        "Render" => Some("render"),
        "Firebase" => Some("firebase"),
        "AWS" => Some("aws"),
        _ => None,
    }
}

/// Case-insensitive lookup over an event's `requestHeaders` object.
fn header<'a>(headers: Option<&'a Value>, name: &str) -> Option<&'a str> {
    let obj = headers?.as_object()?;
    obj.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .and_then(|(_, v)| v.as_str())
}

fn detect_auth(headers: Option<&Value>) -> String {
    if let Some(auth) = header(headers, "authorization") {
        if auth.starts_with("Bearer ") {
            return "bearer".to_string();
        }
        if auth.starts_with("Basic ") {
            return "basic".to_string();
        }
        return "api_key".to_string();
    }
    if let Some(obj) = headers.and_then(Value::as_object) {
        for k in obj.keys() {
            let lower = k.to_ascii_lowercase();
            if lower.contains("api-key") || lower.contains("apikey") || lower == "x-api-key" {
                return "api_key".to_string();
            }
        }
    }
    if header(headers, "cookie").is_some() {
        return "cookie".to_string();
    }
    "none".to_string()
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() as f64 * (p / 100.0)).ceil() as isize - 1).max(0) as usize;
    sorted[idx.min(sorted.len() - 1)]
}

// --- Aggregation core ---

/// One normalized endpoint accumulated from many network events.
#[derive(Default)]
struct Endpoint {
    method: String,
    normalized_path: String,
    base_url: String,
    hostname: String,
    service: String,
    auth: String,
    call_count: u64,
    error_count: u64,
    first_seen: i64,
    last_seen: i64,
    durations: Vec<f64>,
    error_codes: BTreeMap<String, u64>,
}

fn ev_str<'a>(e: &'a Value, key: &str) -> Option<&'a str> {
    e.get(key).and_then(Value::as_str)
}

/// Fold a flat list of `network` events into a map of normalized endpoints,
/// keyed by "METHOD origin+path".
fn build_endpoints(events: &[Value]) -> BTreeMap<String, Endpoint> {
    let mut map: BTreeMap<String, Endpoint> = BTreeMap::new();
    for e in events {
        let url = ev_str(e, "url").unwrap_or("");
        if url.is_empty() {
            continue;
        }
        let method = ev_str(e, "method").unwrap_or("GET").to_uppercase();
        let (base_url, hostname, normalized_path) = normalize_url(url);
        let key = format!("{method} {base_url}{normalized_path}");
        let status = e.get("status").and_then(Value::as_i64).unwrap_or(0);
        let duration = e.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        let ts = e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);

        let ep = map.entry(key).or_insert_with(|| Endpoint {
            method: method.clone(),
            normalized_path: normalized_path.clone(),
            base_url: base_url.clone(),
            hostname: hostname.clone(),
            service: detect_service(&hostname),
            auth: detect_auth(e.get("requestHeaders")),
            first_seen: ts,
            last_seen: ts,
            ..Default::default()
        });
        ep.call_count += 1;
        ep.durations.push(duration);
        if ts != 0 {
            if ep.first_seen == 0 || ts < ep.first_seen {
                ep.first_seen = ts;
            }
            if ts > ep.last_seen {
                ep.last_seen = ts;
            }
        }
        if status >= 400 || status == 0 {
            ep.error_count += 1;
            ep.error_codes
                .entry(status.to_string())
                .and_modify(|c| *c += 1)
                .or_insert(1);
        }
    }
    map
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn iso(ms: i64) -> Value {
    // Keep this dependency-free: surface the raw epoch-ms rather than pulling a
    // datetime crate. Callers that need a string can format downstream.
    json!(ms)
}

/// Pick the most recent connected session for the project (used only to surface
/// a sessionId in tool metadata, mirroring resolveSessionContext in the TS tool).
async fn session_id_for(mcp: &Mcp, project_id: Option<&str>) -> Option<String> {
    mcp.store
        .sessions()
        .await
        .into_iter()
        .find(|s| project_id.is_none_or(|p| s.project == p))
        .map(|s| s.session_id)
}

#[tool_router(router = api_discovery_router, vis = "pub")]
impl Mcp {
    #[tool(
        description = "Discover all API endpoints the app is communicating with, auto-grouped by service. Shows normalized paths, call counts, auth patterns, and timing."
    )]
    async fn get_api_catalog(
        &self,
        Parameters(args): Parameters<ApiCatalogArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = self.store.events_by_type("network", args.project_id.as_deref()).await;
        let endpoints = build_endpoints(&events);

        let min_calls = args.min_calls.unwrap_or(0);
        let filtered: Vec<&Endpoint> = endpoints
            .values()
            .filter(|ep| args.service.as_ref().is_none_or(|s| &ep.service == s))
            .filter(|ep| ep.call_count >= min_calls)
            .collect();

        // Service rollup for the `services` block.
        let services = service_map(&endpoints);

        let endpoint_data: Vec<Value> = filtered
            .iter()
            .map(|ep| {
                json!({
                    "method": ep.method,
                    "path": ep.normalized_path,
                    "service": ep.service,
                    "callCount": ep.call_count,
                    "auth": ep.auth,
                    "firstSeen": iso(ep.first_seen),
                    "lastSeen": iso(ep.last_seen),
                    "responseFields": 0,
                })
            })
            .collect();

        let total_calls: u64 = filtered.iter().map(|ep| ep.call_count).sum();
        let from = filtered.iter().map(|ep| ep.first_seen).min().unwrap_or(0);
        let to = filtered.iter().map(|ep| ep.last_seen).max().unwrap_or(0);
        let session_id = session_id_for(self, args.project_id.as_deref()).await;

        Ok(envelope(json!({
            "summary": format!(
                "Discovered {} API endpoint(s) across {} service(s).",
                endpoint_data.len(),
                services.len()
            ),
            "data": { "services": services, "endpoints": endpoint_data },
            "issues": [],
            "metadata": {
                "timeRange": { "from": from, "to": to },
                "eventCount": total_calls,
                "sessionId": session_id,
                "projectId": args.project_id,
            },
        })))
    }

    #[tool(
        description = "Get health metrics for discovered API endpoints: success rate, latency percentiles (p50/p95), error rates and error codes."
    )]
    async fn get_api_health(
        &self,
        Parameters(args): Parameters<ApiHealthArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = self.store.events_by_type("network", args.project_id.as_deref()).await;

        // Optional time-window filter on the raw events before aggregating.
        let cutoff = args.since_seconds.map(|s| now_ms() - (s as i64) * 1000);
        let scoped: Vec<Value> = events
            .into_iter()
            .filter(|e| {
                cutoff.is_none_or(|c| e.get("timestamp").and_then(Value::as_i64).unwrap_or(0) >= c)
            })
            .collect();

        let endpoints = build_endpoints(&scoped);

        let mut health: Vec<Value> = Vec::new();
        let mut issues: Vec<String> = Vec::new();
        let mut total_calls: u64 = 0;

        for ep in endpoints.values() {
            if let Some(filter) = &args.endpoint {
                if !ep.normalized_path.contains(filter) {
                    continue;
                }
            }
            let mut durs = ep.durations.clone();
            durs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let avg = if durs.is_empty() {
                0.0
            } else {
                durs.iter().sum::<f64>() / durs.len() as f64
            };
            let error_rate = if ep.call_count > 0 {
                ep.error_count as f64 / ep.call_count as f64
            } else {
                0.0
            };
            let success_rate = 1.0 - error_rate;
            let p50 = percentile(&durs, 50.0);
            let p95 = percentile(&durs, 95.0);
            total_calls += ep.call_count;

            if error_rate > 0.5 {
                issues.push(format!(
                    "{} {}: {:.0}% error rate",
                    ep.method,
                    ep.normalized_path,
                    error_rate * 100.0
                ));
            }
            if p95 > 5000.0 {
                issues.push(format!(
                    "{} {}: p95 latency {:.1}s",
                    ep.method,
                    ep.normalized_path,
                    p95 / 1000.0
                ));
            }

            let codes: Map<String, Value> = ep
                .error_codes
                .iter()
                .map(|(k, v)| (k.clone(), json!(v)))
                .collect();

            health.push(json!({
                "method": ep.method,
                "path": ep.normalized_path,
                "service": ep.service,
                "callCount": ep.call_count,
                "successRate": format!("{:.1}%", success_rate * 100.0),
                "avgLatency": format!("{:.0}ms", avg),
                "p50Latency": format!("{:.0}ms", p50),
                "p95Latency": format!("{:.0}ms", p95),
                "errorRate": format!("{:.1}%", error_rate * 100.0),
                "errorCodes": Value::Object(codes),
            }));
        }

        let session_id = session_id_for(self, args.project_id.as_deref()).await;
        let issue_note = if issues.is_empty() {
            String::new()
        } else {
            format!(" {} issue(s) found.", issues.len())
        };

        Ok(envelope(json!({
            "summary": format!("Health report for {} endpoint(s).{}", health.len(), issue_note),
            "data": health,
            "issues": issues,
            "metadata": {
                "timeRange": { "from": 0, "to": now_ms() },
                "eventCount": total_calls,
                "sessionId": session_id,
                "projectId": args.project_id,
            },
        })))
    }

    #[tool(
        description = "Generate API documentation from observed network traffic. Shows endpoints, auth, and latency in markdown."
    )]
    async fn get_api_documentation(
        &self,
        Parameters(args): Parameters<ApiDocsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = self.store.events_by_type("network", args.project_id.as_deref()).await;
        let endpoints = build_endpoints(&events);

        // Group endpoints by service, honoring the optional service filter.
        let mut by_service: BTreeMap<String, Vec<&Endpoint>> = BTreeMap::new();
        for ep in endpoints.values() {
            if args.service.as_ref().is_none_or(|s| &ep.service == s) {
                by_service.entry(ep.service.clone()).or_default().push(ep);
            }
        }

        let mut md = String::from("# API Documentation\n\n");
        md.push_str("_Generated from observed network traffic by RuntimeScope._\n\n");
        if by_service.is_empty() {
            md.push_str("No API traffic observed yet.\n");
        }
        for (service, eps) in &by_service {
            md.push_str(&format!("## {service}\n\n"));
            for ep in eps {
                md.push_str(&format!("### `{} {}`\n\n", ep.method, ep.normalized_path));
                md.push_str(&format!("- Base URL: {}\n", ep.base_url));
                md.push_str(&format!("- Auth: {}\n", ep.auth));
                md.push_str(&format!("- Calls: {}\n", ep.call_count));
                let error_rate = if ep.call_count > 0 {
                    ep.error_count as f64 / ep.call_count as f64
                } else {
                    0.0
                };
                md.push_str(&format!("- Error Rate: {:.1}%\n\n", error_rate * 100.0));
            }
        }

        // get_api_documentation returns raw markdown text (matching the TS tool,
        // which bypasses the standard envelope and returns docs directly).
        Ok(envelope(json!(md)))
    }

    #[tool(
        description = "Get a topology map of all external services the app talks to, including detected platforms (Supabase, Vercel, Stripe, etc.), call counts, and latency."
    )]
    async fn get_service_map(
        &self,
        Parameters(args): Parameters<ServiceMapArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = self.store.events_by_type("network", args.project_id.as_deref()).await;
        let endpoints = build_endpoints(&events);
        let services = service_map(&endpoints);
        let total_calls: i64 = services
            .iter()
            .map(|s| s.get("totalCalls").and_then(Value::as_i64).unwrap_or(0))
            .sum();
        let session_id = session_id_for(self, args.project_id.as_deref()).await;

        Ok(envelope(json!({
            "summary": format!("{} service(s) detected from network traffic.", services.len()),
            "data": services,
            "issues": [],
            "metadata": {
                "timeRange": { "from": 0, "to": now_ms() },
                "eventCount": total_calls,
                "sessionId": session_id,
                "projectId": args.project_id,
            },
        })))
    }

    #[tool(
        description = "Compare API endpoints between two sessions. Detects added/removed endpoints across the two captures."
    )]
    async fn get_api_changes(
        &self,
        Parameters(args): Parameters<ApiChangesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = self.store.events_by_type("network", args.project_id.as_deref()).await;

        // Partition raw events by sessionId, then build an endpoint set per side.
        let split = |sid: &str| -> Vec<Value> {
            events
                .iter()
                .filter(|e| ev_str(e, "sessionId") == Some(sid))
                .cloned()
                .collect()
        };
        let eps_a = build_endpoints(&split(&args.session_a));
        let eps_b = build_endpoints(&split(&args.session_b));

        let mut changes: Vec<Value> = Vec::new();
        let mut added = 0;
        let mut removed = 0;

        // Present in B but not A => added.
        for (key, ep) in &eps_b {
            if !eps_a.contains_key(key) {
                added += 1;
                changes.push(json!({
                    "changeType": "added",
                    "method": ep.method,
                    "path": ep.normalized_path,
                    "service": ep.service,
                }));
            }
        }
        // Present in A but not B => removed.
        for (key, ep) in &eps_a {
            if !eps_b.contains_key(key) {
                removed += 1;
                changes.push(json!({
                    "changeType": "removed",
                    "method": ep.method,
                    "path": ep.normalized_path,
                    "service": ep.service,
                }));
            }
        }

        let session_id = session_id_for(self, args.project_id.as_deref()).await;
        let issues: Vec<String> = if removed > 0 {
            vec![format!(
                "{removed} endpoint(s) no longer called — may indicate removed features or routing changes"
            )]
        } else {
            Vec::new()
        };

        Ok(envelope(json!({
            "summary": format!(
                "{} API change(s) between sessions: {} added, {} removed, 0 modified.",
                changes.len(), added, removed
            ),
            "data": changes,
            "issues": issues,
            "metadata": {
                "timeRange": { "from": 0, "to": now_ms() },
                "eventCount": changes.len(),
                "sessionId": session_id,
                "projectId": args.project_id,
            },
        })))
    }
}

/// Roll up per-endpoint stats into a per-service topology (shared by catalog,
/// service map, and docs). Returns ready-to-serialize JSON objects.
fn service_map(endpoints: &BTreeMap<String, Endpoint>) -> Vec<Value> {
    struct Agg {
        base_url: String,
        hostname: String,
        endpoint_count: u64,
        total_calls: u64,
        error_count: u64,
        duration_sum: f64,
        duration_n: u64,
        auth: String,
    }
    let mut by_service: BTreeMap<String, Agg> = BTreeMap::new();
    for ep in endpoints.values() {
        let agg = by_service.entry(ep.service.clone()).or_insert_with(|| Agg {
            base_url: ep.base_url.clone(),
            hostname: ep.hostname.clone(),
            endpoint_count: 0,
            total_calls: 0,
            error_count: 0,
            duration_sum: 0.0,
            duration_n: 0,
            auth: ep.auth.clone(),
        });
        agg.endpoint_count += 1;
        agg.total_calls += ep.call_count;
        agg.error_count += ep.error_count;
        agg.duration_sum += ep.durations.iter().sum::<f64>();
        agg.duration_n += ep.durations.len() as u64;
    }

    by_service
        .into_iter()
        .map(|(name, a)| {
            let avg = if a.duration_n > 0 {
                a.duration_sum / a.duration_n as f64
            } else {
                0.0
            };
            let error_rate = if a.total_calls > 0 {
                a.error_count as f64 / a.total_calls as f64
            } else {
                0.0
            };
            json!({
                "name": name,
                "baseUrl": a.base_url,
                "endpointCount": a.endpoint_count,
                "totalCalls": a.total_calls,
                "avgLatency": format!("{:.0}ms", avg),
                "errorRate": format!("{:.1}%", error_rate * 100.0),
                "auth": a.auth,
                "detectedPlatform": detect_platform(&detect_service(&a.hostname)),
            })
        })
        .collect()
}
