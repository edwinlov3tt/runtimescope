# [Research note title — short, conclusion-shaped]

**Status:** `active | superseded`
**Created:** YYYY-MM-DD
**Last touched:** YYYY-MM-DD
**Spans phases:** `Audit, Rust-Collector, …`

---

## Conclusion (one sentence)

Lead with the takeaway. The reader should know the answer before they read the rationale.

## Why this matters

What goes wrong without this knowledge. What decisions or implementations rely on it. Which phases will need it.

## Evidence

What we observed, measured, or read that produced the conclusion. Be concrete:

- Benchmark numbers, with the command to reproduce.
- Spec sections quoted verbatim.
- Source-code excerpts with file:line.
- LLM dialogue links to [`../external-conversations/`](../external-conversations/).
- Vendor manual page numbers.

## Where it shows up in the codebase

- **Source:** [`../../packages/.../foo.ts`](../../packages/) — the production enforcement / use point(s).
- **Tests:** [`../../packages/.../src/__tests__/...`](../../packages/) — the assertion(s) that lock the contract.
- **Spec:** [`../specs/...`](../specs/) §X.
- **ADR (if any):** [`../decisions/NNNN-...md`](../decisions/) — the decision that rests on this conclusion.

## Edge cases / gotchas

What surprises a reader. What the conclusion does NOT cover. What is easy to get wrong if you're not paying attention.

## Related notes

- [`./other-note.md`](./)

## History

- YYYY-MM-DD — created.
- YYYY-MM-DD — refined after [observation / benchmark / spec amendment].
- (If `superseded`) → replaced by [`./new-note.md`](./new-note.md).
