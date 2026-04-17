/**
 * @runtimescope/sveltekit/server — server-side SDK for SvelteKit apps.
 * Use this in `hooks.server.ts` or any `+page.server.ts` load function.
 */
export { RuntimeScope, parseDsn, buildDsn } from '@runtimescope/server-sdk';
export type { ParsedDsn, ServerSdkConfig } from '@runtimescope/server-sdk';

import { RuntimeScope } from '@runtimescope/server-sdk';

/**
 * Initialize RuntimeScope in a SvelteKit server hook.
 *
 * Reads the DSN from `process.env.RUNTIMESCOPE_DSN`. Safe to call multiple
 * times — subsequent calls are no-ops.
 *
 * @example
 * // src/hooks.server.ts
 * import { initServer } from '@runtimescope/sveltekit/server';
 * initServer();
 *
 * export const handle = async ({ event, resolve }) => resolve(event);
 */
export function initServer(
  config: Parameters<typeof RuntimeScope.connect>[0] = {},
): void {
  if (typeof process === 'undefined') return;
  RuntimeScope.connect({
    captureConsole: true,
    captureHttp: true,
    captureErrors: true,
    capturePerformance: true,
    ...config,
  });
}

type Handle = (input: {
  event: { request: Request; [key: string]: unknown };
  resolve: (event: unknown) => Promise<Response>;
}) => Promise<Response>;

/**
 * Compose with SvelteKit's `handle` hook to wrap every request.
 * Errors thrown inside the handler are re-thrown after being logged.
 *
 * @example
 * import { sequence } from '@sveltejs/kit/hooks';
 * import { handleWithRuntimeScope } from '@runtimescope/sveltekit/server';
 *
 * export const handle = sequence(handleWithRuntimeScope, myOtherHandle);
 */
export const handleWithRuntimeScope: Handle = async ({ event, resolve }) => {
  try {
    return await resolve(event);
  } catch (err) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[RuntimeScope] handle error:', err);
    }
    throw err;
  }
};
