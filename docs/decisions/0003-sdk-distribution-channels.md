# ADR-0003: SDK distribution channels — CDN-default, npm-with-provenance fallback, CLI-vendored opt-in

**Status:** Accepted
**Date:** 2026-05-24
**Deciders:** Project owner + implementing instance
**Phase:** post-Audit (companion to [ADR-0002](./0002-rust-port-sequence-and-distribution.md))

---

## Context

RuntimeScope ships four SDKs to users:
- `@runtimescope/sdk` — browser, zero-dep, IIFE + ESM
- `@runtimescope/server-sdk` — Node, CJS + ESM
- `@runtimescope/workers-sdk` — Cloudflare Workers, ESM
- `runtimescope` (Python) — PyPI, no npm concern

The project owner raised supply-chain concerns about npm in particular — driven by attacks like the Nx CI compromise (late 2025), the `ua-parser-js` 2021 incident, and the steady drumbeat of typo-squatted instrumentation packages. The audit ([0001](../audits/0001-collector-process-lifetime.md)) addressed npm's *behavior-class* bugs (process lifetime, resource hygiene). This ADR addresses the orthogonal concern: **the npm channel itself as a compromise vector.**

Three observations frame the decision:

1. **Our SDKs are zero-dep already.** A compromise of `@runtimescope/sdk` doesn't pivot through a transitive tree (we have none). The risk surface is direct: someone publishes a malicious `@runtimescope/sdk@X.Y.Z` to the registry under a stolen NPM_TOKEN.

2. **Industry precedent for instrumentation SDKs is CDN-as-default, not npm.** Stripe.js ships at `js.stripe.com/v3/`, Sentry at `browser.sentry-cdn.com/...`, PostHog at `app-static.posthog.com/...`. All three use SRI hashes for tamper detection. Users include via `<script src="..." integrity="sha384-...">`. **This is not weird; it's the standard.**

3. **npm has provenance attestation now (since 2023).** Packages published with `npm publish --provenance` from GitHub Actions get OIDC-signed metadata that proves "this tarball was built from this commit by this workflow." `npm audit signatures` verifies. This is the post-Equation-Group defense and it's free. Adopting it costs ~1 day of CI config.

We're at n=1 user (the project owner). Adopting CDN-default before any third party integrates is the lowest-friction time to make the channel choice — no users to migrate, no docs to rewrite, no integration breakage.

## Decision

**SDKs ship via three channels in this priority order:**

1. **CDN-default** at `cdn.runtimescope.dev/<sdk>@<version>.js` — signed, hash-pinned, recommended in all docs.
2. **CLI-vendored** via `runtimescope sdk install <browser|server|workers>` — writes a single-file copy into the user's project, no package manager involved.
3. **npm-with-provenance** as opt-in fallback — `@runtimescope/<sdk>` continues to publish to npm with `--provenance`, but is never the recommended path in docs.

**What we are doing:**

- **Stand up `cdn.runtimescope.dev`** on Cloudflare R2 + Cloudflare Pages (or equivalent). Owner registers the domain if not already. Versioned URL scheme:
  - `cdn.runtimescope.dev/sdk@<semver>.js` — browser
  - `cdn.runtimescope.dev/workers-sdk@<semver>.js` — Workers (ESM)
  - `cdn.runtimescope.dev/server-sdk@<semver>.cjs` — Node (CJS for compat) and `.js` for ESM
  - Each version is immutable. `cdn.runtimescope.dev/sdk@latest.js` resolves via Cloudflare Pages redirect to the most recent semver.
- **CI generates SRI hashes** on every release (sha384). Publish them to:
  - The release notes
  - A canonical index at `cdn.runtimescope.dev/sri.json` (machine-readable, hash for every published version)
  - The docs site's install snippet for each SDK
- **Build the CLI-vendored path into the Rust `runtimescope` binary** (per [ADR-0002](./0002-rust-port-sequence-and-distribution.md)). Commands:
  - `runtimescope sdk install browser --version <semver|latest>` — drops `runtimescope-sdk.js` into the user's project (configurable path).
  - `runtimescope sdk update browser` — re-fetches latest and overwrites.
  - All fetches verify against the SRI hash published in `sri.json`. If the hash doesn't match, the install aborts.
- **Continue npm publishing with provenance.** GitHub Actions workflow already exists; add `--provenance` to the `npm publish` calls (`packages/sdk`, `packages/server-sdk`, `packages/workers-sdk`). One-line change per package once the OIDC trust is configured.
- **Documentation updated to recommend CDN as primary** for browser + Workers SDKs. Node SDK docs recommend `runtimescope sdk install server` as primary, npm as fallback.

**What we are explicitly NOT doing:**

- **No unpublishing the existing npm packages.** Existing integrations continue to work. The npm channel is opt-in but stays alive.
- **No replacing `runtimescope` (Python) package distribution.** PyPI is a different ecosystem; addressed separately if needed (already publishes with `--require-hashes` documentation).
- **No CDN for the collector or MCP server binaries.** Those ship via the curl-install script per ADR-0002 — that's a different channel concern (signed Rust binaries via GitHub Releases).
- **No browser SDK build artifact behind a paywall, gate, or workspace-key requirement.** The CDN is open. Versioning is via the URL path.
- **No npm-default for the browser/Workers SDKs after v0.13.0 ships.** The docs flip the recommended path. Existing users on npm get the same package, just with provenance.

## Consequences

**Positive:**

- **Channel risk is layered.** A compromise of npm doesn't compromise CDN users. A compromise of CDN doesn't compromise CLI-vendored users (their copy is checked into git). A compromise of GitHub Actions OIDC affects all three but is much narrower than a token leak.
- **SRI hashes make tamper-detection automatic** for browser users — the browser refuses to execute mismatched code. No remote control needed.
- **CLI-vendored installs are explicit and reviewable.** The file lands in the user's repo, gets reviewed in PRs, doesn't auto-update.
- **Provenance attestation works retroactively as a verification surface** — anyone can `npm audit signatures` and prove the package came from our CI, not from a hijacked token publish.
- **Documentation simplifies the install story.** Browser users get a 3-line snippet; no `npm install` step before `import RuntimeScope`.

**Negative / accepted trade-offs:**

- **Ongoing infrastructure** — CDN bucket, domain DNS, Cloudflare Pages config, CI workflow for SRI generation. ~$10-20/month, recurring. Maintenance overhead bounded but non-zero.
- **Three channels means three places to ship a release to.** The CI workflow that already publishes to npm needs new steps: upload to R2 with versioned key, update sri.json, invalidate CDN cache. Adds ~1 minute to each release.
- **CLI-vendored installs become a third "source of truth" for SDK versions in user projects.** Users may forget to update them. Mitigation: a `runtimescope sdk outdated` command that checks installed versions against `latest`.
- **CDN-default sets an expectation that the CDN stays up.** If `cdn.runtimescope.dev` goes down, every CDN-installed browser SDK fails to load. Mitigation: Cloudflare's uptime SLA (99.99%) + a documented fallback to npm.
- **Provenance attestation is only as strong as the GitHub Actions secret pipeline.** The v0.10.9 NPM_TOKEN-rotation incident showed how fragile that is. Mitigation: alerting on token expiry; document the secret-rotation runbook in `docs/operations/`.

**Reversal cost:**

- Low for CDN-default. If we want to roll back, point docs at npm again and stop publishing to CDN. Existing CDN URLs continue to resolve (R2 doesn't auto-delete). Users on the recommended path keep working.
- Medium for CLI-vendored. The CLI command stays; users who used it have local copies. No active reversal cost.
- Zero for provenance. Adding `--provenance` to `npm publish` is additive; removing it later is also fine.

## Alternatives considered

1. **Keep npm as the default for all SDKs, lock down the NPM_TOKEN, rotate often.** Rejected. The npm-channel risk is real and growing; rotation discipline doesn't help if the registry itself is compromised. CDN+SRI is structurally stronger.

2. **Self-host the CDN on the project owner's existing infra (no Cloudflare).** Rejected. Cloudflare R2 is cheap, has good uptime, and edge-cached delivery. Self-hosting introduces a dependency on the owner's machine staying up, plus DDoS surface. Not worth the savings.

3. **Drop npm publishing entirely once CDN ships.** Rejected. Some users have integrations that pull from npm via Renovate/Dependabot automation; ripping the rug pulls breaks them. Opt-in fallback is the safer transition. Revisit after the CDN has been live for 6+ months with no significant npm-channel adoption.

4. **Ship the browser SDK as a WebAssembly module instead of JS.** Rejected as out of scope. WASM adds a load-time penalty (instantiation, no top-level await for the polyfill case), the SDK is small enough that JS is fine, and the audit didn't surface any JS-engine-specific bugs in the SDK code path.

## Cross-links

- Sibling ADR: [`./0002-rust-port-sequence-and-distribution.md`](./0002-rust-port-sequence-and-distribution.md) — the phase plan; this ADR captures the SDK-channel piece of Phase SDK-Channel-Migration.
- Phase that implements this decision: Phase SDK-Channel-Migration in [`../roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md).
- Audit that drove the security framing: [`../audits/0001-collector-process-lifetime.md`](../audits/0001-collector-process-lifetime.md).

## Notes

The SRI hash mechanism is the part most likely to bite us if we're sloppy. A few rules to keep:

1. **CDN files are immutable per-version.** Never overwrite a published `<sdk>@1.0.0.js`. If a hot-fix is needed, ship `1.0.1`.
2. **`sri.json` is the single source of truth for hashes.** Generate it from the CDN upload step in CI; never hand-edit.
3. **The CLI MUST verify the hash before writing the vendored file.** Don't trust the CDN to be uncompromised at fetch time; trust the hash from `sri.json` and verify the download matches.
4. **`sri.json` itself must be served from the same domain** so a compromise of just one needs to compromise both. (Optional defense: also publish a signed copy to GitHub Releases for users who want belt-and-suspenders verification.)
