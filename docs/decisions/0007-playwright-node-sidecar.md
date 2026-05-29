# ADR-0007: Browser tools (scan_website + browser-recon) ship as a Node sidecar in the Rust collector

**Status:** Accepted
**Date:** 2026-05-29
**Deciders:** Project owner + implementing instance
**Phase:** Rust-Collector (Milestone 0)

---

## Context

Phase Rust-Collector ports `mcp-server`'s 63 tools to Rust. ~50 are pure store reads — mechanical once `collector-core`'s query API exists. But a handful depend on **Playwright**, a Node/JS-only headless-browser engine with no production-grade Rust equivalent:

- **`scan_website`** ([`packages/mcp-server/src/tools/scanner.ts`](../../packages/mcp-server/src/tools/scanner.ts)) — drives a headless Chromium via Playwright to scan an arbitrary URL.
- The **browser-driven recon tools** that capture live page state (computed styles, element/layout snapshots) when triggered against a running page.

`playwright` is a hard dependency of `mcp-server` today. Reimplementing it natively in Rust (chromiumoxide / CDP) means re-deriving a large surface of browser-automation ergonomics — a known time sink that would dominate the 8-week budget for a feature that isn't the point of the port.

The Rust handoff flagged this as Hard Spot #1 and listed three options: (a) Node sidecar, (b) native Rust via chromiumoxide, (c) cut the tools from v0.11.0.

## Decision

**The Rust `mcp-server` keeps the browser tools by spawning a small Node sidecar process on demand.**

- The sidecar is a minimal Node script (bundling only Playwright + the existing scan/recon logic lifted from the current TS tools) that the Rust `mcp-server` launches as a child process when a browser tool is invoked, communicates with over stdio/JSON (or a localhost port), and tears down when idle.
- Everything else in `mcp-server` stays pure Rust. The sidecar is the *only* JS the Rust collector carries, and it's isolated behind a single boundary.
- The sidecar is **lazy**: no browser tool invoked → no Node process, no Playwright, no Chromium download cost at idle.
- Distribution: the sidecar ships as part of the curl-install bundle (a vendored Node script + a way to obtain Playwright's browser, or a documented one-time `npx playwright install`). The exact packaging is a Milestone 6 detail; the *architecture* (sidecar, not native) is decided here.

## Consequences

**Positive:**
- Keeps `scan_website` + browser-recon working in v0.11.0 with no feature regression — the conformance/parity bar stays "all 63 tools answer correctly."
- Confines the one genuinely-JS capability to a single, replaceable boundary instead of smearing a CDP reimplementation across the codebase.
- Reuses the existing, battle-tested Playwright scan/recon logic verbatim — lower risk than a native rewrite.
- The Rust core stays free of any browser-engine dependency; the sidecar can be swapped, updated, or dropped independently.

**Negative / accepted:**
- The Rust collector is not 100% JS-free — there's a Node sidecar for browser tools. Accepted: it's lazy, isolated, and optional at runtime. (The *supply-chain* win ADR-0002 targets is the **CLI/dashboard** npm surface, not "zero JS anywhere"; the sidecar doesn't reintroduce the `npm install -g` attack surface.)
- Packaging Node + Playwright into the curl-install flow adds Milestone 6 work (bundling or a documented post-install step).
- A process boundary adds a small latency + failure mode (sidecar spawn/crash) the in-process TS version didn't have — handled with a clear "browser sidecar unavailable" tool error, mirroring today's "no active session" path.

**Reversal cost:** low-medium. The sidecar boundary is narrow; replacing it with native chromiumoxide later (if the JS dependency ever becomes painful) is a contained change behind the same tool interface.

## Alternatives considered

1. **Native Rust (chromiumoxide / fantoccini+WebDriver).** Rejected for v0.11.0 — reimplements Playwright's ergonomics, a time sink that would crowd out the actual port. Revisit only if the sidecar proves operationally painful.
2. **Cut the browser tools from v0.11.0.** Rejected — the owner uses recon/scan; a feature regression on the cutover release is worse than carrying one lazy sidecar.

## Cross-links

- Hard Spot #1 in [`../handoffs/phase-rust-collector-handoff.md`](../handoffs/phase-rust-collector-handoff.md).
- Tool inventory + the 🎭/🔌 hazard markers: [`../specs/mcp-tool-surface.md`](../specs/mcp-tool-surface.md).
- Parent decision (the port itself): [`./0002-rust-port-sequence-and-distribution.md`](./0002-rust-port-sequence-and-distribution.md).
