/**
 * @runtimescope/remix/client — browser-side SDK for Remix apps.
 * Use this in `entry.client.tsx`.
 */
export { RuntimeScope, parseDsn, buildDsn } from '@runtimescope/sdk';
export type { ParsedDsn, RuntimeScopeConfig } from '@runtimescope/sdk';

import { RuntimeScope } from '@runtimescope/sdk';

/**
 * Initialize RuntimeScope in a Remix client entry.
 *
 * Reads `window.ENV.RUNTIMESCOPE_DSN` first (Remix pattern for exposing env
 * vars), falls back to the generic `RUNTIMESCOPE_DSN` global if present.
 *
 * @example
 * // app/entry.client.tsx
 * import { initClient } from '@runtimescope/remix/client';
 * initClient();
 * // ...existing hydrateRoot call
 */
export function initClient(
  config: Parameters<typeof RuntimeScope.init>[0] = {},
): void {
  if (typeof window === 'undefined') return;
  if (RuntimeScope.isConnected) return;

  const win = window as unknown as {
    ENV?: { RUNTIMESCOPE_DSN?: string };
    RUNTIMESCOPE_DSN?: string;
  };
  const dsn = config.dsn ?? win.ENV?.RUNTIMESCOPE_DSN ?? win.RUNTIMESCOPE_DSN;

  RuntimeScope.init({ ...config, dsn });
}
