---
description: Get a new Claude instance up to speed on the project by reading all documentation
allowed-tools: ["Read", "Bash", "Grep"]
---

# Onboard — Get Up to Speed

Read all project documentation and generate a comprehensive briefing. This is for NEW Claude instances that need context fast.

This command reads docs — it does NOT scan code deeply. Use `/audit` for deep code analysis once you have context.

## Phase 1: Read Core Documentation

Read these in order. Skip any that don't exist.

### Priority 1 — Must Read
1. `CLAUDE.md` — Project-specific instructions, conventions, rules
2. `README.md` — Project overview, purpose, quick start
3. `PRD.md` / `SPEC.md` / `REQUIREMENTS.md` — Product requirements (check root and docs/)
4. `.claude/docs/ARCHITECTURE.md` — Tech stack, structure, deployment

### Priority 2 — Context
5. `.claude/docs/KNOWN_ISSUES.md` — Current bugs and blockers
6. `.claude/docs/DECISIONS.md` — Why things were built this way
7. `.claude/docs/ASSESSMENT.md` — Production readiness (if exists)
8. `.claude/docs/LOCAL_DEV.md` — How to run locally (if exists)

### Priority 3 — Current Work
9. `.claude/tasks/README.md` — Task board, what's in progress
10. `.claude/features/README.md` — Feature backlog by phase (if exists)
11. `.claude/docs/CHANGELOG.md` — Recent changes (last 10 entries)

### Priority 4 — Reference (scan titles, read if relevant)
12. `.claude/docs/services/*.md` — External integrations
13. `.claude/docs/components/*.md` — Internal component docs

## Phase 2: Quick Project Scan

Lightweight context gathering (NOT a full audit):

```bash
# Project type and structure
ls -la package.json pyproject.toml Cargo.toml wrangler.toml 2>/dev/null

# High-level directory structure
find . -type d -maxdepth 2 | grep -v node_modules | grep -v .git | grep -v __pycache__ | grep -v .next | sort

# Recent git activity
git log --oneline -10 2>/dev/null
git branch --show-current 2>/dev/null
git status --short 2>/dev/null
```

## Phase 3: Generate Briefing

Present the briefing directly in chat:

```markdown
# Project Briefing

## Overview
**Project**: [name]
**Purpose**: [1-2 sentences]
**Type**: [Web app / API / CLI / etc.]
**Stage**: [Early dev / Feature complete / Production / etc.]

## Tech Stack
| Layer | Technology |
|-------|------------|
| Frontend | [X] |
| Backend | [X] |
| Database | [X] |
| Hosting | [X] |

## Current State

### Active Tasks
| Task | Status | Priority |
|------|--------|----------|
| [task] | 🔄 | P0 |

### Blocking Issues
- [CRITICAL/HIGH issues from KNOWN_ISSUES.md]

### Recent Changes
- [Last 3-5 meaningful commits or changelog entries]

## Key Decisions
[2-3 most important architectural decisions that affect current work]

## Gotchas
[Things to watch out for — from KNOWN_ISSUES and DECISIONS]

## Feature Backlog
| Feature | Phase | Complexity |
|---------|-------|------------|
| [feature] | MVP | M |
[Top 5 features if backlog exists]

---

## Ready to Help With

Based on current project state:
1. [Most relevant priority]
2. [Second priority]
3. [Third priority]

What would you like to work on?
```

## Rules

- Present the briefing IN CHAT so it's immediately useful
- Be concise — this is a briefing, not a novel
- Focus on what matters NOW: active tasks, blocking issues, recent decisions
- If documentation is sparse, say what's missing and suggest running `/audit`
- Do NOT audit code or scan for undocumented items — that's `/audit`'s job
- Do NOT start servers or check environment — that's `/dev`'s job
