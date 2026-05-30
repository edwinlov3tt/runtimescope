//! Process-monitor + infra-connector tools. All deferred stubs for now: these
//! need OS process inspection and external infra-platform APIs the Rust
//! collector does not have yet. Each tool registers with the correct args and
//! returns a valid envelope whose data is null and summary marks it deferred.

// Stub args feed the MCP input schema (schemars JsonSchema derive) but aren't
// read yet — not dead code, the lint can't see through the derive. Revisit when
// these grow real OS/infra implementations (M4).
#![allow(dead_code)]

use crate::tools::{envelope, now_ms};
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;

/// Extract the hostname from a URL (scheme://host[:port][/path]). Empty on failure.
fn host_of_url(url: &str) -> &str {
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    host.split('@').next_back().unwrap_or(host).split(':').next().unwrap_or(host)
}

/// Build/dev cache directories purge_caches + restart_dev_server delete (Node parity).
const CACHE_TARGETS: [&str; 9] = [
    ".next/cache",
    "node_modules/.cache",
    "node_modules/.vite",
    ".turbo",
    ".cache",
    ".swc",
    ".parcel-cache",
    ".nuxt",
    "tsconfig.tsbuildinfo",
];

/// Run a command for its exit status: `(success, stderr)`. For destructive ops
/// where we need to distinguish success from failure (unlike `run`, read-only).
async fn run_result(cmd: &str, args: &[&str]) -> (bool, String) {
    match Command::new(cmd).args(args).output().await {
        Ok(out) if out.status.success() => (true, String::new()),
        Ok(out) => (false, String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(e) => (false, e.to_string()),
    }
}

/// Size of a path in MB via `du -sk` (matches Node `getDirSizeMB`). 0.0 on failure.
async fn dir_size_mb(path: &str) -> f64 {
    if let Some(out) = run("du", &["-sk", path]).await {
        if let Some(kb) = out.split_whitespace().next().and_then(|s| s.parse::<f64>().ok()) {
            return kb / 1024.0;
        }
    }
    0.0
}

/// Classify a (lowercased) process command line into a dev-tool type — port of
/// Node's `PROCESS_PATTERNS` / `detectProcessType`.
fn detect_process_type(lc: &str) -> &'static str {
    let has = |a: &str| lc.contains(a);
    if has("next dev") || has("next-dev") || has("next-server") {
        "next"
    } else if has("vite") {
        "vite"
    } else if has("webpack-dev-server") || has("webpack dev server") || has("webpack serve") {
        "webpack"
    } else if has("wrangler") {
        "wrangler"
    } else if has("prisma studio") || has("prisma dev") {
        "prisma"
    } else if has("docker") {
        "docker"
    } else if has("postgres") || has("pg_") {
        "postgres"
    } else if has("mysqld") {
        "mysql"
    } else if has("redis-server") {
        "redis"
    } else if word_match(lc, "bun") {
        "bun"
    } else if word_match(lc, "deno") {
        "deno"
    } else if word_match(lc, "python") || word_match(lc, "python2") || word_match(lc, "python3") {
        "python"
    } else if word_match(lc, "node") {
        "node"
    } else {
        "unknown"
    }
}

/// Infer a dev-server start command from process type + raw command line — port
/// of Node's `inferStartCommand`. `None` when nothing sensible can be inferred.
fn infer_start_command(ptype: &str, raw: &str) -> Option<String> {
    let default = match ptype {
        "next" => Some("npx next dev"),
        "vite" => Some("npx vite"),
        "webpack" => Some("npx webpack serve"),
        "wrangler" => Some("npx wrangler dev"),
        "prisma" => Some("npx prisma studio"),
        "bun" => Some("bun run dev"),
        "deno" => Some("deno task dev"),
        _ => None,
    };
    if let Some(d) = default {
        return Some(d.to_string());
    }
    for kw in ["ts-node", "tsx"] {
        if let Some(idx) = raw.find(kw) {
            let after = raw[idx + kw.len()..].trim_start();
            if !after.is_empty() {
                return Some(format!("npx {kw} {after}"));
            }
        }
    }
    if ptype == "node" {
        return Some("npm run dev".to_string());
    }
    None
}

/// The working directory of a process via `lsof` (macOS/Linux) — the cwd needed
/// to purge caches + respawn. Mirrors Node's `getProcessCwd`.
async fn process_cwd(pid: u32) -> Option<String> {
    let out = run("lsof", &["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]).await?;
    out.lines().find_map(|l| l.strip_prefix('n').map(|p| p.to_string()))
}

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
        Parameters(args): Parameters<KillProcessArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let pid = args.pid;
        let signal = args.signal.clone().unwrap_or_else(|| "SIGTERM".to_string());
        let now = now_ms();
        // Safety: refuse PID < 2 (init/system) or our own process (Node parity).
        if pid < 2 || pid == std::process::id() {
            let why = if pid < 2 { "system process" } else { "current process" };
            return Ok(envelope(json!({
                "summary": format!("Refusing to kill PID {pid}: {why}."),
                "data": { "success": false, "pid": pid },
                "issues": [format!("Cannot kill PID {pid}")],
                "metadata": { "timeRange": { "from": now, "to": now }, "eventCount": 0, "sessionId": null },
            })));
        }
        let sig = signal.strip_prefix("SIG").unwrap_or(&signal);
        let (ok, err) = run_result("kill", &[&format!("-{sig}"), &pid.to_string()]).await;
        let data = if ok {
            json!({ "success": true })
        } else {
            json!({ "success": false, "error": err })
        };
        Ok(envelope(json!({
            "summary": if ok {
                format!("Process {pid} terminated with {signal}.")
            } else {
                format!("Failed to kill process {pid}: {err}")
            },
            "data": data,
            "issues": if ok { vec![] } else { vec![err] },
            "metadata": { "timeRange": { "from": now, "to": now }, "eventCount": 1, "sessionId": null },
        })))
    }

    #[tool(description = "Delete common build/dev cache directories (.next/cache, node_modules/.cache, .vite, .turbo, .swc, .parcel-cache, etc.) for a project directory. Reports size freed per cache.")]
    async fn purge_caches(
        &self,
        Parameters(args): Parameters<PurgeCachesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let dry = args.dry_run.unwrap_or(false);
        let base = args.directory.trim_end_matches('/').to_string();
        let now = now_ms();
        let mut caches: Vec<Value> = Vec::new();
        let mut total = 0.0f64;
        for target in CACHE_TARGETS {
            let full = format!("{base}/{target}");
            if !std::path::Path::new(&full).exists() {
                continue;
            }
            let size = dir_size_mb(&full).await;
            if !dry {
                let removed = std::fs::remove_dir_all(&full).is_ok() || std::fs::remove_file(&full).is_ok();
                if !removed {
                    caches.push(json!({ "path": target, "sizeMB": size, "deleted": false }));
                    continue;
                }
            }
            total += size;
            caches.push(json!({ "path": target, "sizeMB": size, "deleted": !dry }));
        }
        let total_freed = (total * 10.0).round() / 10.0;
        let mode = if dry { "Dry run" } else { "Purged" };
        let phrase = if dry { "would be freed" } else { "freed" };
        let summary = if caches.is_empty() {
            "No caches found to purge.".to_string()
        } else {
            format!("{mode}: {} cache(s), {:.1}MB {phrase}.", caches.len(), total)
        };
        let issues: Vec<String> = caches
            .iter()
            .filter(|c| !dry && c["deleted"] == json!(false))
            .map(|c| format!("Failed to delete {}", c["path"].as_str().unwrap_or("")))
            .collect();
        let count = caches.len();
        Ok(envelope(json!({
            "summary": summary,
            "data": { "directory": args.directory, "dryRun": dry, "totalFreedMB": total_freed, "caches": caches },
            "issues": issues,
            "metadata": { "timeRange": { "from": now, "to": now }, "eventCount": count, "sessionId": null },
        })))
    }

    #[tool(description = "Kill a dev server process, purge build caches in its working directory, and restart it with the same or a custom command. Combines kill_process + purge_caches + spawn into one operation.")]
    async fn restart_dev_server(
        &self,
        Parameters(args): Parameters<RestartDevServerArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        use std::process::Stdio;
        let pid = args.pid;
        let now = now_ms();
        let signal = args.signal.clone().unwrap_or_else(|| "SIGTERM".to_string());

        // Safety: refuse PID < 2 / our own process.
        if pid < 2 || pid == std::process::id() {
            let why = if pid < 2 { "system process" } else { "current process" };
            return Ok(envelope(json!({
                "summary": format!("Refusing to restart PID {pid}: {why}."),
                "data": { "success": false, "pid": pid },
                "issues": [format!("Cannot kill PID {pid}")],
                "metadata": { "timeRange": { "from": now, "to": now }, "eventCount": 0, "sessionId": null },
            })));
        }

        // Find the dev process (ps scan, same hint-matching as get_dev_processes).
        let proc = match run("ps", &["-axo", "pid=,args="]).await {
            Some(out) => out.lines().find_map(|line| {
                let line = line.trim_start();
                let (pid_str, cmdline) = line.split_once(char::is_whitespace)?;
                let p = pid_str.trim().parse::<u32>().ok()?;
                if p != pid {
                    return None;
                }
                let cmdline = cmdline.trim().to_string();
                let lc = cmdline.to_lowercase();
                if !DEV_HINTS.iter().any(|h| word_match(&lc, h)) {
                    return None;
                }
                Some((cmdline.clone(), detect_process_type(&lc)))
            }),
            None => None,
        };
        let Some((raw_command, ptype)) = proc else {
            return Ok(envelope(json!({
                "summary": format!("Process {pid} not found. It may have already exited."),
                "data": { "pid": pid, "found": false },
                "issues": [format!("Process {pid} not found")],
                "metadata": { "timeRange": { "from": now, "to": now }, "eventCount": 0, "sessionId": null },
            })));
        };

        let cwd = process_cwd(pid).await;
        let start_command = args.command.clone().or_else(|| infer_start_command(ptype, &raw_command));

        // 1. Kill.
        let sig = signal.strip_prefix("SIG").unwrap_or(&signal);
        let (killed, kill_err) = run_result("kill", &[&format!("-{sig}"), &pid.to_string()]).await;
        if !killed {
            return Ok(envelope(json!({
                "summary": format!("Failed to kill process {pid}: {kill_err}"),
                "data": { "pid": pid, "killed": false, "error": kill_err },
                "issues": [kill_err],
                "metadata": { "timeRange": { "from": now, "to": now }, "eventCount": 0, "sessionId": null },
            })));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // 2. Purge caches in the process's cwd.
        let mut caches_freed = 0.0f64;
        let mut caches_purged = 0usize;
        if !args.skip_cache_purge.unwrap_or(false) {
            if let Some(cwd) = &cwd {
                let base = cwd.trim_end_matches('/');
                for target in CACHE_TARGETS {
                    let full = format!("{base}/{target}");
                    if !std::path::Path::new(&full).exists() {
                        continue;
                    }
                    let size = dir_size_mb(&full).await;
                    if std::fs::remove_dir_all(&full).is_ok() || std::fs::remove_file(&full).is_ok() {
                        caches_freed += size;
                        caches_purged += 1;
                    }
                }
            }
        }

        // 3. Respawn, detached, in the cwd (nohup so it survives our exit).
        let mut restarted = false;
        let mut new_pid: Option<u32> = None;
        let mut restart_error: Option<String> = None;
        match (&start_command, &cwd) {
            (Some(cmd), Some(cwd)) => {
                match std::process::Command::new("sh")
                    .arg("-c")
                    .arg(format!("nohup {cmd} >/dev/null 2>&1 &"))
                    .current_dir(cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    Ok(child) => {
                        new_pid = Some(child.id());
                        restarted = true;
                    }
                    Err(e) => restart_error = Some(e.to_string()),
                }
            }
            (None, _) => {
                restart_error = Some("Could not infer start command. Provide one via the \"command\" parameter.".to_string());
            }
            (_, None) => {
                restart_error = Some("Could not determine working directory for the process. Provide a command and working directory manually.".to_string());
            }
        }

        let cache_part = if caches_purged > 0 {
            Some(format!("Purged {caches_purged} cache(s) ({:.1}MB).", caches_freed))
        } else {
            None
        };
        let restart_part = if restarted {
            Some(format!(
                "Restarted with PID {} using: {}",
                new_pid.map(|p| p.to_string()).unwrap_or_default(),
                start_command.clone().unwrap_or_default()
            ))
        } else {
            None
        };
        let fail_part = restart_error.clone().map(|e| format!("Restart failed: {e}"));
        let summary = [Some(format!("Killed {ptype} process {pid}.")), cache_part, restart_part, fail_part]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");

        Ok(envelope(json!({
            "summary": summary,
            "data": {
                "killed": { "pid": pid, "type": ptype, "signal": signal },
                "cachesPurged": { "count": caches_purged, "freedMB": (caches_freed * 10.0).round() / 10.0 },
                "restarted": { "success": restarted, "newPid": new_pid, "command": start_command, "cwd": cwd },
            },
            "issues": restart_error.map(|e| vec![e]).unwrap_or_default(),
            "metadata": { "timeRange": { "from": now, "to": now }, "eventCount": 1, "sessionId": null },
        })))
    }

    #[tool(description = "Get deployment history from connected platforms (Vercel, Cloudflare, Railway). Shows build status, branch, commit, and timing.")]
    async fn get_deploy_logs(
        &self,
        Parameters(_args): Parameters<DeployLogsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Mirrors Node: no platform client is ever loaded (loadFromConfig is never
        // called + needs platform API tokens), so the result is always empty.
        Ok(envelope(json!({
            "summary": "0 deployment(s) found.",
            "data": [],
            "issues": [],
            "metadata": { "timeRange": { "from": 0, "to": 0 }, "eventCount": 0, "sessionId": null },
        })))
    }

    #[tool(description = "Get runtime error/info logs from connected deployment platforms.")]
    async fn get_runtime_logs(
        &self,
        Parameters(_args): Parameters<RuntimeLogsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "0 runtime log(s) found.",
            "data": [],
            "issues": [],
            "metadata": { "timeRange": { "from": 0, "to": 0 }, "eventCount": 0, "sessionId": null },
        })))
    }

    #[tool(description = "Get the current deployment status for each connected platform.")]
    async fn get_build_status(
        &self,
        Parameters(_args): Parameters<BuildStatusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "0 platform(s) reporting build status.",
            "data": [],
            "issues": [],
            "metadata": { "timeRange": { "from": 0, "to": now_ms() }, "eventCount": 0, "sessionId": null },
        })))
    }

    #[tool(description = "Overview of which platforms a project uses, combining explicit configuration with auto-detection from network traffic.")]
    async fn get_infra_overview(
        &self,
        Parameters(args): Parameters<InfraOverviewArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Real store-read: detect platforms from network-request hostnames (over ALL
        // network events, not project-scoped — matches Node getInfraOverview). No
        // configured clients (loadFromConfig is never called) → `platforms` is empty.
        let network = self.store.events_by_type("network", None).await;
        let mut detected: Vec<String> = Vec::new();
        let push = |detected: &mut Vec<String>, name: &str| {
            if !detected.iter().any(|d| d == name) {
                detected.push(name.to_string());
            }
        };
        for e in &network {
            let url = e.get("url").and_then(Value::as_str).unwrap_or("");
            let host = host_of_url(url);
            if host.is_empty() {
                continue;
            }
            if host.contains("vercel") {
                push(&mut detected, "Vercel");
            }
            if host.contains("cloudflare") || host.contains("workers.dev") {
                push(&mut detected, "Cloudflare");
            }
            if host.contains("railway") {
                push(&mut detected, "Railway");
            }
            if host.contains("supabase") {
                push(&mut detected, "Supabase");
            }
            if host.contains("firebase") {
                push(&mut detected, "Firebase");
            }
            if host.contains("netlify") {
                push(&mut detected, "Netlify");
            }
        }

        let project = args.project.clone().unwrap_or_else(|| "default".to_string());
        let overview = json!([{
            "project": project,
            "platforms": [],
            "detectedFromTraffic": detected,
        }]);
        Ok(envelope(json!({
            "summary": format!(
                "Infrastructure overview: 0 configured platform(s), {} detected from traffic.",
                detected.len()
            ),
            "data": overview,
            "issues": [],
            "metadata": { "timeRange": { "from": 0, "to": now_ms() }, "eventCount": 1, "sessionId": null },
        })))
    }
}
