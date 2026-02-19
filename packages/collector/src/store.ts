import { RingBuffer } from './ring-buffer.js';
import type { SqliteStore } from './sqlite-store.js';
import type {
  RuntimeEvent,
  NetworkEvent,
  ConsoleEvent,
  SessionEvent,
  StateEvent,
  RenderEvent,
  PerformanceEvent,
  DatabaseEvent,
  ReconMetadataEvent,
  ReconDesignTokensEvent,
  ReconFontsEvent,
  ReconLayoutTreeEvent,
  ReconAccessibilityEvent,
  ReconComputedStylesEvent,
  ReconElementSnapshotEvent,
  ReconAssetInventoryEvent,
  NetworkFilter,
  ConsoleFilter,
  StateFilter,
  RenderFilter,
  PerformanceFilter,
  DatabaseFilter,
  ReconFilter,
  ReconEventType,
  SessionInfo,
  TimelineFilter,
  EventType,
} from './types.js';

export class EventStore {
  private buffer: RingBuffer<RuntimeEvent>;
  private sessions: Map<string, SessionInfo> = new Map();
  private sqliteStore: SqliteStore | null = null;
  private currentProject: string | null = null;
  private onEventCallbacks: ((event: RuntimeEvent) => void)[] = [];

  constructor(capacity = 10_000) {
    this.buffer = new RingBuffer<RuntimeEvent>(capacity);
  }

  get eventCount(): number {
    return this.buffer.count;
  }

  setSqliteStore(store: SqliteStore, project: string): void {
    this.sqliteStore = store;
    this.currentProject = project;
  }

  onEvent(callback: (event: RuntimeEvent) => void): void {
    this.onEventCallbacks.push(callback);
  }

  removeEventListener(callback: (event: RuntimeEvent) => void): void {
    const idx = this.onEventCallbacks.indexOf(callback);
    if (idx !== -1) this.onEventCallbacks.splice(idx, 1);
  }

  addEvent(event: RuntimeEvent): void {
    this.buffer.push(event);

    if (event.eventType === 'session') {
      const se = event as SessionEvent;
      this.sessions.set(se.sessionId, {
        sessionId: se.sessionId,
        appName: se.appName,
        connectedAt: se.connectedAt,
        sdkVersion: se.sdkVersion,
        eventCount: 0,
        isConnected: true,
      });
    }

    const session = this.sessions.get(event.sessionId);
    if (session) session.eventCount++;

    // SQLite dual-write
    if (this.sqliteStore && this.currentProject) {
      this.sqliteStore.addEvent(event, this.currentProject);
    }

    // Notify listeners
    for (const cb of this.onEventCallbacks) {
      try {
        cb(event);
      } catch {
        // Don't let listener errors break event ingestion
      }
    }
  }

  getNetworkRequests(filter: NetworkFilter = {}): NetworkEvent[] {
    const since = filter.sinceSeconds
      ? Date.now() - filter.sinceSeconds * 1000
      : 0;

    return this.buffer.query((e) => {
      if (e.eventType !== 'network') return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      const ne = e as NetworkEvent;
      if (ne.timestamp < since) return false;
      if (filter.urlPattern && !ne.url.includes(filter.urlPattern)) return false;
      if (filter.status !== undefined && ne.status !== filter.status) return false;
      if (filter.method && ne.method.toUpperCase() !== filter.method.toUpperCase())
        return false;
      return true;
    }) as NetworkEvent[];
  }

  getConsoleMessages(filter: ConsoleFilter = {}): ConsoleEvent[] {
    const since = filter.sinceSeconds
      ? Date.now() - filter.sinceSeconds * 1000
      : 0;

    return this.buffer.query((e) => {
      if (e.eventType !== 'console') return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      const ce = e as ConsoleEvent;
      if (ce.timestamp < since) return false;
      if (filter.level && ce.level !== filter.level) return false;
      if (filter.search && !ce.message.toLowerCase().includes(filter.search.toLowerCase()))
        return false;
      return true;
    }) as ConsoleEvent[];
  }

  getSessionInfo(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  markDisconnected(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.isConnected = false;
  }

  getEventTimeline(filter: TimelineFilter = {}): RuntimeEvent[] {
    const since = filter.sinceSeconds
      ? Date.now() - filter.sinceSeconds * 1000
      : 0;
    const typeSet = filter.eventTypes
      ? new Set<EventType>(filter.eventTypes)
      : null;

    // toArray returns oldest→newest (chronological order)
    return this.buffer.toArray().filter((e) => {
      if (e.timestamp < since) return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      if (typeSet && !typeSet.has(e.eventType)) return false;
      return true;
    });
  }

  getAllEvents(sinceSeconds?: number, sessionId?: string): RuntimeEvent[] {
    const since = sinceSeconds ? Date.now() - sinceSeconds * 1000 : 0;
    return this.buffer.toArray().filter((e) => {
      if (e.timestamp < since) return false;
      if (sessionId && e.sessionId !== sessionId) return false;
      return true;
    });
  }

  getSessionIdsForProject(appName: string): string[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.appName === appName)
      .map((s) => s.sessionId);
  }

  getStateEvents(filter: StateFilter = {}): StateEvent[] {
    const since = filter.sinceSeconds
      ? Date.now() - filter.sinceSeconds * 1000
      : 0;

    return this.buffer.query((e) => {
      if (e.eventType !== 'state') return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      const se = e as StateEvent;
      if (se.timestamp < since) return false;
      if (filter.storeId && se.storeId !== filter.storeId) return false;
      return true;
    }) as StateEvent[];
  }

  getRenderEvents(filter: RenderFilter = {}): RenderEvent[] {
    const since = filter.sinceSeconds
      ? Date.now() - filter.sinceSeconds * 1000
      : 0;

    return this.buffer.query((e) => {
      if (e.eventType !== 'render') return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      const re = e as RenderEvent;
      if (re.timestamp < since) return false;
      if (filter.componentName) {
        const hasMatch = re.profiles.some((p) =>
          p.componentName.toLowerCase().includes(filter.componentName!.toLowerCase())
        );
        if (!hasMatch) return false;
      }
      return true;
    }) as RenderEvent[];
  }

  getPerformanceMetrics(filter: PerformanceFilter = {}): PerformanceEvent[] {
    const since = filter.sinceSeconds
      ? Date.now() - filter.sinceSeconds * 1000
      : 0;

    return this.buffer.query((e) => {
      if (e.eventType !== 'performance') return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      const pe = e as PerformanceEvent;
      if (pe.timestamp < since) return false;
      if (filter.metricName && pe.metricName !== filter.metricName) return false;
      return true;
    }) as PerformanceEvent[];
  }

  getDatabaseEvents(filter: DatabaseFilter = {}): DatabaseEvent[] {
    const since = filter.sinceSeconds
      ? Date.now() - filter.sinceSeconds * 1000
      : 0;

    return this.buffer.query((e) => {
      if (e.eventType !== 'database') return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      const de = e as DatabaseEvent;
      if (de.timestamp < since) return false;
      if (filter.table) {
        const hasTable = de.tablesAccessed.some(
          (t) => t.toLowerCase() === filter.table!.toLowerCase()
        );
        if (!hasTable) return false;
      }
      if (filter.minDurationMs !== undefined && de.duration < filter.minDurationMs) return false;
      if (filter.search && !de.query.toLowerCase().includes(filter.search.toLowerCase()))
        return false;
      if (filter.operation && de.operation !== filter.operation) return false;
      if (filter.source && de.source !== filter.source) return false;
      return true;
    }) as DatabaseEvent[];
  }

  // ============================================================
  // Recon event queries — returns the most recent event of each type
  // ============================================================

  private getLatestReconEvent<T extends RuntimeEvent>(
    eventType: ReconEventType,
    filter: ReconFilter = {},
  ): T | null {
    const since = filter.sinceSeconds
      ? Date.now() - filter.sinceSeconds * 1000
      : 0;

    // query() returns newest-first, so the first match is the most recent
    const results = this.buffer.query((e) => {
      if (e.eventType !== eventType) return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      if (e.timestamp < since) return false;
      if (filter.url) {
        const re = e as unknown as { url?: string };
        if (re.url && !re.url.includes(filter.url)) return false;
      }
      return true;
    });

    return (results[0] as T) ?? null;
  }

  private getReconEvents<T extends RuntimeEvent>(
    eventType: ReconEventType,
    filter: ReconFilter = {},
  ): T[] {
    const since = filter.sinceSeconds
      ? Date.now() - filter.sinceSeconds * 1000
      : 0;

    return this.buffer.query((e) => {
      if (e.eventType !== eventType) return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      if (e.timestamp < since) return false;
      if (filter.url) {
        const re = e as unknown as { url?: string };
        if (re.url && !re.url.includes(filter.url)) return false;
      }
      return true;
    }) as T[];
  }

  getReconMetadata(filter: ReconFilter = {}): ReconMetadataEvent | null {
    return this.getLatestReconEvent<ReconMetadataEvent>('recon_metadata', filter);
  }

  getReconDesignTokens(filter: ReconFilter = {}): ReconDesignTokensEvent | null {
    return this.getLatestReconEvent<ReconDesignTokensEvent>('recon_design_tokens', filter);
  }

  getReconFonts(filter: ReconFilter = {}): ReconFontsEvent | null {
    return this.getLatestReconEvent<ReconFontsEvent>('recon_fonts', filter);
  }

  getReconLayoutTree(filter: ReconFilter = {}): ReconLayoutTreeEvent | null {
    return this.getLatestReconEvent<ReconLayoutTreeEvent>('recon_layout_tree', filter);
  }

  getReconAccessibility(filter: ReconFilter = {}): ReconAccessibilityEvent | null {
    return this.getLatestReconEvent<ReconAccessibilityEvent>('recon_accessibility', filter);
  }

  getReconComputedStyles(filter: ReconFilter = {}): ReconComputedStylesEvent[] {
    return this.getReconEvents<ReconComputedStylesEvent>('recon_computed_styles', filter);
  }

  getReconElementSnapshots(filter: ReconFilter = {}): ReconElementSnapshotEvent[] {
    return this.getReconEvents<ReconElementSnapshotEvent>('recon_element_snapshot', filter);
  }

  getReconAssetInventory(filter: ReconFilter = {}): ReconAssetInventoryEvent | null {
    return this.getLatestReconEvent<ReconAssetInventoryEvent>('recon_asset_inventory', filter);
  }

  clear(): { clearedCount: number } {
    const count = this.buffer.count;
    this.buffer.clear();
    this.sessions.clear();
    return { clearedCount: count };
  }
}
