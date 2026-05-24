# RuntimeScope — Documentation

RuntimeScope is a runtime monitoring system for Claude Code. The collector (long-running daemon) ingests events from SDK-instrumented apps over WebSocket, persists them to SQLite + WAL, and exposes them as MCP tools and an HTTP dashboard. The SDKs (browser, Node server, Cloudflare Workers, Python, framework wrappers) target their host runtimes and stay JavaScript. The collector is the piece we're hardening — currently TypeScript on Node, planned to be ported to Rust once the architecture is locked.

This folder is the project's written record: contracts, decisions, reports, handoffs, audits, and curated research.

For the **operating manual** (rules of engagement, hierarchy of authority, gates) see [`../CLAUDE.md`](../CLAUDE.md). That file wins every conflict with anything in this folder.

## Start here

1. [`HANDOFF.md`](./HANDOFF.md) — 5-minute orientation. Where the active work is right now.
2. [`CURRENT_STATE.md`](./CURRENT_STATE.md) — what is live: published versions, gate status, open deferrals.
3. [`roadmap/MASTER_PHASE_PLAN.md`](./roadmap/MASTER_PHASE_PLAN.md) — the master roadmap. Single source of truth for what phase is next; do not invent phase names without updating it.
4. [`audits/`](./audits/) — current audit findings driving immediate fix work.
5. [`specs/`](./specs/) — the contract documents (added as phases author them).

## Layout

```
docs/
├── README.md                          (this file)
├── HANDOFF.md                         5-min orientation + pointer to active handoff
├── CURRENT_STATE.md                   build / test / gate / deferral snapshot
├── roadmap/                           master phase plan
├── specs/                             phase briefs + wire-protocol contracts (the locked inputs)
├── decisions/                         architecture decision records (ADRs)
├── reports/                           phase completion reports
├── handoffs/                          phase-to-phase handoff docs
├── audits/                            cross-cutting audit findings (correctness, perf, security)
├── research-notes/                    distilled lessons from spikes / benchmarks
├── templates/                         blank templates (ADR, handoff, completion report, audit, research note)
└── archive/                           superseded files preserved for reference
```

**Convention adopted from `mc-v2/docs/`.** RuntimeScope's prior docs (see *Legacy artifacts* below) predate this structure; new work goes in the layout above.

## Folder map

| Folder | What lives here | What does NOT |
|---|---|---|
| [`specs/`](./specs/) | The contract: phase briefs, wire-protocol locks. **Locked during a phase.** | Decisions, reports, prose. |
| [`roadmap/`](./roadmap/) | The master phase plan and any forward-looking sequencing docs. **Single source of truth for "what phase next."** | Detailed implementation plans (those go in handoffs); decisions (those go in `decisions/`). |
| [`decisions/`](./decisions/) | ADRs — one per decision, append-only, supersession-aware. | Implementation notes (those go in code) or routine choices that follow the brief verbatim. |
| [`reports/`](./reports/) | Phase completion reports. One per phase. | Decisions (those are ADRs); ongoing work logs. |
| [`handoffs/`](./handoffs/) | Per-phase handoff documents. The bridge between phase N and phase N+1. Embeds the next-phase prompt verbatim. | Permanent contracts; those go in `specs/`. |
| [`audits/`](./audits/) | Cross-cutting audits before a phase commits — correctness, perf, security. RuntimeScope-specific; no mc-v2 equivalent. | Phase-internal review notes. |
| [`research-notes/`](./research-notes/) | Distilled lessons. One concept per file, written for a future reader. | Raw transcripts. |
| [`templates/`](./templates/) | Blank templates: ADR, handoff, completion report, research note, audit. | Filled-in copies (those go in their target folder). |
| [`archive/`](./archive/) | Superseded files preserved for reference. | Active work. |

## Filing rules

1. **Specs are locked during a phase.** Once a phase brief is accepted into [`specs/`](./specs/), it is not edited mid-phase. Amendments are new files; they do not overwrite earlier ones.

2. **Every phase ships a completion report.** Use [`templates/phase-completion-report.md`](./templates/phase-completion-report.md). The report lists commands run, exact test counts, deviations from the brief with rationale, acceptance criteria status, files changed, deferred items.

3. **Every phase hands off via a handoff doc.** Use [`templates/handoff.md`](./templates/handoff.md). The handoff embeds the next-phase prompt verbatim, captures landmarks the receiving instance will need (commit hash, test counts, wire-protocol invariants, fixtures), and lists touch / don't-touch files.

4. **Every non-trivial decision gets an ADR.** Use [`templates/adr.md`](./templates/adr.md). Status (`Proposed | Accepted | Deprecated | Superseded by ADR-NNNN`), context, decision, consequences, alternatives considered. ADRs are append-only — when revised, the new one supersedes the old.

5. **Every audit gets a numbered audit doc + a fix closure plan.** Use [`templates/audit.md`](./templates/audit.md). An audit is `Closed` only when every finding has a fix commit and a regression test.

6. **Every research finding worth keeping gets a research note.** Use [`templates/research-note.md`](./templates/research-note.md). One concept per file. Cross-link to source code, ADRs, and primary sources.

7. **Cross-link everywhere.** Reports link to ADRs. ADRs link to specs. Research notes link to source code. Audits link to fix commits. Use relative paths so links work when browsing the filesystem.

## How a typical phase flows

```
audits/NNNN-<scope>.md           (findings — runs BEFORE the phase that fixes them)
       │
       ▼
specs/<phase>-brief.md            (locked input — written before the phase starts)
       │
       ▼
decisions/<NNNN>-<slug>.md        (ADRs written when scope/design choices land)
       │
       ▼
[implementation in packages/]
       │
       ▼
reports/phase-<N>-completion-report.md
       │
       ▼
handoffs/phase-<N+1>-handoff.md
       │
       ▼
audits/NNNN updated → Closed
```

Research notes feed in throughout — they are sources, not phase outputs.

## Legacy artifacts (pre-convention)

The following top-level files predate the phased convention and are preserved as historical context. Migration to the new structure is **not scheduled** — they stay where they are until a future phase explicitly takes the migration as work.

| File | Status | Migration target |
|---|---|---|
| [`AGENT-OS-SCOPE.md`](./AGENT-OS-SCOPE.md) | historical scope doc | → split into `specs/` if revived |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | high-level architecture narrative | → keep, link from this README; eventually split per-component into `specs/` |
| [`ASSESSMENT.md`](./ASSESSMENT.md) | early-stage project assessment | → `archive/` once superseded |
| [`CHANGELOG.md`](./CHANGELOG.md) | running changelog (active) | → keep as-is |
| [`DECISIONS.md`](./DECISIONS.md) | single-file ADR collection (D001-DNNN) | → migrate each entry to `decisions/NNNN-*.md` in a future phase |
| [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) | known-issues tracker | → migrate findings into `audits/` going forward |

Subfolders that predate the convention (`components/`, `design/`, `services/`, `transcripts/`, `ui-update/`, `ui-update.zip`) stay where they are. They are not load-bearing for current work.
