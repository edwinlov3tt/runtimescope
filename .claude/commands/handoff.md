---
description: Generate comprehensive developer handoff document
allowed-tools: ["Read", "Write", "Edit", "Bash", "Grep"]
---

# Handoff — Generate Developer Onboarding Doc

Aggregate all documentation into a single HANDOFF.md for developer onboarding.

---

## Phase 1: Gather All Documentation

Read all available docs:

```bash
echo "=== Available Docs ==="
ls -la README.md CLAUDE.md .claude/docs/*.md 2>/dev/null
ls -la .claude/docs/services/*.md 2>/dev/null
ls -la .claude/docs/components/*.md 2>/dev/null
ls -la .claude/tasks/README.md 2>/dev/null
ls -la .claude/features/README.md 2>/dev/null
```

Read each file that exists:
1. README.md
2. .claude/docs/ARCHITECTURE.md
3. .claude/docs/KNOWN_ISSUES.md
4. .claude/docs/DECISIONS.md
5. .claude/docs/LOCAL_DEV.md
6. .claude/docs/ASSESSMENT.md
7. All services/*.md
8. All components/*.md
9. .claude/tasks/README.md
10. .claude/features/README.md

## Phase 2: Gather Runtime Info

```bash
# Tech detection
cat package.json 2>/dev/null | grep -E "(name|version)" | head -2
cat package.json 2>/dev/null | grep -A20 '"dependencies"' | head -20

# Git info
git remote get-url origin 2>/dev/null
git log --oneline -5 2>/dev/null

# Structure
find . -type d -maxdepth 2 | grep -v node_modules | grep -v .git | grep -v __pycache__ | grep -v .next | sort
```

## Phase 3: Generate HANDOFF.md

Create `HANDOFF.md` in project root:

```markdown
# [Project Name] — Developer Handoff

**Generated**: [DATE]
**Purpose**: Everything you need to start working on this project.

---

## Quick Start

### Prerequisites
[From LOCAL_DEV.md or detection]
- Node.js >= X
- [Package manager]
- [Other requirements]

### Setup
```bash
git clone [repo-url]
cd [project-name]
[install command]
cp .env.example .env  # Fill in values below
[start command]
```

### Verify It Works
- Frontend: http://localhost:[port]
- Backend: http://localhost:[port]
- [Other services]

---

## Project Overview

[From README.md — brief description of what this project does]

---

## Tech Stack

[From ARCHITECTURE.md]

| Layer | Technology |
|-------|------------|
| Frontend | [X] |
| Backend | [X] |
| Database | [X] |
| Hosting | [X] |
| Key Libs | [X] |

---

## Architecture

[From ARCHITECTURE.md — system diagram or description]

### Project Structure
```
[Key directories and their purposes]
```

---

## Environment Variables

[Aggregated from all sources]

| Variable | Required | Description | Where to Get |
|----------|----------|-------------|-------------|
| `VAR_NAME` | Yes | [purpose] | [source] |

---

## Key Decisions

[From DECISIONS.md — most important ones]

| Decision | Choice | Why |
|----------|--------|-----|
| [decision] | [choice] | [rationale] |

---

## Known Issues

[From KNOWN_ISSUES.md — sorted by severity]

### Critical
- [Issue]: [description + workaround]

### High
- [Issue]: [description]

### Medium
- [Issue]: [description]

---

## External Services

[From services/*.md — summarized]

| Service | Purpose | Docs |
|---------|---------|------|
| [Service] | [Why we use it] | `.claude/docs/services/[name].md` |

---

## Development Workflow

### Running Locally
[From LOCAL_DEV.md]

### Making Changes
1. Create a branch: `git checkout -b feature/[name]`
2. Make changes following conventions in CLAUDE.md
3. Run `/push` to scan, commit, and push safely

### Using Claude Code
This project uses claude-docs-system for automated documentation:
- `/onboard` — Get up to speed (start here)
- `/dev` — Start local servers
- `/task` — View or create implementation tasks
- `/feature` — Log ideas to backlog
- `/sync` — Log work at end of session
- `/push` — Scan secrets and push
- `/audit` — Full project analysis
- `/handoff` — Regenerate this document

### Documentation
All docs live in `.claude/docs/`:
- `ARCHITECTURE.md` — System overview
- `CHANGELOG.md` — Change history
- `DECISIONS.md` — Why things were built this way
- `KNOWN_ISSUES.md` — Bugs and tech debt
- `services/` — External service docs
- `components/` — Internal component docs

---

## Current Status

### Production Readiness
[From ASSESSMENT.md if exists, otherwise brief summary]

### Active Tasks
[From tasks/README.md]

### Feature Backlog
[From features/README.md — top items by phase]

---

## Next Steps

### Immediate Priorities
1. [From ASSESSMENT.md or KNOWN_ISSUES.md]
2. [Second priority]
3. [Third priority]

### Upcoming Features
[Top MVP features from backlog]

---

*This handoff was auto-generated. Run `/handoff` to regenerate after significant changes.*
```

## Phase 4: Output

```markdown
# Handoff Generated ✅

**File**: `HANDOFF.md`

Includes:
- Quick start guide
- Tech stack & architecture
- Environment variables
- Key decisions
- Known issues (prioritized)
- External services
- Development workflow
- Current status & next steps

Share this file with any developer joining the project.
```
