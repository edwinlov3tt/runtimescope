/**
 * @runtimescope/nextjs/edge — edge-runtime SDK for Next.js middleware,
 * edge routes, and Cloudflare Workers.
 *
 * The Node.js SDK can't run here (no `fs`, no `http`, no long-lived
 * connections). This package delegates to the Workers SDK which uses
 * HTTP POST + `ctx.waitUntil()` instead.
 */
export {
  withRuntimeScope,
  scopeD1,
  scopeKV,
  scopeR2,
  track,
  addBreadcrumb,
  parseDsn,
  buildDsn,
} from '@runtimescope/workers-sdk';
export type {
  WorkersConfig,
  ParsedDsn,
} from '@runtimescope/workers-sdk';
