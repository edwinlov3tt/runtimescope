import type { ProjectManager } from './project-manager.js';
import type { SqliteStore } from './sqlite-store.js';
import type { EventStore } from './store.js';
import type {
  RuntimeEvent,
  NetworkEvent,
  RenderEvent,
  StateEvent,
  PerformanceEvent,
  DatabaseEvent,
  ConsoleEvent,
  SessionMetrics,
  SessionSnapshot,
  WebVitalRating,
} from './types.js';

// ============================================================
// Session Manager
// Computes session metrics and manages session snapshots
// ============================================================

export class SessionManager {
  private projectManager: ProjectManager;
  private sqliteStores: Map<string, SqliteStore>;
  private store: EventStore;

  constructor(
    projectManager: ProjectManager,
    sqliteStores: Map<string, SqliteStore>,
    store: EventStore
  ) {
    this.projectManager = projectManager;
    this.sqliteStores = sqliteStores;
    this.store = store;
  }

  computeMetrics(sessionId: string, project: string, events: RuntimeEvent[]): SessionMetrics {
    const sessionEvents = events.filter((e) => e.sessionId === sessionId);

    const networkEvents = sessionEvents.filter((e) => e.eventType === 'network') as NetworkEvent[];
    const renderEvents = sessionEvents.filter((e) => e.eventType === 'render') as RenderEvent[];
    const stateEvents = sessionEvents.filter((e) => e.eventType === 'state') as StateEvent[];
    const performanceEvents = sessionEvents.filter((e) => e.eventType === 'performance') as PerformanceEvent[];
    const databaseEvents = sessionEvents.filter((e) => e.eventType === 'database') as DatabaseEvent[];
    const consoleEvents = sessionEvents.filter((e) => e.eventType === 'console') as ConsoleEvent[];

    // Endpoint metrics
    const endpoints: Record<string, { avgLatency: number; errorRate: number; callCount: number }> = {};
    const endpointGroups = new Map<string, NetworkEvent[]>();
    for (const e of networkEvents) {
      const key = `${e.method} ${e.url}`;
      const group = endpointGroups.get(key) ?? [];
      group.push(e);
      endpointGroups.set(key, group);
    }
    for (const [key, group] of endpointGroups) {
      const avgLatency = group.reduce((s, e) => s + e.duration, 0) / group.length;
      const errorCount = group.filter((e) => e.status >= 400).length;
      endpoints[key] = { avgLatency, errorRate: errorCount / group.length, callCount: group.length };
    }

    // Component metrics
    const components: Record<string, { renderCount: number; avgDuration: number }> = {};
    for (const re of renderEvents) {
      for (const p of re.profiles) {
        const existing = components[p.componentName];
        if (existing) {
          existing.renderCount += p.renderCount;
          existing.avgDuration = (existing.avgDuration + p.avgDuration) / 2;
        } else {
          components[p.componentName] = { renderCount: p.renderCount, avgDuration: p.avgDuration };
        }
      }
    }

    // Store metrics
    const stores: Record<string, { updateCount: number }> = {};
    for (const se of stateEvents) {
      const existing = stores[se.storeId];
      if (existing) {
        existing.updateCount++;
      } else {
        stores[se.storeId] = { updateCount: 1 };
      }
    }

    // Web Vitals (only include events with a rating — i.e., browser Web Vitals, not server metrics)
    const webVitals: Record<string, { value: number; rating: WebVitalRating }> = {};
    for (const pe of performanceEvents) {
      if (pe.rating) {
        webVitals[pe.metricName] = { value: pe.value, rating: pe.rating };
      }
    }

    // Query metrics
    const queries: Record<string, { avgDuration: number; callCount: number }> = {};
    const queryGroups = new Map<string, DatabaseEvent[]>();
    for (const de of databaseEvents) {
      const group = queryGroups.get(de.normalizedQuery) ?? [];
      group.push(de);
      queryGroups.set(de.normalizedQuery, group);
    }
    for (const [key, group] of queryGroups) {
      const avgDuration = group.reduce((s, e) => s + e.duration, 0) / group.length;
      queries[key] = { avgDuration, callCount: group.length };
    }

    const timestamps = sessionEvents.map((e) => e.timestamp);
    const errorCount = consoleEvents.filter((e) => e.level === 'error').length +
      networkEvents.filter((e) => e.status >= 400).length;

    return {
      sessionId,
      project,
      connectedAt: timestamps.length > 0 ? Math.min(...timestamps) : Date.now(),
      disconnectedAt: timestamps.length > 0 ? Math.max(...timestamps) : Date.now(),
      totalEvents: sessionEvents.length,
      errorCount,
      endpoints,
      components,
      stores,
      webVitals,
      queries,
    };
  }

  createSnapshot(sessionId: string, project: string): SessionSnapshot {
    const events = this.store.getAllEvents();
    const metrics = this.computeMetrics(sessionId, project, events);

    // Save to SQLite
    const sqliteStore = this.sqliteStores.get(project);
    if (sqliteStore) {
      sqliteStore.saveSessionMetrics(sessionId, project, metrics);
    }

    return {
      sessionId,
      project,
      metrics,
      createdAt: Date.now(),
    };
  }

  getSessionHistory(project: string, limit = 20): SessionSnapshot[] {
    const sqliteStore = this.sqliteStores.get(project);
    if (!sqliteStore) return [];

    const sessions = sqliteStore.getSessions(project, limit);
    const snapshots: SessionSnapshot[] = [];

    for (const session of sessions) {
      const metricsData = sqliteStore.getSessionMetrics(session.sessionId);
      if (metricsData) {
        snapshots.push({
          sessionId: session.sessionId,
          project,
          metrics: metricsData as SessionMetrics,
          buildMeta: session.buildMeta,
          createdAt: session.disconnectedAt ?? session.connectedAt,
        });
      }
    }

    return snapshots;
  }
}
