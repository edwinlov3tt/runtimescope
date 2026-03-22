---
description: Install RuntimeScope SDK — detect framework, generate snippet, verify connection
allowed-tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "mcp__runtimescope__setup_project", "mcp__runtimescope__get_session_info", "mcp__runtimescope__get_project_config"]
---

# Setup — Install RuntimeScope SDK

One-step project setup: detect framework, scaffold config, generate SDK snippets, register hooks.

---

## Step 1: Run setup_project

Call the `setup_project` MCP tool with `project_dir` set to the current working directory:

```
setup_project({ project_dir: "<absolute path to project root>" })
```

This automatically:
- Detects the framework(s) from package.json, wrangler.toml, etc.
- Creates `.runtimescope/config.json` with a stable project ID
- Generates the correct SDK snippet(s) for each detected SDK type
- Registers Claude Code hooks for tool timing in `~/.claude/settings.json`
- Checks if the SDK is already installed and connected

## Step 2: Install the SDK

From the `setup_project` response, follow the `nextSteps` instructions:

1. **Run the install command** shown in each snippet (e.g., `npm install @runtimescope/sdk`)
2. **Paste the snippet** into the entry file indicated by `placement`
3. **If multiple SDKs detected** (e.g., Next.js browser + server), install both

## Step 3: Verify Connection

After the user starts their app:

```
get_session_info({ project_id: "<projectId from setup>" })
```

If connected, setup is complete. If not:
- Check the app is running
- Check the endpoint matches (default: `ws://localhost:9090`)
- Check for console errors in the browser

## Step 4: Confirm

Report back:

```markdown
# RuntimeScope Setup Complete

**Project**: [name] ([projectId])
**Framework**: [detected framework]
**SDK**: [browser/server/workers]
**Connection**: Connected / Awaiting app start
**Hooks**: Registered / Already existed

Config saved to `.runtimescope/config.json` — commit this to git.
```

---

## Notes

- `.runtimescope/config.json` is git-safe (no secrets) — commit it
- The server SDK auto-reads config from `.runtimescope/config.json` if no explicit config is passed
- Hooks fire in the background and never block Claude
- If the collector isn't running, the SDK and hooks fail silently (no crash)
