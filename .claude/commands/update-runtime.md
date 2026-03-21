---
description: Update RuntimeScope SDK to latest — detect installed packages, upgrade, check for new features
allowed-tools: ["Bash", "Read", "Grep", "Glob", "WebFetch", "mcp__runtimescope__get_session_info", "mcp__runtimescope__get_sdk_snippet"]
---

# Update RuntimeScope — Upgrade SDK & Discover New Features

Detect which RuntimeScope packages are installed, update them to the latest version, and show what's new.

---

## Phase 1: Detect Installed Packages

Find which RuntimeScope packages are in the project:

```bash
# Check package.json for installed SDK packages
cat package.json 2>/dev/null | grep -E '"@runtimescope/(sdk|server-sdk|workers-sdk|mcp-server|collector)"' | head -10

# Check if MCP server is registered
claude mcp list 2>/dev/null | grep -i runtimescope || echo "MCP server: not registered"

# Current installed versions
npm ls @runtimescope/sdk @runtimescope/server-sdk @runtimescope/workers-sdk 2>/dev/null | grep runtimescope
```

Determine what's installed:
- `@runtimescope/sdk` → Browser SDK
- `@runtimescope/server-sdk` → Server/Node.js SDK
- `@runtimescope/workers-sdk` → Cloudflare Workers SDK
- MCP server registered → MCP tools available

If nothing is installed, tell the user to run `/setup` instead.

---

## Phase 2: Update Packages

### 2.1 Update npm packages
For each installed package, update to latest:

```bash
# Update browser SDK
npm install @runtimescope/sdk@latest 2>/dev/null

# Update server SDK
npm install @runtimescope/server-sdk@latest 2>/dev/null

# Update workers SDK
npm install @runtimescope/workers-sdk@latest 2>/dev/null
```

Only run the install commands for packages that are actually in package.json.

### 2.2 Update MCP server
If the MCP server is registered:

```bash
# The MCP server auto-updates via npx -y, but let's clear the cache
npx -y @runtimescope/mcp-server --version 2>/dev/null || echo "MCP server will auto-update on next Claude Code restart"
```

### 2.3 Verify versions after update
```bash
npm ls @runtimescope/sdk @runtimescope/server-sdk @runtimescope/workers-sdk 2>/dev/null | grep runtimescope
```

---

## Phase 3: Check for New Features

Fetch the latest README from GitHub to discover new tools and features:

```
Use WebFetch to read: https://raw.githubusercontent.com/edwinlov3tt/runtimescope/main/README.md
```

From the README, extract:
1. **New MCP tools** — compare against what the user might already know
2. **New SDK config options** — any new fields like `projectId`, `captureNavigation`, etc.
3. **New slash commands** — commands they might not have copied yet
4. **Breaking changes** — anything that requires code changes

---

## Phase 4: Apply New Features

### 4.1 Project ID (v0.9.0+)
Check if the user's SDK init already has `projectId`. If not, suggest adding it:

Search the codebase for RuntimeScope.init or RuntimeScope.connect calls:
```bash
grep -rn "RuntimeScope\.\(init\|connect\)" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" . 2>/dev/null | grep -v node_modules | grep -v dist/
```

If `projectId` is missing from their init config:
- Use `get_sdk_snippet` to generate a snippet with a `projectId` for their app
- Show the user what to add: just the `projectId: 'proj_xxx',` line to their existing config
- Explain: "This groups all your SDKs (browser, server, worker) under one project so MCP tools can scope queries per-project"

### 4.2 New Slash Commands
Check which commands the user has vs what's available:
```bash
echo "=== User has ==="
ls .claude/commands/ 2>/dev/null

echo "=== Available ==="
# List from the repo
echo "api, audit, clone-ui, dev, devops, diagnose, events, feature, handoff, history, network, onboard, push, queries, recon, renders, setup, snapshot, sync, task, trace, update-runtime"
```

If they're missing any, offer to copy them.

### 4.3 Verify Connection
Use `get_session_info` to verify the SDK is still connected after the update.

---

## Phase 5: Report

```markdown
# RuntimeScope Updated

## Packages Updated
| Package | Previous | Current |
|---------|----------|---------|
| @runtimescope/sdk | 0.8.0 | 0.9.0 |
| @runtimescope/server-sdk | 0.8.0 | 0.9.0 |

## New in This Version
- **Project ID system** — `projectId` field groups all SDKs for a project. Auto-generated on connect.
- **MCP tool scoping** — all tools accept `project_id` param to filter by project.
- **Unified ports** — MCP and standalone both use 9090/9091.
- **Cross-platform** — process detection works on macOS, Linux, and Windows.

## Action Items
- [ ] Add `projectId` to SDK init config (optional — auto-generated if missing)
- [ ] Copy new slash commands: [list any missing]

## Connection
SDK connected: [yes/no]
```
