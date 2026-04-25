---
description: Scan for secrets, review changes, commit, and push to GitHub
allowed-tools: ["Read", "Write", "Edit", "Bash", "Grep"]
---

# Push — Scan, Commit, and Push Safely

Scan for hardcoded secrets, review what's changed, generate a commit message, and push to GitHub.

---

## Phase 1: Security Scan

### 1.1 Common Secret Patterns
```bash
echo "=== Scanning for secrets ==="

# API Keys (generic)
grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.json" --include="*.yml" --include="*.yaml" --include="*.env" \
  -E "(api[_-]?key|apikey|api_secret)['\"]?\s*[:=]\s*['\"][a-zA-Z0-9_\-]{16,}" . 2>/dev/null | grep -v node_modules | grep -v ".env.example"

# AWS
grep -rn -E "AKIA[0-9A-Z]{16}" . 2>/dev/null | grep -v node_modules

# Private Keys
grep -rn -E "BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY" . 2>/dev/null | grep -v node_modules

# Database URLs with credentials
grep -rn -E "(postgresql|mysql|mongodb|redis)://[^:]+:[^@]+@" . 2>/dev/null | grep -v node_modules | grep -v ".env.example" | grep -v ".env"

# Tokens
grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" \
  -E "(token|bearer|auth)['\"]?\s*[:=]\s*['\"][a-zA-Z0-9_\-\.]{20,}" . 2>/dev/null | grep -v node_modules | grep -v ".env.example" | grep -v ".env"
```

### 1.2 Service-Specific Keys
```bash
# Stripe
grep -rn -E "(sk_live_|sk_test_|pk_live_|pk_test_)[a-zA-Z0-9]{24,}" . 2>/dev/null | grep -v node_modules

# OpenAI
grep -rn -E "sk-[a-zA-Z0-9]{48}" . 2>/dev/null | grep -v node_modules

# Anthropic
grep -rn -E "sk-ant-[a-zA-Z0-9\-]{40,}" . 2>/dev/null | grep -v node_modules

# GitHub tokens
grep -rn -E "(ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})" . 2>/dev/null | grep -v node_modules

# SendGrid
grep -rn -E "SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}" . 2>/dev/null | grep -v node_modules

# Supabase JWTs (in source code, not .env)
grep -rn --include="*.ts" --include="*.tsx" --include="*.js" -E "eyJ[a-zA-Z0-9_-]{20,}\.eyJ" . 2>/dev/null | grep -v node_modules | grep -v ".env" | head -5
```

### 1.3 Sensitive Files Check
```bash
echo "=== Sensitive Files ==="
# Files that shouldn't be committed
for file in .env .env.local .env.production "*.pem" "*.key" id_rsa id_ed25519 credentials.json service-account.json; do
  found=$(find . -name "$file" -not -path "./node_modules/*" -not -path "./.git/*" 2>/dev/null)
  if [ -n "$found" ]; then
    for f in $found; do
      git check-ignore -q "$f" 2>/dev/null || echo "⚠️ NOT GITIGNORED: $f"
    done
  fi
done
```

### 1.4 .gitignore Check
```bash
if [ ! -f ".gitignore" ]; then
  echo "⚠️ NO .gitignore FILE"
else
  for entry in ".env" ".env.local" ".env.*.local" "*.pem" "*.key"; do
    grep -q "$entry" .gitignore 2>/dev/null || echo "⚠️ Missing from .gitignore: $entry"
  done
fi
```

### If Secrets Found → BLOCK

Log findings to KNOWN_ISSUES.md:

```markdown
### [CRITICAL] Hardcoded Secret — BLOCKS PUSH
- **Location**: `[file:line]`
- **Type**: [API Key / Token / Credential]
- **Fix**: Move to `.env`, replace with `process.env.VAR_NAME`, add `.env` to `.gitignore`
- **Added**: [DATE]
```

Report to user and **STOP** — do not proceed to commit/push.

```markdown
# 🚫 Push Blocked — Secrets Found

| File | Line | Type |
|------|------|------|
| `src/config.ts` | 45 | Stripe API Key |

## Required Actions
1. Move secret to `.env` file
2. Replace with `process.env.VAR_NAME`
3. Ensure `.env` is in `.gitignore`
4. Run `/push` again

Issues logged to KNOWN_ISSUES.md
```

---

## Phase 2: Review Changes (only if secrets scan passes)

### 2.1 What's Changed
```bash
echo "=== Git Status ==="
git status

echo "=== Changed Files ==="
git diff --stat

echo "=== Untracked Files ==="
git ls-files --others --exclude-standard
```

### 2.2 Summarize Changes

Read the diffs to understand what was modified:
```bash
git diff --name-status
git diff --stat
```

Categorize changes:
- **Added**: New files
- **Modified**: Changed files
- **Deleted**: Removed files

---

## Phase 3: Generate Commit Message

Based on the changes, generate a conventional commit message:

**Format:**
```
type(scope): brief description

- Detail 1
- Detail 2
```

**Types:** feat, fix, refactor, docs, chore, style, test, perf

**Examples:**
- `feat(auth): add OAuth login with Google`
- `fix(api): resolve timeout on large file uploads`
- `docs: update architecture and known issues`
- `refactor(db): migrate to connection pooling`

If changes span multiple areas, use the most significant type with details in body.

---

## Phase 4: Commit and Push

### Stage all changes
```bash
git add .
```

### Show what will be committed (for confirmation)
Present to user:

```markdown
# Ready to Push

## Security: ✅ Clean

## Changes
| Action | File |
|--------|------|
| Modified | `src/api/auth.ts` |
| Added | `src/lib/oauth.ts` |
| Modified | `.claude/docs/CHANGELOG.md` |

## Commit Message
```
feat(auth): add OAuth login with Google

- Add Google OAuth provider configuration
- Create callback handler for auth flow
- Update user model with OAuth fields
```

**Proceed?** (waiting for confirmation)
```

### After user confirms, execute:
```bash
git add .
git commit -m "[generated message]"
git push
```

### Report result:
```markdown
# ✅ Pushed Successfully

**Branch**: main
**Commit**: `feat(auth): add OAuth login with Google`
**Files**: X modified, Y added, Z deleted

## What Was Pushed
- [Summary of changes]
```

---

## Phase 5: Handle Errors

### If Push Fails (remote conflict)
```markdown
# ⚠️ Push Failed — Remote Has Changes

```bash
git pull --rebase origin main
# Resolve any conflicts
git push
```
```

### If Nothing to Commit
```markdown
# Nothing to Push

Working tree is clean. No changes to commit.
```

### If Not a Git Repo
```markdown
# Not a Git Repository

Initialize with:
```bash
git init
git remote add origin [your-repo-url]
```
```
