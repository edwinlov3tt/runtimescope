import { create } from 'zustand';
import type {
  NetworkEvent,
  ConsoleEvent,
  StateEvent,
  RenderEvent,
  PerformanceEvent,
  DatabaseEvent,
  UIInteractionEvent,
  DevProcess,
  PortUsage,
} from '@/lib/runtime-types';

type RuntimeEvent = NetworkEvent | ConsoleEvent | StateEvent | RenderEvent | PerformanceEvent | DatabaseEvent | UIInteractionEvent;

const MAX_EVENTS = 10_000;

function cappedPush<T>(arr: T[], item: T): T[] {
  const next = [...arr, item];
  return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
}

/** Remove duplicate events by eventId, keeping the first occurrence. */
function dedup<T extends { eventId: string }>(events: T[]): T[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (seen.has(e.eventId)) return false;
    seen.add(e.eventId);
    return true;
  });
}

interface DataState {
  source: 'mock' | 'live';
  connected: boolean;
  /** Set to true after the first data fetch completes (used for skeleton display). */
  initialLoadDone: boolean;

  network: NetworkEvent[];
  console: ConsoleEvent[];
  state: StateEvent[];
  renders: RenderEvent[];
  performance: PerformanceEvent[];
  database: DatabaseEvent[];
  ui: UIInteractionEvent[];
  processes: DevProcess[];
  ports: PortUsage[];

  setSource: (s: 'mock' | 'live') => void;
  setConnected: (v: boolean) => void;

  setNetwork: (events: NetworkEvent[]) => void;
  setConsole: (events: ConsoleEvent[]) => void;
  setState: (events: StateEvent[]) => void;
  setRenders: (events: RenderEvent[]) => void;
  setPerformance: (events: PerformanceEvent[]) => void;
  setDatabase: (events: DatabaseEvent[]) => void;
  setUI: (events: UIInteractionEvent[]) => void;
  setProcesses: (p: DevProcess[]) => void;
  setPorts: (p: PortUsage[]) => void;

  appendEvent: (event: RuntimeEvent) => void;
  clearAll: () => void;
}

export const useDataStore = create<DataState>((set, get) => ({
  source: 'mock',
  connected: false,
  initialLoadDone: false,

  network: [],
  console: [],
  state: [],
  renders: [],
  performance: [],
  database: [],
  ui: [],
  processes: [],
  ports: [],

  setSource: (s) => set({ source: s }),
  setConnected: (v) => set({ connected: v }),

  setNetwork: (events) => { const d = dedup(events); if (d.length !== get().network.length) set({ network: d, initialLoadDone: true }); else if (!get().initialLoadDone) set({ initialLoadDone: true }); },
  setConsole: (events) => { const d = dedup(events); if (d.length !== get().console.length) set({ console: d, initialLoadDone: true }); else if (!get().initialLoadDone) set({ initialLoadDone: true }); },
  setState: (events) => { const d = dedup(events); if (d.length !== get().state.length) set({ state: d, initialLoadDone: true }); else if (!get().initialLoadDone) set({ initialLoadDone: true }); },
  setRenders: (events) => { const d = dedup(events); if (d.length !== get().renders.length) set({ renders: d, initialLoadDone: true }); else if (!get().initialLoadDone) set({ initialLoadDone: true }); },
  setPerformance: (events) => { const d = dedup(events); if (d.length !== get().performance.length) set({ performance: d, initialLoadDone: true }); else if (!get().initialLoadDone) set({ initialLoadDone: true }); },
  setDatabase: (events) => { const d = dedup(events); if (d.length !== get().database.length) set({ database: d, initialLoadDone: true }); else if (!get().initialLoadDone) set({ initialLoadDone: true }); },
  setUI: (events) => { const d = dedup(events); if (d.length !== get().ui.length) set({ ui: d, initialLoadDone: true }); else if (!get().initialLoadDone) set({ initialLoadDone: true }); },
  setProcesses: (p) => { if (p.length !== get().processes.length) set({ processes: p }); },
  setPorts: (p) => { if (p.length !== get().ports.length) set({ ports: p }); },

  appendEvent: (event) =>
    set((s) => {
      const eid = (event as { eventId?: string }).eventId;
      switch (event.eventType) {
        case 'network':
          if (eid && s.network.some((e) => e.eventId === eid)) return {};
          return { network: cappedPush(s.network, event as NetworkEvent) };
        case 'console':
          if (eid && s.console.some((e) => e.eventId === eid)) return {};
          return { console: cappedPush(s.console, event as ConsoleEvent) };
        case 'state':
          if (eid && s.state.some((e) => e.eventId === eid)) return {};
          return { state: cappedPush(s.state, event as StateEvent) };
        case 'render':
          if (eid && s.renders.some((e) => e.eventId === eid)) return {};
          return { renders: cappedPush(s.renders, event as RenderEvent) };
        case 'performance':
          if (eid && s.performance.some((e) => e.eventId === eid)) return {};
          return { performance: cappedPush(s.performance, event as PerformanceEvent) };
        case 'database':
          if (eid && s.database.some((e) => e.eventId === eid)) return {};
          return { database: cappedPush(s.database, event as DatabaseEvent) };
        case 'ui':
          if (eid && s.ui.some((e) => e.eventId === eid)) return {};
          return { ui: cappedPush(s.ui, event as UIInteractionEvent) };
        default:
          return {};
      }
    }),

  clearAll: () =>
    set({
      network: [],
      console: [],
      state: [],
      renders: [],
      performance: [],
      database: [],
      ui: [],
      processes: [],
      ports: [],
      initialLoadDone: false,
    }),
}));
