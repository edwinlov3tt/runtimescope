# Workspaces and API keys

Workspaces are the **top-level tenancy boundary** in RuntimeScope. Every project belongs to exactly one workspace; every API key is scoped to one workspace. On a fresh install there's a single "Personal" workspace and no authentication — the local collector trusts anything.

Workspaces matter when:

- The collector is **hosted / shared** (not just local dev).
- You want to isolate **staging vs production** telemetry.
- Multiple engineers or services push to the same collector.
- The user mentions "API key", "workspace", a 401/403 from the collector, or "bearer token".

For single-user local dev, ignore workspaces entirely — the default tenancy works transparently.

## MCP tools

| Tool | Purpose |
|---|---|
| `mcp__runtimescope__list_workspaces` | Show all workspaces with project and API key counts |
| `mcp__runtimescope__create_workspace` | Create a new workspace (e.g. "Work", "Production") |
| `mcp__runtimescope__move_project_to_workspace` | Change a project's tenancy pointer (no data moves) |
| `mcp__runtimescope__create_workspace_api_key` | Mint an API key for SDK auth — **returned once only** |

Note: `project_id` arguments here are the **PM project id** (e.g. `edwinlovettiii--flighting-docs`), not the runtime `projectId` (e.g. `proj_abc123`).

## DSN form — how SDKs authenticate

The SDK authenticates with a workspace by embedding the API key as the **password component** of the DSN:

```
runtimescope://<projectId>:<apiKey>@<host>:<port>/<appName>
https://<projectId>:<apiKey>@collector.example.com/<appName>
```

Examples:

```bash
RUNTIMESCOPE_DSN="https://proj_abc123:wsk_9f2a...secret@collector.example.com/1"
RUNTIMESCOPE_DSN="runtimescope://proj_abc123:wsk_9f2a...secret@10.0.0.5:6767/my-api"
```

The SDK parses this and sends the API key as a bearer token on every WebSocket handshake (SDK) or HTTP request (Workers). The collector rejects events whose API key doesn't match the project's workspace.

All SDKs (`@runtimescope/sdk`, `@runtimescope/server-sdk`, `@runtimescope/workers-sdk`, Python) accept `dsn` as an init option. Prefer the DSN form in production over separate `projectId` + `endpoint` fields.

## Typical flow when user asks to set up a shared collector

1. `list_workspaces` — does a suitable one already exist?
2. If not: `create_workspace({ name: "Production" })` — save the returned `id`.
3. `move_project_to_workspace({ project_id, workspace_id })` — park the project in the new workspace.
4. `create_workspace_api_key({ workspace_id, label: "production-backend" })` — **capture the `key` field immediately**. It will not be shown again.
5. Set `RUNTIMESCOPE_DSN` on the target machine / service:
   ```
   https://<projectId>:<apiKey>@<collector-host>/<appName>
   ```
6. Redeploy. Confirm with `wait_for_session` and `get_session_info`.

## Security rules

- **Never** check an API key into git. Use env vars, secret managers, or `wrangler secret put`.
- **Never** paste a key into chat or a shared log. When `create_workspace_api_key` returns one, tell the user to store it in their secret manager, then **stop** echoing it.
- Use one key per environment / service, not a single shared key. Makes rotation and auditing sane.
- Set `expires_at` on CI keys so forgotten ones auto-expire.
- If a key leaks, there's no rotation MCP tool yet — have the user delete and recreate via the dashboard.

## Dashboard

The runtimescope dashboard (`npm run dashboard`, `http://localhost:3200`) has a workspace picker and API key management UI. For anything beyond "create / view", point the user there rather than the MCP tools — it's interactive and handles secret display safely.
