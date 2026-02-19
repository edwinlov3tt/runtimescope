// Re-defined types matching packages/collector/src/types.ts
// Kept in dashboard to avoid cross-package dependency

export type EventType = 'network' | 'console' | 'session' | 'state' | 'render' | 'dom_snapshot' | 'performance' | 'database';

export interface BaseEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: EventType;
}

export interface NetworkEvent extends BaseEvent {
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
  graphqlOperation?: { type: 'query' | 'mutation' | 'subscription'; name: string };
  requestBody?: string;
  responseBody?: string;
  errorPhase?: 'error' | 'abort' | 'timeout';
  errorMessage?: string;
  source?: 'fetch' | 'xhr';
}

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug' | 'trace';

export interface ConsoleEvent extends BaseEvent {
  eventType: 'console';
  level: ConsoleLevel;
  message: string;
  args: unknown[];
  stackTrace?: string;
  sourceFile?: string;
}

export interface StateEvent extends BaseEvent {
  eventType: 'state';
  storeId: string;
  library: 'zustand' | 'redux' | 'unknown';
  phase: 'init' | 'update';
  state: unknown;
  previousState?: unknown;
  diff?: Record<string, { from: unknown; to: unknown }>;
  action?: { type: string; payload?: unknown };
  stackTrace?: string;
}

export interface RenderComponentProfile {
  componentName: string;
  renderCount: number;
  totalDuration: number;
  avgDuration: number;
  lastRenderPhase: 'mount' | 'update' | 'unmount';
  lastRenderCause?: 'props' | 'state' | 'context' | 'parent' | 'unknown';
  renderVelocity: number;
  suspicious: boolean;
}

export interface RenderEvent extends BaseEvent {
  eventType: 'render';
  profiles: RenderComponentProfile[];
  snapshotWindowMs: number;
  totalRenders: number;
  suspiciousComponents: string[];
}

export type WebVitalRating = 'good' | 'needs-improvement' | 'poor';

export interface PerformanceEvent extends BaseEvent {
  eventType: 'performance';
  metricName: 'LCP' | 'FCP' | 'CLS' | 'TTFB' | 'FID' | 'INP';
  value: number;
  rating: WebVitalRating;
  element?: string;
  entries?: unknown[];
}

export type DatabaseOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';
export type DatabaseSource = 'prisma' | 'drizzle' | 'knex' | 'pg' | 'mysql2' | 'better-sqlite3' | 'generic';

export interface DatabaseEvent extends BaseEvent {
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

export type IssueSeverity = 'high' | 'medium' | 'low';

export interface DetectedIssue {
  id: string;
  pattern: string;
  severity: IssueSeverity;
  title: string;
  description: string;
  evidence: string[];
  suggestion?: string;
}

export interface ApiEndpoint {
  normalizedPath: string;
  method: string;
  baseUrl: string;
  service: string;
  callCount: number;
  firstSeen: number;
  lastSeen: number;
  auth: { type: 'bearer' | 'basic' | 'api_key' | 'cookie' | 'none'; headerName?: string };
  graphqlOperation?: { type: 'query' | 'mutation' | 'subscription'; name: string };
}

export interface ApiEndpointHealth {
  normalizedPath: string;
  method: string;
  service: string;
  callCount: number;
  successRate: number;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  errorRate: number;
  errorCodes: Record<number, number>;
}

export interface ServiceInfo {
  name: string;
  baseUrl: string;
  endpointCount: number;
  totalCalls: number;
  avgLatency: number;
  errorRate: number;
  auth: { type: 'bearer' | 'basic' | 'api_key' | 'cookie' | 'none'; headerName?: string };
  detectedPlatform?: string;
}

export interface NormalizedQueryStats {
  normalizedQuery: string;
  tables: string[];
  operation: DatabaseOperation;
  callCount: number;
  avgDuration: number;
  maxDuration: number;
  p95Duration: number;
  totalDuration: number;
  avgRowsReturned: number;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
}

export interface SchemaForeignKey {
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface SchemaIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  foreignKeys: SchemaForeignKey[];
  indexes: SchemaIndex[];
  rowCount?: number;
}

export type DevProcessType = 'next' | 'vite' | 'webpack' | 'wrangler' | 'prisma' | 'docker' | 'postgres' | 'mysql' | 'redis' | 'node' | 'bun' | 'deno' | 'python' | 'unknown';

export interface DevProcess {
  pid: number;
  command: string;
  type: DevProcessType;
  cpuPercent: number;
  memoryMB: number;
  ports: number[];
  cwd?: string;
  project?: string;
  uptime?: number;
  isOrphaned: boolean;
}

export interface PortUsage {
  port: number;
  pid: number;
  process: string;
  type: DevProcessType;
  project?: string;
}

export interface DeployLog {
  id: string;
  platform: string;
  project: string;
  status: 'building' | 'ready' | 'error' | 'canceled';
  url?: string;
  branch?: string;
  commit?: string;
  createdAt: number;
  readyAt?: number;
  errorMessage?: string;
}

export interface BuildStatus {
  platform: string;
  project: string;
  latestDeployId: string;
  status: 'building' | 'ready' | 'error' | 'canceled';
  url?: string;
  lastDeployed: number;
}

export interface InfraOverview {
  project: string;
  platforms: {
    name: string;
    configured: boolean;
    deployCount: number;
    lastDeploy?: number;
    status?: string;
  }[];
  detectedFromTraffic: string[];
}

export interface SessionMetrics {
  sessionId: string;
  project: string;
  connectedAt: number;
  disconnectedAt: number;
  totalEvents: number;
  errorCount: number;
  endpoints: Record<string, { avgLatency: number; errorRate: number; callCount: number }>;
  components: Record<string, { renderCount: number; avgDuration: number }>;
  stores: Record<string, { updateCount: number }>;
  webVitals: Record<string, { value: number; rating: WebVitalRating }>;
  queries: Record<string, { avgDuration: number; callCount: number }>;
}

export interface MetricDelta {
  key: string;
  before: number;
  after: number;
  delta: number;
  percentChange: number;
  classification: 'regression' | 'improvement' | 'unchanged';
}

export interface SessionDiffResult {
  sessionA: string;
  sessionB: string;
  endpointDeltas: MetricDelta[];
  componentDeltas: MetricDelta[];
  storeDeltas: MetricDelta[];
  webVitalDeltas: MetricDelta[];
  queryDeltas: MetricDelta[];
  overallDelta: {
    errorCountDelta: number;
    totalEventsDelta: number;
  };
}
