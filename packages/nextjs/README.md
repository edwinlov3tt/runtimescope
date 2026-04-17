# @runtimescope/nextjs

One install, works in every Next.js runtime — client, server, and edge.

```bash
npm install @runtimescope/nextjs
```

## Setup

### 1. Set your DSN

```bash
# .env.local
RUNTIMESCOPE_DSN=runtimescope://proj_xxx@localhost:6768/my-app
NEXT_PUBLIC_RUNTIMESCOPE_DSN=runtimescope://proj_xxx@localhost:6768/my-app
```

### 2. Wire up the server runtime

```typescript
// instrumentation.ts
export { register } from '@runtimescope/nextjs';
```

That's it for the server side. The `register()` function auto-runs when Next.js boots, reads `RUNTIMESCOPE_DSN`, and enables sensible defaults (console, HTTP, errors, performance).

### 3. Wire up the client runtime (App Router)

```typescript
// app/providers.tsx
'use client';
import { useEffect } from 'react';
import { initClient } from '@runtimescope/nextjs/client';

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => { initClient(); }, []);
  return <>{children}</>;
}
```

```typescript
// app/layout.tsx
import { Providers } from './providers';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

### 4. (Optional) Edge runtime

```typescript
// middleware.ts or edge route
import { track } from '@runtimescope/nextjs/edge';

export async function middleware(req: NextRequest) {
  track('page_view', { path: req.nextUrl.pathname });
  return NextResponse.next();
}
```

## What gets captured

| Runtime | Automatic | Opt-in |
|---------|-----------|--------|
| **Client** | network, console, errors, renders, Web Vitals, navigation | click tracking, state |
| **Server** | console, errors, HTTP in/out, performance | DB queries (call `instrumentPrisma(prisma)` etc.) |
| **Edge** | incoming requests, console | — |

## Production behavior

The SDK is **completely inert** in production if `RUNTIMESCOPE_DSN` / `NEXT_PUBLIC_RUNTIMESCOPE_DSN` is not set. No WebSocket errors, no monkey-patching, zero overhead. Safe to ship to Vercel / Cloudflare / any host.

## Subpath exports

| Import | Use when |
|--------|----------|
| `@runtimescope/nextjs` | `instrumentation.ts`, shared utilities |
| `@runtimescope/nextjs/client` | Client Components, browser-only code |
| `@runtimescope/nextjs/server` | Route handlers, Server Components, server actions |
| `@runtimescope/nextjs/edge` | `middleware.ts`, edge routes |

Never import `/server` inside a Client Component — Next will bundle Node APIs into the browser and the build will fail.

## License

MIT
