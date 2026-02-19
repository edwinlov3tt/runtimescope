---
description: Install RuntimeScope SDK — detect framework, generate snippet, verify connection
allowed-tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob"]
---

# Setup — Install RuntimeScope SDK

Detect the project's framework, generate the correct SDK installation snippet, walk through installation, and verify the connection.

---

## Phase 1: Detect Framework

Scan the project to determine the tech stack:

```bash
# Check package.json for framework indicators
cat package.json 2>/dev/null | grep -E '"(next|react|vue|@vue|svelte|@sveltejs|angular|@angular|nuxt|astro|remix|solid)"' | head -10

# Check for non-Node frameworks
ls requirements.txt pyproject.toml 2>/dev/null  # Python (Flask/Django)
ls Gemfile 2>/dev/null                           # Ruby (Rails)
ls composer.json 2>/dev/null                     # PHP
ls wp-config.php 2>/dev/null                     # WordPress
```

Map to framework type:
- `next` → nextjs
- `react` / `react-dom` → react
- `vue` / `@vue/core` → vue
- `svelte` / `@sveltejs/kit` → svelte
- `@angular/core` → angular
- `nuxt` → nuxt
- `flask` / `django` → flask/django
- `rails` → rails
- No match → html

---

## Phase 2: Generate SDK Snippet

Run `get_sdk_snippet` with the detected framework and a sensible app name (from `package.json` name field or directory name).

---

## Phase 3: Install the SDK

Based on the framework, guide the user through installation:

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

After the user has added the snippet and loaded their app:

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

If the project has a Node.js backend (Express, Fastify, Hono, Next.js API routes):

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
