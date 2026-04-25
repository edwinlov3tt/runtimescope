---
description: Create, view, or complete implementation tasks with parallel execution guidance
allowed-tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
---

# Task Management

Create detailed tasks, view the task board, or complete tasks.

**Usage:**
- `/task` — View task board (status, parallel groups, blockers)
- `/task [description]` — Create a new task
- `/task done [name]` — Complete and archive a task

**Argument:** $ARGUMENTS

---

## Mode Detection

**No arguments** → Show Task Board (Phase A)
**"done [name]"** → Complete Task (Phase C)
**Anything else** → Create Task (Phase B)

---

## Phase A: Task Board

### Scan Tasks
```bash
echo "=== Task Files ==="
ls .claude/tasks/*.md 2>/dev/null | grep -v README | grep -v _TEMPLATE

echo "=== Status Counts ==="
echo -n "Not Started: "; grep -l "Status: ⬜" .claude/tasks/*.md 2>/dev/null | wc -l
echo -n "In Progress: "; grep -l "Status: 🔄" .claude/tasks/*.md 2>/dev/null | wc -l
echo -n "Complete: "; grep -l "Status: ✅" .claude/tasks/*.md 2>/dev/null | wc -l
```

### Read Each Task
For each task file, extract: Status, Priority, Effort, Dependencies, Files it modifies.

### Check Feature Backlog
```bash
ls .claude/features/*.md 2>/dev/null | grep -v README | grep -v _TEMPLATE | grep -v archive
```

Note features that are ready to become tasks (marked as "Ready to implement").

### Build Parallel Safety Map

Tasks are parallel-safe if they modify different files and have no shared dependencies.

### Display Board

```markdown
# Task Board

## Ready to Start
| Task | Priority | Effort | Key Files |
|------|----------|--------|-----------|
| [task](tasks/task.md) | P0 | M | `src/api/` |

## Parallel Execution Groups
Tasks within each group are safe for simultaneous Claude instances.

### Group A (no conflicts)
- `task-1` → modifies `src/components/`
- `task-2` → modifies `src/api/`

### Group B (no conflicts)
- `task-3` → modifies `workers/`

### ⚠️ Sequential Only
- `task-4` and `task-5` both modify `src/lib/db.ts`

## In Progress
| Task | Progress |
|------|----------|
| [task] | Step 3/7 |

## Blocked
| Task | Waiting On |
|------|------------|
| [task] | [blocking-task] |

## Feature Backlog (ready to task out)
| Feature | Phase | Complexity |
|---------|-------|------------|
| [feature] | MVP | M |

Run `/task [name]` to create a task
Run `/task done [name]` to complete a task
Run `/feature` to view full backlog
```

---

## Phase B: Create Task

### Gather Context

1. **Check if a matching feature exists** in `.claude/features/`:
   ```bash
   ls .claude/features/*$ARGUMENTS*.md 2>/dev/null
   ```
   If found, use its assessment (phase, complexity, dependencies) as the starting point.

2. **Check for PRD/specs** that define requirements for this feature.

3. **Analyze codebase** for related files, existing patterns, conventions:
   ```bash
   grep -rn "[relevant keywords]" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py" . 2>/dev/null | grep -v node_modules | head -30
   ```

4. **Read CLAUDE.md** for conventions and code standards.

5. **Check existing tasks** for dependencies and conflicts.

### Create Task File

Create `.claude/tasks/[task-name].md`:

```markdown
# Task: [Task Name]

## Status: ⬜ Not Started

## Meta
- **Priority**: P0 / P1 / P2
- **Effort**: S (< 1 day) / M (1-3 days) / L (3+ days)
- **Created**: [DATE]
- **Source**: [Feature backlog / conversation / ad-hoc]
- **Branch**: `feature/[task-name]`

## Goal
[2-3 sentences: what this accomplishes and why it matters]

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

---

## Dependencies

### Blocked By (must complete first)
| Task | Status | Why |
|------|--------|-----|
| _None_ | - | - |

### Blocks (other tasks waiting on this)
| Task | Impact |
|------|--------|
| _None_ | - |

### Parallel Safety
These tasks can run simultaneously (different files, no shared state):
- [list of compatible tasks]

⚠️ **Cannot parallelize with**: [tasks that touch same files]

---

## Pre-Implementation Checklist

Before writing any code:

- [ ] Read these files for context:
  1. `[file-path]` — [what to understand]
  2. `[file-path]` — [what to understand]
- [ ] Dependencies above are ✅ complete
- [ ] Branch created: `git checkout -b feature/[task-name]`
- [ ] Understand the acceptance criteria below

### Patterns to Follow
```typescript
// From existing codebase — follow this convention:
[code example from actual project]
```

---

## Implementation Steps

### Step 1: [Name]
**Time**: ~30 min

**Files**:
- `path/to/file.ts` — [what changes]

**Do**:
[Specific implementation details, code guidance, or pseudocode]

**Verify**:
- [ ] [How to confirm this step works]

---

### Step 2: [Name]
**Time**: ~45 min

**Files**:
- `path/to/file.ts` — [what changes]

**Do**:
[Implementation details]

**Verify**:
- [ ] [Verification]

---

[Continue for each step...]

---

## Code Standards

Keep consistent across Claude instances:

### Naming
```typescript
// Use this pattern:
[example from project]
```

### Error Handling
```typescript
// Standard pattern:
[example from project]
```

### Types
```typescript
// Type conventions:
[example from project]
```

---

## Files to Modify

| File | Action | What Changes |
|------|--------|--------------|
| `src/file.ts` | Modify | [description] |
| `src/new.ts` | Create | [purpose] |
| `tests/file.test.ts` | Create | [test coverage] |

---

## Verification

Before marking complete:
- [ ] All implementation steps done
- [ ] `pnpm typecheck` passes (or equivalent)
- [ ] `pnpm build` passes
- [ ] Manual testing: [specific things to test]
- [ ] Edge cases: [specific scenarios]
- [ ] No debug code or console.logs left
- [ ] Code follows project conventions

---

## Completion

When done: `/task done [task-name]`
```

### Update Task Board
Add the new task to `.claude/tasks/README.md`.

### Output
```markdown
# Task Created

**File**: `.claude/tasks/[task-name].md`
**Priority**: P0 | **Effort**: M | **Steps**: 5

## Quick Start
```bash
git checkout -b feature/[task-name]
# Review pre-implementation checklist first
```

## Can Parallel With
- [compatible tasks]

## Blocked By
- [dependencies, if any]
```

---

## Phase C: Complete Task

### Find Task
```bash
ls .claude/tasks/*[argument]*.md 2>/dev/null | grep -v README | grep -v archive
```

### Run Verification
```bash
# Build check
pnpm build 2>&1 || npm run build 2>&1 || echo "No build script"

# Type check
pnpm typecheck 2>&1 || npm run typecheck 2>&1 || echo "No typecheck"

# Test check
pnpm test 2>&1 || npm run test 2>&1 || echo "No test script"
```

### If Verification Passes

1. Update task status:
   ```markdown
   ## Status: ✅ Complete
   ## Completed: [DATE]
   ```

2. Move to archive:
   ```bash
   mkdir -p .claude/tasks/archive
   mv .claude/tasks/[task-name].md .claude/tasks/archive/
   ```

3. Update `.claude/tasks/README.md` — remove from active, add to completed.

4. Add to `.claude/docs/CHANGELOG.md`:
   ```markdown
   ## [DATE]
   ### Completed
   - [task name]: [brief description]
   ```

5. Check for unblocked tasks:
   ```bash
   grep -l "[task-name]" .claude/tasks/*.md 2>/dev/null
   ```
   Update any tasks that were blocked by this one.

6. If a matching feature exists in `.claude/features/`, move it to archive too.

### Output
```markdown
# Task Complete ✅

**Task**: [task-name]
**Archived**: `.claude/tasks/archive/[task-name].md`

## Verification
| Check | Result |
|-------|--------|
| Build | ✅ |
| Types | ✅ |
| Tests | ✅ |

## Unblocked
- [tasks now ready to start]

**Next recommended**: [highest priority unblocked task]
```

### If Verification Fails
```markdown
# Task Completion Blocked ❌

## Failures
- Build: [error]
- Tests: [X failures]

Fix the issues, then run `/task done [name]` again.
```
