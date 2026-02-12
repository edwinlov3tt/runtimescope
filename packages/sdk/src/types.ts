// SDK-side types — mirrors the collector's wire format
// Intentionally duplicated to keep the SDK dependency-free

export type EventType =
  | 'network'
  | 'console'
  | 'session'
  | 'state'
  | 'render'
  | 'dom_snapshot'
  | 'performance';

export interface BaseEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: EventType;
}

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

export interface BuildMeta {
  gitCommit?: string;
  gitBranch?: string;
  buildTime?: string;
  deployId?: string;
}

export interface SessionEvent extends BaseEvent {
  eventType: 'session';
  appName: string;
  connectedAt: number;
  sdkVersion: string;
  buildMeta?: BuildMeta;
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

export interface DomSnapshotEvent extends BaseEvent {
  eventType: 'dom_snapshot';
  html: string;
  url: string;
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  elementCount: number;
  truncated: boolean;
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

export type RuntimeEvent =
  | NetworkEvent
  | ConsoleEvent
  | SessionEvent
  | StateEvent
  | RenderEvent
  | DomSnapshotEvent
  | PerformanceEvent;

export interface RuntimeScopeConfig {
  enabled?: boolean;
  serverUrl?: string;
  appName?: string;
  buildMeta?: BuildMeta;
  captureNetwork?: boolean;
  captureConsole?: boolean;
  captureXhr?: boolean;
  captureBody?: boolean;
  maxBodySize?: number;
  capturePerformance?: boolean;
  captureRenders?: boolean;
  stores?: Record<string, unknown>;
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null;
  redactHeaders?: string[];
  batchSize?: number;
  flushIntervalMs?: number;
}
