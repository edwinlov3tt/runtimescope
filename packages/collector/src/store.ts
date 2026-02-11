import { RingBuffer } from './ring-buffer.js';
import type {
  RuntimeEvent,
  NetworkEvent,
  ConsoleEvent,
  SessionEvent,
  NetworkFilter,
  ConsoleFilter,
  SessionInfo,
  TimelineFilter,
  EventType,
} from './types.js';

export class EventStore {
  private buffer: RingBuffer<RuntimeEvent>;
  private sessions: Map<string, SessionInfo> = new Map();

  constructor(capacity = 10_000) {
    this.buffer = new RingBuffer<RuntimeEvent>(capacity);
  }

  get eventCount(): number {
    return this.buffer.count;
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
  }

  getNetworkRequests(filter: NetworkFilter = {}): NetworkEvent[] {
    const since = filter.sinceSeconds
      ? Date.now() - filter.sinceSeconds * 1000
      : 0;

    return this.buffer.query((e) => {
      if (e.eventType !== 'network') return false;
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
      if (typeSet && !typeSet.has(e.eventType)) return false;
      return true;
    });
  }

  getAllEvents(sinceSeconds?: number): RuntimeEvent[] {
    const since = sinceSeconds ? Date.now() - sinceSeconds * 1000 : 0;
    return this.buffer.toArray().filter((e) => e.timestamp >= since);
  }

  clear(): { clearedCount: number } {
    const count = this.buffer.count;
    this.buffer.clear();
    for (const s of this.sessions.values()) {
      s.eventCount = 0;
    }
    return { clearedCount: count };
  }
}
