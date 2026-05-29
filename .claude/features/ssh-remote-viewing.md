# Feature: SSH-Friendly Remote Viewing

## Status: ⬜ Backlog

## Assessment
- **Phase**: v1.1
- **Complexity**: S (~1 day for the hint + docs; item 3 is a constraint, not new work)
- **Value**: Medium
- **Created**: 2026-05-28

## Description
Make the "I'm SSH'd into a remote box and want to see RuntimeScope on my local
machine" workflow first-class — through ergonomics and documentation, **not** a
bespoke SSH transport. When the CLI detects an SSH session it prints the exact
tunnel command to view the dashboard locally; a docs page covers the three
viable topologies; and the dashboard SPA is constrained to same-origin URLs so
it survives being forwarded to a non-default local port.

## Why
Developers commonly SSH into dev boxes / cloud VMs / remote workstations and run
their app there. The instinct is "I don't want to forward a port" — but SSH
forwarding is the *correct, encrypted, already-authenticated* primitive for
this, and the alternative (`RUNTIMESCOPE_HOST=0.0.0.0`) silently exposes the
full event store and `modify_table_data` with auth off by default. The product
should steer users toward forwarding and make it painless, rather than inventing
a transport or encouraging the dangerous bind.

## Architectural driver (why the answer is "docs + ergonomics", not a transport)
The MCP server and collector run as **one stdio-coupled process** sharing an
in-memory `EventStore`. Claude Code talks to the MCP server over stdio, which
only works when Claude Code and the collector are on the **same machine**. The
SDK↔collector link, by contrast, is already a network protocol
(`ws://…:6767` browser, HTTP POST `:6768` server/workers) with a configurable
endpoint. That asymmetry means SSH forwarding composes cleanly at the network
seam, and there is nothing to gain from a custom SSH layer.

Two distinct "viewing surfaces" behave differently over SSH:
- **MCP tools** — stdio-coupled; must be co-located with the collector.
- **HTTP dashboard (`:6768`)** — ordinary web server; trivially tunnelable.

## Scope

### What It Includes
1. **SSH-session detection + hint.** When `$SSH_CONNECTION` / `$SSH_TTY` is set,
   `runtimescope service status` and `runtimescope dashboard` append a hint with
   the exact command, e.g.:
   `Detected an SSH session — view the dashboard locally with:
   ssh -L 6768:localhost:6768 <user>@<host>`
2. **Docs page** covering the three topologies:
   - **Co-located remote** — app + collector + Claude Code all remote; forward
     only the dashboard port (`ssh -L 6768:localhost:6768`). Works today.
   - **Reverse-tunnel the ingest link** — collector + Claude Code + dashboard
     local; remote app's SDK keeps default `ws://localhost:6767`, reverse-tunnel
     it home with `ssh -R 6767:localhost:6767`. Nicest fit for "see it locally";
     only caveat is ordering (collector → tunnel → (re)start remote app).
   - **Discourage `RUNTIMESCOPE_HOST=0.0.0.0`** over SSH/internet — auth is off
     by default; SSH forwarding gives encryption + auth for free.
3. **Wire-protocol-lock constraint** (a guardrail, not new code): the dashboard
   SPA must use **same-origin / relative URLs** for its API + WebSocket calls,
   never hardcoded `http://127.0.0.1:6768`. Otherwise forwarding to a different
   local port (e.g. `ssh -L 16768:localhost:6768` when 6768 is taken locally)
   breaks the UI. "Must work behind a forwarded port" belongs in the locked
   wire protocol.

### What It Doesn't Include
- **No bespoke SSH transport.** SSH forwarding is the primitive; we don't wrap it.
- **No auto-tunnel-spawning** from the CLI (no managing `ssh` child processes).
- Configurable tray endpoint (host/port) so the tray can watch a *forwarded*
  remote collector — deliberately deferred; it bumps the tray's "HTTP-only,
  port 6768" v1 contract and is a separate later decision.

## Technical Notes

### Systems Affected
- `packages/cli/src/` — SSH detection + hint output in `service status` / `dashboard`.
- `packages/dashboard/src/` — verify/enforce same-origin API + WS base URLs.
- `docs/` — new SSH topologies page.

### Dependencies
- **Builds on**: existing `RUNTIMESCOPE_HOST` bind support and the dashboard
  Vite proxy.
- **Relates to**: Phase Wire-Protocol-Lock (item 3 is a constraint for the
  locked surface — the dashboard's transport assumptions should be pinned there).

### Rough Approach
Item 1 is a few lines reading `process.env.SSH_CONNECTION || process.env.SSH_TTY`
and printing a templated hint. Item 2 is documentation. Item 3 is an audit of
the dashboard's fetch/WebSocket base-URL construction plus a note in the wire
protocol spec — most of the work is *verifying* it's already same-origin and
adding a regression guard, not rewriting.

## Questions / Open Items
- Does the dashboard SPA today construct any absolute `127.0.0.1:6768` URLs, or
  is it already same-origin? (Determines whether item 3 is a no-op + guard, or
  a real fix.)
- Should the SSH hint also surface in the Tauri tray (which can't show it today,
  since it assumes a local collector)? Likely tied to the deferred
  configurable-endpoint work.

---

*When ready to implement, run `/task ssh-remote-viewing` to generate a detailed task plan.*
