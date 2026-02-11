// ============================================================
// Canonical type definitions for RuntimeScope
// Used by both the collector and MCP server packages
// ============================================================

// --- Base Event ---

export type EventType = 'network' | 'console' | 'session';

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

// --- Session Events ---

export interface SessionEvent extends BaseEvent {
  eventType: 'session';
  appName: string;
  connectedAt: number;
  sdkVersion: string;
}

// --- Union ---

export type RuntimeEvent = NetworkEvent | ConsoleEvent | SessionEvent;

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

// --- WebSocket Protocol ---

export interface WSMessage {
  type: 'event' | 'handshake' | 'heartbeat';
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
