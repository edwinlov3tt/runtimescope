# Feature: Session Task-Type Classifier (make CapEx work-type real)

## Status: ⬜ Backlog

## Assessment
- **Phase**: post-M5 / v1.1 pm-hardening
- **Complexity**: S–M (port the classifier; wire into CapEx + a by-task view)
- **Value**: Medium (fills the CapEx work-type stub; adds spend-by-task breakdown)
- **Created**: 2026-05-31
- **Source**: CodeBurn (MIT) — `src/classifier.ts`

## Description
Classify each session/turn into test/git/build/install/debug/feature/refactor/
brainstorm/research by the tools used (Edit/Read/Bash/Task/Search/MCP/Skill) +
prompt keywords. Use it to populate the pm/ CapEx work-type (currently a stub —
capitalizable vs expensed) and a spend-by-task-type breakdown.

## Why
pm/ CapEx has a work-type classification stub we never implemented. CodeBurn's
classifier is a concrete, borrowable implementation. Capitalization accounting
(ours) + task-type (theirs) compose well.

## Notes
See `docs/research/0003-codeburn-cost-tracking.md`. MIT source; attribution.
