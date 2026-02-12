---
description: Check local dev environment, find/generate setup instructions, and start the servers
allowed-tools: ["Read", "Write", "Edit", "Bash", "Grep"]
---

# Dev — Check Environment & Start Servers

Check if local development is ready, find or generate setup instructions, then start the application.

---

## Phase 1: Find Existing Instructions

Check for existing setup docs and scripts:

```bash
echo "=== Existing Dev Docs ==="
ls -la .claude/docs/LOCAL_DEV.md 2>/dev/null
cat README.md 2>/dev/null | grep -A20 -i "getting started\|quick start\|development\|setup\|running"

echo "=== Existing Scripts ==="
cat package.json 2>/dev/null | grep -A30 '"scripts"'
ls -la scripts/*.sh bin/*.sh Makefile 2>/dev/null
cat docker-compose.yml docker-compose.yaml 2>/dev/null | head -5
```

## Phase 2: Environment Check

### 2.1 Runtime
```bash
node --version 2>/dev/null || echo "Node.js: NOT FOUND"
python3 --version 2>/dev/null || echo "Python: NOT FOUND"
pnpm --version 2>/dev/null || echo "pnpm: NOT FOUND"
npm --version 2>/dev/null || echo "npm: NOT FOUND"
bun --version 2>/dev/null || echo "Bun: NOT FOUND"
```

### 2.2 Package Manager & Dependencies
```bash
# Detect package manager
for f in pnpm-lock.yaml yarn.lock package-lock.json bun.lockb; do [ -f "$f" ] && echo "Package Manager: $f"; done

# Check if deps are installed
if [ -d "node_modules" ]; then
  echo "node_modules: ✅ ($(ls node_modules | wc -l) packages)"
else
  echo "node_modules: ❌ MISSING"
fi

# Python
if [ -d ".venv" ] || [ -d "venv" ]; then
  echo "Python venv: ✅"
elif [ -f "requirements.txt" ] || [ -f "pyproject.toml" ]; then
  echo "Python venv: ❌ MISSING (Python project detected)"
fi
```

### 2.3 Environment Variables
```bash
echo "=== Env Files ==="
ls -la .env .env.local .env.development .env.example 2>/dev/null

echo "=== Required Vars ==="
grep -rh --include="*.ts" --include="*.tsx" --include="*.js" \
  -oE "process\.env\.[A-Z_]+" . 2>/dev/null | sort -u | grep -v node_modules

echo "=== Missing Vars ==="
# Compare required vs what's in .env
if [ -f ".env" ]; then
  grep -rh --include="*.ts" --include="*.tsx" --include="*.js" \
    -oE "process\.env\.([A-Z_]+)" . 2>/dev/null | sort -u | sed 's/process.env.//' | while read var; do
    grep -q "^$var=" .env 2>/dev/null || echo "Missing: $var"
  done
fi
```

### 2.4 Services
```bash
# Database
pg_isready 2>/dev/null && echo "PostgreSQL: ✅" || echo "PostgreSQL: not detected"
redis-cli ping 2>/dev/null && echo "Redis: ✅" || echo "Redis: not detected"
docker info >/dev/null 2>&1 && echo "Docker: ✅" || echo "Docker: not running"
```

### 2.5 Port Availability
```bash
# Check common dev ports
for port in 3000 3001 4000 5000 5173 8000 8080 8787; do
  lsof -i :$port >/dev/null 2>&1 && echo "Port $port: ⚠️ IN USE ($(lsof -i :$port | tail -1 | awk '{print $1}'))" || true
done
```

### 2.6 CORS Check
```bash
grep -rn "cors\|CORS\|Access-Control" --include="*.ts" --include="*.js" --include="*.py" . 2>/dev/null | grep -v node_modules | head -10
```

---

## Phase 3: Fix Blockers

### Install Missing Dependencies
If node_modules is missing:
```bash
# Use detected package manager
pnpm install || npm install || yarn install || bun install
```

### Start Required Services
If docker-compose exists and services are needed:
```bash
docker compose up -d 2>/dev/null
```

### Copy Env Example
If `.env` is missing but `.env.example` exists:
```bash
cp .env.example .env
echo "⚠️ Created .env from example — fill in actual values"
```

---

## Phase 4: Start the Application

### Detect Start Commands
From package.json scripts, look for:
- `dev` — most common
- `dev:frontend` + `dev:backend` — split frontend/backend
- `start` — production start
- `serve` — alternative dev
- Custom scripts from README or LOCAL_DEV.md

### Start Servers
Run the detected dev command(s). If multiple services (frontend + backend + workers):

```bash
# Example: Run all needed processes
# Adapt to what's actually in the project
pnpm dev
```

If the project has separate frontend/backend, note both URLs.

### Report Running Services
```markdown
## Servers Started

| Service | URL | Command |
|---------|-----|---------|
| Frontend | http://localhost:3000 | `pnpm dev` |
| Backend | http://localhost:8000 | `pnpm dev:api` |
```

---

## Phase 5: Update Documentation

### Create/Update LOCAL_DEV.md

Create or update `.claude/docs/LOCAL_DEV.md`:

```markdown
# Local Development Setup

**Last verified**: [DATE]

## Quick Start
```bash
[install command]
[env setup command]
[start command]
```

## Prerequisites
| Tool | Required Version | Install |
|------|-----------------|---------|
| Node.js | >=18 | https://nodejs.org |

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `VAR_NAME` | Yes | [purpose] |

## Running
| Service | URL | Command |
|---------|-----|---------|
| Frontend | http://localhost:3000 | `pnpm dev` |

## Common Issues
### Port Conflict
```bash
lsof -i :[port]
kill -9 [PID]
```
```

### Update CLAUDE.md

Add or update the local dev section in CLAUDE.md:

```markdown
## Local Development
[start command]
- Frontend: http://localhost:[port]
- Backend: http://localhost:[port]
Full setup: `.claude/docs/LOCAL_DEV.md`
```

---

## Phase 6: Output

```markdown
# Dev Environment

**Status**: ✅ Ready / ⚠️ Issues / ❌ Blocked

## Environment
| Check | Status |
|-------|--------|
| Runtime | ✅ Node 20.x |
| Dependencies | ✅ Installed |
| Env vars | ⚠️ Missing: API_KEY |
| Services | ✅ Docker running |

## Servers
| Service | URL | Status |
|---------|-----|--------|
| Frontend | http://localhost:3000 | 🟢 Running |
| Backend | http://localhost:8000 | 🟢 Running |

## Issues Found
[Any problems encountered and how they were handled]

---

Docs updated: `.claude/docs/LOCAL_DEV.md`
```
