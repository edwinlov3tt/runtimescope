---
description: Dev environment status — processes, ports, builds, deployments
allowed-tools: ["Bash", "Read", "Grep", "Glob", "mcp__runtimescope__get_dev_processes", "mcp__runtimescope__get_port_usage", "mcp__runtimescope__get_build_status", "mcp__runtimescope__get_deploy_logs", "mcp__runtimescope__get_runtime_logs", "mcp__runtimescope__get_infra_overview", "mcp__runtimescope__kill_process", "mcp__runtimescope__purge_caches", "mcp__runtimescope__restart_dev_server"]
---

# DevOps — Dev Environment Status

Check the health of your local development environment: running processes, port usage, build status, and deployment logs.

---

## Phase 1: Local Processes

Run `get_dev_processes` to list all running dev servers, databases, and background processes.

```markdown
## Running Processes
| PID | Type | Command | Port | Memory | CPU |
|-----|------|---------|------|--------|-----|
| 12345 | next | next dev | 3000 | 245MB | 12% |
| 12346 | postgres | postgres | 5432 | 89MB | 1% |
```

---

## Phase 2: Port Usage

Run `get_port_usage` to check for port conflicts and see what's listening where.

```markdown
## Port Map
| Port | Process | PID | Status |
|------|---------|-----|--------|
| 3000 | next dev | 12345 | Listening |
| 5432 | postgres | 12346 | Listening |
| 6767 | RuntimeScope | 12347 | Listening |
```

Flag any port conflicts or unexpected listeners.

---

## Phase 3: Build & Deploy Status

Run `get_build_status` to check deployment platforms (Vercel, Cloudflare, Railway).

If no deployment platform is configured:

```markdown
No deployment platform detected. If you deploy to Vercel, Cloudflare, or Railway,
configure the platform connector for deployment monitoring.
```

If available, also run:
- `get_deploy_logs` — Recent deployment history
- `get_runtime_logs` — Production runtime errors

---

## Phase 4: Infrastructure Overview

Run `get_infra_overview` to see all connected platforms and services.

---

## Phase 5: Report

```markdown
# Dev Environment Status

**Overall**: [Healthy / Issues Found]

## Local Development
| Component | Status | Details |
|-----------|--------|---------|
| Dev Server | Running | next dev on :3000 (245MB) |
| Database | Running | postgres on :5432 |
| RuntimeScope | Connected | ws://localhost:6767 |

## Port Summary
[X] ports in use, [Y] conflicts detected

## Deployments
| Platform | Last Deploy | Status | Branch |
|----------|------------|--------|--------|
| Vercel | 2h ago | Success | main |

## Issues
- [Any port conflicts]
- [Any crashed processes]
- [Any failed deployments]

## Quick Actions
- Kill a process: specify the PID
- Restart dev server: `get_dev_processes` → `kill_process` → restart
- Clear caches: `purge_caches` to free disk space
```
