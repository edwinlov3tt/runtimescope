// ============================================================
// Canonical type definitions for RuntimeScope
// Used by both the collector and MCP server packages
// ============================================================

// --- Base Event ---

export type EventType =
  | 'network'
  | 'console'
  | 'session'
  | 'state'
  | 'render'
  | 'dom_snapshot'
  | 'performance'
  | 'database';

export interface BaseEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: EventType;
}

// --- Network Events ---

export interface GraphQLOperation {
  type: 'query' | 'mutation' | 'subscription';
  name: string;
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
  graphqlOperation?: GraphQLOperation;
  // M2 additions
  requestBody?: string;
  responseBody?: string;
  errorPhase?: 'error' | 'abort' | 'timeout';
  errorMessage?: string;
  source?: 'fetch' | 'xhr';
}

// --- Console Events ---

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug' | 'trace';

export interface ConsoleEvent extends BaseEvent {
  eventType: 'console';
  level: ConsoleLevel;
  message: string;
  args: unknown[];
  stackTrace?: string;
  sourceFile?: string;
}

// --- Build Metadata ---

export interface BuildMeta {
  gitCommit?: string;
  gitBranch?: string;
  buildTime?: string;
  deployId?: string;
}

// --- Session Events ---

export interface SessionEvent extends BaseEvent {
  eventType: 'session';
  appName: string;
  connectedAt: number;
  sdkVersion: string;
  buildMeta?: BuildMeta;
}

// --- State Events ---

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

// --- Render Events ---

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

// --- DOM Snapshot Events ---

export interface DomSnapshotEvent extends BaseEvent {
  eventType: 'dom_snapshot';
  html: string;
  url: string;
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  elementCount: number;
  truncated: boolean;
}

// --- Performance Events ---

export type WebVitalRating = 'good' | 'needs-improvement' | 'poor';

export interface PerformanceEvent extends BaseEvent {
  eventType: 'performance';
  metricName: 'LCP' | 'FCP' | 'CLS' | 'TTFB' | 'FID' | 'INP';
  value: number;
  rating: WebVitalRating;
  element?: string;
  entries?: unknown[];
}

// --- Database Events ---

export type DatabaseOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';

export type DatabaseSource =
  | 'prisma'
  | 'drizzle'
  | 'knex'
  | 'pg'
  | 'mysql2'
  | 'better-sqlite3'
  | 'generic';

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

// --- Union ---

export type RuntimeEvent =
  | NetworkEvent
  | ConsoleEvent
  | SessionEvent
  | StateEvent
  | RenderEvent
  | DomSnapshotEvent
  | PerformanceEvent
  | DatabaseEvent;

// --- Query Filters ---

export interface NetworkFilter {
  sinceSeconds?: number;
  urlPattern?: string;
  status?: number;
  method?: string;
}

export interface ConsoleFilter {
  level?: string;
  sinceSeconds?: number;
  search?: string;
}

export interface StateFilter {
  storeId?: string;
  sinceSeconds?: number;
}

export interface RenderFilter {
  componentName?: string;
  sinceSeconds?: number;
}

export interface PerformanceFilter {
  metricName?: string;
  sinceSeconds?: number;
}

export interface DatabaseFilter {
  sinceSeconds?: number;
  table?: string;
  minDurationMs?: number;
  search?: string;
  operation?: DatabaseOperation;
  source?: DatabaseSource;
}

// --- Historical Filter (SQLite queries) ---

export interface HistoricalFilter {
  project?: string;
  sessionId?: string;
  eventTypes?: EventType[];
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  endpoint?: string;
  component?: string;
  storeId?: string;
}

// --- Tool Response Envelope ---

export interface ToolResponse<T = unknown> {
  summary: string;
  data: T;
  issues: string[];
  metadata: {
    timeRange: { from: number; to: number };
    eventCount: number;
    sessionId: string | null;
  };
}

// --- Session Info ---

export interface SessionInfo {
  sessionId: string;
  appName: string;
  connectedAt: number;
  sdkVersion: string;
  eventCount: number;
  isConnected: boolean;
}

export interface SessionInfoExtended extends SessionInfo {
  project: string;
  disconnectedAt?: number;
  buildMeta?: BuildMeta;
}

// --- Session Metrics & Diffing ---

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

export interface SessionSnapshot {
  sessionId: string;
  project: string;
  snapshotPath?: string;
  metrics: SessionMetrics;
  buildMeta?: BuildMeta;
  createdAt: number;
}

// --- WebSocket Protocol ---

export interface WSMessage {
  type: 'event' | 'handshake' | 'heartbeat' | 'command' | 'command_response';
  payload: unknown;
  timestamp: number;
  sessionId: string;
}

export interface HandshakePayload {
  appName: string;
  sdkVersion: string;
  sessionId: string;
}

export interface EventBatchPayload {
  events: RuntimeEvent[];
}

// --- Server→SDK Commands ---

export type ServerCommand =
  | { command: 'capture_dom_snapshot'; requestId: string; params?: { maxSize?: number } }
  | { command: 'capture_performance_metrics'; requestId: string }
  | { command: 'clear_renders'; requestId: string };

export interface CommandResponse {
  type: 'command_response';
  requestId: string;
  command: string;
  payload: unknown;
  timestamp: number;
  sessionId: string;
}

// --- Timeline ---

export interface TimelineFilter {
  sinceSeconds?: number;
  eventTypes?: EventType[];
}

// --- Issue Detection ---

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

// --- API Discovery ---

export interface AuthInfo {
  type: 'bearer' | 'basic' | 'api_key' | 'cookie' | 'none';
  headerName?: string;
}

export interface ApiContractField {
  path: string;
  type: string;
  nullable: boolean;
  example?: unknown;
}

export interface ApiContract {
  requestFields?: ApiContractField[];
  responseFields: ApiContractField[];
  sampleCount: number;
}

export interface ApiEndpoint {
  normalizedPath: string;
  method: string;
  baseUrl: string;
  service: string;
  callCount: number;
  firstSeen: number;
  lastSeen: number;
  auth: AuthInfo;
  contract?: ApiContract;
  graphqlOperation?: GraphQLOperation;
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
  auth: AuthInfo;
  detectedPlatform?: string;
}

export interface ApiChangeRecord {
  normalizedPath: string;
  method: string;
  changeType: 'added' | 'removed' | 'modified';
  fieldChanges?: {
    path: string;
    change: 'added' | 'removed' | 'type_changed';
    oldType?: string;
    newType?: string;
  }[];
}

// --- Query Monitor ---

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

export interface IndexSuggestion {
  table: string;
  columns: string[];
  reason: string;
  estimatedImpact: 'high' | 'medium' | 'low';
  queryPattern: string;
}

// --- Schema Introspection ---

export interface DatabaseConnectionConfig {
  id: string;
  type: 'postgres' | 'mysql' | 'sqlite';
  connectionString?: string;
  label?: string;
  projectRef?: string;
  serviceKey?: string;
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

export interface DatabaseSchema {
  connectionId: string;
  tables: SchemaTable[];
  fetchedAt: number;
}

// --- Process Monitor ---

export type DevProcessType =
  | 'next'
  | 'vite'
  | 'webpack'
  | 'wrangler'
  | 'prisma'
  | 'docker'
  | 'postgres'
  | 'mysql'
  | 'redis'
  | 'node'
  | 'bun'
  | 'deno'
  | 'python'
  | 'unknown';

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

// --- Infrastructure Connector ---

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

export interface RuntimeLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
  platform: string;
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
