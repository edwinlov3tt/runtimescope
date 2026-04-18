// ============================================================
// PM API Client — all calls to /api/pm/*
// ============================================================

import type {
  PmProject,
  PmTask,
  PmSession,
  PmNote,
  PmCapexEntry,
  CapexSummary,
  SessionStats,
  MemoryFile,
  RulesFiles,
  TaskStatus,
  TaskPriority,
  ProjectPhase,
  ProjectStatus,
  CapexClassification,
  WorkType,
  PmWorkspace,
  PmApiKey,
} from './pm-types';

const BASE = '';

async function json<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  return res.json();
}

async function get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T | null> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  try {
    const res = await fetch(url.toString());
    return json<T>(res);
  } catch {
    return null;
  }
}

/** GET for list endpoints that return { data: T[], count: number } */
async function getList<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T[] | null> {
  const envelope = await get<{ data: T[]; count: number }>(path, params);
  return envelope?.data ?? null;
}

async function post<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return json<T>(res);
  } catch {
    return null;
  }
}

async function put<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return json<T>(res);
  } catch {
    return null;
  }
}

async function del(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}${path}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Discovery ---

export async function triggerDiscovery() {
  return post<{ projectsDiscovered: number; sessionsDiscovered: number }>('/api/pm/discover');
}

// --- Projects ---

export async function fetchPmProjects() {
  return getList<PmProject>('/api/pm/projects');
}

export async function fetchPmProject(id: string) {
  return get<PmProject>(`/api/pm/projects/${id}`);
}

export async function updatePmProject(id: string, data: Partial<PmProject>) {
  return put<PmProject>(`/api/pm/projects/${id}`, data);
}

export async function deletePmProject(id: string): Promise<boolean> {
  return del(`/api/pm/projects/${id}`);
}

export async function fetchCategories(): Promise<string[] | null> {
  const envelope = await get<{ data: string[] }>('/api/pm/categories');
  return envelope?.data ?? null;
}

// --- Tasks ---

export async function fetchPmTasks(params?: { project_id?: string; status?: TaskStatus }) {
  return getList<PmTask>('/api/pm/tasks', params);
}

export async function createPmTask(data: {
  title: string;
  description?: string;
  projectId?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  labels?: string[];
}) {
  return post<PmTask>('/api/pm/tasks', data);
}

export async function updatePmTask(id: string, data: Partial<PmTask>) {
  return put<PmTask>(`/api/pm/tasks/${id}`, data);
}

export async function deletePmTask(id: string) {
  return del(`/api/pm/tasks/${id}`);
}

export async function reorderPmTask(id: string, data: { status: TaskStatus; sortOrder: number }) {
  return put<PmTask>(`/api/pm/tasks/${id}/reorder`, data);
}

// --- Sessions ---

export interface PaginatedSessions {
  sessions: PmSession[];
  total: number;
}

export async function fetchPmSessions(params?: { project_id?: string; limit?: number; offset?: number; start_date?: string; end_date?: string; hide_empty?: boolean }): Promise<PaginatedSessions | null> {
  const envelope = await get<{ data: PmSession[]; count: number; total: number }>('/api/pm/sessions', params);
  if (!envelope) return null;
  return { sessions: envelope.data, total: envelope.total };
}

export async function fetchPmSession(id: string) {
  return get<PmSession>(`/api/pm/sessions/${id}`);
}

export async function refreshPmSession(id: string) {
  return post<PmSession>(`/api/pm/sessions/${id}/refresh`);
}

export async function fetchSessionStats(params?: { project_id?: string; start_date?: string; end_date?: string; hide_empty?: boolean }) {
  return get<SessionStats>('/api/pm/sessions/stats', params);
}

// --- Project Summaries ---

export interface ProjectSummary {
  id: string;
  name: string;
  path: string | null;
  category: string | null;
  sdk_installed: number;
  runtimescope_project: string | null;
  runtime_apps: string | null;
  session_count: number;
  total_cost: number;
  total_active_minutes: number;
  last_session_at: number | null;
  total_messages: number;
}

export async function fetchProjectSummaries(params?: { start_date?: string; end_date?: string; hide_empty?: boolean }) {
  return getList<ProjectSummary>('/api/pm/projects/summaries', params as Record<string, string | number | boolean | undefined>);
}

// --- Notes ---

export async function fetchPmNotes(params?: { project_id?: string; pinned?: boolean }) {
  return getList<PmNote>('/api/pm/notes', params);
}

export async function createPmNote(data: {
  title: string;
  content?: string;
  projectId?: string;
  pinned?: boolean;
  tags?: string[];
}) {
  return post<PmNote>('/api/pm/notes', data);
}

export async function updatePmNote(id: string, data: Partial<PmNote>) {
  return put<PmNote>(`/api/pm/notes/${id}`, data);
}

export async function deletePmNote(id: string) {
  return del(`/api/pm/notes/${id}`);
}

// --- Memory ---

export async function fetchMemoryFiles(projectId: string) {
  return getList<MemoryFile>(`/api/pm/memory/${projectId}`);
}

export async function fetchMemoryFile(projectId: string, filename: string) {
  return get<MemoryFile>(`/api/pm/memory/${projectId}/${filename}`);
}

export async function saveMemoryFile(projectId: string, filename: string, content: string) {
  return put<MemoryFile>(`/api/pm/memory/${projectId}/${filename}`, { content });
}

export async function deleteMemoryFile(projectId: string, filename: string) {
  return del(`/api/pm/memory/${projectId}/${filename}`);
}

// --- Rules ---

export async function fetchRules(projectId: string) {
  return get<RulesFiles>(`/api/pm/rules/${projectId}`);
}

export async function saveRule(projectId: string, scope: 'global' | 'project' | 'local', content: string) {
  return put<{ path: string; content: string }>(`/api/pm/rules/${projectId}/${scope}`, { content });
}

// --- CapEx ---

export async function fetchCapexEntries(projectId: string) {
  return getList<PmCapexEntry>(`/api/pm/capex/${projectId}`);
}

export async function fetchCapexSummary(projectId: string) {
  return get<CapexSummary>(`/api/pm/capex/${projectId}/summary`);
}

export async function updateCapexEntry(projectId: string, entryId: string, data: {
  classification?: CapexClassification;
  workType?: WorkType;
  adjustmentFactor?: number;
  notes?: string;
}) {
  return put<PmCapexEntry>(`/api/pm/capex/${projectId}/${entryId}`, data);
}

export async function confirmCapexEntry(projectId: string, entryId: string) {
  return post<PmCapexEntry>(`/api/pm/capex/${projectId}/${entryId}/confirm`);
}

export function getCapexExportUrl(projectId: string): string {
  return `${BASE}/api/pm/capex/${projectId}/export`;
}

export function getCapexExportXlsxUrl(projectId: string): string {
  return `${BASE}/api/pm/capex-report/${projectId}`;
}

export function getCapexExportAllUrl(opts?: { category?: string }): string {
  const url = `${BASE}/api/pm/capex-report-all`;
  if (opts?.category) return `${url}?category=${encodeURIComponent(opts.category)}`;
  return url;
}

export interface GlobalCapexSummary {
  totalCost: number;
  capitalizable: number;
  expensed: number;
  activeMinutes: number;
  activeHours: number;
  confirmed: number;
  unconfirmed: number;
  projectCount: number;
}

export interface GlobalCapexByProject {
  projectId: string;
  projectName: string;
  category?: string;
  totalCost: number;
  capitalizable: number;
  expensed: number;
  activeMinutes: number;
  activeHours: number;
  confirmed: number;
  total: number;
}

export async function fetchGlobalCapex(category?: string): Promise<{
  summary: GlobalCapexSummary;
  byProject: GlobalCapexByProject[];
  entries: unknown[];
} | null> {
  const url = category
    ? `${BASE}/api/pm/capex-all?category=${encodeURIComponent(category)}`
    : `${BASE}/api/pm/capex-all`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return json.data ?? null;
  } catch {
    return null;
  }
}

// --- Git ---

import type { GitStatus, GitCommit } from './pm-types';

export async function fetchGitStatus(projectId: string) {
  const envelope = await get<{ data: GitStatus }>(`/api/pm/projects/${projectId}/git/status`);
  return envelope?.data ?? null;
}

export async function fetchGitLog(projectId: string) {
  const envelope = await get<{ data: GitCommit[] }>(`/api/pm/projects/${projectId}/git/log`);
  return envelope?.data ?? null;
}

export async function stageGitFiles(projectId: string, files?: string[]) {
  return post<{ ok: boolean }>(`/api/pm/projects/${projectId}/git/stage`, files ? { files } : undefined);
}

export async function unstageGitFiles(projectId: string, files?: string[]) {
  return post<{ ok: boolean }>(`/api/pm/projects/${projectId}/git/unstage`, files ? { files } : undefined);
}

export async function createGitCommit(projectId: string, message: string) {
  return post<{ ok: boolean; hash: string }>(`/api/pm/projects/${projectId}/git/commit`, { message });
}

export async function fetchGitDiff(projectId: string, opts?: { staged?: boolean; file?: string }) {
  const params: Record<string, string | boolean | undefined> = {};
  if (opts?.staged) params.staged = true;
  if (opts?.file) params.file = opts.file;
  const envelope = await get<{ data: { diff: string } }>(`/api/pm/projects/${projectId}/git/diff`, params);
  return envelope?.data?.diff ?? '';
}

// --- Dev Server ---

export interface DevServerState {
  status: 'starting' | 'running' | 'stopped' | 'crashed';
  pid?: number;
  command?: string;
  startedAt?: number;
  exitCode?: number | null;
  logs?: string[];
}

export async function fetchDevServerStatus(projectId: string): Promise<DevServerState | null> {
  const envelope = await get<{ data: DevServerState }>(`/api/pm/projects/${projectId}/dev-server`);
  return envelope?.data ?? null;
}

export interface ProjectScripts {
  scripts: Record<string, string>;
  recommended: string | null;
}

export async function fetchProjectScripts(projectId: string): Promise<ProjectScripts | null> {
  const envelope = await get<{ data: ProjectScripts }>(`/api/pm/projects/${projectId}/scripts`);
  return envelope?.data ?? null;
}

export async function startDevServer(projectId: string, options?: { script?: string; command?: string }) {
  return post<{ data: { pid: number; command: string; cwd: string } }>(`/api/pm/projects/${projectId}/dev-server`, options);
}

export async function stopDevServer(projectId: string) {
  try {
    const res = await fetch(`${BASE}/api/pm/projects/${projectId}/dev-server`, { method: 'DELETE' });
    return json<{ data: { killed: boolean; pid: number; signal: string } }>(res);
  } catch {
    return null;
  }
}

// ============================================================
// Workspaces (multi-tenant)
// ============================================================

export async function fetchWorkspaces(): Promise<PmWorkspace[]> {
  const res = await getList<PmWorkspace>('/api/pm/workspaces');
  return res ?? [];
}

export async function createWorkspace(input: {
  name: string;
  slug?: string;
  description?: string;
}): Promise<PmWorkspace | null> {
  return post<PmWorkspace>('/api/pm/workspaces', input);
}

export async function updateWorkspace(
  id: string,
  input: { name?: string; slug?: string; description?: string },
): Promise<PmWorkspace | null> {
  return put<PmWorkspace>(`/api/pm/workspaces/${id}`, input);
}

export async function deleteWorkspace(id: string): Promise<boolean> {
  return del(`/api/pm/workspaces/${id}`);
}

export async function moveProjectToWorkspace(
  projectId: string,
  workspaceId: string,
): Promise<boolean> {
  const res = await put(`/api/pm/projects/${projectId}/workspace`, { workspace_id: workspaceId });
  return res !== null;
}

// ============================================================
// API Keys (workspace-scoped)
// ============================================================

export async function fetchApiKeys(workspaceId: string): Promise<PmApiKey[]> {
  const res = await getList<PmApiKey>(`/api/pm/workspaces/${workspaceId}/api-keys`);
  return res ?? [];
}

/**
 * Creates a new API key. The returned `key` field is shown exactly once —
 * store it in the UI immediately, because the server will not reveal it again
 * on subsequent list calls.
 */
export async function createApiKey(
  workspaceId: string,
  label: string,
  expiresAt?: number,
): Promise<PmApiKey | null> {
  return post<PmApiKey>(`/api/pm/workspaces/${workspaceId}/api-keys`, {
    label,
    expires_at: expiresAt,
  });
}

export async function revokeApiKey(key: string): Promise<boolean> {
  return del(`/api/pm/api-keys/${encodeURIComponent(key)}`);
}
