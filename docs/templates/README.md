# Templates

Blank templates for the artifacts we produce during phased work. Convention adopted from `mc-v2/docs/templates/` and tailored for the TypeScript-now / Rust-later RuntimeScope codebase.

| Template | Used for | Lives in |
|---|---|---|
| [`adr.md`](./adr.md) | Architecture Decision Records — one per non-trivial decision | [`../decisions/`](../decisions/) |
| [`handoff.md`](./handoff.md) | Phase-to-phase handoff. Embeds the next-phase prompt verbatim. | [`../handoffs/`](../handoffs/) |
| [`phase-completion-report.md`](./phase-completion-report.md) | Required output of every phase. Commands run, test counts, deviations, deferred items. | [`../reports/`](../reports/) |
| [`research-note.md`](./research-note.md) | Distilled finding from a benchmark, spike, or external source. One concept per file. | [`../research-notes/`](../research-notes/) |
| [`audit.md`](./audit.md) | Cross-cutting audit (correctness, security, perf) before a phase commits. RuntimeScope-specific; no mc-v2 equivalent. | [`../audits/`](../audits/) |

## Filing rules

1. **Copy, don't edit.** When you start filling a template, copy it into its target folder with a number prefix (`0001-…`, `0002-…`) — don't mutate the template itself.
2. **Append-only.** ADRs and audits do not get rewritten when superseded — the new one references the old one's status. Supersession is traceable.
3. **Cross-link.** Reports link to ADRs. ADRs link to specs. Audits link to their findings' fix commits. Use relative paths so links work when browsing the filesystem.
4. **One concept per research note.** If you find yourself writing "and also" three times, split it into two notes.
