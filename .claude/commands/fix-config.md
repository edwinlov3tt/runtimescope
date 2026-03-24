---
description: Check and fix .runtimescope/config.json — scaffold if missing, repair if incomplete
allowed-tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "mcp__runtimescope__get_project_config", "mcp__runtimescope__setup_project"]
---

# Fix Config — Ensure .runtimescope/ is set up correctly

Check if the current project has a valid `.runtimescope/config.json`. If not, create it. If incomplete, fix it.

**IMPORTANT**: Do NOT restart, kill, or modify any running processes. Only fix the config file.

---

## Step 1: Check current state

```bash
# Does .runtimescope/config.json exist?
cat .runtimescope/config.json 2>/dev/null || echo "MISSING"
```

If `MISSING`, go to Step 2.
If it exists, go to Step 3 to validate.

## Step 2: Create config from scratch

### 2.1 Detect app name and framework
```bash
# App name from package.json
cat package.json 2>/dev/null | grep '"name"' | head -1 | sed 's/.*"name".*"\(.*\)".*/\1/'

# Framework detection
cat package.json 2>/dev/null | grep -E '"(next|react|vue|svelte|angular|nuxt)"' | head -3
ls wrangler.toml wrangler.jsonc 2>/dev/null
ls requirements.txt pyproject.toml Gemfile composer.json 2>/dev/null
```

### 2.2 Find existing SDK init calls
```bash
grep -rn "RuntimeScope\.\(init\|connect\)" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.html" . 2>/dev/null | grep -v node_modules | grep -v dist/
```

### 2.3 Try `setup_project` first (if available)
```
setup_project({ project_dir: "<absolute path to project root>" })
```

If `setup_project` is not available, manually scaffold:

### 2.4 Manual scaffold

Create the directory and config:

```bash
mkdir -p .runtimescope
```

Then write `.runtimescope/config.json` with this structure (fill in detected values):

```json
{
  "projectId": "proj_<generate 12 random alphanumeric chars>",
  "appName": "<detected app name>",
  "sdks": [
    {
      "type": "<browser|server|workers>",
      "entryFile": "<path where RuntimeScope.init is called>",
      "framework": "<detected framework>"
    }
  ],
  "capture": {
    "network": true,
    "console": true,
    "xhr": true,
    "performance": true,
    "renders": false,
    "body": false
  }
}
```

Generate the projectId:
```bash
echo "proj_$(cat /dev/urandom | LC_ALL=C tr -dc 'a-z0-9' | head -c 12)"
```

### 2.5 Add projectId to existing SDK init

If the SDK is already installed but missing `projectId`, find the init call and add it:

```bash
grep -rn "RuntimeScope\.\(init\|connect\)" --include="*.ts" --include="*.tsx" --include="*.js" . 2>/dev/null | grep -v node_modules | grep -v dist/
```

Add `projectId: '<the generated projectId>',` to the init config object.

### 2.6 Add to .gitignore (only the sensitive parts)

```bash
# .runtimescope/config.json is safe to commit (no secrets)
# But add .env pattern if it exists
grep -q "\.runtimescope/\.env" .gitignore 2>/dev/null || echo ".runtimescope/.env" >> .gitignore
```

## Step 3: Validate existing config

If `.runtimescope/config.json` exists, check for:

1. **Has `projectId`?** — If missing, generate one and add it
2. **Has `appName`?** — If missing, detect from package.json
3. **Has `sdks` array?** — If missing, detect from codebase
4. **Has `capture` object?** — If missing, add defaults
5. **Does SDK init have matching `projectId`?** — If not, update the init call

Report what was found and fixed.

## Step 4: Report

```markdown
# Config Check Complete

**Project**: [name]
**Project ID**: [projectId]
**Config**: .runtimescope/config.json [created/validated/fixed]

| Check | Status |
|-------|--------|
| Config file exists | ✅/❌ → created |
| projectId present | ✅/❌ → generated |
| appName present | ✅/❌ → detected |
| SDKs listed | ✅/❌ → detected |
| SDK init has projectId | ✅/❌ → updated |

**Next**: Restart your app to pick up the new projectId.
```
