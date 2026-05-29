# ADR-0006: Conformance tests are the executable spec; the spec doc is documentation

**Status:** Accepted
**Date:** 2026-05-29
**Deciders:** Project owner + implementing instance
**Phase:** Wire-Protocol-Lock (v0.11.0)

---

## Context

Phase Wire-Protocol-Lock exists to freeze the contract the Rust collector must honor before any Rust is written ([ADR-0002](./0002-rust-port-sequence-and-distribution.md) §33, invariant #3: "the wire protocol is sacred from Phase Wire-Protocol-Lock onward"). The question this ADR settles: **what *is* the contract — the prose spec, or the tests?**

A prose-only spec rots. It drifts from the implementation the moment a handler changes, and nothing catches the drift. Worse, a from-scratch reimplementation (the Rust collector) can read a prose spec, implement what it *says*, and still diverge in a dozen unstated behaviors — status codes, field casing, close codes, recovery semantics — that the prose never pinned down. The failure mode is silent: every published SDK breaks in the field with no compile error.

We already built the enabling machinery ahead of this phase:
- A collector-agnostic launch seam — `spawnCollector` via `RUNTIMESCOPE_COLLECTOR_CMD` (and `RUNTIMESCOPE_MCP_CMD` for the MCP bin) — so any binary runs under the same suite.
- The `stress/` suite and the `bench/` harness, both already running through that seam.

This ADR adds the conformance suite on the same seam and decides its authority relative to the docs.

## Decision

**The conformance suite (`tests/conformance/`) is the executable contract. The spec docs (`docs/specs/wire-protocol.md`, `mcp-tool-surface.md`, `tray-api-surface.md`) are documentation that mirrors it.**

Concretely:

1. **Where a spec doc and a green conformance test disagree, the test wins** and the doc is re-derived. The docs cite `file:line` sources and the guarding spec precisely so they stay cheap to refresh.
2. **The conformance suite is the Rust port's acceptance gate.** "Phase Rust-Collector is done" is *defined* as `RUNTIMESCOPE_COLLECTOR_CMD=<rust> npm run conformance` green, alongside `npm run stress` and `npm run bench:compare`. Not "the Rust collector implements the spec doc" — that's unfalsifiable.
3. **The conformance suite must pass against the v0.10.12 Node collector today.** It is written against the *current, blessed* behavior, not against an idealized spec. It encodes what the collector *does*, which is what SDKs depend on.
4. **A wire-protocol change is an ADR + a conformance-suite change, in that order.** You don't change collector behavior and then update the tests to match; you decide (ADR), change the contract (tests), then make both implementations pass. This is what "sacred" operationally means.
5. **The conformance suite is kept OUT of the default `npm test` workspace** (it spawns real processes, runs sequentially, is slow). It has its own config and `npm run conformance` entry, wired into the release gate.

### Scope of the lock

- **Locked (the Rust collector must match):** the WS envelope + handshake (incl. 5s auth timeout / close 4001), event ingest + project isolation, the server→SDK command channel's `requestId` correlation, the HTTP `/api/*` shapes + status codes + the public/auth gate, the SQLite logical schema, and WAL `fsync`-before-`commit` durability + torn-tail recovery. Five spec files, 15 tests at v0.11.0.
- **Documented but evolvable (not locked):** internal routes (`/api/pm/*`, `/api/v1/admin/*`).
- **Not in this suite:** throughput/latency/memory — that's the `bench/` contract (a *performance* gate, not *correctness*).

### One open question this phase surfaced but did not resolve

The server→SDK command channel (`capture_dom_snapshot` et al.) is triggered today by the MCP tool layer calling `collector.sendCommand()` **in-process** — mcp-server embeds the collector. ADR-0002 splits them into separate Rust bins. The conformance test pins the **observable** round-trip; the **mechanism** (shared process vs. internal bridge) is left to Phase Rust-Collector to design, flagged in `wire-protocol.md` §5 and the Rust handoff. Recorded here so it isn't forgotten: it must be decided before Rust Milestone 2.

## Consequences

**Positive:**
- The contract can't silently rot — drift fails a test, not a code review.
- The Rust port gets an unambiguous, runnable definition of done.
- The same seam serves correctness (conformance), robustness (stress), and performance (bench) — one launch contract, three gates.
- New invariants are cheap to add: write a test, cite it in the doc.

**Negative / accepted:**
- Conformance runs real processes and is slower than unit tests; it's deliberately outside `npm test` and must be invoked explicitly (and in CI).
- The suite encodes *current* behavior including any current quirks. If a quirk is actually a bug, freezing it into the Rust port is a risk — mitigated by rule #4 (a deliberate ADR can change the contract; the test changes with it).

**Reversal cost:** low. It's tests + docs. Abandoning the approach loses the suite, not any shipped behavior.

## Cross-links

- Mandate: [`0002-rust-port-sequence-and-distribution.md`](./0002-rust-port-sequence-and-distribution.md) (invariant #3).
- The locked surface: [`../specs/wire-protocol.md`](../specs/wire-protocol.md), [`../specs/mcp-tool-surface.md`](../specs/mcp-tool-surface.md), [`../specs/tray-api-surface.md`](../specs/tray-api-surface.md).
- The gate consumer: [`../handoffs/phase-rust-collector-handoff.md`](../handoffs/phase-rust-collector-handoff.md).

## Notes

The master phase plan originally reserved "ADR-0004 (TBD)" for this decision. ADR-0004 was taken by the v0.10.10 install-blocker exception before this phase ran, so this lands as **ADR-0006** (0005 is the pnpm-over-npm decision).
