# @runtimescope/remix

One install for full-stack Remix apps — browser + server in a single package.

```bash
npm install @runtimescope/remix
```

## Setup

### 1. Environment

```bash
# .env
RUNTIMESCOPE_DSN=runtimescope://proj_xxx@localhost:6768/my-app
```

### 2. Client entry

```typescript
// app/entry.client.tsx
import { initClient } from '@runtimescope/remix/client';
initClient();

// ...existing RemixBrowser hydrateRoot call
```

Expose the DSN to the browser via `root.tsx` loader (standard Remix pattern — see the Remix docs on "Exposing Environment Variables" for the full setup).

### 3. Server entry

```typescript
// app/entry.server.tsx
import { initServer } from '@runtimescope/remix/server';
initServer();

// ...existing handleRequest export
```

### 4. (Optional) Wrap loaders/actions

```typescript
import { withRuntimeScope } from '@runtimescope/remix/server';

export const loader = withRuntimeScope(async ({ request }) => {
  return json(await fetchData());
});
```

## Subpath Exports

| Import | Use in |
|--------|--------|
| `@runtimescope/remix` | Shared utilities, types |
| `@runtimescope/remix/client` | `entry.client.tsx` |
| `@runtimescope/remix/server` | `entry.server.tsx`, loaders, actions |

Never import `/server` from a component file — Remix bundles the server code into the browser and it'll break.

## Production Safety

If `RUNTIMESCOPE_DSN` is unset, the SDK is completely inert — no connection attempts, no errors, zero overhead.

## License

MIT
