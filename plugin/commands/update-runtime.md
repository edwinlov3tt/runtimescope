---
description: Update RuntimeScope — upgrade installed packages, MCP server, Python SDK, service binary; verify connection after
allowed-tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "WebFetch", "mcp__runtimescope__get_session_info", "mcp__runtimescope__wait_for_session", "mcp__runtimescope__get_sdk_snippet", "mcp__runtimescope__get_project_config"]
---

# Update RuntimeScope

Upgrades every RuntimeScope component the user has installed — SDK packages, the MCP server, the Python SDK, the unscoped `runtimescope` CLI / background service — then verifies the connection is still healthy.

Safe to run on any project. If RuntimeScope isn't installed yet, the command bails and tells the user to run `/runtimescope:setup` instead.

---

## Phase 1: Detect what's installed

```bash
# Node packages (including framework packages and unscoped CLI)
cat package.json 2>/dev/null | grep -oE '"(@runtimescope/[a-z-]+|runtimescope)"' | sort -u

# Python SDK (project-local or global)
pip show runtimescope 2>/dev/null | head -3
grep -E '^runtimescope' requirements.txt pyproject.toml 2>/dev/null

# Background service / CLI
which runtimescope 2>/dev/null && runtimescope --version 2>/dev/null
ls ~/Library/LaunchAgents/com.runtimescope.collector.plist ~/.config/systemd/user/runtimescope.service 2>/dev/null

# MCP server registration
claude mcp list 2>/dev/null | grep -i runtimescope

# Plugin install
claude plugin list 2>/dev/null | grep -A 2 "runtimescope@"
```

Categorise the findings:

- `@runtimescope/sdk`, `server-sdk`, `workers-sdk` → base SDKs
- `@runtimescope/nextjs`, `remix`, `sveltekit`, `vite` → framework packages (bundle the relevant base SDK)
- `runtimescope` (native binary on PATH) → CLI + `collector-server` + `mcp-server` (Rust, v0.11.0+; the old `@runtimescope/mcp-server` / `@runtimescope/collector` npm packages are deprecated)
- `runtimescope` (PyPI) → Python SDK
- Plugin at user scope → `/runtimescope:*` slash commands and the skill

If nothing is installed → print: `No RuntimeScope packages detected. Run /runtimescope:setup first.` and stop.

---

## Phase 2: Fetch the target version

Ask npm what the newest published version is:

```bash
npm view @runtimescope/sdk version 2>/dev/null
```

Use that as the target for every `@runtimescope/*` package so they stay aligned (they ship together).

For Python:

```bash
pip index versions runtimescope 2>/dev/null | head -1
```

For the plugin:

```bash
claude plugin marketplace update runtimescope 2>&1 | tail -5
```

Surface a one-line summary: `current → target` for each group.

---

## Phase 3: Update

Only run the install commands for components that are actually in use.

### 3.1 Node packages

```bash
# Base SDKs (only if explicitly in package.json)
npm install @runtimescope/sdk@latest @runtimescope/server-sdk@latest @runtimescope/workers-sdk@latest

# Framework packages (only those in package.json)
npm install @runtimescope/nextjs@latest   # if Next.js app
npm install @runtimescope/remix@latest    # if Remix
npm install @runtimescope/sveltekit@latest  # if SvelteKit
npm install @runtimescope/vite@latest     # if Vite app
```

Framework packages bundle their matching base SDK. If the project uses `@runtimescope/nextjs`, you do **not** need to also upgrade `@runtimescope/sdk` or `server-sdk` directly — the framework package pins the compatible version.

### 3.2 Python SDK

```bash
pip install -U runtimescope
```

### 3.3 CLI + collector + MCP server (the Rust binaries)

As of v0.11.0 the `runtimescope` CLI, `collector-server`, and `mcp-server` are native
binaries (one crate, three bins) — updated by reinstalling, not via npm.

```bash
# cargo if present (cross-platform), else point at the GitHub release.
which cargo >/dev/null && cargo install runtimescope --force || \
  echo "No cargo — grab the latest binaries from https://github.com/edwinlov3tt/runtimescope/releases/latest"

# Regenerate the launchd/systemd unit so it points at the refreshed binary + restart.
runtimescope service install
```

The MCP server picks up the new binary automatically: the plugin's `.mcp.json` runs
`runtimescope mcp`, so the next Claude Code launch uses the updated binary. (If the user
registered it manually without the plugin, `claude mcp` still points at the same
`runtimescope mcp` command — no re-registration needed.)

### 3.5 Plugin

```bash
claude plugin update runtimescope@runtimescope
```

The user must restart Claude Code for the new plugin version to load.

---

## Phase 4: Validate config + migrate anything drifted

Run `/runtimescope:fix-config` (or call `setup_project` with the existing project path — it's idempotent and will patch any missing fields like a newer `dsn` shape).

If `RUNTIMESCOPE_DSN` is set in shell / CI, verify the port still matches (defaults moved from 9090/9091 → 6767/6768 in v0.10.0).

---

## Phase 5: Verify the upgrade

Ask the user to restart their app, then:

```
wait_for_session({ project_id: "<projectId from config>", timeout_seconds: 30, min_events: 1 })
```

- If it connects with events → report success.
- If it times out → `/runtimescope:diagnose` for a detailed report, or check `runtimescope service status` + `lsof -nP -iTCP:6768` for port conflicts.

---

## Phase 6: Report

```markdown
# RuntimeScope Updated

## Packages
| Component | Before | After |
|---|---|---|
| @runtimescope/nextjs | [prev] | [target] |
| @runtimescope/workers-sdk | [prev] | [target] |
| runtimescope (Python) | [prev] | [target] |
| runtimescope (CLI + collector + mcp, Rust) | [prev] | [target] |
| Plugin | [prev] | [target] |

## What's new in this version
[fetched from CHANGELOG or release notes via WebFetch on
 https://raw.githubusercontent.com/edwinlov3tt/runtimescope/main/CHANGELOG.md — summarise only items that affect how existing SDK users call the library]

## Action items
- [ ] Restart Claude Code to pick up the updated plugin (if updated).
- [ ] Restart dev server(s) to load the new SDK.
- [ ] If the app uses Next.js / Remix / SvelteKit / Vite, prefer the framework package over the base SDK.
- [ ] [any breaking changes from the changelog, as a checklist]

## Connection
Verified after restart: [yes/no]
```

---

## Rules

- Only upgrade components actually in use — don't install `runtimescope` (Python) into a Node-only project.
- Framework packages replace their base SDK — don't double-install.
- Never skip hooks, force-push, or modify lockfiles silently. If `npm install` wants to update a lockfile, let it — that's the update.
- If an upgrade step fails (npm auth error, Python environment issue), stop and surface it. Don't paper over.
- The plugin upgrade requires a Claude Code restart to take effect. Flag that clearly.
