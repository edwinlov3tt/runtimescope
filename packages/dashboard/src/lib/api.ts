import type {
  NetworkEvent,
  ConsoleEvent,
  StateEvent,
  RenderEvent,
  PerformanceEvent,
  DatabaseEvent,
  DevProcess,
  PortUsage,
} from '@/mock/types';

// Base URL is empty — Vite proxy forwards /api/* to the collector
const BASE = '';

interface ApiResponse<T> {
  data: T[];
  count: number;
}

export interface ProjectInfo {
  appName: string;
  sessions: string[];
  isConnected: boolean;
  eventCount: number;
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T[] | null> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const json: ApiResponse<T> = await res.json();
    return json.data;
  } catch {
    return null;
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (!res.ok) return false;
    const json = await res.json();
    return json.status === 'ok';
  } catch {
    return false;
  }
}

// --- Event endpoints (all support session_id filtering) ---

export async function fetchNetworkEvents(params?: {
  since_seconds?: number;
  url_pattern?: string;
  method?: string;
  session_id?: string;
}): Promise<NetworkEvent[] | null> {
  return get<NetworkEvent>(`${BASE}/api/events/network`, params);
}

export async function fetchConsoleEvents(params?: {
  since_seconds?: number;
  level?: string;
  search?: string;
  session_id?: string;
}): Promise<ConsoleEvent[] | null> {
  return get<ConsoleEvent>(`${BASE}/api/events/console`, params);
}

export async function fetchStateEvents(params?: {
  since_seconds?: number;
  store_id?: string;
  session_id?: string;
}): Promise<StateEvent[] | null> {
  return get<StateEvent>(`${BASE}/api/events/state`, params);
}

export async function fetchRenderEvents(params?: {
  since_seconds?: number;
  component?: string;
  session_id?: string;
}): Promise<RenderEvent[] | null> {
  return get<RenderEvent>(`${BASE}/api/events/renders`, params);
}

export async function fetchPerformanceEvents(params?: {
  since_seconds?: number;
  metric?: string;
  session_id?: string;
}): Promise<PerformanceEvent[] | null> {
  return get<PerformanceEvent>(`${BASE}/api/events/performance`, params);
}

export async function fetchDatabaseEvents(params?: {
  since_seconds?: number;
  table?: string;
  min_duration_ms?: number;
  search?: string;
  session_id?: string;
}): Promise<DatabaseEvent[] | null> {
  return get<DatabaseEvent>(`${BASE}/api/events/database`, params);
}

export async function fetchTimelineEvents(params?: {
  since_seconds?: number;
  event_types?: string;
  session_id?: string;
}): Promise<(NetworkEvent | ConsoleEvent | StateEvent | RenderEvent | PerformanceEvent | DatabaseEvent)[] | null> {
  return get(`${BASE}/api/events/timeline`, params);
}

// --- Session & project endpoints ---

export async function fetchSessions(): Promise<unknown[] | null> {
  return get(`${BASE}/api/sessions`);
}

export async function fetchProjects(): Promise<ProjectInfo[] | null> {
  return get<ProjectInfo>(`${BASE}/api/projects`);
}

// --- Process endpoints ---

export async function fetchProcesses(params?: {
  type?: string;
  project?: string;
}): Promise<DevProcess[] | null> {
  return get<DevProcess>(`${BASE}/api/processes`, params);
}

export async function fetchPorts(params?: {
  port?: number;
}): Promise<PortUsage[] | null> {
  return get<PortUsage>(`${BASE}/api/ports`, params);
}

// --- Bulk operations ---

export async function clearEvents(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/events`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}
