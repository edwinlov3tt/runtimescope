# RuntimeScope stress harness

A pre-push test suite that hammers RuntimeScope with realistic + adversarial
workloads and asserts the result. Designed to run in **<30 seconds** so it can
gate every push.

## Run it

```bash
npm run stress              # all 7 scenarios — ~20s
npm run stress:quick        # the 4 fast-path ones — ~7s
npm run stress -- crash     # run only scenarios matching "crash"
npm run stress -- --list    # list scenarios

# Pre-push gate: build + unit + stress, fail-fast
npm run prepush
```

Exit code 0 if all checks pass, non-zero otherwise — so it slots into a git
hook or CI step without ceremony.

## Scenarios

| Scenario              | Quick | What it stresses |
|-----------------------|:-----:|------------------|
| `flood-events`        | ✓     | 20 000 events through one session — accept rate, ring-buffer cap, backpressure |
| `concurrent-sessions` | ✓     | 100 parallel SDK handshakes × 50 events each — multi-tenant isolation, session-map fan-out |
| `pathological-events` | ✓     | 512 KB payloads, 40-deep nesting, Unicode hellscape, missing fields, NaN/Inf — collector survival |
| `auth-fuzz`           | ✓     | Garbage tokens, header-injection attempts, public-route exemptions, workspace-vs-admin gating |
| `crash-recovery`      |       | SIGKILL mid-flight, restart with same data dir, verify WAL replay populates SqliteStore |
| `memory-leak`         |       | 10 connect→flood→disconnect cycles, RSS sampling, growth bounded under 50% |
| `framework-smoke`     |       | Each shipped SDK (`server-sdk`, `workers-sdk`, `runtimescope` Python) sends a canary, asserts arrival |

## What the harness has already caught

- **Auth bypass**: workspace tokens were misclassified as admin when no global
  AuthManager was configured. The auth gate used `authManager.isAuthorized()`
  which returns `true` when AuthManager is disabled — meaning every workspace
  token passed the `isGlobal` check. Fix: use `validate()` instead, which
  returns null when disabled. ([http-server.ts](../packages/collector/src/http-server.ts))
- **Workers SDK config naming inconsistency**: `httpEndpoint` (workers-sdk) vs
  `endpoint` (browser-sdk, server-sdk). The stress test surfaced this by
  silently posting to the wrong port.
- **Crash-recovery query gap**: post-crash queries can't filter by `project_id`
  because the in-memory session→project map isn't rehydrated. Workaround:
  query without filter, or by `session_id`.

## Layout

```
stress/
├── cli.ts                       # orchestrator
├── tsconfig.json
├── utils/
│   ├── spawn-collector.ts       # boots a fresh standalone with isolated $HOME
│   ├── sdk-driver.ts            # thin WS client — direct wire-protocol speaker
│   └── assert.ts                # CheckCollector + scenario wrapper
└── scenarios/
    ├── flood-events.ts
    ├── concurrent-sessions.ts
    ├── pathological-events.ts
    ├── auth-fuzz.ts
    ├── crash-recovery.ts
    ├── memory-leak.ts
    └── framework-smoke.ts
```

Each scenario:
1. Spawns its own fresh standalone collector on a random port pair (no shared
   state with other scenarios).
2. Runs assertions that are **specific** — every check has an actionable
   "actual=X, expected=Y" message on failure.
3. Cleans up in `finally` so a thrown assertion doesn't leak processes.

## Adding a scenario

Drop a `stress/scenarios/<name>.ts` exporting an async function that takes a
`CheckCollector` and runs assertions. Then register it in `cli.ts`:

```ts
import { yourScenario } from './scenarios/your-scenario.js';

const SCENARIOS: ScenarioDef[] = [
  // ...existing scenarios
  { name: 'your-scenario', body: yourScenario, inQuick: true },
];
```

Mark `inQuick: true` only if it runs in under ~3 seconds — the quick suite is
meant to be cheap enough to gate every push.

## CI / pre-push hook

Add this to `.git/hooks/pre-push` (or via husky):

```bash
#!/usr/bin/env bash
set -e
npm run prepush
```

Or wire it into CI:

```yaml
- name: Stress
  run: npm run stress
```

## Docker (future)

The current scenarios all run in-process so Docker isn't required. When we
add scenarios that need framework runtimes the host doesn't have (e.g. real
Cloudflare Workers via Wrangler, Next.js production builds), those will go
under `stress/docker/<scenario>/Dockerfile` and the harness will detect
Docker availability and skip with a clear message if it's not present.
