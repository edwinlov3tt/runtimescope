/**
 * @runtimescope/nextjs — the main entry.
 *
 * Next.js apps span three runtimes (browser, Node server, edge) and each
 * needs a different SDK. Import from the subpath that matches your context:
 *
 * - `@runtimescope/nextjs/client` — Client Components, browser-only code
 * - `@runtimescope/nextjs/server` — instrumentation.ts, route handlers, Server Components
 * - `@runtimescope/nextjs/edge` — middleware.ts, edge runtime routes
 *
 * This root entry re-exports only the shared utilities (DSN helpers, types).
 * Importing SDK classes from here would bundle all three runtimes into every
 * runtime, breaking Next's build. Always use the subpath imports — including
 * `register` from `@runtimescope/nextjs/server` (do not import it from the root,
 * because that drags `@runtimescope/server-sdk` into edge and client bundles).
 */
export { parseDsn, buildDsn } from '@runtimescope/sdk';
export type { ParsedDsn } from '@runtimescope/sdk';
