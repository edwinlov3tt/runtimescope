# Phase [N] Handoff — [One-line title]

> **Audience:** the Claude Code instance running in this repo that picks up Phase [N].
> **You inherit a green Phase [N-1].** Read this whole file before touching code.

---

## Where Phase [N-1] ended

- **Last commit:** `<short-sha>` — *<commit subject>*
- **Test status:** N / N unit passing, N / N stress scenarios passing.
- **npm release:** v0.X.Y published (collector, mcp-server, sdks, cli).
- **Smoke check:** `<command>` exits 0 and matches the expected reference output.
- **Gates green:** build (`npm run build`), test (`npm test`), stress (`npm run stress`).
- **Toolchain:** Node 20+ required. Rust toolchain pinned in [`../../rust-toolchain.toml`](../../rust-toolchain.toml) (if applicable to this phase).
- **Outstanding deferral being addressed by this phase:** [audit finding / brief criterion / known issue].

For the full Phase [N-1] audit, read [`../reports/phase-[N-1]-completion-report.md`](../reports/). The non-negotiable operating manual is [`../../CLAUDE.md`](../../CLAUDE.md). Read its relevant sections before writing any code.

---

## Phase [N] prompt (verbatim — this is your contract)

> [Paste the user's prompt here verbatim. Don't paraphrase. The prompt is the contract.]

---

## Context the prompt above does NOT spell out

These are landmarks the receiving instance will need but the user-facing prompt didn't include. Pull them from the previous phase's completion report, the source code, the spec, and your own running notes.

### A. [Topic, e.g., wire-protocol invariants]

What's true today and why. Concrete suggestions for the first thing to try. What "stop and report options" looks like.

### B. [Topic, e.g., test fixtures + their golden values]

The public API the next instance will call against. Code excerpts. Golden values to use as sanity checks.

### C. [Topic, e.g., known hot spots from previous phase]

Comments-tagged follow-ups, deferred items, ceiling violations. Don't fix them; document them as findings.

---

## Pointers to existing files you will most likely touch

| Why you might touch it | File | Phase [N] action |
|---|---|---|
| … | [`...`](...) | … |

Files you should **NOT** touch unless [explicit condition the prompt allows]:

- Anything in `packages/sdk/src/` — browser SDK is at-rest; mutate only when the prompt scope says so.
- Tests are contracts; don't loosen them.
- [List others.]
- Locked specs: [`../specs/...`](../specs/).

---

## Reproducible commands you can rely on

These all exit 0 today on the inherited HEAD. They are the ground state your work must preserve.

```bash
cd /Users/edwinlovettiii/runtimescope
npm install
npm run build
npm test                    # N / 0
npm run stress              # N / N scenarios
node packages/cli/dist/cli.js --version  # → 0.X.Y
```

---

## Final checklist before you call Phase [N] done

- [ ] Every item in the prompt's scope list is implemented.
- [ ] All N existing unit tests still pass.
- [ ] All N stress scenarios still pass.
- [ ] `npm run build` exits clean across all touched packages.
- [ ] Smoke check exits 0.
- [ ] The completion report is written at [`../reports/phase-[N]-completion-report.md`](../reports/) and answers all sections of [`../templates/phase-completion-report.md`](../templates/phase-completion-report.md).
- [ ] No out-of-scope additions (re-read the hard rules list in the prompt above).
- [ ] **You did not start Phase [N+1] features.**

If you are uncertain at any point, the resolution order is:

1. The Phase [N] prompt above.
2. [`../reports/phase-[N-1]-completion-report.md`](../reports/).
3. [`../specs/...`](../specs/).
4. [`../../CLAUDE.md`](../../CLAUDE.md).
5. Anything else.

If those still don't resolve it: stop, ask the project owner, do not guess.
