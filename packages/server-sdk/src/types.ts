// Types mirroring collector's types for the server SDK

export type DatabaseOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';

export type DatabaseSource =
  | 'prisma'
  | 'drizzle'
  | 'knex'
  | 'pg'
  | 'mysql2'
  | 'better-sqlite3'
  | 'generic';

export interface DatabaseEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: 'database';
  query: string;
  normalizedQuery: string;
  duration: number;
  rowsReturned?: number;
  rowsAffected?: number;
  tablesAccessed: string[];
  operation: DatabaseOperation;
  source: DatabaseSource;
  stackTrace?: string;
  label?: string;
  error?: string;
  params?: string;
}

// --- Console Events (mirrors collector's ConsoleEvent) ---

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug' | 'trace';

export interface ConsoleEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: 'console';
  level: ConsoleLevel;
  message: string;
  args: unknown[];
  stackTrace?: string;
  sourceFile?: string;
}

// --- Network Events (mirrors collector's NetworkEvent) ---

export interface GraphQLOperation {
  type: 'query' | 'mutation' | 'subscription';
  name: string;
}

export interface NetworkEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: 'network';
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodySize: number;
  responseBodySize: number;
  duration: number;
  ttfb: number;
  graphqlOperation?: GraphQLOperation;
  requestBody?: string;
  responseBody?: string;
  errorPhase?: 'error' | 'abort' | 'timeout';
  errorMessage?: string;
  source?: 'fetch' | 'xhr' | 'node-http' | 'node-https';
}

// --- Performance Events (server-side Node.js metrics) ---

export type ServerMetricName =
  | 'memory.rss'
  | 'memory.heapUsed'
  | 'memory.heapTotal'
  | 'memory.external'
  | 'eventloop.lag.mean'
  | 'eventloop.lag.p99'
  | 'eventloop.lag.max'
  | 'gc.pause.major'
  | 'gc.pause.minor'
  | 'cpu.user'
  | 'cpu.system'
  | 'handles.active'
  | 'requests.active';

export type MetricUnit = 'bytes' | 'ms' | 'percent' | 'count';

export interface PerformanceEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: 'performance';
  metricName: ServerMetricName;
  value: number;
  unit: MetricUnit;
}

// --- Union of all server-SDK event types ---

export type ServerRuntimeEvent = DatabaseEvent | ConsoleEvent | NetworkEvent | PerformanceEvent;

// --- Configuration ---

export interface ServerSdkConfig {
  serverUrl?: string;
  /** Alias for serverUrl — matches the browser SDK's config */
  endpoint?: string;
  appName?: string;
  sessionId?: string;
  projectId?: string;
  /** API key for authenticated connections to the collector */
  authToken?: string;
  captureStackTraces?: boolean;
  redactParams?: boolean;
  maxQueryLength?: number;
  captureConsole?: boolean;
  captureErrors?: boolean;
  captureHttp?: boolean;
  captureBody?: boolean;
  maxBodySize?: number;
  redactHeaders?: string[];
  beforeSend?: (event: ServerRuntimeEvent) => ServerRuntimeEvent | null;
  // Performance metrics
  capturePerformance?: boolean;
  performanceInterval?: number;
  performanceMetrics?: ServerMetricName[];
  // Sampling & rate limiting
  sampleRate?: number;
  maxEventsPerSecond?: number;
  maxQueueSize?: number;
  // Transport
  /** Transport type: 'ws' (WebSocket, default) or 'http' (HTTP POST for serverless) */
  transport?: 'ws' | 'http';
  /** HTTP endpoint URL for HTTP transport (e.g., 'http://collector:9091/api/events') */
  httpEndpoint?: string;
  /** HTTP batch flush interval in ms (default: 1000) */
  httpFlushIntervalMs?: number;
}

export interface WSMessage {
  type: 'event' | 'handshake' | 'heartbeat';
  payload: unknown;
  timestamp: number;
  sessionId: string;
}
