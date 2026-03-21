import type {
  NetworkEvent,
  ConsoleEvent,
  StateEvent,
  RenderEvent,
  PerformanceEvent,
  DatabaseEvent,
  CustomEvent,
  UIInteractionEvent,
  NavigationEvent,
  DevProcess,
  PortUsage,
} from '@/lib/runtime-types';

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

/**
 * Find all runtime projects matching a PM project.
 * When runtimeApps is set (grouped project), returns all matching apps.
 * Otherwise falls back to legacy single-match strategy.
 */
export function findRuntimeProjects(
  runtimeProjects: ProjectInfo[],
  opts: { runtimescopeProject?: string; runtimeApps?: string[]; name?: string },
): ProjectInfo[] {
  if (!runtimeProjects.length) return [];

  // Grouped project: match all listed app names
  if (opts.runtimeApps?.length) {
    const appSet = new Set(opts.runtimeApps.map((a) => a.toLowerCase()));
    return runtimeProjects.filter((r) => appSet.has(r.appName.toLowerCase()));
  }

  // Legacy single-match: exact → case-insensitive → name fallback
  if (opts.runtimescopeProject) {
    const exact = runtimeProjects.find((r) => r.appName === opts.runtimescopeProject);
    if (exact) return [exact];
    const lower = opts.runtimescopeProject.toLowerCase();
    const ci = runtimeProjects.find((r) => r.appName.toLowerCase() === lower);
    if (ci) return [ci];
  }

  if (opts.name) {
    const nameLower = opts.name.toLowerCase();
    const byName = runtimeProjects.find((r) => r.appName.toLowerCase() === nameLower);
    if (byName) return [byName];
  }

  return [];
}

/** Find the first runtime project matching a PM project (backward-compatible). */
export function findRuntimeProject(
  runtimeProjects: ProjectInfo[],
  opts: { runtimescopeProject?: string; runtimeApps?: string[]; name?: string },
): ProjectInfo | undefined {
  return findRuntimeProjects(runtimeProjects, opts)[0];
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

export async function fetchCustomEvents(params?: {
  since_seconds?: number;
  name?: string;
  session_id?: string;
}): Promise<CustomEvent[] | null> {
  return get<CustomEvent>(`${BASE}/api/events/custom`, params);
}

export async function fetchUIEvents(params?: {
  since_seconds?: number;
  action?: 'click' | 'breadcrumb';
  session_id?: string;
}): Promise<UIInteractionEvent[] | null> {
  return get<UIInteractionEvent>(`${BASE}/api/events/ui`, params);
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

export async function killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<{ success: boolean; error?: string } | null> {
  try {
    const res = await fetch(`${BASE}/api/processes`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid, signal }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data ?? null;
  } catch {
    return null;
  }
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
