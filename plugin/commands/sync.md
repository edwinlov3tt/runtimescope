---
description: Auto-extract issues, decisions, services, and changes from conversation into documentation
allowed-tools: ["Read", "Write", "Edit", "Bash", "Grep"]
---

# Sync Documentation

Review the conversation and auto-extract everything worth documenting.

This is the primary documentation command. Run it at the end of every coding session.

## What to Extract

Review the entire conversation history and look for:

### 1. Issues & Bugs → `.claude/docs/KNOWN_ISSUES.md`

**Signals**: "doesn't work", "broke", "error", "bug", "failing", "workaround", TODO mentioned, edge case discovered, "hack", "temporary fix"

For each issue found:
```markdown
### [SEVERITY] Brief description
- **Location**: `file:line` or area of code
- **Symptom**: What goes wrong
- **Workaround**: If one exists
- **Proper Fix**: What should be done
- **Added**: [DATE]
```

**Severity inference:**
- Blocking / security / data loss → CRITICAL
- Major feature broken → HIGH
- Workaround exists → MEDIUM
- Minor / cosmetic → LOW

### 2. Decisions → `.claude/docs/DECISIONS.md`

**Signals**: "let's use X", "chose Y because", "going with", "switched from", "decided to", tradeoff discussions, framework/library selections

For each decision:
```markdown
### [DATE] Decision title
- **Choice**: What was decided
- **Alternatives**: What else was considered
- **Rationale**: Why this choice
- **Impact**: What it affects
```

**Record if**: Framework choice, data model design, infrastructure decision, non-obvious tradeoff
**Skip if**: Obvious pattern, temporary hack, personal preference

### 3. Service Integrations → `.claude/docs/services/[name].md`

**Signals**: `npm install`, `pip install`, API key setup, SDK imports, new environment variables, "integrated with", "connected to"

For each new service, create or update the service doc:
```markdown
# [Service Name]

## Purpose
Why this service is used in the project

## Setup
- Package: `package-name`
- Env vars: `SERVICE_API_KEY`

## Usage
Where and how it's used in the codebase

## Key Files
- `src/lib/service.ts` - Client setup
- `src/api/webhook.ts` - Webhook handler
```

### 4. Component Changes → `.claude/docs/components/[name].md`

**Signals**: New files created, major refactors, new API routes, schema changes, new React components, new utilities

For significant components, create or update:
```markdown
# [Component Name]

## Purpose
What this component does

## Key Files
- `path/to/file.ts` - Description

## Exports
- `functionName()` - What it does

## Dependencies
- Internal: [other components]
- External: [packages]
```

### 5. Changelog → `.claude/docs/CHANGELOG.md`

Add a session summary entry:
```markdown
## [DATE]

### Added
- [New features or capabilities]

### Changed
- [Modifications to existing behavior]

### Fixed
- [Bug fixes]

### Decisions
- [Key decisions made this session]
```

## Deduplication Rules

Before adding any entry:
1. Check if a similar issue/decision already exists
2. If so, UPDATE it rather than creating a duplicate
3. For issues: update status, add new information
4. For decisions: only add if the decision changed or was revisited

## Output

After extracting, report:

```markdown
# Sync Complete

## Extracted from this session:

### Issues (X new, Y updated)
- [SEVERITY] Issue description → KNOWN_ISSUES.md

### Decisions (X logged)
- Decision description → DECISIONS.md

### Services (X documented)
- Service name → services/service.md

### Components (X updated)
- Component name → components/component.md

### Changelog
- Session summary → CHANGELOG.md

---

Nothing to extract? That's fine too. Not every session produces documentation.
```

## Edge Cases

- If `.claude/docs/` doesn't exist, create the structure first
- If a doc file doesn't exist, create it from the template
- If conversation was just Q&A with no code changes, say so — don't force documentation
- Short conversations may have nothing to extract — that's normal
