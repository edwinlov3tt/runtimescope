/**
 * @runtimescope/sveltekit/client — browser-side SDK for SvelteKit apps.
 * Use this in `hooks.client.ts`.
 */
export { RuntimeScope, parseDsn, buildDsn } from '@runtimescope/sdk';
export type { ParsedDsn, RuntimeScopeConfig } from '@runtimescope/sdk';

import { RuntimeScope } from '@runtimescope/sdk';

/**
 * Initialize RuntimeScope in a SvelteKit client hook.
 *
 * Reads the DSN from `import.meta.env.PUBLIC_RUNTIMESCOPE_DSN` if no DSN
 * is passed. Safe to call multiple times — subsequent calls are no-ops.
 *
 * @example
 * // src/hooks.client.ts
 * import { initClient } from '@runtimescope/sveltekit/client';
 * initClient();
 */
export function initClient(
  config: Parameters<typeof RuntimeScope.init>[0] = {},
): void {
  if (typeof window === 'undefined') return;
  if (RuntimeScope.isConnected) return;

  // SvelteKit exposes PUBLIC_* env vars on the client via import.meta.env
  const env = (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string> }).env) || {};
  const dsn = config.dsn ?? env.PUBLIC_RUNTIMESCOPE_DSN;

  RuntimeScope.init({ ...config, dsn });
}
