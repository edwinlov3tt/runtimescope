---
description: Install RuntimeScope SDK — detect framework, generate snippet, verify connection
allowed-tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "mcp__runtimescope__setup_project", "mcp__runtimescope__get_sdk_snippet", "mcp__runtimescope__get_session_info", "mcp__runtimescope__get_project_config"]
---

# Setup — Install RuntimeScope SDK

One-step project setup: detect framework, scaffold config, generate SDK snippets, register hooks.

**IMPORTANT**: Do NOT restart, kill, or modify the user's dev server. Only scaffold config and generate snippets. The user starts their own app.

---

## Step 1: Set Up the Project

**Try `setup_project` first** (preferred — does everything in one call):

```
setup_project({ project_dir: "<absolute path to project root>" })
```

**If `setup_project` is not available** (older MCP server version), fall back to manual steps:

### Fallback: Manual Setup

1. Detect the framework:
```bash
cat package.json 2>/dev/null | grep -E '"(next|react|vue|svelte|angular|nuxt|wrangler)"' | head -5
ls wrangler.toml wrangler.jsonc 2>/dev/null
```

2. Get the app name:
```bash
cat package.json 2>/dev/null | grep '"name"' | head -1
```

3. Generate snippet with `get_sdk_snippet`:
```
get_sdk_snippet({
  app_name: "<app name>",
  framework: "<detected framework>",
  project_dir: "<absolute path to project root>"
})
```

This creates `.runtimescope/config.json` and returns the snippet to install.

## Step 2: Install the SDK

From the response, follow the instructions:

1. **Run the install command** (e.g., `npm install @runtimescope/sdk`)
2. **Paste the snippet** into the entry file indicated by `placement`
3. **If multiple SDKs detected** (e.g., Next.js browser + server), install both

## Step 3: Verify Connection

After the user starts their app:

```
get_session_info({ project_id: "<projectId from setup>" })
```

If connected, setup is complete. If not:
- Check the app is running
- Check the endpoint matches (default: `ws://localhost:6767`)
- Check for console errors in the browser

## Step 4: Confirm

Report back:

```markdown
# RuntimeScope Setup Complete

**Project**: [name] ([projectId])
**Framework**: [detected framework]
**SDK**: [browser/server/workers]
**Connection**: Connected / Awaiting app start

Config saved to `.runtimescope/config.json` — commit this to git.
```

---

## Rules

- **NEVER restart, stop, or kill the user's dev server or any running processes**
- **NEVER modify existing application code without showing the user first**
- Only scaffold `.runtimescope/config.json` and generate snippets
- Let the user decide when to restart their app
- If the collector isn't running, the SDK fails silently (no crash)
