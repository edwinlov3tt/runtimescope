# ADR-0004: Ship v0.10.10 as an exception to "no further Node releases"

**Status:** Accepted
**Date:** 2026-05-24
**Deciders:** Project owner + implementing instance
**Phase:** post-Audit (between v0.10.9 and Phase Tauri-Tray)

---

## Context

[ADR-0002](./0002-rust-port-sequence-and-distribution.md) §"What we are explicitly NOT doing" stated: **"No Node v0.10.10 / v0.10.11 / etc. The Node collector ships no further releases."** That rule was correct at the moment we wrote it — the intent was to stop spending time on Node features and concentrate on the Rust port.

Within hours of v0.10.9 publishing, the project owner installed it on a second machine (the MacBook) and hit a hard install-time failure:

```
✗ Collector did not respond on /readyz within 5s.
```

Root cause: the readyz poll in `runtimescope service install` ([service.ts:waitForCollectorReady(5000)](../../packages/cli/src/service.ts)) was hardcoded at 5 seconds. The collector's synchronous `runStartupRecovery()` opens every project's SQLite store, which on a 40+ project machine takes 5-10 seconds. The collector *does* eventually start; the install command just gives up before it finishes booting. End state: "looks broken to the user; service is actually fine if you wait."

This is exactly the install-pain class that's been driving the supply-chain framing. It also revealed two adjacent gaps:

1. The dashboard is currently only reachable from monorepo checkouts (`npm run dashboard` spawns Vite dev). End users with global installs have no way to see the dashboard at all.
2. There's no first-class way to expose the dashboard on the local network for screen-sharing or multi-device debugging.

The owner's call: **fix all three in one tight v0.10.10 release** rather than wait until Phase Rust-Collector ships months later, AND don't relax the "no further Node releases" rule generally — keep it as the policy with this specific exception documented.

## Decision

**Ship v0.10.10 as a single targeted release with three changes; the "no further Node releases" rule continues to apply for everything else.**

**What ships in v0.10.10:**

1. **Increase `runtimescope service install`'s readyz poll timeout from 5s to 30s.** Three call sites in `packages/cli/src/service.ts`: the default value, plus both `installLaunchd` and `installSystemd`. One-line change per site. Real fix for the install-blocking UX bug.

2. **Bundle the built dashboard into the published `@runtimescope/collector` package.** The collector's `tsup.config.ts` gets an `onSuccess` hook that copies `packages/dashboard/dist/` into `packages/collector/dist/dashboard-assets/`. The HTTP server gains a `/dashboard` route serving the SPA + an `/assets/*` route serving its hashed asset bundles. Both are public (no auth gate) so the dashboard works the same as the API health/snippet endpoints.

3. **Add `runtimescope dashboard` CLI command.** Opens `http://127.0.0.1:6768/dashboard` in the system browser. `--network` flag inspects the LAN IP, opens the LAN-reachable URL instead, and if the service is bound to `127.0.0.1` it surfaces a clear instruction to re-install with `RUNTIMESCOPE_HOST=0.0.0.0 runtimescope service install`. Includes a security warning that 0.0.0.0 binds expose the collector to the whole network.

**What this exception is NOT:**

- **Not a relaxation of the rule.** The "no further Node releases" rule continues to apply for feature work, scope changes, optimization, etc. v0.10.10 is *exclusively* the three changes above.
- **Not a precedent for endless v0.10.x releases.** Any future v0.10.11+ proposal needs its own ADR with this format: real install-blocker + clear scope + no scope creep. The bar is high.
- **Not a rebuilt strategy.** ADR-0002's sequencing (Tray → Wire-Lock → Rust → SDK Migration) is intact and not affected.

## Consequences

**Positive:**

- The install-blocking readyz timeout is fixed. Every user on a 40+ project machine — which includes both the project owner's machines today — no longer sees a misleading "Collector did not respond" error during install.
- The dashboard is reachable from a global install for the first time. Previously, only monorepo users could see it. The Tauri tray (next phase) will have an "Open Dashboard" button that points at the now-functional `/dashboard` URL.
- `runtimescope dashboard --network` provides the foundation for multi-device debugging and screen-sharing scenarios that any user (incl. the project owner sharing the dashboard with someone on another laptop) needs.
- The dashboard bundle being embedded in the collector's npm package is also the foundation for the Rust collector's `include_bytes!` embed (per ADR-0002 §"Embedded dashboard via include_bytes!"). The build pipeline shape we're establishing here transfers directly.

**Negative / accepted trade-offs:**

- **One extra round of Node release work.** Time spent on v0.10.10 is time not spent on Phase Tauri-Tray. Bounded — these three changes are ~1 hour of focused work plus CI publish time.
- **The published `@runtimescope/collector` npm package grows from ~280KB to ~1.4MB** because the dashboard bundle (1.1MB) is now included. End users on `npm install -g runtimescope` see a slightly heavier install. The size is bounded (no transitive deps; just static assets), and Phase Rust-Collector replaces this entirely.
- **The rule "no further Node releases" is now ADR-amendable, not absolute.** Future install-blockers can land via the same exception path. We accept the discipline cost of one ADR per release to keep the gate high.

**Reversal cost:**

- Reverting the readyz timeout bump: one-line change, trivial.
- Reverting the dashboard embed: remove the tsup onSuccess hook, remove the `/dashboard` + `/assets/*` routes, remove the CLI command. ~30 minutes.
- Both reverts are unlikely; the changes are additive and don't touch the wire protocol or core behavior.

## Alternatives considered

1. **Document the workaround and live with the install-time error message.** Rejected. Every install on a 40+ project machine hits it. The error is misleading ("did not respond" vs. "still booting"). Users (including the project owner across multiple machines) experience it as "broken." This is the kind of polish that defines whether a tool feels reliable.

2. **Bump readyz timeout to 30s but skip the dashboard work.** Rejected — only because of bundling efficiency. Since we're already shipping a release for the timeout fix, doing the dashboard work in the same release amortizes the CI publish + npm token + version-bump overhead. If the dashboard work were larger (say, >half a day), it would land separately.

3. **Wait for Phase Rust-Collector to ship and fix everything at once.** Rejected. Phase Rust-Collector is ~8 weeks out. The install-blocker is hitting the project owner today, on every machine they touch. v0.10.10 is shippable in hours.

4. **Wait for Phase Tauri-Tray to ship and have the tray launch the dashboard.** Rejected. The tray doesn't help users who already use `runtimescope service install` from CLI. And the dashboard work in v0.10.10 is what makes the tray's "Open Dashboard" button useful when Tauri ships.

## Cross-links

- Rule being excepted: [`./0002-rust-port-sequence-and-distribution.md`](./0002-rust-port-sequence-and-distribution.md) §"What we are explicitly NOT doing"
- Master phase plan (unchanged by this ADR): [`../roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md)
- Phase Audit completion report (the previous release): [`../reports/phase-audit-completion-report.md`](../reports/phase-audit-completion-report.md)
- Current state snapshot will be updated on v0.10.10 ship: [`../CURRENT_STATE.md`](../CURRENT_STATE.md)
- Audit that documented the bug class (F4 readyz timeout came from this audit): [`../audits/0001-collector-process-lifetime.md`](../audits/0001-collector-process-lifetime.md)

## Notes

The dashboard-bundle-in-collector approach is a working precedent for the Rust port's `include_bytes!` strategy. The bundle copy via tsup's `onSuccess` hook lands the SPA at `dist/dashboard-assets/` — same shape as `include_bytes!` will produce in Rust (a static asset blob inside the binary). The HTTP route logic (SPA fallback for client-side routes, hashed-asset cache headers, MIME-type detection) ports over verbatim.

One thing v0.10.10 deliberately does NOT do: change the service plist to default to `RUNTIMESCOPE_HOST=0.0.0.0`. That's a security-sensitive default that should stay 127.0.0.1; users who want network access opt in explicitly per the `runtimescope dashboard --network` flow.
