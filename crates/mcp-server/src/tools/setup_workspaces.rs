//! Setup + workspace tools: SDK-snippet generation (real) plus a family of
//! deferred stubs for capabilities the Rust collector doesn't have yet —
//! the Playwright sidecar (scan_website, ADR-0007), the `pm/` workspace
//! subsystem (workspaces/*), config scaffolding (setup_project,
//! get_project_config), and service lifecycle (start/stop_collector).
//!
//! Stubs register with the correct args and return a valid envelope whose
//! summary says it's deferred and whose `data` is null. They still count
//! toward the tool catalog.

use crate::tools::envelope;
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::json;

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
    /// Viewport width in pixels (default 1280).
    viewport_width: Option<u32>,
    /// Viewport height in pixels (default 720).
    viewport_height: Option<u32>,
    /// Wait condition before scanning: load, networkidle, or domcontentloaded.
    wait_for: Option<String>,
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
            "metadata": { "eventCount": 0, "projectId": null },
        })))
    }

    // ---------------- scan_website (STUB — needs Playwright sidecar, ADR-0007) ----------------

    #[tool(
        description = "Visit a website with a headless browser and extract tech stack, design tokens, layout tree, accessibility structure, fonts, and asset inventory. After scanning, the recon tools return data from the scanned page."
    )]
    async fn scan_website(
        &self,
        Parameters(args): Parameters<ScanWebsiteArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = (&args.viewport_width, &args.viewport_height, &args.wait_for);
        Ok(envelope(json!({
            "summary": format!(
                "Deferred: scanning {} requires the Playwright Node sidecar (ADR-0007), which is not yet wired into the Rust collector.",
                args.url
            ),
            "data": null,
            "issues": ["scan_website is deferred — the Playwright headless-browser sidecar is not yet available in the Rust collector."],
            "metadata": { "eventCount": 0, "projectId": null },
        })))
    }

    // ---------------- create_workspace (STUB — needs pm/ subsystem) ----------------

    #[tool(
        description = "Create a new workspace (tenancy container). Useful for separating personal projects from work, or keeping different customers/environments isolated."
    )]
    async fn create_workspace(
        &self,
        Parameters(args): Parameters<CreateWorkspaceArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = (&args.slug, &args.description);
        Ok(envelope(json!({
            "summary": format!(
                "Deferred: cannot create workspace \"{}\" — the workspace/PM subsystem is not yet ported to the Rust collector.",
                args.name
            ),
            "data": null,
            "issues": ["create_workspace is deferred — the pm/ workspace subsystem is not yet available in the Rust collector."],
            "metadata": { "eventCount": 0, "projectId": null },
        })))
    }

    // ---------------- list_workspaces (STUB — needs pm/ subsystem) ----------------

    #[tool(
        description = "List all workspaces (tenancy containers). Every project belongs to exactly one workspace."
    )]
    async fn list_workspaces(
        &self,
        Parameters(_args): Parameters<ListWorkspacesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": "Deferred: listing workspaces requires the workspace/PM subsystem, which is not yet ported to the Rust collector.",
            "data": null,
            "issues": ["list_workspaces is deferred — the pm/ workspace subsystem is not yet available in the Rust collector."],
            "metadata": { "eventCount": 0, "projectId": null },
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
        let _ = (&args.label, &args.expires_at);
        Ok(envelope(json!({
            "summary": format!(
                "Deferred: cannot create an API key for workspace {} — the workspace/PM subsystem is not yet ported to the Rust collector.",
                args.workspace_id
            ),
            "data": null,
            "issues": ["create_workspace_api_key is deferred — the pm/ workspace subsystem is not yet available in the Rust collector."],
            "metadata": { "eventCount": 0, "projectId": null },
        })))
    }

    // ---------------- move_project_to_workspace (STUB — needs pm/ subsystem) ----------------

    #[tool(
        description = "Move a project from its current workspace to a different one. Does not move or delete any data — only changes the tenancy pointer."
    )]
    async fn move_project_to_workspace(
        &self,
        Parameters(args): Parameters<MoveProjectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(envelope(json!({
            "summary": format!(
                "Deferred: cannot move project {} to workspace {} — the workspace/PM subsystem is not yet ported to the Rust collector.",
                args.project_id, args.workspace_id
            ),
            "data": null,
            "issues": ["move_project_to_workspace is deferred — the pm/ workspace subsystem is not yet available in the Rust collector."],
            "metadata": { "eventCount": 0, "projectId": null },
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
            "metadata": { "eventCount": 0, "projectId": null },
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
            "metadata": { "eventCount": 0, "projectId": null },
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
            "metadata": { "eventCount": 0, "projectId": null },
        })))
    }
}
