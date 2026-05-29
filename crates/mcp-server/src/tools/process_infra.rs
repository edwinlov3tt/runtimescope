//! Process-monitor + infra-connector tools. All deferred stubs for now: these
//! need OS process inspection and external infra-platform APIs the Rust
//! collector does not have yet. Each tool registers with the correct args and
//! returns a valid envelope whose data is null and summary marks it deferred.

// Stub args feed the MCP input schema (schemars JsonSchema derive) but aren't
// read yet — not dead code, the lint can't see through the derive. Revisit when
// these grow real OS/infra implementations (M4).
#![allow(dead_code)]

use crate::tools::envelope;
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DevProcessesArgs {
    /// Filter by process type (next, vite, docker, postgres, etc.)
    r#type: Option<String>,
    /// Filter by project name.
    project: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PortUsageArgs {
    /// Filter by specific port number.
    port: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct KillProcessArgs {
    /// Process ID to kill.
    pid: u32,
    /// Signal to send (default: SIGTERM).
    signal: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PurgeCachesArgs {
    /// Absolute path to the project directory.
    directory: String,
    /// If true, report what would be deleted without actually deleting.
    dry_run: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RestartDevServerArgs {
    /// PID of the dev server process to restart.
    pid: u32,
    /// Custom start command (e.g. "npm run dev"). If omitted, infers from process type.
    command: Option<String>,
    /// If true, skip cache purging (default: false).
    skip_cache_purge: Option<bool>,
    /// Kill signal (default: SIGTERM).
    signal: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DeployLogsArgs {
    /// Project name.
    project: Option<String>,
    /// Filter by platform (vercel, cloudflare, railway).
    platform: Option<String>,
    /// Get details for a specific deployment.
    deploy_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RuntimeLogsArgs {
    /// Project name.
    project: Option<String>,
    /// Filter by platform.
    platform: Option<String>,
    /// Filter by log level (info, warn, error).
    level: Option<String>,
    /// Only return logs from the last N seconds.
    since_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct BuildStatusArgs {
    /// Project name.
    project: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct InfraOverviewArgs {
    /// Project name.
    project: Option<String>,
}

#[tool_router(router = process_infra_router, vis = "pub")]
impl Mcp {
    #[tool(description = "List all running dev processes (Next.js, Vite, Prisma, Docker, databases, etc.) with PID, port, memory, and CPU usage.")]
    async fn get_dev_processes(
        &self,
        Parameters(_args): Parameters<DevProcessesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "get_dev_processes deferred (OS/infra engine): OS process inspection is not yet available in the Rust collector.",
            "data": null,
            "issues": [],
            "metadata": {},
        })))
    }

    #[tool(description = "Show which dev processes are bound to which ports. Useful for debugging port conflicts.")]
    async fn get_port_usage(
        &self,
        Parameters(_args): Parameters<PortUsageArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "get_port_usage deferred (OS/infra engine): OS port inspection is not yet available in the Rust collector.",
            "data": null,
            "issues": [],
            "metadata": {},
        })))
    }

    #[tool(description = "Terminate a dev process by PID. Default signal is SIGTERM; use SIGKILL for force kill.")]
    async fn kill_process(
        &self,
        Parameters(_args): Parameters<KillProcessArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "kill_process deferred (OS/infra engine): OS process control is not yet available in the Rust collector.",
            "data": null,
            "issues": [],
            "metadata": {},
        })))
    }

    #[tool(description = "Delete common build/dev cache directories (.next/cache, node_modules/.cache, .vite, .turbo, .swc, .parcel-cache, etc.) for a project directory. Reports size freed per cache.")]
    async fn purge_caches(
        &self,
        Parameters(_args): Parameters<PurgeCachesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "purge_caches deferred (OS/infra engine): filesystem cache purging is not yet available in the Rust collector.",
            "data": null,
            "issues": [],
            "metadata": {},
        })))
    }

    #[tool(description = "Kill a dev server process, purge build caches in its working directory, and restart it with the same or a custom command. Combines kill_process + purge_caches + spawn into one operation.")]
    async fn restart_dev_server(
        &self,
        Parameters(_args): Parameters<RestartDevServerArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "restart_dev_server deferred (OS/infra engine): OS process control and spawning are not yet available in the Rust collector.",
            "data": null,
            "issues": [],
            "metadata": {},
        })))
    }

    #[tool(description = "Get deployment history from connected platforms (Vercel, Cloudflare, Railway). Shows build status, branch, commit, and timing.")]
    async fn get_deploy_logs(
        &self,
        Parameters(_args): Parameters<DeployLogsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "get_deploy_logs deferred (OS/infra engine): infra-platform connectors are not yet available in the Rust collector.",
            "data": null,
            "issues": [],
            "metadata": {},
        })))
    }

    #[tool(description = "Get runtime error/info logs from connected deployment platforms.")]
    async fn get_runtime_logs(
        &self,
        Parameters(_args): Parameters<RuntimeLogsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "get_runtime_logs deferred (OS/infra engine): infra-platform connectors are not yet available in the Rust collector.",
            "data": null,
            "issues": [],
            "metadata": {},
        })))
    }

    #[tool(description = "Get the current deployment status for each connected platform.")]
    async fn get_build_status(
        &self,
        Parameters(_args): Parameters<BuildStatusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "get_build_status deferred (OS/infra engine): infra-platform connectors are not yet available in the Rust collector.",
            "data": null,
            "issues": [],
            "metadata": {},
        })))
    }

    #[tool(description = "Overview of which platforms a project uses, combining explicit configuration with auto-detection from network traffic.")]
    async fn get_infra_overview(
        &self,
        Parameters(_args): Parameters<InfraOverviewArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "get_infra_overview deferred (OS/infra engine): infra-platform connectors are not yet available in the Rust collector.",
            "data": null,
            "issues": [],
            "metadata": {},
        })))
    }
}
