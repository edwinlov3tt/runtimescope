// SDK-side types — mirrors the collector's wire format
// Intentionally duplicated to keep the SDK dependency-free

export type EventType = 'network' | 'console' | 'session';

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

export interface SessionEvent extends BaseEvent {
  eventType: 'session';
  appName: string;
  connectedAt: number;
  sdkVersion: string;
}

export type RuntimeEvent = NetworkEvent | ConsoleEvent | SessionEvent;

export interface RuntimeScopeConfig {
  enabled?: boolean;
  serverUrl?: string;
  appName?: string;
  captureNetwork?: boolean;
  captureConsole?: boolean;
  redactHeaders?: string[];
  batchSize?: number;
  flushIntervalMs?: number;
}
