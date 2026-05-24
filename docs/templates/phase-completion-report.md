# Phase [N] Completion Report

**Project:** RuntimeScope — [phase one-line description]
**Brief:** [`../specs/phase-[N]-brief.md`](../specs/) (or the inherited brief, if this phase didn't author its own)
**Operating manual:** [`../../CLAUDE.md`](../../CLAUDE.md)
**Initial commit:** `<sha>` — *<subject>*
**Final commit:** `<sha>` — *<subject>*
**Released as:** v0.X.Y (npm) / plugin 0.X.Y (claude marketplace) — N/A if not a publish phase

---

## 1. Commands run + summarized outputs

| Command | Purpose | Result |
|---|---|---|
| `npm install` | Dep refresh | … |
| `npm run build` | Acceptance criterion: builds all changed packages | … |
| `npm test` | Acceptance criterion: unit test gate | N / 0 |
| `npm run stress` | Acceptance criterion: stress gate | N / N scenarios |
| `node packages/cli/dist/cli.js --version` | Smoke check | 0.X.Y |
| `runtimescope service status` | Live-service smoke (if applicable) | … |

Note any deviations between actual output and the spec'd reference output.

---

## 2. Final test count

**Total: N unit tests passed / 0 failed. N / N stress scenarios passed.**

Per target:

| Target | Passed | Notes |
|---|---:|---|
| `packages/collector` unit | … | |
| `packages/mcp-server` unit | … | |
| `packages/mcp-server` integration | … | |
| `packages/sdk` unit | … | |
| `stress/scenarios/*` | … | |
| **Total** | **N** | |

---

## 3. Deviations from the brief

List every place the implementation behaves differently from the brief's literal text. **Surface every deviation;** don't normalize them away.

1. **[Short title.]**
2. **[Short title.]**

Each rationale is in §4.

---

## 4. Rationale per deviation

### 4.1 [Title from §3]

**What the brief says:** [verbatim quote or precise paraphrase].

**What I did:** [concrete description].

**Rationale:** [why this is the correct decision, what alternatives were considered, what spec-intent is preserved].

(Repeat per deviation.)

---

## 5. Acceptance criteria — complete

| # | Criterion | Status |
|---:|---|---|
| 1 | … | ✓ |
| 2 | … | ✓ |

---

## 6. Acceptance criteria — deferred

| # | Criterion | Reason | Closure condition |
|---:|---|---|---|
| … | … | … | … |

---

## 7. Implemented files / modules

### Workspace / config

- [`package.json`](../../package.json) — what changed (if anything).
- [`packages/*/package.json`](../../packages/) — version bumps.

### Source

| Module | File | Brief §X |
|---|---|---|
| … | [`...`](../../packages/...) | §… |

### Tests

- [`packages/.../src/__tests__/...`](../../packages/) — coverage of brief §….

### Documentation

- [`docs/...`](../) — what was added or moved this phase.

---

## 8. Known follow-ups for the next phase

These are explicit hooks left in the code or surfaced during this phase. **They are not scheduled.**

- [ ] …
- [ ] …

---

## 9. Reviewer / handoff pointer

The handoff doc that picks this up is at [`../handoffs/phase-[N+1]-handoff.md`](../handoffs/).

The inputs that the next phase inherits — fixtures, file surface, golden values — are captured in that handoff under §A–§D.
