---
description: Update RuntimeScope across the whole user — global CLI, background service, MCP server, plugin, AND every project on this machine that has @runtimescope/* installed
allowed-tools: ["Bash", "Read", "Edit", "Glob", "WebFetch", "mcp__runtimescope__list_projects", "mcp__runtimescope__get_session_info", "mcp__runtimescope__wait_for_session"]
---

# Update All — Cross-Project RuntimeScope Updater

Run from anywhere. Walks every project on this machine that has RuntimeScope installed and brings it up to the latest published version, plus updates the user-level CLI + service + MCP server + plugin. Saves the user from having to run upgrade commands manually in each project.

---

## Step 1: Confirm user-level install exists

```bash
test -f ~/.runtimescope/installed-at && echo "INSTALLED" || echo "MISSING"
```

If `MISSING`, tell the user: "no user-level install detected — run `/runtimescope:install` first, then re-run this command." Do not proceed.

## Step 2: Resolve the target version from npm

```bash
TARGET=$(npm view @runtimescope/sdk version 2>/dev/null)
echo "Target version: $TARGET"
```

This is the canonical "latest stable" — every `@runtimescope/*` package ships in lockstep at the same version. Use this for all subsequent installs so projects stay aligned.

## Step 3: Update the user-level pieces

```bash
# Unscoped CLI (provides `runtimescope` binary, service manager)
npm install -g runtimescope@latest

# Background service binary (recompiles plist/unit if the wrapper changed)
runtimescope service update 2>/dev/null || runtimescope service install

# MCP server — auto-updates via npx -y on next Claude Code restart, but
# clear the cache so the next launch picks up the new version
npx -y @runtimescope/mcp-server@latest --version 2>/dev/null

# Plugin — pulls latest commands + skill files
claude plugin marketplace update runtimescope 2>&1 | tail -3
claude plugin update runtimescope@runtimescope 2>&1 | tail -3
```

If any of these fail, surface the error but continue with the project sweep — partial success is better than aborting.

## Step 4: Discover all projects on this machine

Two sources, in order:

**Primary**: ask the running collector via its PM API (this is what RuntimeScope's own dashboard uses):

```bash
curl -sS http://127.0.0.1:6768/api/pm/projects 2>/dev/null | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('\n'.join(p['path'] for p in d['data'] if p.get('path')))"
```

**Fallback** (if the collector isn't running): filesystem scan for `.runtimescope/config.json` files under `~`:

```bash
find ~ -maxdepth 6 -name "config.json" -path "*/.runtimescope/*" -not -path "*/node_modules/*" 2>/dev/null | \
  xargs -n1 dirname | xargs -n1 dirname
```

Filesystem scan is slower (5-30s depending on home size) — only use if the collector isn't reachable.

Result: a list of project directories. Print the count.

## Step 5: Update each project's RuntimeScope packages

For each project directory:

```bash
cd "$DIR"

# Detect installed @runtimescope/* and unscoped runtimescope packages
PACKAGES=$(cat package.json 2>/dev/null | python3 -c "
import json, sys
try:
    p = json.load(sys.stdin)
    deps = {**p.get('dependencies', {}), **p.get('devDependencies', {})}
    rs = [n for n in deps if n.startswith('@runtimescope/') or n == 'runtimescope']
    print(' '.join(rs))
except: pass
")

if [ -n "$PACKAGES" ]; then
  echo "→ $DIR ($PACKAGES)"
  # Pin everything to the same target version so framework packages and
  # base SDKs stay in lockstep
  for PKG in $PACKAGES; do
    npm install --save "$PKG@$TARGET" 2>&1 | tail -3
  done
fi

# Python: same project might also have a Python SDK install
if grep -q "^runtimescope" requirements.txt 2>/dev/null || grep -q "runtimescope" pyproject.toml 2>/dev/null; then
  pip install -U runtimescope 2>&1 | tail -2
fi
```

Skip directories that have no `@runtimescope/*` deps in `package.json` AND no Python install.

If a project hasn't been touched in 30+ days, ask before updating — it might be archived, and an unwanted lockfile change would be annoying.

## Step 6: Validate each updated project's config

For each project that got upgraded, verify the config is still valid:

```
get_project_config({ project_dir: "<path>" })
```

If a field went missing in the upgrade (rare — config schema is stable), call `setup_project` with the same dir — it's idempotent and will repair.

## Step 7: Report

```markdown
# RuntimeScope — Updated Across User

## User-level
- CLI:               [prev] → $TARGET
- Background service: ✓ restarted (pid: ...)
- MCP server:        auto-updates on next Claude Code restart
- Plugin:            [prev] → [current]

## Per-project (N projects detected)
| Project            | Packages                                 | Status |
|--------------------|------------------------------------------|--------|
| my-app             | @runtimescope/nextjs, sdk                | ✓ updated to $TARGET |
| backend            | @runtimescope/server-sdk                 | ✓ updated to $TARGET |
| python-api         | runtimescope (PyPI)                      | ✓ updated |
| legacy-thing       | @runtimescope/sdk @ 0.9.x                | ⚠ version locked, skipped |

## What's new in this release
[fetch from CHANGELOG via WebFetch on
 https://raw.githubusercontent.com/edwinlov3tt/runtimescope/main/CHANGELOG.md
 — summarise items affecting SDK users only]

## Action needed
- [ ] Restart Claude Code to pick up the updated MCP server + plugin
- [ ] Restart any running dev servers to load the new SDK
- [ ] [breaking-change checklist if applicable]
```

---

## Rules

- Update commands run in the user's existing shell — don't change directories outside the project being updated.
- If `npm install` would change a lockfile in a way the user didn't expect (major version jump), surface it and ask for confirmation.
- If a project pins a specific RuntimeScope version (`"@runtimescope/sdk": "0.9.3"` exact), respect it — skip with a "version-locked" note.
- The cross-project sweep should not run any of the user's project scripts (no `npm run anything`). Just install.
- If the collector goes down during the update (unlikely, but if `runtimescope service update` blips it), `/readyz` will return 503 briefly. Wait for it to come back before reporting success.

## Failure modes

- **Collector not running**: discovery falls back to filesystem; the per-project install still works because `npm` doesn't need the collector.
- **Network down**: every step that hits the npm registry will fail. Surface "no network" and bail cleanly.
- **No projects found**: print "✓ user-level updates done — no projects with RuntimeScope installed on this machine yet."
- **Project has unknown lock state** (Yarn 1, pnpm, bun, etc.): detect via lockfile and use the matching tool's `add @latest` command instead of npm install.
