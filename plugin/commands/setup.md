---
description: Install or repair RuntimeScope — detects existing config, installs fresh or verifies/repairs as needed
allowed-tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "mcp__runtimescope__setup_project", "mcp__runtimescope__get_sdk_snippet", "mcp__runtimescope__get_session_info", "mcp__runtimescope__wait_for_session", "mcp__runtimescope__get_project_config", "mcp__runtimescope__list_projects"]
---

# Setup — Install or Repair RuntimeScope

Detects whether RuntimeScope is already configured in the project and takes the right path:

- **Fresh install** → scaffold `.runtimescope/config.json`, detect framework, generate SDK snippet, verify connection.
- **Already installed** → validate config, confirm the SDK is actually connecting, fix any drift (missing projectId, outdated ports, missing SDKs), skip re-scaffolding.

**IMPORTANT**: Do NOT restart, kill, or modify the user's dev server. Only scaffold config and generate snippets. The user starts their own app.

---

## Step 0: Detect existing install

Check what's already in the project:

```bash
ls -la .runtimescope/config.json 2>/dev/null && echo "CONFIG_EXISTS" || echo "FRESH"
grep -l "@runtimescope/\|RuntimeScope\." package.json requirements.txt pyproject.toml 2>/dev/null
```

Branch on the result:

- If `FRESH` → go to **Fresh Install**.
- If `CONFIG_EXISTS` → go to **Existing Install Verification**.

---

## Fresh Install

### 1. Run `setup_project`

One call — detects framework, scaffolds config, picks the best-fit SDK package, returns snippets:

```
setup_project({ project_dir: "<absolute path to project root>" })
```

**Multi-repo projects** — to link a separate repo (e.g. backend in a different repo) to an existing project, pass `project_id`:

```
setup_project({ project_dir: "/path/to/backend", project_id: "proj_abc123def456" })
```

`setup_project` automatically picks:
- `@runtimescope/nextjs` / `remix` / `sveltekit` / `vite` for those frameworks,
- `runtimescope` (PyPI) for Python,
- `@runtimescope/workers-sdk` for Cloudflare Workers,
- `@runtimescope/sdk` / `@runtimescope/server-sdk` as fallback.

Don't second-guess its choice.

**If `setup_project` is not available** (older MCP server), fall back to `get_sdk_snippet`:

```bash
# Detect framework
cat package.json 2>/dev/null | grep -E '"(next|react|vue|svelte|angular|nuxt|wrangler)"' | head -5
ls wrangler.toml wrangler.jsonc pyproject.toml 2>/dev/null
```

```
get_sdk_snippet({ app_name: "<pkg name>", framework: "<detected>", project_dir: "<abs path>" })
```

### 2. Install + paste

Follow the instructions returned:
1. Run the install command (`npm install ...` or `pip install runtimescope`).
2. Paste the snippet at the indicated `placement`.
3. For multi-SDK setups (e.g. Next.js browser + server), install/paste each one.

### 3. Verify connection

After the user says they've started their app, prefer `wait_for_session`:

```
wait_for_session({ project_id: "<projectId>", timeout_seconds: 30, min_events: 1 })
```

Falls back to `get_session_info` if unavailable. If the SDK never connects:
- Confirm the app is running.
- Confirm `endpoint` matches the collector (default `ws://localhost:6767`).
- If another process owns the port, run `npx runtimescope doctor`.

### 4. Confirm

```markdown
# RuntimeScope — Fresh Install Complete

**Project**: [name] ([projectId])
**Framework**: [detected]
**Package**: [@runtimescope/nextjs / sdk / server-sdk / workers-sdk / runtimescope (PyPI)]
**Connection**: Connected ✅ / Awaiting app start

Config saved to `.runtimescope/config.json` — commit this to git.
```

---

## Existing Install Verification

### 1. Read current config

```
get_project_config({ project_dir: "<abs path>" })
```

Note what's already set: `projectId`, `appName`, `dsn`, `sdks[]`.

### 2. Check health of the running SDK

```
wait_for_session({ project_id: "<projectId from config>", timeout_seconds: 10 })
```

Interpret the result:
- **Connected** → SDK is healthy. Skip to step 5.
- **Not connected, 0 sessions** → Either the app isn't running, or the SDK isn't installed/imported. Check the installed packages + entry file.
- **Connected but 0 events** → SDK handshake works but no activity. Ask the user to interact with the app.

### 3. Validate config shape

Check each field in `.runtimescope/config.json`:

| Field | Required | Fix if missing |
|---|---|---|
| `projectId` | ✅ | Call `setup_project` with existing path — it'll repair. |
| `appName` | ✅ | Same. |
| `dsn` | Recommended | Generate: `runtimescope://<projectId>@localhost:6768/<appName>` |
| `sdks[]` | ✅ | Regenerate from detected frameworks via `setup_project`. |
| `capture.*` flags | Optional | Leave as-is if present. |

If any required field is missing, run `setup_project` (idempotent — it patches what's missing without overwriting valid values).

### 4. Check installed packages vs config

```bash
# List what's claimed in config.sdks vs what's actually installed
cat .runtimescope/config.json | grep -oE '"type":[^,]+' | sort -u
grep -oE '"@runtimescope/[a-z-]+"' package.json 2>/dev/null | sort -u
pip list 2>/dev/null | grep -i runtimescope
```

If a declared SDK isn't installed, offer to install it (don't install without asking — there may be a pending migration). For monorepos, check every workspace.

### 5. Check for out-of-sync projectIds

Every connected session should report the **same** `projectId`:

```
get_session_info({ project_id: "<projectId from config>" })
```

If sessions exist for this project but with different `projectId` values, the identity chain broke. This is usually fixed by restarting the app once (the collector's migration runs on startup). If it persists, read `.runtimescope/config.json` and `~/.runtimescope/projects/<appName>/config.json` — the user-level file should match the project's `projectId`.

### 6. Report

```markdown
# RuntimeScope — Existing Install Verified

**Project**: [name] ([projectId])
**Config**: [✓ valid / ⚠ missing <field> — patched]
**SDK(s)**: [list with install status]
**Connection**: Connected ✅ / Not connected (reason)
**Events captured**: [N since start]

[Any warnings or repair actions taken]
```

---

## Rules

- **NEVER restart, stop, or kill the user's dev server or any running processes.**
- **NEVER modify existing application code without showing the user first.**
- Only scaffold or patch `.runtimescope/config.json` and generate snippets; the user starts their own app.
- `setup_project` is idempotent — safe to run again on an existing install. It patches missing fields and leaves valid values alone.
- If the collector isn't running, the SDK fails silently (no crash). That's expected — tell the user how to start it (`npx runtimescope service install` for a persistent service).
