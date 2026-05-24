# ADR-0001: Audit and harden the Node collector before any Rust port begins

**Status:** Accepted
**Date:** 2026-05-24
**Deciders:** Project owner + implementing instance
**Phase:** Audit

---

## Context

Through May 2026 the RuntimeScope collector accumulated three classes of bugs that compounded into "the app feels unusable" on the project owner's primary machine:

1. **Distribution/packaging bugs in the JS ecosystem** — broken `exports` map, `__dirname` undefined in the ESM CLI bundle, npm workspace resolution pulling published packages over local source, `npx` cache returning stale 404s. Half a dozen fixes shipped across v0.10.1 through v0.10.7.

2. **Long-running daemon hygiene bugs** — `uncaughtException` handler firing in a tight loop against a broken stderr pipe (leaving 7 orphan processes pegged at 80% CPU, one accumulated 39h44m of CPU time), per-project SQLite handles never evicted (~100MB permanent baseline RSS on a 40-project machine). Fixed in v0.10.8.

3. **Wire-protocol drift risks** — cross-project bleed in `detect_issues` / `get_api_health` (engine getters didn't filter by `projectId`). Fixed in v0.10.6.

The owner raised the strategic question: should we rewrite the collector in Rust?

Three arguments for Rust were on the table:

- **Memory leaks like the SQLite-handle one don't exist in Rust** — no GC, explicit RAII cleanup.
- **Process-lifetime bugs like the zombie loop are JS-architecture-specific** — Rust has no `uncaughtException` handler, panic recovery is bounded, parent-death detection is explicit.
- **Distribution as a single static binary** would eliminate the entire npm-ecosystem class of installation bugs (10+ separate fixes in the last 30 days).

Three arguments against pulling the trigger *now*:

- The bugs we keep hitting are JS-shaped, but they're each individually small fixes. The full Rust port is 4-6 weeks.
- The SDKs cannot move to Rust — they target browser/Node/Workers/Python runtimes. Half the npm surface stays.
- Porting a buggy architecture to Rust gives you a buggy Rust app. The current Node collector still has at least the F1-F5 findings from [audit 0001](../audits/0001-collector-process-lifetime.md) latent in it.

## Decision

**Run the audit phase first, then a wire-protocol-lock phase, then start the Rust port. Do not start the Rust port before both gates close.**

**What we are doing:**

- Treat v0.10.8 as the audit baseline. Findings F1-F5 in [`../audits/0001-collector-process-lifetime.md`](../audits/0001-collector-process-lifetime.md) are scheduled as Phase Audit work (lands as v0.10.9, possibly v0.10.10).
- After the audit closes, run Phase Wire-Protocol-Lock to author `specs/wire-protocol.md` and `specs/mcp-tool-surface.md` plus a conformance test suite that runs against any collector binary. Ships as v0.11.0 (no behavior change).
- After v0.11.0 ships, start Phase Rust-Collector. The Rust port's acceptance gate is the conformance suite from v0.11.0 — not a manual review.
- The Node collector survives the cutover as `packages/collector-legacy/` for one release cycle, so a regression can be reverted without unwinding the Rust work.

**What we are explicitly NOT doing:**

- **Starting the Rust port today.** Every justification we have for Rust gets stronger if we wait until the wire protocol is locked, because then the Rust port has an unambiguous specification target.
- **Skipping the audit and going straight to Rust.** Even if Rust eliminates the bug *class*, we still need to know which behaviors are intentional vs accidental — otherwise the Rust port preserves the bugs.
- **Replacing the JS SDKs.** They stay JS; they target their host runtimes natively.
- **Replacing the dashboard.** Out of scope until both phases ship.
- **Adopting `workspace:*` cross-package pins** to fix the per-package node_modules issue that bit us in v0.10.6. Investigated; `EUNSUPPORTEDPROTOCOL` errors on `npm install`. Stays at exact-version pins for now; `npm install` with no per-package stale copies resolves correctly.

## Consequences

**Positive:**

- The Rust port starts against a *known-good* baseline, not "the latest thing on main." This is the difference between "I'm porting working software" and "I'm rescuing the burning house in a new language."
- The wire-protocol-lock phase produces a conformance test suite that has value beyond the Rust port — it stays as the contract for any future re-implementation (WASM, browser-collector, etc.).
- v0.10.9 + v0.10.10 are real fixes that ship value to users in the next 1-3 weeks regardless of what happens with Rust.

**Negative / accepted trade-offs:**

- The owner is motivated to start Rust *now*. Waiting 3-5 days for Audit + 3-4 days for Wire-Protocol-Lock is a real delay against that motivation.
- During the audit and wire-protocol-lock phases, no new user-facing features ship. Bug-fix releases only.
- The wire-protocol-lock work is non-trivial — it forces us to write down behaviors that are currently only encoded in tests. Some of those behaviors will turn out to be wrong, and we'll have to choose between fixing them (delaying further) or locking in a wart.

**Reversal cost:**

Cheap. If we decide partway through Phase Audit that we want to skip ahead, we can — the audit findings already shipped will be valuable regardless. The wire-protocol-lock phase is the harder one to skip, because without it the Rust port has no test gate, but even there the cost of going back and writing the spec post-hoc is bounded.

## Alternatives considered

1. **Start the Rust port immediately, treat F1-F5 as Rust acceptance criteria.** Rejected. The audit findings are bug *classes*; characterizing them properly in JS first (where the cost is hours, not weeks) is cheaper than discovering them in Rust mid-port. Also: porting an architecture with known leaks means the Rust port has to defensively guard against them, which encodes JS-thinking into the Rust design.

2. **Ship the v0.10.9 audit fixes but skip Phase Wire-Protocol-Lock; start Rust port directly from v0.10.9.** Rejected. The Rust port without a spec has no acceptance gate beyond "looks right to me" — that's the same vagueness that produced the bugs we're trying to escape. The conformance suite is the discipline forcing function.

3. **Don't port to Rust at all; keep iterating in Node.** Rejected. The supply-chain risk argument (the project owner's explicit concern about recent npm attacks) plus the memory/process-lifetime class of bugs are both real and recurring. The audit + wire-lock investment caps the JS work at 1-2 weeks; the Rust port starts from a known-good baseline and compounds value from there.

4. **Build the Tauri tray first as a Rust foothold, then port the collector.** Rejected for *sequencing reasons*, not on merit. The tray is genuinely a smaller / lower-stakes Rust intro, and may be the right next thing post-Rust-collector. But starting it before the collector port delays the actual leak/zombie fix the owner wants. The tray is on the master phase plan for after the Rust collector ships.

## Cross-links

- Audit driving this decision: [`../audits/0001-collector-process-lifetime.md`](../audits/0001-collector-process-lifetime.md)
- Master phase plan: [`../roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md)
- Current state snapshot: [`../CURRENT_STATE.md`](../CURRENT_STATE.md)
- Strategic conversation that produced this decision: this repo's conversation transcripts for the May 23-24 session.

## Notes

The owner was honest about the temptation to skip ahead: *"I want to do all of the debugging again, hours of reimplementation, be honest, would it be a massive improvement with setup?"* The honest answer was: ~50% of the recent install pain class is JS-ecosystem-specific (would disappear in Rust), the other ~50% is architectural and would happen in any language. That framing — Rust solves real problems but not all of them — is what makes the sequencing matter. Going straight to Rust would solve the JS half while leaving the architectural half unfixed in the new language.
