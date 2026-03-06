import { create } from 'zustand';
import type {
  NetworkEvent,
  ConsoleEvent,
  StateEvent,
  RenderEvent,
  PerformanceEvent,
  DatabaseEvent,
  DevProcess,
  PortUsage,
} from '@/lib/runtime-types';

type RuntimeEvent = NetworkEvent | ConsoleEvent | StateEvent | RenderEvent | PerformanceEvent | DatabaseEvent;

const MAX_EVENTS = 10_000;

function cappedPush<T>(arr: T[], item: T): T[] {
  const next = [...arr, item];
  return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
}

interface DataState {
  source: 'mock' | 'live';
  connected: boolean;

  network: NetworkEvent[];
  console: ConsoleEvent[];
  state: StateEvent[];
  renders: RenderEvent[];
  performance: PerformanceEvent[];
  database: DatabaseEvent[];
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
  setProcesses: (p: DevProcess[]) => void;
  setPorts: (p: PortUsage[]) => void;

  appendEvent: (event: RuntimeEvent) => void;
  clearAll: () => void;
}

export const useDataStore = create<DataState>((set, get) => ({
  source: 'mock',
  connected: false,

  network: [],
  console: [],
  state: [],
  renders: [],
  performance: [],
  database: [],
  processes: [],
  ports: [],

  setSource: (s) => set({ source: s }),
  setConnected: (v) => set({ connected: v }),

  setNetwork: (events) => { if (events.length !== get().network.length) set({ network: events }); },
  setConsole: (events) => { if (events.length !== get().console.length) set({ console: events }); },
  setState: (events) => { if (events.length !== get().state.length) set({ state: events }); },
  setRenders: (events) => { if (events.length !== get().renders.length) set({ renders: events }); },
  setPerformance: (events) => { if (events.length !== get().performance.length) set({ performance: events }); },
  setDatabase: (events) => { if (events.length !== get().database.length) set({ database: events }); },
  setProcesses: (p) => { if (p.length !== get().processes.length) set({ processes: p }); },
  setPorts: (p) => { if (p.length !== get().ports.length) set({ ports: p }); },

  appendEvent: (event) =>
    set((s) => {
      switch (event.eventType) {
        case 'network':
          return { network: cappedPush(s.network, event as NetworkEvent) };
        case 'console':
          return { console: cappedPush(s.console, event as ConsoleEvent) };
        case 'state':
          return { state: cappedPush(s.state, event as StateEvent) };
        case 'render':
          return { renders: cappedPush(s.renders, event as RenderEvent) };
        case 'performance':
          return { performance: cappedPush(s.performance, event as PerformanceEvent) };
        case 'database':
          return { database: cappedPush(s.database, event as DatabaseEvent) };
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
      processes: [],
      ports: [],
    }),
}));
