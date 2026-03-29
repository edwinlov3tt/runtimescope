// ============================================================
// DSN parser for @runtimescope/server-sdk
// Format: runtimescope://proj_abc123@localhost:9091/my-app
// Duplicated from browser SDK (server-sdk is zero-dep)
// ============================================================

export interface ParsedDsn {
  projectId: string;
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
  const url = new URL(dsn.replace(/^runtimescopes?:\/\//, 'http://'));
  const projectId = url.username;
  if (!projectId || !projectId.startsWith('proj_')) {
    throw new Error(`Invalid RuntimeScope DSN: missing projectId (expected proj_xxx@host)`);
  }
  const host = url.hostname;
  const httpPort = url.port ? parseInt(url.port) : 9091;
  const wsPort = httpPort - 1;
  const appName = url.pathname.replace(/^\//, '') || undefined;
  const wsProto = tls ? 'wss' : 'ws';
  const httpProto = tls ? 'https' : 'http';
  return { projectId, wsEndpoint: `${wsProto}://${host}:${wsPort}`, httpEndpoint: `${httpProto}://${host}:${httpPort}`, appName, tls };
}

export function buildDsn(opts: { projectId: string; host?: string; port?: number; appName?: string; tls?: boolean }): string {
  const proto = opts.tls ? 'runtimescopes' : 'runtimescope';
  const host = opts.host ?? 'localhost';
  const port = opts.port ?? 9091;
  const path = opts.appName ? `/${opts.appName}` : '';
  return `${proto}://${opts.projectId}@${host}:${port}${path}`;
}
