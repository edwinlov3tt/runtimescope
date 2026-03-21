---
description: Install RuntimeScope SDK — detect framework, generate snippet, verify connection
allowed-tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "mcp__runtimescope__get_sdk_snippet", "mcp__runtimescope__get_session_info", "mcp__runtimescope__get_project_config"]
---

# Setup — Install RuntimeScope SDK

Detect the project's framework, generate the correct SDK installation snippet, walk through installation, and verify the connection.

---

## Phase 1: Detect Framework

Scan the project to determine the tech stack:

```bash
# Check package.json for framework indicators
cat package.json 2>/dev/null | grep -E '"(next|react|vue|@vue|svelte|@sveltejs|angular|@angular|nuxt|astro|remix|solid)"' | head -10

# Check for Cloudflare Workers
ls wrangler.toml wrangler.jsonc 2>/dev/null
cat package.json 2>/dev/null | grep -E '"(wrangler|@cloudflare/workers-types)"' | head -5

# Check for non-Node frameworks
ls requirements.txt pyproject.toml 2>/dev/null  # Python (Flask/Django)
ls Gemfile 2>/dev/null                           # Ruby (Rails)
ls composer.json 2>/dev/null                     # PHP
ls wp-config.php 2>/dev/null                     # WordPress
```

Map to framework type:
- `wrangler.toml` or `@cloudflare/workers-types` → workers
- `next` → nextjs
- `react` / `react-dom` → react
- `vue` / `@vue/core` → vue
- `svelte` / `@sveltejs/kit` → svelte
- `@angular/core` → angular
- `nuxt` → nuxt
- `flask` / `django` → flask/django
- `rails` → rails
- No match → html

**If the project contains BOTH a Workers backend AND a frontend framework**, set up both (see Phase 6).

---

## Phase 2: Scaffold Project Config

Check if `.runtimescope/config.json` already exists:

```bash
cat .runtimescope/config.json 2>/dev/null || echo "NOT_FOUND"
```

If it exists, read it with `get_project_config` to see what's already configured.

If it doesn't exist, it will be auto-created in the next phase when `get_sdk_snippet` is called with `project_dir`.

---

## Phase 3: Generate SDK Snippet

Run `get_sdk_snippet` with:
- The detected framework
- A sensible app name (from `package.json` name field or directory name)
- `project_dir` set to the current working directory (this creates `.runtimescope/config.json` automatically)

The snippet will include the `projectId` from the generated config.

---

## Phase 3: Install the SDK

Based on the framework, guide the user through installation:

### For Cloudflare Workers

1. Show the `withRuntimeScope` wrapper snippet
2. Identify the Worker entry file (typically `src/index.ts`)
3. Offer to wrap the existing export:

```markdown
I'll add the RuntimeScope Workers SDK to your Worker. This wraps your fetch handler to capture:
- Incoming requests with timing and CF properties
- D1 queries, KV operations, R2 operations
- Console output and errors
- Custom events and breadcrumbs

**Entry file**: `src/index.ts`

I'll also need to:
1. Install `@runtimescope/workers-sdk`
2. Add `nodejs_compat` to your `wrangler.toml` compatibility flags (required for AsyncLocalStorage)

Shall I set this up automatically?
```

If auto-installing:
- Run `npm install @runtimescope/workers-sdk`
- Wrap the existing export with `withRuntimeScope`
- Instrument any D1/KV/R2 bindings found in the code
- Add `nodejs_compat` to `wrangler.toml` if not present

### For npm-based projects (React, Vue, Svelte, Next.js, etc.)

1. Show the import snippet and where to place it
2. Offer to add it automatically:

```markdown
I'll add the RuntimeScope SDK to your app. The snippet goes in:
- **Next.js App Router**: `app/layout.tsx` (client component wrapper)
- **Next.js Pages**: `pages/_app.tsx`
- **React (Vite/CRA)**: `src/main.tsx` or `src/index.tsx`
- **Vue**: `src/main.ts`
- **Svelte**: `src/main.ts`

Shall I add it automatically, or would you prefer to paste it yourself?
```

### For HTML/template-based projects (Flask, Django, Rails, PHP, WordPress)

1. Show the `<script>` tag snippet
2. Identify the base template file
3. Offer to add it before `</body>`

---

## Phase 4: Verify Connection

After the user has added the snippet and started their app/worker:

### For Cloudflare Workers

1. Check if the collector is running
2. Run `get_session_info` to check for a connected session
3. If connected:

```markdown
## Connection Verified!

**App**: [app name]
**Session**: [session id]
**SDK Version**: [version]
**Connected**: [time ago]

RuntimeScope is now capturing from your Worker:
- Incoming HTTP requests with CF properties
- Console logs, warnings, errors
- D1/KV/R2 operations (if instrumented)
- Custom events and breadcrumbs

## Available Commands
| Command | What it does |
|---------|-------------|
| `/diagnose` | Full health check |
| `/network` | Network analysis |
| `/queries` | Database query audit (D1) |
| `/api` | API health report |
```

4. If not connected:

```markdown
## Not Connected Yet

No session detected from your Worker. Common issues:
1. **Worker not running**: Run `wrangler dev` to start locally
2. **Collector not running**: Make sure the RuntimeScope collector is up
3. **Wrong endpoint**: Check `httpEndpoint` points to `http://localhost:9091/api/events`
4. **nodejs_compat missing**: Add `nodejs_compat` to `compatibility_flags` in wrangler.toml
5. **Network issue**: Workers in dev mode need to reach localhost — check no firewall is blocking

Try sending a request to your Worker and run `/setup` again to verify.
```

### For Browser SDK

1. Run `get_session_info` to check for a connected session
2. If connected:

```markdown
## Connection Verified!

**App**: [app name]
**Session**: [session id]
**SDK Version**: [version]
**Connected**: [time ago]

RuntimeScope is now capturing:
- Network requests (fetch/XHR)
- Console logs, warnings, errors
- Web Vitals (LCP, FCP, CLS, TTFB, INP)
- Unhandled errors and promise rejections

## Available Commands
| Command | What it does |
|---------|-------------|
| `/diagnose` | Full health check |
| `/trace [flow]` | Trace a user flow |
| `/renders` | Component render audit |
| `/api` | API health report |
| `/network` | Network analysis |
| `/recon [url]` | Website recon |
```

3. If not connected:

```markdown
## Not Connected Yet

No RuntimeScope session detected. Common issues:
1. **App not running**: Start your dev server first
2. **Snippet not loaded**: Check that the `<script>` tag or import is in the right place
3. **Wrong port**: Make sure `endpoint: 'ws://localhost:9090'` matches the collector port
4. **Browser not open**: The SDK runs in the browser — open your app in a browser tab

The RuntimeScope collector is listening on ws://localhost:9090.
Try reloading your app and run `/setup` again to verify.
```

---

## Phase 5: Server SDK (Optional)

If the project has a Node.js backend (Express, Fastify, Hono, Next.js API routes) AND is NOT a Workers project:

```markdown
## Optional: Server-Side Monitoring

For database query tracking and server-side metrics, add the server SDK:

```bash
npm install @runtimescope/server-sdk
```

Then in your server entry point:
```js
import { RuntimeScope } from '@runtimescope/server-sdk';

RuntimeScope.init({
  appName: 'my-api',
  endpoint: 'ws://localhost:9090',
  instrumentations: ['pg'],  // or 'prisma', 'mysql2', 'drizzle'
});
```

This enables: `/queries` for database audit, server performance metrics.
```

---

## Phase 6: Combined Setup (Workers + Frontend)

If the project has BOTH a Workers backend and a frontend framework (e.g., a monorepo with a Workers API and a React dashboard):

1. Set up the Workers SDK first (captures backend)
2. Then set up the browser SDK (captures frontend)
3. Both will send events to the same collector, giving full-stack visibility

```markdown
## Full-Stack Setup Complete

You now have RuntimeScope monitoring on both sides:

| Layer | SDK | Captures |
|-------|-----|----------|
| **Workers** | `@runtimescope/workers-sdk` | Requests, D1/KV/R2, console, custom events |
| **Frontend** | `@runtimescope/sdk` | Network, renders, state, Web Vitals, clicks |

Both feed into the same collector — use `/diagnose` for a unified health check.
```

---

## Phase 7: Register Claude Code Hooks (Optional)

Register global hooks for real-time tool timing data, improving CapEx time tracking accuracy.

### Check existing hooks
```bash
cat ~/.claude/settings.json 2>/dev/null | grep -c "runtimescope\|9091" || echo "0"
```

If the count is 0 (no RuntimeScope hooks registered), proceed to add them.

### Merge hooks into settings.json

Read `~/.claude/settings.json`. If it doesn't exist, create it with `{}`.

Add the following hook entries. **IMPORTANT**: Merge into any existing `hooks` object — do NOT overwrite other hooks the user may have configured.

The hooks to add under `hooks.PostToolUse` (append to existing array if one exists):

```json
{
  "matcher": ".*",
  "hooks": [
    {
      "type": "command",
      "command": "curl -s -X POST http://localhost:9091/api/events -H 'Content-Type: application/json' -d '{\"sessionId\":\"claude-hooks\",\"appName\":\"claude-hooks\",\"events\":[{\"eventId\":\"hook-'$(date +%s%N)'\",\"sessionId\":\"claude-hooks\",\"timestamp\":'$(date +%s000)',\"eventType\":\"custom\",\"name\":\"tool_use\",\"properties\":{\"tool\":\"'\"$CLAUDE_TOOL_NAME\"'\",\"exitCode\":\"'\"$CLAUDE_TOOL_EXIT_CODE\"'\"}}]}' >/dev/null 2>&1 &"
    }
  ]
}
```

### What the hooks do
- **PostToolUse**: After every tool call, fires a background `curl` to log the tool name and exit code to the RuntimeScope collector
- Events appear as `custom` type events with name `tool_use` in the event timeline
- Fire-and-forget (`&` + `>/dev/null 2>&1`) — zero impact on Claude performance
- Improves CapEx time tracking by providing per-tool timing data

### Verify hooks are registered
```bash
cat ~/.claude/settings.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('Hooks registered:', 'PostToolUse' in d.get('hooks', {}))"
```

### If user declines
Hooks are optional. The tool works without them — session timing falls back to JSONL gap-aware parsing. Hooks just add finer granularity.
