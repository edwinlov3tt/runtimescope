# Audit NNNN: [Title — what was audited, in five words]

**Status:** `In Progress | Findings Published | Fixes Shipped | Closed`
**Date opened:** YYYY-MM-DD
**Date closed:** YYYY-MM-DD (or empty if open)
**Auditor:** [who did the audit]
**Triggered by:** [incident, regression, scheduled review, ADR-NNNN, etc.]
**Scope:** [the exact paths / packages / behaviors audited — set the boundary explicitly]

---

## Context

What prompted this audit? What was happening or could happen if we didn't audit? Pull facts from incidents, prior reports, ADRs, or the master phase plan. Be concrete about why this audit is worth the time *now*.

## Method

How the audit was conducted, so a future reader can reproduce or extend it:

- Static checks (e.g., `grep -rn "console\.error" packages/`).
- Dynamic checks (e.g., `sample <pid>` on a live process, stress runs, heap snapshots).
- Code-review passes (specific files / pattern queries).
- Whatever else.

State the **audit gate** — the explicit pass condition. "All findings closed and a regression test exists" is a good gate. "Looks fine to me" is not.

## Findings

One subsection per finding. Number them `F1, F2, …`. Each finding has:

- **Severity:** `LOW | MEDIUM | HIGH | CRITICAL` — how bad is it?
- **Blast radius:** what does it affect, and who is hit?
- **Evidence:** the concrete grep result, stack trace, measurement, or repro.
- **Root cause:** one or two sentences naming the actual mechanism.
- **Fix proposal:** what would close it. Include rough effort estimate and risk.

### F1 — [Short finding title]

**Severity:** …
**Blast radius:** …
**Evidence:**
```
[grep output, stack trace, code excerpt, etc.]
```
**Root cause:** …
**Fix proposal:** …

### F2 — [Short finding title]

[…]

## Prioritized fix list

| # | Fix | Severity | Effort | Risk | Lands in |
|---|---|---|---|---|---|
| F1 | … | HIGH | 3h | Low | v0.X.Y |
| F2 | … | MED | 30min | Zero | v0.X.Y |

## Recommended sequence

The implementation order, with rationale. If fixes are independent, say so. If one fix unlocks the next, say so.

## Cross-links

- ADRs that capture decisions from this audit: [`../decisions/NNNN-...md`](../decisions/)
- Phase plan that schedules the fixes: [`../roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md)
- Reports for the phases that ship the fixes: [`../reports/...`](../reports/)
- Commits that implement the fixes: [list as they land]
- Regression tests added: [`../../packages/.../src/__tests__/...`](../../packages/), [`../../stress/scenarios/...`](../../stress/scenarios/)

## Closure

When `Status` flips to `Closed`, every finding above must have:

1. A fix commit referenced.
2. A regression test that fails without the fix and passes with it.
3. An entry in the relevant phase completion report.

If any finding is intentionally NOT fixed, downgrade it to an ADR explaining why and link the ADR here.

## History

- YYYY-MM-DD — audit opened, findings published.
- YYYY-MM-DD — Fx fix landed in commit `<sha>`, v0.X.Y.
- YYYY-MM-DD — audit closed.
