# @runtimescope/sveltekit

One install for SvelteKit apps — hooks.client.ts + hooks.server.ts covered.

```bash
npm install @runtimescope/sveltekit
```

## Setup

### 1. Environment

```bash
# .env
RUNTIMESCOPE_DSN=runtimescope://proj_xxx@localhost:9091/my-app
PUBLIC_RUNTIMESCOPE_DSN=runtimescope://proj_xxx@localhost:9091/my-app
```

SvelteKit exposes `PUBLIC_*` env vars to the browser automatically.

### 2. Client hook

```typescript
// src/hooks.client.ts
import { initClient } from '@runtimescope/sveltekit/client';
initClient();
```

### 3. Server hook

```typescript
// src/hooks.server.ts
import { initServer } from '@runtimescope/sveltekit/server';
initServer();

export const handle = async ({ event, resolve }) => resolve(event);
```

### 4. (Optional) Auto-wrap every request

```typescript
import { sequence } from '@sveltejs/kit/hooks';
import { handleWithRuntimeScope } from '@runtimescope/sveltekit/server';

export const handle = sequence(handleWithRuntimeScope, myOtherHandle);
```

## Subpath Exports

| Import | Use in |
|--------|--------|
| `@runtimescope/sveltekit` | Shared utilities |
| `@runtimescope/sveltekit/client` | `hooks.client.ts`, browser-only files |
| `@runtimescope/sveltekit/server` | `hooks.server.ts`, `+*.server.ts`, endpoints |

## Production Safety

If the DSN env vars are unset, the SDK is completely inert.

## License

MIT
