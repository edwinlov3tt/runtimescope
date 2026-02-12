# Project Tasks

Track implementation tasks, dependencies, and parallel execution opportunities.

## Status Legend
- ⬜ Not Started
- 🔄 In Progress
- ✅ Complete
- 🚫 Blocked (waiting on dependency)

---

## Current Tasks

| Task | Priority | Effort | Status | Blocked By |
|------|----------|--------|--------|------------|
| _No tasks yet_ | - | - | - | - |

---

## Parallel Execution Groups

Tasks within each group can be worked on simultaneously by different Claude instances.

### Group A
_Tasks will be grouped here based on file independence_

### ⚠️ Sequential Only
_Tasks that modify same files - must be done one at a time_

---

## Recently Completed

| Task | Completed | Notes |
|------|-----------|-------|
| _None yet_ | - | - |

---

## Archive

Completed tasks moved to `archive/` folder.

---

## Working with Tasks

### View Task Board
```
/tasks
```

### Create New Task
```
/task [feature description]
```

### Complete a Task
```
/task-complete [task-name]
```

### Task Workflow
1. Run `/tasks` to see current board
2. Pick an unblocked task matching your focus area
3. Read the full task file for context and steps
4. Update status to 🔄 In Progress
5. Create branch: `git checkout -b feature/[task-name]`
6. Follow implementation steps
7. Run verification checklist
8. Run `/task-complete [task-name]`

---

## Multi-Instance Guidelines

When running multiple Claude Code instances simultaneously:

### ✅ Safe to Parallelize
- Tasks in different parallel groups
- Tasks modifying completely different directories
- Independent test writing
- Documentation tasks

### ❌ Never Parallelize
- Tasks modifying the same files
- Database migrations
- Package.json changes
- Shared configuration
- Tasks with explicit dependencies on each other

### Claiming a Task
Before starting, update the task status to 🔄 to signal other instances.

---

## Task File Structure

Each task file includes:
- **Goal**: What the task accomplishes
- **Dependencies**: What must be done first
- **Pre-Implementation Checklist**: What to review before coding
- **Implementation Steps**: Detailed step-by-step guide
- **Code Standards**: Patterns to follow for consistency
- **Files to Modify**: Explicit list of files
- **Verification**: How to confirm completion
