# ADR-0005: Prefer pnpm over npm for monorepo internal tooling

**Status:** Proposed
**Date:** 2026-05-24
**Deciders:** Project owner + implementing instance
**Phase:** post-Audit (forward-looking; not scheduled for action yet)

---

## Context

[ADR-0003](./0003-sdk-distribution-channels.md) addresses the *external* npm-channel risk for SDK consumers (CDN-default + npm-with-provenance). This ADR addresses the *internal* equivalent: the monorepo's own package management layer, used during dev, in CI, and at publish time.

Three pressures push toward changing it:

1. **The workspace-resolution bugs we keep hitting.** During the v0.10.6/0.10.7/0.10.8 cycle, npm repeatedly populated per-package `node_modules/@runtimescope/` directories with *published* versions of sibling workspaces — overriding the workspace symlinks at the repo root. We had to manually `rm -rf packages/*/node_modules/@runtimescope` before every build to recover. The root cause is npm's "exact pin to a published version = prefer registry over workspace" behavior when the version on disk matches the pin. `workspace:*` would fix it but produced `EUNSUPPORTEDPROTOCOL` on this npm version when we tried it.

2. **Disk + install-time cost.** A clean `npm install` on this monorepo pulls ~1.2GB of `node_modules/` across 13 packages, with substantial duplication (every package gets its own copy of tsup's deps, etc.). pnpm's content-addressable store dedupes across all projects on the machine — ~80–90% disk reduction in practice.

3. **Same supply-chain concern as ADR-0003 but applied internally.** When we `npm install`, the install scripts of *every* transitive dep can run with our user privileges. The recent npm-channel attacks (Nx CI compromise, etc.) were as much about install-time code execution as about runtime payloads. pnpm doesn't change the install-script execution model on its own, but `--ignore-scripts` is more practically usable in pnpm because the symlink-based layout doesn't depend as heavily on `node-gyp` and friends running successfully at install time.

The pressure to *not* change it: pnpm's symlink-based layout occasionally breaks tools that walk `node_modules` (Webpack 4 setups, some bundlers that pre-date PnP). Our toolchain is tsup + Vite + vitest — all known to work with pnpm out of the box.

This isn't scheduled work. It's captured here so the next session that touches the package management layer (likely early in Phase Rust-Collector when the Node packages are about to retire anyway) picks it up with the rationale ready.

## Decision (proposed)

**When we next touch the monorepo's package management layer, switch from npm + npm workspaces to pnpm + pnpm workspaces.** Likely trigger: early Phase Rust-Collector, when most Node packages are being deprecated and the diff cost is low.

**What "switch" entails:**

- Add a `pnpm-workspace.yaml` declaring the workspace globs (mirroring the current `workspaces` field in root `package.json`).
- Delete `package-lock.json`; pnpm produces `pnpm-lock.yaml`.
- Convert cross-package version pins from `"@runtimescope/sdk": "0.10.10"` (current — exact pin) to `"@runtimescope/sdk": "workspace:*"` (pnpm-native). pnpm rewrites these to the actual version at publish time, so consumers see a normal version.
- Update the GitHub Actions publish workflow: `npm ci` → `pnpm install --frozen-lockfile`, `npm publish` → `pnpm publish` (with provenance preserved per ADR-0003).
- Update CLAUDE.md and the docs to say `pnpm install` instead of `npm install`.

**What we are explicitly NOT doing:**

- **Not changing what end users install.** Users of `@runtimescope/sdk` still run `npm install` (or yarn/pnpm — their choice). The published package format is unchanged; only our internal layer differs.
- **Not adopting `pnpm` for the Rust collector's curl-install.** That path is its own channel ([ADR-0002](./0002-rust-port-sequence-and-distribution.md)). pnpm is for monorepo dev only.
- **Not migrating before the Node collector retires.** Doing it during active Node development risks workspace-resolution churn at the worst possible time. Wait until Phase Rust-Collector is well underway.

## Consequences

**Positive:**

- **The per-package `node_modules/@runtimescope/` ghost problem disappears** entirely. pnpm's symlink layout always resolves a workspace dep to the workspace source — there's no path where it could pull a published version instead.
- **Disk savings.** ~80–90% reduction in `node_modules/` size on machines with multiple JS projects (shared content-addressable store at `~/.local/share/pnpm/store`).
- **Faster CI installs.** pnpm caches by content hash; on cache hit the install is sub-second.
- **Stricter dep tree by default.** pnpm makes phantom deps (importing a package you didn't declare) fail at import time, not at runtime. This would have caught the v0.10.6 collector bug where the mcp-server's bundle silently imported from `@runtimescope/extension` because the workspace happened to have it installed.

**Negative / accepted trade-offs:**

- **One-time migration cost.** Maybe 1–2 hours of focused work: convert pins, update CI, smoke-test the publish pipeline, regenerate the lockfile. Plus a round of "fix the workflow" iteration if anything snags.
- **Anyone cloning the repo needs pnpm installed.** Standard `corepack enable` covers this on Node 16.13+; documented but a small papercut for casual contributors.
- **The `workspace:*` protocol gets rewritten by pnpm at publish time** — published packages have normal version pins, so consumers don't see `workspace:*`. We need to verify this rewrite works correctly the first time we publish from pnpm; tested-in-isolation before flipping the live pipeline.

**Reversal cost:**

Cheap. `pnpm` → `npm` migration is essentially: delete `pnpm-lock.yaml` + `pnpm-workspace.yaml`, regenerate `package-lock.json` via `npm install`, restore the `workspaces` field in root `package.json` if it was removed. ~30 minutes. The published packages don't carry any pnpm-specific markers.

## Alternatives considered

1. **Stay on npm + adopt `workspace:*` protocol.** We tried this during v0.10.5/0.10.6 debugging and got `EUNSUPPORTEDPROTOCOL` from npm despite running npm 11.6. Unclear root cause; possibly an interaction with our hybrid workspace setup. Not blocking enough to dig further while npm-with-exact-pins works at all, but it's the symptom that motivates this ADR.

2. **Switch to yarn (classic or berry).** Viable. Yarn berry (v3+) has PnP mode which goes further than pnpm in the strictness direction, but PnP has historically broken more tools than pnpm's symlink layout. yarn classic (v1) is unmaintained. pnpm is closer to npm in mental model with better defaults, so the cognitive switching cost is lowest.

3. **Switch to bun.** Faster than pnpm on cold install, but bun is bundler + runtime + test-runner + package manager all-in-one. We'd be coupling four decisions to one tool, and bun's package manager is still maturing. Premature.

4. **Keep npm; just delete the per-package `node_modules/@runtimescope/` directories in a pre-build hook.** Workaround, not fix. Trades a hard error for silent corruption when the hook fails. Rejected as the kind of defensive scripting that papers over a tooling mismatch.

## Cross-links

- [`./0002-rust-port-sequence-and-distribution.md`](./0002-rust-port-sequence-and-distribution.md) — defines Phase Rust-Collector, the likely trigger for actually executing this ADR.
- [`./0003-sdk-distribution-channels.md`](./0003-sdk-distribution-channels.md) — the external counterpart to this internal concern.
- [`./0004-v0-10-10-install-blocker-exception.md`](./0004-v0-10-10-install-blocker-exception.md) — most recent precedent for an "internal tooling change ships even though we said no more Node releases."

## Notes

When this ADR moves from `Proposed` to `Accepted`, the implementing session should:

1. Verify pnpm 9+ (the version that handles publish-time `workspace:*` rewrite correctly).
2. Run the full publish pipeline against a test package to verify provenance attestation still works through pnpm (the GitHub Actions OIDC bits).
3. Confirm Vite, tsup, vitest, and better-sqlite3 all work against the symlinked pnpm layout — they should, but a single workflow run catches any surprises before the migration ships.

Trigger condition for acting on this ADR: **early Phase Rust-Collector, when the Node collector is days away from being deprecated and the workspace-pin pain is minimal.** Acting earlier risks active Node development churn; acting later misses the window where the migration cost is lowest (no production npm releases happening from the monorepo anymore).
