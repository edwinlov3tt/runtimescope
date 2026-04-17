/**
 * @runtimescope/nextjs/client — browser-side SDK for Next.js apps.
 *
 * Use this in Client Components or client-only entry points.
 * Re-exports the browser SDK as-is.
 */
export { RuntimeScope, parseDsn, buildDsn } from '@runtimescope/sdk';
export type { ParsedDsn, RuntimeScopeConfig } from '@runtimescope/sdk';

import { RuntimeScope } from '@runtimescope/sdk';

/**
 * Initialize RuntimeScope in a Next.js client component.
 *
 * Reads DSN from `NEXT_PUBLIC_RUNTIMESCOPE_DSN` if no DSN is passed.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * @example
 * // app/layout.tsx
 * 'use client';
 * import { initClient } from '@runtimescope/nextjs/client';
 *
 * if (typeof window !== 'undefined') initClient();
 */
export function initClient(
  config: Parameters<typeof RuntimeScope.init>[0] = {},
): void {
  if (typeof window === 'undefined') return;
  if (RuntimeScope.isConnected) return;

  const dsn =
    config.dsn ??
    (typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_RUNTIMESCOPE_DSN
      : undefined);

  RuntimeScope.init({ ...config, dsn });
}
