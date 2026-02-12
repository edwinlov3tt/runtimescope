import type {
  NetworkEvent,
  ConsoleEvent,
  SessionEvent,
  StateEvent,
  RenderEvent,
  PerformanceEvent,
  DatabaseEvent,
  DomSnapshotEvent,
  RenderComponentProfile,
  SessionMetrics,
  WebVitalRating,
  ConsoleLevel,
  DatabaseOperation,
  DatabaseSource,
} from '../types.js';

let counter = 0;

function nextId(): string {
  return `evt-${++counter}`;
}

export function resetCounter(): void {
  counter = 0;
}

export function makeNetworkEvent(overrides: Partial<NetworkEvent> = {}): NetworkEvent {
  return {
    eventId: nextId(),
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'network',
    url: 'https://api.example.com/users',
    method: 'GET',
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    requestBodySize: 0,
    responseBodySize: 100,
    duration: 150,
    ttfb: 50,
    ...overrides,
  };
}

export function makeConsoleEvent(overrides: Partial<ConsoleEvent> = {}): ConsoleEvent {
  return {
    eventId: nextId(),
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'console',
    level: 'log' as ConsoleLevel,
    message: 'test message',
    args: [],
    ...overrides,
  };
}

export function makeSessionEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    eventId: nextId(),
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'session',
    appName: 'test-app',
    connectedAt: Date.now(),
    sdkVersion: '0.1.0',
    ...overrides,
  };
}

export function makeStateEvent(overrides: Partial<StateEvent> = {}): StateEvent {
  return {
    eventId: nextId(),
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'state',
    storeId: 'main-store',
    library: 'zustand',
    phase: 'update',
    state: { count: 1 },
    ...overrides,
  };
}

export function makeRenderProfile(overrides: Partial<RenderComponentProfile> = {}): RenderComponentProfile {
  return {
    componentName: 'MyComponent',
    renderCount: 5,
    totalDuration: 25,
    avgDuration: 5,
    lastRenderPhase: 'update',
    lastRenderCause: 'state',
    renderVelocity: 2,
    suspicious: false,
    ...overrides,
  };
}

export function makeRenderEvent(overrides: Partial<RenderEvent> = {}): RenderEvent {
  return {
    eventId: nextId(),
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'render',
    profiles: [makeRenderProfile()],
    snapshotWindowMs: 5000,
    totalRenders: 5,
    suspiciousComponents: [],
    ...overrides,
  };
}

export function makePerformanceEvent(overrides: Partial<PerformanceEvent> = {}): PerformanceEvent {
  return {
    eventId: nextId(),
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'performance',
    metricName: 'LCP',
    value: 2500,
    rating: 'good' as WebVitalRating,
    ...overrides,
  };
}

export function makeDatabaseEvent(overrides: Partial<DatabaseEvent> = {}): DatabaseEvent {
  return {
    eventId: nextId(),
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'database',
    query: 'SELECT * FROM users WHERE id = 1',
    normalizedQuery: 'SELECT * FROM users WHERE id = ?',
    duration: 50,
    tablesAccessed: ['users'],
    operation: 'SELECT' as DatabaseOperation,
    source: 'prisma' as DatabaseSource,
    ...overrides,
  };
}

export function makeDomSnapshotEvent(overrides: Partial<DomSnapshotEvent> = {}): DomSnapshotEvent {
  return {
    eventId: nextId(),
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'dom_snapshot',
    html: '<html><body>Hello</body></html>',
    url: 'http://localhost:3000',
    viewport: { width: 1280, height: 720 },
    scrollPosition: { x: 0, y: 0 },
    elementCount: 3,
    truncated: false,
    ...overrides,
  };
}

export function makeSessionMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    sessionId: 'session-1',
    project: 'default',
    connectedAt: Date.now() - 60000,
    disconnectedAt: Date.now(),
    totalEvents: 100,
    errorCount: 5,
    endpoints: {},
    components: {},
    stores: {},
    webVitals: {},
    queries: {},
    ...overrides,
  };
}
