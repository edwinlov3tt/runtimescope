//! Setup + workspace tools: SDK-snippet generation (real) plus a family of
//! deferred stubs for capabilities the Rust collector doesn't have yet —
//! the Playwright sidecar (scan_website, ADR-0007), the `pm/` workspace
//! subsystem (workspaces/*), config scaffolding (setup_project,
//! get_project_config), and service lifecycle (start/stop_collector).
//!
//! Stubs register with the correct args and return a valid envelope whose
//! summary says it's deferred and whose `data` is null. They still count
//! toward the tool catalog.

use crate::tools::{envelope, iso_ms, now_ms};
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

/// HTTP API port (dashboard + SDK bundle + /api/events). Mirrors the TS default.
fn http_port() -> u16 {
    std::env::var("RUNTIMESCOPE_HTTP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6768)
}

/// WebSocket collector port. Mirrors the TS default.
fn ws_port() -> u16 {
    std::env::var("RUNTIMESCOPE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6767)
}

// ---- arg structs (module-scoped, unique within this file) ----

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SdkSnippetArgs {
    /// Name for the app in RuntimeScope (e.g. "echo-frontend", "dashboard").
    app_name: Option<String>,
    /// Framework/tech stack: html, react, vue, angular, svelte, nextjs, nuxt,
    /// flask, django, rails, php, wordpress, workers, other. Use "html" for any
    /// plain HTML or server-rendered pages; "workers" for Cloudflare Workers.
    framework: Option<String>,
    /// Existing project ID to use (proj_xxx). If omitted, "proj_xxx" is used as a placeholder.
    project_id: Option<String>,
    /// Absolute path to the project root. If provided, .runtimescope/config.json scaffolding is requested (deferred).
    project_dir: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ProjectConfigArgs {
    /// Absolute path to the project root directory.
    project_dir: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ScanWebsiteArgs {
    /// The full URL to scan (e.g. "https://stripe.com").
    url: String,
    /// Project to store the captured recon events under (so the recon tools can
    /// read them back). Defaults to the URL's host.
    project_id: Option<String>,
    /// Viewport width in pixels (default 1280).
    viewport_width: Option<u32>,
    /// Viewport height in pixels (default 720).
    viewport_height: Option<u32>,
    /// Wait condition before scanning: load, networkidle, or domcontentloaded.
    wait_for: Option<String>,
}

/// True if an IP literal points at the local machine or a private/internal
/// network — covers IPv4 (incl. CGNAT 100.64/10, broadcast, TEST-NETs), IPv6
/// (loopback/ULA fc00::/7/link-local fe80::/10/multicast), and IPv4-mapped IPv6.
fn ip_is_internal(ip: &std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT 100.64.0.0/10
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || v6.to_ipv4_mapped().is_some_and(|m| ip_is_internal(&IpAddr::V4(m)))
        }
    }
}

/// Resolve a URL host to an IP literal if it is one — handling the dotted/IPv6
/// forms AND the alternate encodings browsers accept (bare decimal like
/// `2130706433`, hex `0x7f000001`). Returns None for DNS names.
fn host_as_ip(host: &str) -> Option<std::net::IpAddr> {
    use std::net::{IpAddr, Ipv4Addr};
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = h.parse::<IpAddr>() {
        return Some(ip);
    }
    if let Ok(n) = h.parse::<u32>() {
        return Some(IpAddr::V4(Ipv4Addr::from(n))); // decimal IPv4 (SSRF classic)
    }
    if let Some(hex) = h.strip_prefix("0x").or_else(|| h.strip_prefix("0X")) {
        if let Ok(n) = u32::from_str_radix(hex, 16) {
            return Some(IpAddr::V4(Ipv4Addr::from(n)));
        }
    }
    None
}

/// SSRF guard for `scan_website` (audit #9): http(s) only, and reject hosts that
/// point at the local machine / private networks. IP literals (incl. decimal/
/// hex/IPv6/mapped) are checked against [`ip_is_internal`]. For DNS NAMES this is
/// **advisory** — it blocks localhost/.local/.internal but cannot stop a public
/// name that resolves to a private IP, nor DNS rebinding. Post-resolution
/// enforcement is the sidecar's job (it performs the actual navigation); tracked
/// in audit 0002 #9.
fn guard_scan_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    let Some(end) = trimmed.find("://") else {
        return Err("URL must start with http:// or https://".into());
    };
    let scheme = trimmed[..end].to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("scheme '{scheme}' is not allowed (http/https only)"));
    }
    let authority = trimmed[end + 3..].split(['/', '?', '#']).next().unwrap_or("");
    // host = authority minus userinfo; keep IPv6 brackets, drop the port.
    let hostport = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(rest) = hostport.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest) // bracketed IPv6
    } else {
        hostport.split(':').next().unwrap_or(hostport)
    };
    if host.is_empty() {
        return Err("URL has no host".into());
    }
    let lower = host.to_ascii_lowercase();
    if let Some(ip) = host_as_ip(&lower) {
        if ip_is_internal(&ip) {
            return Err(format!("host '{host}' resolves to a private/internal address"));
        }
    } else if lower == "localhost" || lower.ends_with(".local") || lower.ends_with(".internal") || lower.ends_with(".localhost") {
        return Err(format!("host '{host}' is internal and may not be scanned"));
    }
    Ok(())
}

/// Derive a project name from a URL's host (fallback "scan").
fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .filter(|h| !h.is_empty())
        .unwrap_or("scan")
        .to_string()
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateWorkspaceArgs {
    /// Display name, e.g. "Work" or "Acme Corp".
    name: String,
    /// Optional URL-safe slug. Auto-derived from the name if omitted. Must be unique.
    slug: Option<String>,
    /// Optional description.
    description: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListWorkspacesArgs {}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateApiKeyArgs {
    /// Workspace id (e.g. "ws_abc123").
    workspace_id: String,
    /// Human-readable label, e.g. "CI server", "Production backend", "Local dev key".
    label: String,
    /// Optional Unix timestamp (ms) after which the key is no longer valid.
    expires_at: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MoveProjectArgs {
    /// PM project id (e.g. "edwinlovettiii--flighting-docs"). Not the runtime projectId.
    project_id: String,
    /// Target workspace id (e.g. "ws_abc123").
    workspace_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetupProjectArgs {
    /// Absolute path to the project root directory.
    project_dir: String,
    /// App name for RuntimeScope (defaults to directory name or package.json name).
    app_name: Option<String>,
    /// Register Claude Code hooks for tool timing (default true).
    register_hooks: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StartCollectorArgs {
    /// If true, install the collector as a background service so it auto-starts on login.
    persist: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StopCollectorArgs {
    /// If true, also remove the launchd/systemd service definition.
    uninstall_service: Option<bool>,
}

#[tool_router(router = setup_workspaces_router, vis = "pub")]
impl Mcp {
    // ---------------- get_sdk_snippet (REAL) ----------------

    #[tool(
        description = "Generate a ready-to-paste code snippet to connect any web application to RuntimeScope for live runtime monitoring. Works with ANY tech stack — React, Vue, Angular, Svelte, plain HTML, Flask/Django templates, Rails ERB, PHP, WordPress, Cloudflare Workers, etc. Returns the appropriate installation method based on the project type."
    )]
    async fn get_sdk_snippet(
        &self,
        Parameters(args): Parameters<SdkSnippetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let app_name = args.app_name.unwrap_or_else(|| "my-app".to_string());
        let framework = args.framework.unwrap_or_else(|| "html".to_string());
        let resolved_project_id = args.project_id.clone();
        let pid = resolved_project_id
            .clone()
            .unwrap_or_else(|| "proj_xxx".to_string());
        let http = http_port();
        let ws = ws_port();

        let dsn = format!("runtimescope://{pid}@localhost:{http}/{app_name}");

        let script_tag_snippet = format!(
            "<!-- RuntimeScope — paste before </body> -->\n\
<script src=\"http://localhost:{http}/runtimescope.js\"></script>\n\
<script>\n  RuntimeScope.init({{ dsn: '{dsn}' }});\n</script>"
        );

        let npm_snippet = format!(
            "// npm install @runtimescope/sdk\n\
import {{ RuntimeScope }} from '@runtimescope/sdk';\n\n\
RuntimeScope.init({{ dsn: '{dsn}' }});"
        );

        let workers_snippet = format!(
            "// npm install @runtimescope/workers-sdk\n\
import {{ withRuntimeScope, scopeD1, scopeKV, scopeR2, track, addBreadcrumb }} from '@runtimescope/workers-sdk';\n\n\
export default withRuntimeScope({{\n  \
async fetch(request, env, ctx) {{\n    \
// const db = scopeD1(env.DB);\n    \
// const kv = scopeKV(env.KV);\n    \
// const bucket = scopeR2(env.BUCKET);\n    \
// track('request.processed', {{ path: new URL(request.url).pathname }});\n    \
return new Response('Hello!');\n  }},\n}}, {{\n  \
dsn: '{dsn}',\n  appName: '{app_name}',\n}});"
        );

        let is_workers = framework == "workers";
        let uses_npm = is_workers
            || matches!(
                framework.as_str(),
                "react" | "vue" | "angular" | "svelte" | "nextjs" | "nuxt"
            );
        let primary_snippet = if is_workers {
            &workers_snippet
        } else if uses_npm {
            &npm_snippet
        } else {
            &script_tag_snippet
        };

        let placement = match framework.as_str() {
            "html" => "Paste the <script> tags before </body> in your HTML file(s).",
            "react" => "Add the import to your entry file (src/index.tsx or src/main.tsx), before ReactDOM.render/createRoot.",
            "vue" => "Add the import to your entry file (src/main.ts), before createApp().",
            "angular" => "Add the import to your main.ts, before bootstrapApplication().",
            "svelte" => "Add the import to your entry file (src/main.ts), before new App().",
            "nextjs" => "Add the import to your app/layout.tsx or pages/_app.tsx. For App Router, use a client component wrapper.",
            "nuxt" => "Create a plugin file (plugins/runtimescope.client.ts) with the init call.",
            "flask" | "django" => "Add the <script> tags to your base template (templates/base.html) before </body>.",
            "rails" => "Add the <script> tags to your application layout (app/views/layouts/application.html.erb) before </body>.",
            "php" => "Add the <script> tags to your layout/footer file before </body>.",
            "wordpress" => "Add the <script> tags to your theme's footer.php before </body>, or use a custom HTML plugin.",
            "workers" => "Wrap your default export with withRuntimeScope in your Worker entry file (src/index.ts). Enable nodejs_compat in wrangler.toml.",
            _ => "Add the <script> tags to your HTML template before </body>. Works in any HTML page.",
        };

        let workers_captures = json!([
            "Incoming HTTP requests with timing, status, and Cloudflare properties",
            "Console logs, warnings, and errors with stack traces",
            "D1 database queries with SQL parsing, timing, and N+1 detection",
            "KV namespace operations (get/put/delete/list) with timing",
            "R2 bucket operations (get/put/delete/list/head) with size tracking",
            "Custom business events via track()",
            "Request breadcrumbs via addBreadcrumb()",
        ]);
        let browser_captures = json!([
            "Network requests (fetch/XHR) with timing and headers",
            "Console logs, warnings, and errors with stack traces",
            "React/Vue/Svelte component renders (if applicable)",
            "State store changes (Redux, Zustand, Pinia)",
            "Web Vitals (LCP, FCP, CLS, TTFB, INP)",
            "Unhandled errors and promise rejections",
        ]);

        let requirements = if is_workers {
            json!([
                "RuntimeScope collector must be reachable from your Worker",
                format!("HTTP collector endpoint at http://localhost:{http}/api/events"),
                "Add nodejs_compat to compatibility_flags in wrangler.toml",
                "For production: set httpEndpoint to your hosted collector URL",
            ])
        } else {
            json!([
                "RuntimeScope MCP server must be running (it starts automatically with Claude Code)",
                format!("SDK bundle served at http://localhost:{http}/runtimescope.js"),
                format!("WebSocket collector at ws://localhost:{ws}"),
            ])
        };

        let alternative_snippet = if is_workers {
            json!(null)
        } else if uses_npm {
            json!(script_tag_snippet)
        } else {
            json!(npm_snippet)
        };
        let alternative_note = if is_workers {
            json!(null)
        } else if uses_npm {
            json!("If you prefer, you can also use a <script> tag instead of npm:")
        } else {
            json!("If the project uses npm/Node.js, you can also install via:")
        };

        let project_config = if let Some(ref dir) = args.project_dir {
            json!({
                "created": false,
                "path": format!("{dir}/.runtimescope/config.json"),
                "projectId": resolved_project_id,
                "note": "Config scaffolding is deferred in the Rust collector — pass project_id explicitly or run setup_project once it lands.",
            })
        } else {
            json!(null)
        };

        let summary = if is_workers {
            format!("Workers SDK snippet for Cloudflare Worker \"{app_name}\". Captures requests, D1/KV/R2 operations, console, custom events, and breadcrumbs.")
        } else {
            format!(
                "SDK snippet for {framework} project \"{app_name}\". {}",
                if uses_npm {
                    "Uses npm import."
                } else {
                    "Uses <script> tag — no build system required."
                }
            )
        };

        Ok(envelope(json!({
            "summary": summary,
            "data": {
                "dsn": dsn,
                "snippet": primary_snippet,
                "placement": placement,
                "alternativeSnippet": alternative_snippet,
                "alternativeNote": alternative_note,
                "requirements": requirements,
                "whatItCaptures": if is_workers { workers_captures } else { browser_captures },
                "projectConfig": project_config,
            },
            "issues": [],
            "metadata": { "eventCount": 0, "projectId": resolved_project_id },
        })))
    }

    // ---------------- get_project_config (STUB) ----------------

    #[tool(
        description = "Read the .runtimescope/config.json from a project directory. Returns the project ID, SDK entries, capture settings, and metadata."
    )]
    async fn get_project_config(
        &self,
        Parameters(args): Parameters<ProjectConfigArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": format!(
                "Deferred: reading .runtimescope/config.json from {} is not yet implemented in the Rust collector.",
                args.project_dir
            ),
            "data": null,
            "issues": ["get_project_config is deferred — config file I/O is not yet ported to the Rust collector."],
            "metadata": { "deferred": true, "eventCount": 0, "projectId": null },
        })))
    }

    // ---------------- scan_website (REAL — via the Playwright sidecar, ADR-0007) ----------------

    #[tool(
        description = "Visit a website with a headless browser and extract tech stack, design tokens, layout tree, accessibility structure, fonts, and asset inventory. After scanning, the recon tools return data from the scanned page."
    )]
    async fn scan_website(
        &self,
        Parameters(args): Parameters<ScanWebsiteArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Err(reason) = guard_scan_url(&args.url) {
            return Ok(envelope(json!({
                "summary": format!("Refused to scan {}: {reason}", args.url),
                "data": null,
                "issues": [reason],
                "metadata": { "eventCount": 0, "projectId": null },
            })));
        }

        let mut params = json!({ "url": args.url });
        if let Some(w) = args.viewport_width {
            params["viewportWidth"] = json!(w);
        }
        if let Some(h) = args.viewport_height {
            params["viewportHeight"] = json!(h);
        }
        if let Some(w) = &args.wait_for {
            params["waitFor"] = json!(w);
        }

        let project = args.project_id.clone().unwrap_or_else(|| host_of(&args.url));

        match crate::sidecar::call_sidecar("scan_website", params).await {
            Ok(result) => {
                // The sidecar returns { events: [...], ... } ready to store. INGEST
                // them under `project` so the recon read-tools (get_design_tokens,
                // get_layout_tree, …) return this scan's data.
                let events: Vec<Value> = result
                    .get("events")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let event_count = events.len();
                if event_count > 0 {
                    if let Err(e) = self.store.add_batch(project.clone(), events).await {
                        eprintln!("[RuntimeScope] scan_website: failed to store recon events: {e}");
                    }
                }
                Ok(envelope(json!({
                    "summary": format!(
                        "Scanned {} — {event_count} recon event(s) captured under project '{project}'. Query them with the recon tools (project_id: '{project}').",
                        args.url
                    ),
                    "data": result,
                    "issues": [],
                    "metadata": { "eventCount": event_count, "projectId": project },
                })))
            }
            Err(e) => Ok(envelope(json!({
                "summary": format!("Failed to scan {}: {e}", args.url),
                "data": null,
                "issues": [e],
                "metadata": { "eventCount": 0, "projectId": null },
            }))),
        }
    }

    // ---------------- create_workspace (STUB — needs pm/ subsystem) ----------------

    #[tool(
        description = "Create a new workspace (tenancy container). Useful for separating personal projects from work, or keeping different customers/environments isolated."
    )]
    async fn create_workspace(
        &self,
        Parameters(args): Parameters<CreateWorkspaceArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match self.pm.create_workspace(&args.name, args.slug.as_deref(), args.description.as_deref()) {
            Ok(ws) => {
                // create_workspace returns the raw PmWorkspace (createdAt/updatedAt
                // are NUMBERS here; list_workspaces is the one that ISO-formats them).
                let mut data = serde_json::Map::new();
                data.insert("id".into(), json!(ws.id));
                data.insert("name".into(), json!(ws.name));
                data.insert("slug".into(), json!(ws.slug));
                if let Some(d) = &ws.description {
                    data.insert("description".into(), json!(d));
                }
                data.insert("createdAt".into(), json!(ws.created_at));
                data.insert("updatedAt".into(), json!(ws.updated_at));
                data.insert("isDefault".into(), json!(ws.is_default));
                Ok(envelope(json!({
                    "summary": format!("Created workspace \"{}\" ({}).", ws.name, ws.id),
                    "data": data,
                    "issues": [],
                    "metadata": { "timeRange": { "from": 0, "to": now_ms() }, "eventCount": 0, "sessionId": null, "projectId": null },
                })))
            }
            Err(e) => Ok(envelope(json!({
                "summary": format!("Failed to create workspace: {e}"),
                "data": null,
                "issues": [e],
            }))),
        }
    }

    // ---------------- list_workspaces (STUB — needs pm/ subsystem) ----------------

    #[tool(
        description = "List all workspaces (tenancy containers). Every project belongs to exactly one workspace."
    )]
    async fn list_workspaces(
        &self,
        Parameters(_args): Parameters<ListWorkspacesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspaces = self.pm.list_workspaces();
        let projects = self.pm.list_projects();
        let data: Vec<Value> = workspaces
            .iter()
            .map(|ws| {
                let project_count =
                    projects.iter().filter(|p| p.workspace_id.as_deref() == Some(ws.id.as_str())).count();
                let api_key_count = self.pm.list_api_keys(&ws.id).len();
                let mut m = serde_json::Map::new();
                m.insert("id".into(), json!(ws.id));
                m.insert("name".into(), json!(ws.name));
                m.insert("slug".into(), json!(ws.slug));
                if let Some(d) = &ws.description {
                    m.insert("description".into(), json!(d));
                }
                m.insert("isDefault".into(), json!(ws.is_default));
                m.insert("projectCount".into(), json!(project_count));
                m.insert("apiKeyCount".into(), json!(api_key_count));
                m.insert("createdAt".into(), json!(iso_ms(ws.created_at)));
                Value::Object(m)
            })
            .collect();
        Ok(envelope(json!({
            "summary": format!("{} workspace(s). {} project(s) total.", workspaces.len(), projects.len()),
            "data": data,
            "issues": [],
            "metadata": { "timeRange": { "from": 0, "to": now_ms() }, "eventCount": 0, "sessionId": null, "projectId": null },
        })))
    }

    // ---------------- create_workspace_api_key (STUB — needs pm/ subsystem) ----------------

    #[tool(
        description = "Create a new API key scoped to the given workspace. The secret is returned EXACTLY ONCE. Use it as the Bearer token in the SDK DSN: runtimescope://proj_xxx:TOKEN@host:port/app."
    )]
    async fn create_workspace_api_key(
        &self,
        Parameters(args): Parameters<CreateApiKeyArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match self.pm.create_api_key(&args.workspace_id, &args.label, args.expires_at.map(|v| v as i64)) {
            Ok(k) => {
                let mut data = serde_json::Map::new();
                data.insert("key".into(), json!(k.key));
                data.insert("keyPrefix".into(), json!(k.key_prefix));
                data.insert("keyLast4".into(), json!(k.key_last4));
                data.insert("workspaceId".into(), json!(k.workspace_id));
                data.insert("label".into(), json!(k.label));
                data.insert("createdAt".into(), json!(k.created_at));
                if let Some(e) = k.expires_at {
                    data.insert("expiresAt".into(), json!(e));
                }
                Ok(envelope(json!({
                    "summary": format!(
                        "Created API key for workspace {}. Store the `key` field securely — it will not be shown again.",
                        args.workspace_id
                    ),
                    "data": data,
                    "issues": [],
                    "metadata": { "timeRange": { "from": 0, "to": now_ms() }, "eventCount": 0, "sessionId": null, "projectId": null },
                })))
            }
            Err(e) => Ok(envelope(json!({
                "summary": format!("Failed: {e}"),
                "data": null,
                "issues": [e],
            }))),
        }
    }

    // ---------------- move_project_to_workspace (STUB — needs pm/ subsystem) ----------------

    #[tool(
        description = "Move a project from its current workspace to a different one. Does not move or delete any data — only changes the tenancy pointer."
    )]
    async fn move_project_to_workspace(
        &self,
        Parameters(args): Parameters<MoveProjectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let Some(project) = self.pm.get_project(&args.project_id) else {
            return Ok(envelope(json!({
                "summary": format!("Project {} not found.", args.project_id),
                "data": null,
                "issues": ["project-not-found"],
            })));
        };
        self.pm.set_project_workspace(&args.project_id, &args.workspace_id);
        let updated = self.pm.get_project(&args.project_id).unwrap_or(project);
        Ok(envelope(json!({
            "summary": format!("Moved project \"{}\" to workspace {}.", updated.name, args.workspace_id),
            "data": {
                "id": updated.id,
                "workspaceId": updated.workspace_id,
                "name": updated.name,
            },
            "issues": [],
            "metadata": { "timeRange": { "from": 0, "to": now_ms() }, "eventCount": 0, "sessionId": null, "projectId": null },
        })))
    }

    // ---------------- setup_project (STUB — needs scaffolding) ----------------

    #[tool(
        description = "Set up RuntimeScope in a project — detects framework, creates .runtimescope/config.json, generates SDK snippets, and registers Claude hooks. Returns everything needed to install the SDK in one call."
    )]
    async fn setup_project(
        &self,
        Parameters(args): Parameters<SetupProjectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = (&args.app_name, &args.register_hooks);
        Ok(envelope(json!({
            "summary": format!(
                "Deferred: project setup for {} requires framework detection + config scaffolding + hook registration, which are not yet ported to the Rust collector. Use get_sdk_snippet with an explicit project_id in the meantime.",
                args.project_dir
            ),
            "data": null,
            "issues": ["setup_project is deferred — config scaffolding and hook registration are not yet available in the Rust collector."],
            "metadata": { "deferred": true, "eventCount": 0, "projectId": null },
        })))
    }

    // ---------------- start_collector (STUB — lifecycle) ----------------

    #[tool(
        description = "Start the RuntimeScope collector if it is not already running. Starts the installed launchd/systemd service or spawns a detached process. Set persist=true to install the service so the collector auto-starts on login."
    )]
    async fn start_collector(
        &self,
        Parameters(args): Parameters<StartCollectorArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = &args.persist;
        Ok(envelope(json!({
            "summary": "Deferred: collector lifecycle control (launchd/systemd/spawn) is not yet ported to the Rust collector. When running under the MCP server, a collector is already embedded.",
            "data": null,
            "issues": ["start_collector is deferred — service install/spawn lifecycle is not yet available in the Rust collector."],
            "metadata": { "deferred": true, "eventCount": 0, "projectId": null },
        })))
    }

    // ---------------- stop_collector (STUB — lifecycle) ----------------

    #[tool(
        description = "Stop the RuntimeScope collector. If started as a launchd/systemd service, stops the service; otherwise sends SIGTERM to the process holding the collector's HTTP port."
    )]
    async fn stop_collector(
        &self,
        Parameters(args): Parameters<StopCollectorArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = &args.uninstall_service;
        Ok(envelope(json!({
            "summary": "Deferred: collector lifecycle control (launchd/systemd/SIGTERM) is not yet ported to the Rust collector.",
            "data": null,
            "issues": ["stop_collector is deferred — service stop/uninstall lifecycle is not yet available in the Rust collector."],
            "metadata": { "deferred": true, "eventCount": 0, "projectId": null },
        })))
    }
}
