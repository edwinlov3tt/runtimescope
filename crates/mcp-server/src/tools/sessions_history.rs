//! Session-diff + history tools: list_projects, get_session_history,
//! get_historical_events (real where the store supports it) plus the
//! snapshot-based tools (compare_sessions, create_session_snapshot,
//! get_session_snapshots) which are deferred until the Rust store grows a
//! snapshot/SessionManager facility.

use crate::tools::envelope;
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CompareSessionsArgs {
    /// First session ID (baseline) — used when comparing sessions.
    session_a: Option<String>,
    /// Second session ID (comparison) — used when comparing sessions.
    session_b: Option<String>,
    /// First snapshot ID (baseline) — used when comparing snapshots.
    snapshot_a: Option<i64>,
    /// Second snapshot ID (comparison) — used when comparing snapshots.
    snapshot_b: Option<i64>,
    /// Project name.
    project: Option<String>,
    /// Scope to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateSnapshotArgs {
    /// Session ID (defaults to first active session).
    session_id: Option<String>,
    /// Label for this snapshot (e.g., "before-fix", "baseline").
    label: Option<String>,
    /// Project name.
    project: Option<String>,
    /// Scope to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetSnapshotsArgs {
    /// Session ID.
    session_id: String,
    /// Project name.
    project: Option<String>,
    /// Scope to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SessionHistoryArgs {
    /// Project name.
    project: Option<String>,
    /// Max sessions to return (default 20).
    limit: Option<usize>,
    /// Scope to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct HistoricalEventsArgs {
    /// Project/app name (the appName used in SDK init).
    project: Option<String>,
    /// Project ID (proj_xxx). Alternative to project name.
    project_id: Option<String>,
    /// Filter by event types (e.g., ["network", "console"]).
    event_types: Option<Vec<String>>,
    /// Filter by specific session ID.
    session_id: Option<String>,
    /// Max events to return (default 200, max 1000).
    limit: Option<usize>,
    /// Pagination offset.
    offset: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListProjectsArgs {
    /// Scope to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
}

#[tool_router(router = sessions_history_router, vis = "pub")]
impl Mcp {
    #[tool(description = "Compare two sessions or two snapshots: render counts, API latency, errors, Web Vitals, and query performance. Deferred — the Rust collector does not yet persist session snapshots.")]
    async fn compare_sessions(
        &self,
        Parameters(args): Parameters<CompareSessionsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = (
            &args.session_a,
            &args.session_b,
            &args.snapshot_a,
            &args.snapshot_b,
            &args.project,
        );
        Ok(envelope(json!({
            "summary": "compare_sessions is deferred: session snapshots are not yet implemented in the Rust collector.",
            "data": null,
            "issues": ["Snapshot comparison requires the SessionManager facility, not yet ported to Rust."],
            "metadata": { "deferred": true, "eventCount": 0, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Capture a point-in-time snapshot of a live or recent session. Deferred — the Rust collector does not yet persist session snapshots.")]
    async fn create_session_snapshot(
        &self,
        Parameters(args): Parameters<CreateSnapshotArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = (&args.session_id, &args.label, &args.project);
        Ok(envelope(json!({
            "summary": "create_session_snapshot is deferred: session snapshots are not yet implemented in the Rust collector.",
            "data": null,
            "issues": ["Snapshot capture requires the SessionManager facility, not yet ported to Rust."],
            "metadata": { "deferred": true, "eventCount": 0, "projectId": args.project_id },
        })))
    }

    #[tool(description = "List all snapshots for a session. Deferred — the Rust collector does not yet persist session snapshots.")]
    async fn get_session_snapshots(
        &self,
        Parameters(args): Parameters<GetSnapshotsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = (&args.session_id, &args.project);
        Ok(envelope(json!({
            "summary": "get_session_snapshots is deferred: session snapshots are not yet implemented in the Rust collector.",
            "data": null,
            "issues": ["Snapshot listing requires the SessionManager facility, not yet ported to Rust."],
            "metadata": { "deferred": true, "eventCount": 0, "projectId": args.project_id },
        })))
    }

    #[tool(description = "List past sessions with event counts and timestamps. Derived from the live session registry.")]
    async fn get_session_history(
        &self,
        Parameters(args): Parameters<SessionHistoryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(20);
        // History is addressed by appName (Node: getSessionHistory(project)).
        // Resolve a project_id arg to its appName via the session registry.
        let project = match (&args.project, &args.project_id) {
            (Some(p), _) => p.clone(),
            (None, Some(pid)) => self
                .store
                .sessions()
                .await
                .iter()
                .find(|s| s.project_id.as_deref() == Some(pid.as_str()))
                .map(|s| s.app_name.clone())
                .unwrap_or_else(|| "default".to_string()),
            _ => "default".to_string(),
        };

        let history = self.store.session_history(&project, limit).await;
        let m = |snap: &collector_core::store::SnapshotRow, key: &str| -> i64 {
            snap.metrics.get(key).and_then(Value::as_i64).unwrap_or(0)
        };
        let data: Vec<Value> = history
            .iter()
            .map(|s| {
                json!({
                    "sessionId": s.session_id,
                    "project": s.project,
                    "createdAt": crate::tools::iso_ms(s.created_at),
                    "totalEvents": m(s, "totalEvents"),
                    "errorCount": m(s, "errorCount"),
                    "endpointCount": m(s, "endpointCount"),
                    "componentCount": m(s, "componentCount"),
                    "buildMeta": Value::Null,
                })
            })
            .collect();
        let count = data.len();
        let time_range = if history.is_empty() {
            json!({ "from": 0, "to": 0 })
        } else {
            json!({ "from": history[history.len() - 1].created_at, "to": history[0].created_at })
        };
        Ok(envelope(json!({
            "summary": format!("{count} session(s) in history for project \"{project}\"."),
            "data": data,
            "issues": [],
            "metadata": { "timeRange": time_range, "eventCount": count, "sessionId": null },
        })))
    }

    #[tool(description = "Query past events from the collector store. Filter by event type, session, and project. Returns newest-first.")]
    async fn get_historical_events(
        &self,
        Parameters(args): Parameters<HistoricalEventsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let capped_limit = args.limit.unwrap_or(200).min(1000);
        let offset = args.offset.unwrap_or(0);

        // Default to the common event types if none requested.
        let default_types = [
            "network",
            "console",
            "session",
            "state",
            "render",
            "performance",
            "database",
        ];
        let requested: Vec<String> = match &args.event_types {
            Some(types) if !types.is_empty() => types.clone(),
            _ => default_types.iter().map(|s| s.to_string()).collect(),
        };

        // Resolve the event-scoping key. Events are stored under
        // projectId-when-present-else-appName; history is addressed by appName
        // (Node's per-app SQLite store), so map appName → its session's scope key.
        let project_filter: Option<String> = if let Some(pid) = &args.project_id {
            Some(pid.clone())
        } else if let Some(app) = &args.project {
            self.store
                .sessions()
                .await
                .iter()
                .find(|s| &s.app_name == app)
                .map(|s| s.project_key().to_string())
                .or_else(|| Some(app.clone()))
        } else {
            None
        };
        let project_filter = project_filter.as_deref();

        let mut collected: Vec<Value> = Vec::new();
        for ty in &requested {
            let mut events = self.store.events_by_type(ty, project_filter).await;
            if let Some(sid) = &args.session_id {
                events.retain(|e| e.get("sessionId").and_then(Value::as_str) == Some(sid.as_str()));
            }
            collected.extend(events);
        }

        let total = collected.len();
        let page: Vec<Value> = collected.into_iter().skip(offset).take(capped_limit).collect();
        let returned = page.len();

        // Group by event type for the summary.
        let mut type_counts: BTreeMap<String, usize> = BTreeMap::new();
        for e in &page {
            let ty = e
                .get("eventType")
                .or_else(|| e.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            *type_counts.entry(ty).or_insert(0) += 1;
        }
        let breakdown = type_counts
            .iter()
            .map(|(t, c)| format!("{t}: {c}"))
            .collect::<Vec<_>>()
            .join(", ");
        let has_more = offset + capped_limit < total;
        let ts = |e: &Value| e.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
        let time_range = if page.is_empty() {
            json!({ "from": 0, "to": 0 })
        } else {
            json!({ "from": ts(&page[0]), "to": ts(&page[page.len() - 1]) })
        };

        Ok(envelope(json!({
            "summary": format!(
                "{returned} event(s) returned ({total} total matching). {}",
                if breakdown.is_empty() { "No events.".to_string() } else { breakdown }
            ),
            "data": {
                "events": page,
                "pagination": {
                    "returned": returned,
                    "total": total,
                    "limit": capped_limit,
                    "offset": offset,
                    "hasMore": has_more,
                },
            },
            "issues": [],
            "metadata": {
                "timeRange": time_range,
                "eventCount": returned,
                "sessionId": args.session_id,
            },
        })))
    }

    #[tool(description = "List all projects with active SDK sessions. Shows project names, app names, session counts, and connection state.")]
    async fn list_projects(
        &self,
        Parameters(args): Parameters<ListProjectsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sessions = self.store.sessions().await;

        // Aggregate by APP NAME (Node keys projects by appName / per-app SQLite
        // store), tracking the event-scoping key so we can count persisted events.
        struct Agg {
            session_count: usize,
            active_sessions: usize,
            scope: String,
            project_id: Option<String>,
        }
        let mut by_app: BTreeMap<String, Agg> = BTreeMap::new();
        for s in &sessions {
            if let Some(p) = &args.project_id {
                if s.project_key() != p {
                    continue;
                }
            }
            let entry = by_app.entry(s.app_name.clone()).or_insert(Agg {
                session_count: 0,
                active_sessions: 0,
                scope: s.project_key().to_string(),
                project_id: s.project_id.clone(),
            });
            entry.session_count += 1;
            if s.is_connected {
                entry.active_sessions += 1;
            }
        }

        let mut data: Vec<Value> = Vec::with_capacity(by_app.len());
        for (name, agg) in &by_app {
            let event_count = self.store.event_count(Some(&agg.scope)).await;
            data.push(json!({
                "name": name,
                "projectId": agg.project_id,
                "eventCount": event_count,
                "sessionCount": agg.session_count,
                "activeSessions": agg.active_sessions,
                "isConnected": agg.active_sessions > 0,
            }));
        }

        let project_count = data.len();
        let total_events: u64 = data.iter().map(|p| p["eventCount"].as_u64().unwrap_or(0)).sum();
        let connected_count = data.iter().filter(|p| p["isConnected"] == json!(true)).count();
        Ok(envelope(json!({
            "summary": format!("{project_count} project(s), {total_events} total events, {connected_count} currently connected."),
            "data": data,
            "issues": [],
            "metadata": { "timeRange": { "from": 0, "to": 0 }, "eventCount": project_count, "sessionId": null },
        })))
    }
}
