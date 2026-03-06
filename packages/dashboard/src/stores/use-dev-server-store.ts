import { create } from 'zustand';

export type DevServerStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'crashed';

export interface DevServerLogLine {
  stream: 'stdout' | 'stderr';
  line: string;
  ts: number;
}

interface ProjectDevState {
  status: DevServerStatus;
  pid: number | null;
  port: number | null;
  logs: DevServerLogLine[];
}

const MAX_LOGS = 500;

const defaultState = (): ProjectDevState => ({ status: 'idle', pid: null, port: null, logs: [] });

interface DevServerStore {
  servers: Map<string, ProjectDevState>;
  setStatus: (projectId: string, status: DevServerStatus, pid?: number, port?: number) => void;
  appendLog: (projectId: string, stream: 'stdout' | 'stderr', line: string, ts: number) => void;
  setOptimisticStarting: (projectId: string) => void;
  getProject: (projectId: string) => ProjectDevState;
}

export const useDevServerStore = create<DevServerStore>((set, get) => ({
  servers: new Map(),

  setStatus: (projectId, status, pid, port) => {
    set((s) => {
      const next = new Map(s.servers);
      const cur = next.get(projectId) ?? defaultState();
      next.set(projectId, {
        ...cur,
        status,
        pid: pid ?? cur.pid,
        port: port ?? cur.port,
      });
      return { servers: next };
    });
  },

  appendLog: (projectId, stream, line, ts) => {
    set((s) => {
      const next = new Map(s.servers);
      const cur = next.get(projectId) ?? defaultState();
      const logs = cur.logs.length >= MAX_LOGS
        ? [...cur.logs.slice(1), { stream, line, ts }]
        : [...cur.logs, { stream, line, ts }];
      next.set(projectId, { ...cur, logs });
      return { servers: next };
    });
  },

  setOptimisticStarting: (projectId) => {
    set((s) => {
      const next = new Map(s.servers);
      next.set(projectId, { status: 'starting', pid: null, port: null, logs: [] });
      return { servers: next };
    });
  },

  getProject: (projectId) => get().servers.get(projectId) ?? defaultState(),
}));
