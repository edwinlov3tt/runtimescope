# ADR-0002: Post-audit phase sequence — tray, wire-lock, Rust collector, SDK migration

**Status:** Accepted
**Date:** 2026-05-24
**Deciders:** Project owner + implementing instance
**Phase:** post-Audit

---

> **Addendum (2026-05-29) — version-number reassignment.** This ADR originally assigned **Wire-Protocol-Lock → v0.11.0** and **Rust-Collector → v0.12.0**. The owner has reassigned the numbers: **Wire-Protocol-Lock ships as a `0.10.x` patch (v0.10.13)** — it's no-behavior-change tooling and doesn't merit a minor bump — and **v0.11.0 is reserved as the clean number for the Rust collector.** SDK-Channel-Migration shifts accordingly (v0.13.0 → v0.12.0). Everything else in this ADR (sequence, fresh-data, curl-install, embedded dashboard, CDN SDKs) stands unchanged. Rationale: keep a clean, memorable minor-version boundary for the Rust cutover rather than spend it on a docs-and-tests phase.

---

## Context

[ADR-0001](./0001-audit-then-rust.md) committed to "audit first, then Rust." That decision is intact and shipped as v0.10.9 — see [Audit 0001](../audits/0001-collector-process-lifetime.md) (Closed) and [Phase Audit completion report](../reports/phase-audit-completion-report.md). This ADR supersedes only the *forward-looking* section of ADR-0001 (the recommended sequence after the audit closes); the audit decision itself remains correct.

Mid-audit, the project owner consulted a second instance for an independent strategic opinion. That instance's proposal sharpened the post-audit plan in three meaningful ways:

1. **Disable the launchd daemon while waiting for Rust.** The original plan kept the Node daemon running 24/7 through the Rust port. The owner is the only user; daily pain comes from continuous operation. If the daemon doesn't run 24/7, the Node bug class becomes irrelevant for daily use, and the post-audit pace is dictated by Rust progress, not Node pain.

2. **CDN-default SDK distribution + npm provenance.** The original plan kept SDKs on npm as primary. The supply-chain concern the owner raised is actually about **channel compromise** (the Nx CI compromise of late 2025, the chalk/debug supply-chain incident before that), not dep-tree choices. The right answer is CDN-as-default with SRI hashes (the Stripe/Sentry/PostHog pattern), with npm-with-provenance as a fallback channel. This wasn't part of the original Rust scope at all.

3. **Embed the dashboard in the Rust binary via `include_bytes!`.** The dashboard's ~200 transitive build-time deps are the largest npm surface in the project, even though end users don't `npm install` it. Baking the built bundle into the Rust binary removes that surface entirely — 95% of the security benefit at 5% of the cost vs. rewriting in Leptos/Dioxus.

A second decision-input arrived alongside those three: **the project owner is willing to lose existing local data.** ~/.runtimescope/ currently holds 44 projects of SQLite + WAL data; the Rust collector does not need a migration path. This removes a meaningful chunk of port complexity.

A third decision-input: **the tray ships before the Rust collector.** This creates a sequencing tension — the tray controls a still-Node launchd daemon during the interim. The owner accepts this; the daemon stays running specifically as the tray's backend during the interim. We do *not* unload launchd today.

## Decision

**Post-audit, the phase sequence is: Tauri-tray → Wire-Protocol-Lock (scoped) → Rust-Collector (with embedded dashboard, fresh data, curl-install) → SDK-Channel-Migration (CDN-default with SRI, npm-with-provenance fallback, CLI-vendored opt-in).**

**What we are doing:**

- **Phase Tauri-Tray ships first.** ~5-7 days. Native macOS menu-bar app, ad-hoc signed for personal use. Talks to the existing Node collector's HTTP API only — never reads the collector's process internals. When the Rust collector ships later, the tray doesn't change.
- **Phase Wire-Protocol-Lock ships second, scoped down.** ~2-3 days. Two deliverables:
  - `docs/specs/wire-protocol.md` — ~2 pages, invariants only (not a full spec; the conformance tests are the executable spec).
  - `tests/conformance/` — SDK-driven black-box tests that exercise WebSocket + HTTP + SQLite invariants against any collector binary. Passes against v0.10.9 (Node) today; will be the acceptance gate for the Rust port.
  - Ships as v0.11.0 to signal contract maturity. No behavior change.
- **Phase Rust-Collector ships third.** ~8 weeks honest. Crate layout:
  ```
  crates/collector-core      ring buffer, sqlite/WAL, engines
  crates/collector-server    bin: WS + HTTP, links core
  crates/mcp-server          bin: stdio JSON-RPC + tools, links core
  crates/cli                 bin: replaces runtimescope npm CLI
  ```
  - Dashboard embedded via `include_bytes!` from the built Vite output.
  - **No data migration.** First run of the Rust collector wipes ~/.runtimescope/ (one-time warning, opt-out env var `RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1`). The owner is the only user; this is acceptable. Document the consequence in release notes.
  - Distribution: `curl -sSL https://runtimescope.dev/install.sh | sh` drops 4 binaries under `~/.runtimescope/bin`. Single `runtimescope` command on PATH. Auto-update via signed binary releases on GitHub Releases. **No npm install for the CLI ever again.**
  - Ships as v0.12.0. The Node packages stay published at v0.10.9 as a rollback artifact (npm "deprecate" only, not unpublish — npm policy).
- **Phase SDK-Channel-Migration ships fourth.** ~2 weeks. Three distribution channels per [ADR-0003](./0003-sdk-distribution-channels.md):
  - **CDN-default** for browser + Workers SDK: signed releases at `cdn.runtimescope.dev` with published SRI hashes.
  - **CLI-vendored** for all SDKs: `runtimescope sdk install <browser|server|workers>` writes a single-file copy into the user's project.
  - **npm-with-provenance** as fallback: SDKs still publish to npm but with provenance attestation (GitHub Actions OIDC → npm). End users who insist on `npm install` get a verifiable, signed artifact.
  - Ships as v0.13.0.

**What we are explicitly NOT doing:**

- **No `launchctl unload` today.** The Node daemon stays running for the tray to control during the interim. Defer the unload until the Rust collector takes over.
- **No data migration code in Rust.** Existing local SQLite/WAL is discarded on first Rust collector run. Saves ~3-5 days of Rust work and removes a class of correctness risk.
- **No supersession of the Audit work.** ADR-0001's "audit-then-Rust" decision was correct; the audit shipped as v0.10.9 and the findings are now permanent value, not "design inputs for Rust."
- **No Node v0.10.10 / v0.10.11 / etc.** The Node collector ships no further releases. F4 + F5 already shipped in v0.10.9; there are no remaining Node deferrals.
- **No `packages/collector-legacy/` directory.** Git is the rollback. When the Rust port ships, delete `packages/collector/`, `packages/mcp-server/`, `packages/cli/` outright. Tagged releases preserve the prior state.
- **No `workspace:*` adoption** (revisit later if cross-package deps need it; not in scope for any of these phases).
- **No replacement of `exceljs`, `better-sqlite3`, or other Node transitive-dep warnings.** They're irrelevant once the Node collector is retired.

## Consequences

**Positive:**

- **Distribution becomes a single curl + signed binary.** Removes the entire npm-CLI attack surface (no `npx`, no `npm install -g`, no transitive trees on the user's machine). The collector's distribution shape becomes more like `rustup` / `bun install` / `pnpm`'s self-installers than a Node CLI.
- **SDKs ship as signed, hash-pinned CDN assets by default.** End users who follow the docs see `<script src="https://cdn.runtimescope.dev/sdk@1.0.0.js" integrity="sha384-...">` instead of `npm install @runtimescope/sdk`. npm becomes opt-in fallback, not the default path.
- **The dashboard's ~200 build-time transitive deps disappear from end-user supply chain.** Embedded as a static asset in the Rust binary, audited once per release, locked.
- **The Tauri tray validates the Rust toolchain before the collector port begins.** Lower-stakes Rust intro; the same crates (tokio, reqwest, serde) carry over.
- **Fresh data on Rust cutover simplifies the port and forces a clean schema.** No "rusqlite must read the better-sqlite3 schema byte-for-byte" constraint.
- **Tray is HTTP-API-only**, so the backend swap (Node → Rust) is invisible to it. Same binary, same UI.

**Negative / accepted trade-offs:**

- **Existing local history is lost** when the Rust collector first runs. The owner explicitly accepted this. For other future users, the opt-out env var is the escape hatch but the default is destructive.
- **8-week Rust port + 2-week SDK migration = ~10 weeks of no user-facing features.** Bug-fix releases on Node already done (v0.10.9); there will be zero Node releases between now and v0.12.0.
- **The launchd daemon keeps running through the interim.** That's accepted because: (a) the v0.10.9 fixes are real — LRU eviction, EPIPE safety, parent-death watchdog are all in place; (b) the daemon's only role is to back the tray; (c) the alternative (no daemon) means the tray has nothing to show.
- **CDN infrastructure adds an ongoing cost surface.** Cloudflare R2 + custom domain + Cloudflare Pages or similar. Cheap (~$5/mo) but non-zero, and requires owning `runtimescope.dev`.
- **Provenance attestation requires keeping the GitHub Actions secret pipeline healthy.** The NPM_TOKEN rotation incident during v0.10.9 was the warning shot; this requires discipline going forward (alerting when the token expires, etc).

**Reversal cost:**

- Cheap up through Phase Wire-Protocol-Lock (v0.10.13). It's docs + tests; abandoning it loses 2-3 days.
- Medium through Phase Rust-Collector. Tagged releases preserve the Node code; if the Rust port fails, we resurrect `packages/collector/` from git history. We just don't keep a parallel copy in the working tree.
- Higher for Phase SDK-Channel-Migration. Once the CDN URL is in the wild as the recommended install pattern, reverting means changing docs + breaking integrations. Worth getting right the first time, not optimizing for reversal.

## Alternatives considered

1. **Skip the audit entirely and jump to Rust today** (the other instance's original framing). Rejected because the audit already shipped — it's moot. The audit findings are now permanent value (v0.10.9 fixes + tests + diagnostic API + docs scaffold), not "design inputs for Rust" the way they would have been before the audit.

2. **Keep npm as the default SDK channel.** Rejected. The supply-chain concern is real and the CDN-default pattern is industry-standard for instrumentation SDKs. The work to set up the CDN channel is bounded (~1 week including CI for SRI generation); the security benefit is durable.

3. **Migrate data from the Node collector's SQLite into the Rust collector's first-run state.** Rejected because the project owner is the only user and explicitly accepted data loss. Building a migration path would add ~3-5 days of Rust work, ongoing test coverage for schema versions, and a class of "what if migration fails?" correctness risk. Not worth it for n=1.

4. **Tray after Rust, not before.** Rejected because the tray gives quick wins (status visibility, "is it running?" closes the loop on every install pain we've debugged this month), validates the Rust toolchain before the larger port, and shares Rust crates that the collector port will use. The sequencing tension ("tray talks to the still-buggy Node daemon during interim") is real but bounded — the daemon's v0.10.9 fixes are in place.

5. **Rewrite the dashboard in Leptos/Dioxus to fully exit JS in the codebase.** Rejected as out of scope. `include_bytes!` embedding gets 95% of the security benefit at 5% of the cost. Revisit only if the dashboard's build-time dep tree produces a CVE that survives audit.

## Cross-links

- Supersedes the *forward-looking* portion of: [`./0001-audit-then-rust.md`](./0001-audit-then-rust.md). The audit decision itself remains correct.
- Companion: [`./0003-sdk-distribution-channels.md`](./0003-sdk-distribution-channels.md) — captures the SDK-channel decision in its own ADR.
- Phase sequencing landing in: [`../roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md)
- Audit that produced the baseline: [`../audits/0001-collector-process-lifetime.md`](../audits/0001-collector-process-lifetime.md)
- Phase Audit completion report: [`../reports/phase-audit-completion-report.md`](../reports/phase-audit-completion-report.md)

## Notes

The pivot toward CDN-default SDKs is the most strategically important change here. Even if every other phase falls behind schedule, **the CDN+SRI+provenance triad is the actual answer to "why is RuntimeScope safer than typical npm-installed instrumentation?"** That's the security positioning. Every other phase is execution of the same fundamental product; the SDK channel migration is what makes the product different.

The "fresh data" decision is acceptable now because the owner is n=1. Before any second user adopts this, we should either:
- Build an explicit `runtimescope migrate <from-version>` command, OR
- Communicate up-front that major version changes wipe local data, with backup advice (export to JSON / SQLite snapshot / etc).

Out of scope for this ADR but the future-second-user concern should land as an ADR before v1.0.0 ships.
