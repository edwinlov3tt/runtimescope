// ============================================================
// Types for @runtimescope/workers-sdk
// Mirrors collector event types (per D004: types duplicated, SDK stays dep-free)
// ============================================================

// --- Event Types ---

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
  source?: 'browser' | 'server' | 'workers';
}

export type DatabaseOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';

export type DatabaseSource =
  | 'd1'
  | 'kv'
  | 'r2'
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
  error?: string;
  label?: string;
}

export interface NetworkEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: 'network';
  url: string;
  method: string;
  status: number;
  duration: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodySize: number;
  responseBodySize: number;
  ttfb: number;
  source: 'workers';
  direction: 'incoming';
  /** Cloudflare-specific properties from request.cf */
  cfProperties?: {
    colo?: string;
    country?: string;
    city?: string;
    region?: string;
    asn?: number;
    httpProtocol?: string;
    tlsVersion?: string;
  };
  errorMessage?: string;
}

// --- Custom Events (user-defined business/product events) ---

export interface CustomEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: 'custom';
  name: string;
  properties?: Record<string, unknown>;
}

// --- UI Interaction Events (manual breadcrumbs from Workers) ---

export type UIInteractionAction = 'breadcrumb';

export interface UIInteractionEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: 'ui';
  action: UIInteractionAction;
  target: string;
  text?: string;
  data?: Record<string, unknown>;
}

export type WorkersRuntimeEvent = ConsoleEvent | DatabaseEvent | NetworkEvent | CustomEvent | UIInteractionEvent;

// --- Configuration ---

export interface WorkersConfig {
  /** DSN connection string (e.g., runtimescope://proj_abc123@localhost:6768/my-worker) */
  dsn?: string;
  /** App name — identifies this worker in session info */
  appName: string;
  /** Project ID — links this worker to a PM project */
  projectId?: string;
  /** HTTP endpoint for collector (default: http://localhost:6768/api/events) */
  httpEndpoint?: string;
  /** Auth token for authenticated collectors */
  authToken?: string;
  /** Probabilistic sample rate: 0.0–1.0 (default: 1.0 = keep all) */
  sampleRate?: number;
  /** Max events queued per request before dropping (default: 500) */
  maxQueueSize?: number;
  /** Capture console.log/warn/error (default: true) */
  captureConsole?: boolean;
  /** Include request/response headers in network events (default: false) */
  captureHeaders?: boolean;
  /** Headers to redact from network events (default: ['authorization', 'cookie', 'set-cookie']) */
  redactHeaders?: string[];
  /** Filter/modify events before sending. Return null to drop. */
  beforeSend?: (event: WorkersRuntimeEvent) => WorkersRuntimeEvent | null;
  /** User context attached to all events */
  user?: UserContext | null;
}

export interface UserContext {
  id?: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

// --- Cloudflare Binding Types (minimal, avoids requiring @cloudflare/workers-types at runtime) ---

/** Minimal D1Database interface — matches Cloudflare's D1Database */
export interface D1DatabaseBinding {
  prepare(query: string): D1PreparedStatementBinding;
  batch<T = unknown>(statements: D1PreparedStatementBinding[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
}

export interface D1PreparedStatementBinding {
  bind(...values: unknown[]): D1PreparedStatementBinding;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(options?: { columnNames?: boolean }): Promise<T[]>;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: {
    duration: number;
    rows_read: number;
    rows_written: number;
    last_row_id: number;
    changed_db: boolean;
    size_after: number;
    changes: number;
  };
  error?: string;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

/** Minimal KVNamespace interface — matches Cloudflare's KVNamespace */
export interface KVNamespaceBinding {
  get(key: string, options?: unknown): Promise<string | null>;
  getWithMetadata<M = unknown>(key: string, options?: unknown): Promise<{ value: string | null; metadata: M | null }>;
  put(key: string, value: string | ReadableStream | ArrayBuffer, options?: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: unknown): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

/** Minimal R2Bucket interface — matches Cloudflare's R2Bucket */
export interface R2BucketBinding {
  get(key: string, options?: unknown): Promise<R2ObjectBody | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: unknown): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: unknown): Promise<R2Objects>;
  head(key: string): Promise<R2Object | null>;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  blob(): Promise<Blob>;
}

export interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}
