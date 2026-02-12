---
description: Log a feature idea with phase/complexity/value assessment, or view the feature backlog
allowed-tools: ["Read", "Write", "Edit", "Bash", "Grep"]
---

# Feature — Log Ideas & Manage Backlog

Capture feature ideas with an assessment of complexity, phase, and value. Or view the current backlog.

**Usage:**
- `/feature` — View backlog by phase
- `/feature [idea description]` — Log and assess a new feature
- `/feature mvp` / `/feature v1` — Filter backlog by phase

**Argument:** $ARGUMENTS

---

## Mode Detection

**No arguments** → Show Backlog (Phase A)
**Phase filter** ("mvp", "v1", "v1.1", "v2") → Show Filtered Backlog (Phase A)
**Anything else** → Log New Feature (Phase B)

---

## Phase A: View Backlog

### Scan Features
```bash
echo "=== Feature Files ==="
ls .claude/features/*.md 2>/dev/null | grep -v README | grep -v _TEMPLATE | grep -v archive
```

For each feature, extract: Name, Phase, Complexity, Value, Status, Dependencies.

### Display Backlog

```markdown
# Feature Backlog

## MVP — Must ship
| Feature | Complexity | Value | Status | Dependencies |
|---------|------------|-------|--------|--------------|
| [feature](features/feature.md) | M | High | ⬜ | Auth system |

## v1.0 — First release
| Feature | Complexity | Value | Status |
|---------|------------|-------|--------|
| [feature] | L | High | ⬜ |

## v1.1 — Fast follow
| Feature | Complexity | Value | Status |
|---------|------------|-------|--------|
| [feature] | S | Medium | ⬜ |

## v2.0 — Future
| Feature | Complexity | Value | Status |
|---------|------------|-------|--------|
| [feature] | XL | Medium | ⬜ |

---

**Total**: X features (Y MVP, Z v1.0, ...)

Ready to build one? Run `/task [feature-name]`
Log a new idea: `/feature [description]`
```

If a phase filter was provided, only show that phase.

---

## Phase B: Log New Feature

### 1. Understand the Idea

Parse `$ARGUMENTS` to understand what the user wants to add.

### 2. Analyze Context

```bash
# Check PRD for related requirements
grep -i "[relevant keywords]" PRD*.md SPEC*.md README.md 2>/dev/null | head -10

# Check existing features for overlap
grep -i "[relevant keywords]" .claude/features/*.md 2>/dev/null | head -10

# Check what exists in codebase already
grep -rn "[relevant keywords]" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py" . 2>/dev/null | grep -v node_modules | head -15

# Check ARCHITECTURE.md for system understanding
cat .claude/docs/ARCHITECTURE.md 2>/dev/null | head -50
```

### 3. Assess the Feature

Determine:

**Complexity** (how hard to build):
- **S** (Small) — < 1 day. Single file changes, straightforward implementation
- **M** (Medium) — 1-3 days. Multiple files, some design decisions
- **L** (Large) — 3-7 days. Cross-cutting concerns, new patterns needed
- **XL** (Extra Large) — 1-2+ weeks. Major subsystem, significant architecture

**Phase** (when it should ship):
- **MVP** — Core to the product. Users can't meaningfully use the app without it
- **v1.0** — Important for first release but app is functional without it
- **v1.1** — Valuable enhancement, ship shortly after launch
- **v2.0** — Future vision, not needed now

**Value** (how important to the product):
- **Critical** — Core product functionality
- **High** — Significant user value, competitive advantage
- **Medium** — Nice improvement, users would appreciate it
- **Low** — Minor enhancement, polish

**Phase inference rules:**
- If PRD lists it as core/required → MVP
- If it's a quality-of-life improvement → v1.1
- If it requires infrastructure not yet built → at least v1.0
- If it's aspirational or "wouldn't it be cool" → v2.0
- If similar features exist in the codebase already → lower effort, earlier phase

### 4. Create Feature File

Create `.claude/features/[feature-name].md`:

```markdown
# Feature: [Feature Name]

## Status: ⬜ Backlog

## Assessment
- **Phase**: MVP / v1.0 / v1.1 / v2.0
- **Complexity**: S / M / L / XL
- **Value**: Critical / High / Medium / Low
- **Created**: [DATE]

## Description
[2-3 sentences describing the feature from the user's perspective]

## Why
[Why this matters — user benefit, business value, or technical necessity]

## Scope

### What It Includes
- [Specific capability 1]
- [Specific capability 2]
- [Specific capability 3]

### What It Doesn't Include
- [Explicitly out of scope item]

## Technical Notes

### Systems Affected
- [List of directories/systems this would touch]

### Dependencies
- **Requires**: [What must exist first]
- **Builds on**: [Existing systems it extends]

### Rough Approach
[Brief technical approach — not a full design, just direction]

## Questions / Open Items
- [Any unknowns that need to be resolved]

---

*When ready to implement, run `/task [feature-name]` to generate a detailed task plan.*
```

### 5. Ensure Backlog Structure
```bash
mkdir -p .claude/features/archive
```

If `.claude/features/README.md` doesn't exist, create it with a backlog template.

### 6. Update Backlog README

Add the feature to the appropriate phase table in `.claude/features/README.md`.

### 7. Output

```markdown
# Feature Logged ✅

**[Feature Name]**

| Assessment | |
|------------|---|
| Phase | v1.0 |
| Complexity | M (~2 days) |
| Value | High |

## Summary
[1-2 sentence description]

## Touches
[Systems/directories affected]

## Dependencies
[What needs to exist first]

**Saved**: `.claude/features/[feature-name].md`

---

Build it now? → `/task [feature-name]`
View backlog → `/feature`
```
