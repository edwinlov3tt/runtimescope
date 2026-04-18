# RuntimeScope Playground

End-to-end test harness. A tiny fullstack app that exercises every SDK feature, so you can verify the dashboard / MCP tools / collector / plugins all work together.

## What it does

- **Frontend** (Vite + React on :5173) with the browser SDK installed via `@runtimescope/vite`. Buttons trigger every event type: network success/failure/slow, console log/warn/error, thrown errors, promise rejections, custom events, breadcrumbs, and React re-renders.
- **Backend** (raw `node:http` on :5174) with `@runtimescope/server-sdk` installed. Answers `/api/ok`, `/api/slow`, `/api/error`, plus returns 404 for unknown paths.
- Both SDKs point at the same project (`proj_playground_demo`) so events unify in the dashboard.
- The Vite plugin auto-starts the collector on boot if it isn't already running.

## Run it

From the monorepo root:

```bash
# First time: install playground deps
npm install -w playground

# Start both frontend + backend (collector auto-spawns if missing)
npm run dev -w playground
```

Then:
- Open http://localhost:5173 — click buttons to generate events
- Open http://localhost:3200 — RuntimeScope dashboard shows everything live (run `npm run dashboard` if it isn't up)
- In Claude Code — ask "show me playground network requests" and the MCP tools will return real data

## What to click to exercise each feature

| Button | What it tests |
|--------|---------------|
| Success (200) | Basic network capture, API catalog |
| Slow (2s) | Slow-request detection |
| Server error (500) | Failed-request detection + server-side error capture |
| Not found (404) | Status filtering |
| console.log/warn/error | Console tool filtering + levels |
| Throw TypeError | Uncaught error capture + source context |
| Unhandled rejection | Promise rejection capture |
| track | Custom event capture |
| addBreadcrumb | Breadcrumb trail |
| Spam 20 re-renders | Render profile + "suspicious components" |

## Verifying with MCP

After clicking buttons, from Claude Code:

```
get_session_info({ project_id: "proj_playground_demo" })
get_network_requests({ project_id: "proj_playground_demo" })
get_console_messages({ project_id: "proj_playground_demo" })
detect_issues({ project_id: "proj_playground_demo" })
```

All should return populated data.
