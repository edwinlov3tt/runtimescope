# M6 tee-up — `cli` + curl-install + dashboard embed

> Scoping + current-state for Milestone 6 (serial, owner-facing). M5.5 is complete
> (full dashboard API on the Rust collector, 128/128 vs both). M6 makes the Rust
> build *installable + self-serving*; M7 is the cutover/ship.

## Current state (investigated)

- **`crates/cli`** is a stub: `--version` + a "comes in M6" message. No deps.
- **Node CLI** (`packages/cli/src`, ~2,362 LOC) is the reference:
  - `service.ts` (951) — **launchd** (`~/Library/LaunchAgents/com.runtimescope.collector.plist`)
    on macOS, **systemd user unit** (`~/.config/systemd/user/runtimescope.service`) on Linux;
    `install/stop/status/start/restart/uninstall` via `launchctl`/`systemctl` (argv, no shell).
  - `cli.ts` (950) — command dispatch + install/link diagnostics.
  - `dashboard-cmd.ts` (166) — opens `http://127.0.0.1:6768/dashboard` in the browser; LAN-host hint.
  - `mcp-doctor.ts` (295) — MCP-setup diagnostics.
- **Dashboard build** = `packages/dashboard/dist` (**1.1 MB**: `index.html` + 66 `assets/`). The
  **collector** serves the SPA at `/dashboard` (per `dashboard-cmd.ts`) — but the **Rust collector
  does NOT serve `/dashboard` today** (no `include_bytes!`/`ServeDir`/route).

## Sub-slices (recommended order)

### A — Dashboard embed (self-contained, GATEABLE — do first)
The only conformance-gateable piece, and it unblocks `dashboard-cmd`. Embed `packages/dashboard/dist`
into `collector-core` via `include_bytes!` (or `rust-embed`) and serve it:
- `GET /dashboard` + `/dashboard/*` → the SPA, with **client-route fallback to `index.html`**
  (so `/dashboard/projects` works), correct content-types for `assets/*` (js/css/svg/woff).
- Public route (no auth), like health/metrics.
- **Gate** (`dashboard-embed.conformance.test.ts`, green vs both): `/dashboard` → 200 `text/html`
  containing the SPA root div; an `assets/<hash>.js` → 200 `application/javascript`; an unknown
  `/dashboard/<route>` → 200 index.html (SPA fallback); verify it serves **with no
  `packages/dashboard` on disk** (the build is embedded). Build-time: dist must exist at compile
  (a `build.rs` check or a documented `npm run build -w packages/dashboard` prereq).
- Decision: `include_bytes!` (simplest, recompile-on-change, ~1.1 MB in the binary) vs `rust-embed`
  (nicer API, same effect). Roadmap says `include_bytes!`.

### B — CLI service lifecycle (the bulk; owner-facing, NOT conformance-gated)
Port `service.ts` to `crates/cli` with `std::process::Command` (argv, no shell):
- macOS launchd: generate the plist, `launchctl load -w/unload -w/list`; Linux systemd-user:
  generate the unit, `systemctl --user enable/start/stop/status`.
- Commands: `service install|stop|start|restart|status|uninstall`, `dashboard` (open browser),
  `--version`. Decide whether to also port the `doctor`/`mcp-doctor` diagnostics or defer them.
- Verify by a real install/stop/status cycle on this machine (integration-style, not conformance).

### C — Distribution: curl-install + self-update (owner ops; needs decisions)
- `install.sh` (curl | sh) → fetch the right signed binary from GitHub Releases into
  `~/.runtimescope/bin`, put `runtimescope` on PATH.
- `runtimescope self-update` against signed GitHub Releases.
- A release workflow (`.github/workflows/`) building + signing the macOS/Linux binaries.
- **Biggest decision cluster** — signing approach, release-asset naming, self-update trust/verify.

### D — First-run data-wipe warning + `RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1`
The Rust store layout differs from Node's; first run on an existing `~/.runtimescope` should warn
before touching legacy data, with an env opt-out. Small, but a data-safety gate — get it right.

## What's gateable vs owner-call
- **Gateable green-vs-both:** A (dashboard embed) — the collector serves the SPA identically.
- **Integration/manual-verify:** B (service install/stop/status cycle on a real machine).
- **Owner ops + decisions, not gateable:** C (release/signing/self-update), D (data-wipe policy).

## Open decisions for the owner (before/at build time)
1. **CLI scope:** full faithful port (service + dashboard + the doctor/mcp-doctor diagnostics,
   ~2.3 K LOC) or essential set (service install/stop/status/restart + dashboard + version),
   deferring the diagnostics?
2. **Distribution/self-update:** what's the signing + release mechanism (GitHub Releases asset
   signing? notarization on macOS?), and is self-update in-scope for v0.11.0 or a fast-follow?
3. **Dashboard embed:** confirm `include_bytes!` (recompile on dashboard change) vs `rust-embed`;
   and confirm the dashboard build is a CI/release prerequisite step.
