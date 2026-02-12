# Task: [Task Name]

## Status: ⬜ Not Started

## Meta
- **Priority**: P0 / P1 / P2
- **Effort**: S (< 1 day) / M (1-3 days) / L (3+ days)
- **Created**: YYYY-MM-DD
- **Branch**: `feature/[task-name]`

## Goal
[2-3 sentences describing what this task accomplishes and why]

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2

---

## Dependencies

### Blocked By (must complete first)
| Task | Status | Why Blocking |
|------|--------|--------------|
| _None_ | - | - |

### Blocks (waiting on this)
| Task | Impact |
|------|--------|
| _None_ | - |

### Can Run In Parallel
- [ ] [other-task] - safe, different files

---

## Pre-Implementation Checklist

Before starting:
- [ ] Dependencies above are ✅ complete
- [ ] Branch created: `git checkout -b feature/[task-name]`
- [ ] Reviewed context files below

### Context to Review
1. `[file-path]` - [what to understand]
2. `.claude/docs/[doc].md` - [relevant context]

### Patterns to Follow
```typescript
// Example pattern from existing code
```

---

## Implementation Steps

### Step 1: [Name]
**Est**: 30 min

**Files**: `path/to/file.ts`

**Do**:
- [ ] Sub-step 1
- [ ] Sub-step 2

**Verify**: [How to check this step is done]

---

### Step 2: [Name]
**Est**: 45 min

**Files**: `path/to/file.ts`

**Do**:
- [ ] Sub-step 1

**Verify**: [How to check]

---

## Code Standards

```typescript
// Follow these patterns:
```

---

## Files to Modify

| File | Action | What Changes |
|------|--------|--------------|
| `src/file.ts` | Modify | [description] |
| `src/new.ts` | Create | [purpose] |

---

## Testing

### Unit Tests
- [ ] Test case 1
- [ ] Test case 2

### Manual Testing
- [ ] Manual check 1
- [ ] Manual check 2

---

## Verification Checklist

- [ ] All steps complete
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
- [ ] `pnpm test` passes
- [ ] No debug code left
- [ ] Follows code standards

---

## Completion

When done:
1. Mark status: `## Status: ✅ Complete`
2. Run `/task-complete [task-name]`

---

## References
- PRD: `[path]`
- Docs: `[urls]`

## Notes
[Additional context added during implementation]
