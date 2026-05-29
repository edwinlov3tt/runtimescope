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
            "metadata": { "eventCount": 0, "projectId": args.project_id },
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
            "metadata": { "eventCount": 0, "projectId": args.project_id },
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
            "metadata": { "eventCount": 0, "projectId": args.project_id },
        })))
    }

    #[tool(description = "List past sessions with event counts and timestamps. Derived from the live session registry.")]
    async fn get_session_history(
        &self,
        Parameters(args): Parameters<SessionHistoryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(20);
        let sessions = self.store.sessions().await;
        let data: Vec<Value> = sessions
            .iter()
            .filter(|s| args.project.as_ref().is_none_or(|p| &s.project == p))
            .filter(|s| args.project_id.as_ref().is_none_or(|p| &s.project == p))
            .take(limit)
            .map(|s| {
                json!({
                    "sessionId": s.session_id,
                    "project": s.project,
                    "appName": s.app_name,
                    "isConnected": s.is_connected,
                })
            })
            .collect();
        let count = data.len();
        let scope = args
            .project
            .clone()
            .or_else(|| args.project_id.clone())
            .unwrap_or_else(|| "all".to_string());
        Ok(envelope(json!({
            "summary": format!("{count} session(s) in history for \"{scope}\"."),
            "data": data,
            "issues": [],
            "metadata": { "eventCount": count, "projectId": args.project_id },
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

        let project_filter = args.project_id.as_deref().or(args.project.as_deref());

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
            "metadata": { "eventCount": returned, "projectId": args.project_id },
        })))
    }

    #[tool(description = "List all projects with active SDK sessions. Shows project names, app names, session counts, and connection state.")]
    async fn list_projects(
        &self,
        Parameters(args): Parameters<ListProjectsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sessions = self.store.sessions().await;

        // Aggregate sessions into distinct projects.
        struct Agg {
            session_count: usize,
            active_sessions: usize,
            apps: std::collections::BTreeSet<String>,
        }
        let mut by_project: BTreeMap<String, Agg> = BTreeMap::new();
        for s in &sessions {
            if let Some(p) = &args.project_id {
                if &s.project != p {
                    continue;
                }
            }
            let entry = by_project.entry(s.project.clone()).or_insert(Agg {
                session_count: 0,
                active_sessions: 0,
                apps: std::collections::BTreeSet::new(),
            });
            entry.session_count += 1;
            if s.is_connected {
                entry.active_sessions += 1;
            }
            entry.apps.insert(s.app_name.clone());
        }

        let data: Vec<Value> = by_project
            .iter()
            .map(|(name, agg)| {
                json!({
                    "name": name,
                    "apps": agg.apps.iter().cloned().collect::<Vec<_>>(),
                    "sessionCount": agg.session_count,
                    "activeSessions": agg.active_sessions,
                    "isConnected": agg.active_sessions > 0,
                })
            })
            .collect();

        let project_count = data.len();
        let connected_count = data.iter().filter(|p| p["isConnected"] == json!(true)).count();
        Ok(envelope(json!({
            "summary": format!("{project_count} project(s), {connected_count} currently connected."),
            "data": data,
            "issues": [],
            "metadata": { "eventCount": project_count, "projectId": args.project_id },
        })))
    }
}
