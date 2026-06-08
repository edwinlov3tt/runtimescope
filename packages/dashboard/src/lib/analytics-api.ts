// Analytics data layer. Mirrors lib/api.ts's pattern: every request goes through
// authHeaders() (bearer) and routes a 401 → the login gate. NEVER raw fetch in a
// component. The helper names (get/getList/post/put/del) are also what the drift
// detector keys off to infer the HTTP method, so each /api/analytics/* literal
// below maps to a real, registered collector route.

import { authHeaders } from '@/lib/auth';
import { useAuthStore } from '@/stores/use-auth-store';
import type {
  OverviewData,
  AnalyticsUser,
  AnalyticsUserDetail,
  FeatureRollup,
  TrendsData,
  FeatureTrendsData,
  EventMixItem,
  CohortRow,
  FunnelData,
  CompareRow,
  Role,
  Baseline,
  BaselineHistoryEntry,
  Submission,
  Projection,
} from '@/lib/analytics-types';

type Params = Record<string, string | number | undefined>;

function buildUrl(path: string, params?: Params): string {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function on401(res: Response): void {
  if (res.status === 401) useAuthStore.getState().markUnauthorized();
}

/** GET an object endpoint → unwrapped `data` object (or null). */
async function get<T>(path: string, params?: Params): Promise<T | null> {
  try {
    const res = await fetch(buildUrl(path, params), { headers: authHeaders() });
    if (!res.ok) {
      on401(res);
      return null;
    }
    const json = await res.json();
    return (json?.data ?? null) as T | null;
  } catch {
    return null;
  }
}

/** GET a list endpoint → unwrapped `data` array (or null). */
async function getList<T>(path: string, params?: Params): Promise<T[] | null> {
  const data = await get<T[]>(path, params);
  return Array.isArray(data) ? data : null;
}

async function mutate<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(buildUrl(path), {
      method,
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      on401(res);
      return null;
    }
    const json = await res.json();
    return (json?.data ?? null) as T | null;
  } catch {
    return null;
  }
}
const post = <T,>(path: string, body?: unknown) => mutate<T>(path, 'POST', body);
const put = <T,>(path: string, body?: unknown) => mutate<T>(path, 'PUT', body);
const del = <T,>(path: string) => mutate<T>(path, 'DELETE');

// ── Reads (slices 1-2 usage + slice 3a ROI $, all live) ──
export const fetchOverview = (window?: string, projectId?: string) =>
  get<OverviewData>('/api/analytics/overview', { window, project_id: projectId });

export const fetchAnalyticsUsers = (projectId?: string) =>
  getList<AnalyticsUser>('/api/analytics/users', { project_id: projectId });

export const fetchAnalyticsUser = (anonId: string) =>
  get<AnalyticsUserDetail>(`/api/analytics/users/${encodeURIComponent(anonId)}`);

export const fetchFeatures = (window?: string, projectId?: string) =>
  getList<FeatureRollup>('/api/analytics/features', { window, project_id: projectId });

export const fetchTrends = (window?: string, buckets?: number, projectId?: string) =>
  get<TrendsData>('/api/analytics/trends', { window, buckets, project_id: projectId });

export const fetchFeatureTrends = (window?: string, buckets?: number, top?: number, projectId?: string) =>
  get<FeatureTrendsData>('/api/analytics/feature-trends', { window, buckets, top, project_id: projectId });

export const fetchEventMix = (window?: string, projectId?: string) =>
  getList<EventMixItem>('/api/analytics/event-mix', { window, project_id: projectId });

export const fetchCohorts = (weeks?: number, projectId?: string) =>
  getList<CohortRow>('/api/analytics/cohorts', { weeks, project_id: projectId });

export const fetchFunnel = (projectId?: string) =>
  get<FunnelData>('/api/analytics/funnel', { project_id: projectId });

export const fetchCompare = (by: 'role' | 'app', window?: string, projectId?: string) =>
  getList<CompareRow>('/api/analytics/compare', { by, window, project_id: projectId });

export const fetchRoles = () => getList<Role>('/api/analytics/roles');

export const fetchBaselines = (projectId?: string) =>
  getList<Baseline>('/api/analytics/baselines', { project_id: projectId });

export const fetchBaselineHistory = (fn: string) =>
  getList<BaselineHistoryEntry>('/api/analytics/baselines/history', { fn });

export const fetchSubmissions = () =>
  getList<Submission>('/api/analytics/baselines/submissions');

export const fetchProjections = (projectId?: string) =>
  getList<Projection>('/api/analytics/projections', { project_id: projectId });

// ── Mutations ──
export const putBaseline = (b: { fn: string; manualMin: number; toolMin: number; perItem?: boolean; source?: string }) =>
  put<{ fn: string; ok: boolean }>('/api/analytics/baselines', b);

export const putRole = (b: { role: string; hourlyRate: number }) =>
  put<{ role: string; ok: boolean }>('/api/analytics/roles', b);

export const postSubmission = (b: { fn: string; manualMin: number; anonId?: string }) =>
  post<{ id: number; ok: boolean }>('/api/analytics/baselines/submissions', b);

export const acceptSubmission = (id: number) =>
  post<{ accepted: boolean }>(`/api/analytics/baselines/submissions/${id}/accept`);

export const dismissSubmission = (id: number) =>
  del<{ dismissed: boolean }>(`/api/analytics/baselines/submissions/${id}`);

export const postProjection = (b: { quarter: string; projHours: number; projValue: number; notes?: string; setBy?: string }) =>
  post<{ quarter: string; ok: boolean }>('/api/analytics/projections', b);
