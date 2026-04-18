/**
 * DSN (Data Source Name) parser for RuntimeScope workers SDK.
 *
 * Format: runtimescope://proj_abc123[:token]@localhost:6768/my-app
 *   - runtimescope:// or runtimescopes:// (TLS)
 *   - projectId before @  (or before : if a token is included)
 *   - optional bearer token between : and @  (workspace-scoped API key)
 *   - host:port after @ (HTTP API port, default 6768)
 *   - WS port = HTTP port - 1 (so 6768 → ws on 6767)
 *   - Optional /appName path
 */

export interface ParsedDsn {
  projectId: string;
  authToken?: string;
  wsEndpoint: string;
  httpEndpoint: string;
  appName?: string;
  tls: boolean;
}

export function parseDsn(dsn: string): ParsedDsn {
  const tls = dsn.startsWith('runtimescopes://');
  if (!dsn.startsWith('runtimescope://') && !tls) {
    throw new Error(`Invalid RuntimeScope DSN: must start with runtimescope:// or runtimescopes://`);
  }
  // Replace protocol for URL parsing
  const url = new URL(dsn.replace(/^runtimescopes?:\/\//, 'http://'));
  const projectId = url.username;
  if (!projectId || !projectId.startsWith('proj_')) {
    throw new Error(`Invalid RuntimeScope DSN: missing projectId (expected proj_xxx@host)`);
  }
  const authToken = url.password ? decodeURIComponent(url.password) : undefined;
  const host = url.hostname;
  const httpPort = url.port ? parseInt(url.port) : 6768;
  const wsPort = httpPort - 1;
  const appName = url.pathname.replace(/^\//, '') || undefined;
  const wsProto = tls ? 'wss' : 'ws';
  const httpProto = tls ? 'https' : 'http';
  return {
    projectId,
    authToken,
    wsEndpoint: `${wsProto}://${host}:${wsPort}`,
    httpEndpoint: `${httpProto}://${host}:${httpPort}`,
    appName,
    tls,
  };
}

export function buildDsn(opts: {
  projectId: string;
  authToken?: string;
  host?: string;
  port?: number;
  appName?: string;
  tls?: boolean;
}): string {
  const proto = opts.tls ? 'runtimescopes' : 'runtimescope';
  const host = opts.host ?? 'localhost';
  const port = opts.port ?? 6768;
  const path = opts.appName ? `/${opts.appName}` : '';
  const auth = opts.authToken ? `:${encodeURIComponent(opts.authToken)}` : '';
  return `${proto}://${opts.projectId}${auth}@${host}:${port}${path}`;
}
