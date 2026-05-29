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
use serde_json::{json, Value};
use tokio::process::Command;

/// Run a command and capture stdout as a String (None on spawn/exec failure).
async fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().await.ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Dev-tooling process names worth surfacing in get_dev_processes.
const DEV_HINTS: &[&str] = &[
    "node", "vite", "next", "npm", "pnpm", "yarn", "webpack", "esbuild", "rollup",
    "deno", "bun", "tsx", "ts-node", "nodemon", "postgres", "mysqld", "redis-server",
    "docker", "prisma", "turbo", "remix", "astro", "nuxt",
];

/// True if `hint` appears in `haystack` as a whole word (alphanumeric
/// boundaries), so "bun" matches "/bin/bun" but not "powerd.bundle".
fn word_match(haystack: &str, hint: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(hint) {
        let start = from + rel;
        let end = start + hint.len();
        let before_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let after_ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

/// Basename of an executable path or command token.
fn basename(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}

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
    #[tool(description = "List running dev processes (Next.js, Vite, Prisma, Docker, databases, etc.) with PID and command. Optionally filter by type or project substring.")]
    async fn get_dev_processes(
        &self,
        Parameters(args): Parameters<DevProcessesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // `ps -axo pid=,args=` — pid + full command line.
        let Some(out) = run("ps", &["-axo", "pid=,args="]).await else {
            return Ok(envelope(json!({
                "summary": "Could not run `ps` to inspect processes.",
                "data": null, "issues": ["ps unavailable"], "metadata": { "eventCount": 0 },
            })));
        };
        let type_filter = args.r#type.as_deref().map(str::to_lowercase);
        let proj_filter = args.project.as_deref().map(str::to_lowercase);
        let mut procs: Vec<Value> = Vec::new();
        for line in out.lines() {
            let line = line.trim_start();
            let Some((pid_str, cmdline)) = line.split_once(char::is_whitespace) else { continue };
            let Ok(pid) = pid_str.trim().parse::<u32>() else { continue };
            let cmdline = cmdline.trim();
            let lc = cmdline.to_lowercase();
            // Keep only dev-tooling processes (whole-word hint match).
            if !DEV_HINTS.iter().any(|h| word_match(&lc, h)) {
                continue;
            }
            if type_filter.as_ref().is_some_and(|t| !lc.contains(t)) {
                continue;
            }
            if proj_filter.as_ref().is_some_and(|p| !lc.contains(p)) {
                continue;
            }
            let command = basename(cmdline.split_whitespace().next().unwrap_or(cmdline));
            procs.push(json!({ "pid": pid, "command": command, "args": cmdline }));
        }
        let count = procs.len();
        Ok(envelope(json!({
            "summary": format!("{count} dev process(es) running."),
            "data": procs,
            "issues": [],
            "metadata": { "eventCount": count },
        })))
    }

    #[tool(description = "Show which dev processes are bound to which listening TCP ports. Useful for debugging port conflicts.")]
    async fn get_port_usage(
        &self,
        Parameters(args): Parameters<PortUsageArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Listening TCP sockets owned by the user, with the holding process.
        let Some(out) = run("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"]).await else {
            return Ok(envelope(json!({
                "summary": "Could not run `lsof` to inspect ports.",
                "data": null, "issues": ["lsof unavailable"], "metadata": { "eventCount": 0 },
            })));
        };
        let mut ports: Vec<Value> = Vec::new();
        for line in out.lines().skip(1) {
            // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME(:PORT (LISTEN))
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 9 {
                continue;
            }
            let command = cols[0];
            let Ok(pid) = cols[1].parse::<u32>() else { continue };
            let name = cols[8];
            let Some(port) = name.rsplit(':').next().and_then(|p| p.parse::<u32>().ok()) else { continue };
            if args.port.is_some_and(|want| want != port) {
                continue;
            }
            ports.push(json!({ "port": port, "pid": pid, "command": command }));
        }
        ports.sort_by_key(|p| p["port"].as_u64().unwrap_or(0));
        ports.dedup_by_key(|p| (p["port"].as_u64().unwrap_or(0), p["pid"].as_u64().unwrap_or(0)));
        let count = ports.len();
        Ok(envelope(json!({
            "summary": format!("{count} listening TCP port(s) in use by dev processes."),
            "data": ports,
            "issues": [],
            "metadata": { "eventCount": count },
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
            "metadata": { "deferred": true },
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
            "metadata": { "deferred": true },
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
            "metadata": { "deferred": true },
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
            "metadata": { "deferred": true },
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
            "metadata": { "deferred": true },
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
            "metadata": { "deferred": true },
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
            "metadata": { "deferred": true },
        })))
    }
}
