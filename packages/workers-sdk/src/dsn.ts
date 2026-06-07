/**
 * DSN (Data Source Name) parser for RuntimeScope workers SDK.
 *
 * Format: runtimescope://proj_abc123[:token]@localhost:6768/my-app
 *   - runtimescope:// or runtimescopes:// (TLS)
 *   - projectId before @  (or before : if a token is included)
 *   - optional bearer token between : and @  (workspace-scoped API key)
 *   - host[:port] after @ — explicit port → HTTP there + WS on port-1; no port
 *     + TLS → single 443 domain (wss + https share it, the proxy splits the
 *     upgrade); no port + plaintext → local 6768 / 6767
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
  // Endpoint resolution:
  //  - explicit port → HTTP on it, WS on port-1 (local/dev: 6768 → 6767).
  //  - no port + TLS → single HTTPS domain on 443; a reverse proxy/tunnel splits
  //    the WS upgrade to the collector's WS port, so wss + https share host:443
  //    (the hosted default, e.g. runtimescopes://proj_xxx@collector.example.com).
  //  - no port + plaintext → the local collector defaults (6768 / 6767).
  let httpPort: number;
  let wsPort: number;
  if (url.port) {
    httpPort = parseInt(url.port);
    wsPort = httpPort - 1;
  } else if (tls) {
    httpPort = 443;
    wsPort = 443;
  } else {
    httpPort = 6768;
    wsPort = 6767;
  }
  const appName = url.pathname.replace(/^\//, '') || undefined;
  const wsProto = tls ? 'wss' : 'ws';
  const httpProto = tls ? 'https' : 'http';
  // Omit the port when it's the scheme default (443) so a single-domain TLS DSN
  // resolves to a clean wss://host / https://host.
  const wsEndpoint = tls && wsPort === 443 ? `${wsProto}://${host}` : `${wsProto}://${host}:${wsPort}`;
  const httpEndpoint = tls && httpPort === 443 ? `${httpProto}://${host}` : `${httpProto}://${host}:${httpPort}`;
  return {
    projectId,
    authToken,
    wsEndpoint,
    httpEndpoint,
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
  // Omit the port for a TLS DSN with no explicit port → single-443 domain.
  const portPart = opts.port ? `:${opts.port}` : opts.tls ? '' : ':6768';
  const path = opts.appName ? `/${opts.appName}` : '';
  const auth = opts.authToken ? `:${encodeURIComponent(opts.authToken)}` : '';
  return `${proto}://${opts.projectId}${auth}@${host}${portPart}${path}`;
}
