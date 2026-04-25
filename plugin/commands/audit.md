---
description: Deep code analysis — production readiness, undocumented items, known issues refresh
allowed-tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
---

# Audit — Comprehensive Project Analysis

Deep scan of the codebase for production readiness, undocumented services/components, known issues, and documentation health.

Use this for: first-time setup, periodic checkups, after major changes, before milestones.

---

## Phase 1: Codebase Scan

### 1.1 Tech Stack Detection
```bash
# Package manager
for f in pnpm-lock.yaml yarn.lock package-lock.json bun.lockb; do [ -f "$f" ] && echo "Lock: $f"; done

# Languages and frameworks
cat package.json 2>/dev/null | grep -E "(next|react|vue|svelte|express|hono|fastify|nuxt|astro|remix)" | head -10
cat requirements.txt pyproject.toml 2>/dev/null | grep -E "(fastapi|flask|django|streamlit)" | head -5

# Infrastructure
ls wrangler.toml vercel.json netlify.toml fly.toml Dockerfile docker-compose.yml 2>/dev/null
```

### 1.2 Project Structure
```bash
find . -type d -maxdepth 3 | grep -v node_modules | grep -v .git | grep -v __pycache__ | grep -v .next | grep -v dist | sort
```

### 1.3 Entry Points
```bash
ls -la src/index.* src/main.* src/app.* app/layout.* app/page.* pages/index.* pages/_app.* main.* index.* 2>/dev/null
```

### 1.4 API Routes
```bash
# Next.js App Router
find app -name "route.ts" -o -name "route.js" 2>/dev/null
# Next.js Pages
find pages/api -type f 2>/dev/null
# Express/Hono
grep -rln "app\.\(get\|post\|put\|delete\)\|router\.\(get\|post\|put\|delete\)" --include="*.ts" --include="*.js" . 2>/dev/null | grep -v node_modules
```

---

## Phase 2: Production Readiness Assessment

### 2.1 Find Requirements
```bash
ls -la PRD*.md SPEC*.md REQUIREMENTS*.md README.md docs/*.md .claude/docs/ARCHITECTURE.md 2>/dev/null
```

Read any found specs to understand what "production" means for this project.

### 2.2 Check Critical Systems

**Authentication**: Search for auth patterns, protected routes, session management
**Database**: Check for schema, migrations, seed data
**Error Handling**: Look for global error handlers, try/catch patterns
**Security**: Input validation, CORS, rate limiting, env var usage (not hardcoded)
**Performance**: Caching, optimized queries, asset optimization
**Deployment**: Build process, env configs, CI/CD

### 2.3 Gap Analysis

Compare what exists vs what's needed:

```markdown
| Requirement | Status | Gap | Priority | Effort |
|-------------|--------|-----|----------|--------|
| [Feature] | ✅/🔄/❌ | [What's missing] | P0/P1/P2 | S/M/L |
```

---

## Phase 3: Find Undocumented Items

### 3.1 Scan for Services
```bash
# Package dependencies that are services
cat package.json 2>/dev/null | grep -E "(@supabase|@stripe|@sendgrid|@twilio|openai|@anthropic|@aws-sdk|@google-cloud|@cloudflare|firebase|@prisma|@planetscale|@upstash|resend|@sentry|@auth0|@clerk|next-auth)" | sed 's/[",:]//g' | awk '{print $1}'

# Env vars pointing to services
grep -rh --include="*.ts" --include="*.tsx" --include="*.js" --include="*.env*" \
  -oE "[A-Z_]+(KEY|SECRET|URL|TOKEN|API_KEY)" . 2>/dev/null | sort -u | head -20

# Already documented
ls .claude/docs/services/*.md 2>/dev/null | xargs -I {} basename {} .md 2>/dev/null
```

### 3.2 Scan for Components
```bash
# Major directories
find src lib app components pages api routes services utils hooks -type d -maxdepth 1 2>/dev/null | sort -u

# Already documented
ls .claude/docs/components/*.md 2>/dev/null | xargs -I {} basename {} .md 2>/dev/null
```

Compare found vs documented. List undocumented items.

---

## Phase 4: Known Issues Refresh

### 4.1 Scan for TODOs
```bash
grep -rn "TODO\|FIXME\|HACK\|XXX\|WORKAROUND\|TEMP\|BROKEN" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py" . 2>/dev/null | grep -v node_modules | grep -v ".claude/"
```

### 4.2 Check Git for Recent Issues
```bash
git log --oneline -20 2>/dev/null | grep -i "fix\|bug\|hotfix\|patch\|revert"
```

### 4.3 Update KNOWN_ISSUES.md
Cross-reference found TODOs/FIXMEs with existing known issues. Add any new ones, mark any resolved ones.

---

## Phase 5: Documentation Health

Check each doc for freshness and completeness:

```bash
echo "=== Documentation Files ==="
for f in .claude/docs/ARCHITECTURE.md .claude/docs/CHANGELOG.md .claude/docs/DECISIONS.md .claude/docs/KNOWN_ISSUES.md .claude/docs/LOCAL_DEV.md; do
  if [ -f "$f" ]; then
    lines=$(wc -l < "$f")
    echo "✅ $f ($lines lines)"
  else
    echo "❌ $f MISSING"
  fi
done

echo "=== Services ==="
ls .claude/docs/services/*.md 2>/dev/null | wc -l | xargs echo "Documented:"

echo "=== Components ==="
ls .claude/docs/components/*.md 2>/dev/null | wc -l | xargs echo "Documented:"

echo "=== Tasks ==="
ls .claude/tasks/*.md 2>/dev/null | grep -v README | wc -l | xargs echo "Active:"
ls .claude/tasks/archive/*.md 2>/dev/null | wc -l | xargs echo "Archived:"

echo "=== Features ==="
ls .claude/features/*.md 2>/dev/null | grep -v README | grep -v archive | wc -l | xargs echo "Backlog:"
```

---

## Phase 6: Generate Assessment Report

Create/update `.claude/docs/ASSESSMENT.md`:

```markdown
# Project Assessment

**Generated**: [DATE]
**Assessed Against**: [PRD/spec files found]

## Executive Summary

**Production Readiness**: [X]%
**Estimated Time to Production**: [X days/weeks]
**Blocking Issues**: [count]

### Quick Stats
| Category | Complete | Partial | Missing |
|----------|----------|---------|---------|
| Core Features | X | X | X |
| Auth & Security | X | X | X |
| API Endpoints | X | X | X |
| Testing | X | X | X |
| DevOps | X | X | X |

---

## Gap Analysis

### P0 — Must Have (Blocks Production)
| Feature | Status | Gap | Effort |
|---------|--------|-----|--------|
| [Feature] | ❌ | [Missing] | M |

### P1 — Should Have
| Feature | Status | Gap | Effort |
|---------|--------|-----|--------|

### P2 — Nice to Have (Post-launch)
| Feature | Status | Notes |
|---------|--------|-------|

---

## Undocumented Items Found

### Services (in code but not in docs)
| # | Service | Evidence |
|---|---------|----------|
| 1 | [service] | Package dep + env vars |

### Components (in code but not in docs)
| # | Component | Location |
|---|-----------|----------|
| 1 | [component] | src/lib/ |

*To document these, mention them in your next session and run `/sync`, or create the docs manually.*

---

## Known Issues Summary
| Severity | Count |
|----------|-------|
| CRITICAL | X |
| HIGH | X |
| MEDIUM | X |
| LOW | X |

## Documentation Health
| Document | Status | Notes |
|----------|--------|-------|
| ARCHITECTURE.md | ✅/⚠️/❌ | [notes] |
| CHANGELOG.md | ✅/⚠️/❌ | [notes] |
| DECISIONS.md | ✅/⚠️/❌ | [notes] |
| KNOWN_ISSUES.md | ✅/⚠️/❌ | [notes] |

---

## Recommended Next Actions

### Immediate
1. [Most critical action]
2. [Second most critical]

### This Week
1. [Action]
2. [Action]

### Before Launch
1. [Action]
2. [Action]

---

*Run `/task [action]` to create implementation tasks*
*Run `/feature [idea]` to add to backlog*
```

---

## Phase 7: Output

```markdown
# Audit Complete

**Readiness**: [X]% production ready
**Time to Production**: ~[X] days

## Summary
| Category | Status |
|----------|--------|
| Blocking Issues | X critical, Y high |
| Undocumented Services | X found |
| Undocumented Components | X found |
| TODOs/FIXMEs in Code | X found |
| Doc Health | [Good/Fair/Needs Work] |

## Top 3 Actions
1. [Most important]
2. [Second]
3. [Third]

**Full report**: `.claude/docs/ASSESSMENT.md`
```

---

## First-Time Setup

If `.claude/docs/` structure doesn't exist, create it:
```bash
mkdir -p .claude/docs/services .claude/docs/components .claude/tasks/archive .claude/features/archive
```

Populate all templates from scratch based on scan results. This is the "bootstrap" path.
