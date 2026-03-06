import { create } from 'zustand';
import { RuntimeScope } from '@runtimescope/sdk';
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
  GitStatus,
  GitCommit,
} from '@/lib/pm-types';
import type { ProjectSummary } from '@/lib/pm-api';
import * as pmApi from '@/lib/pm-api';

interface PmState {
  // Projects
  projects: PmProject[];
  projectsLoading: boolean;
  fetchProjects: () => Promise<void>;
  updateProject: (id: string, data: Partial<PmProject>) => Promise<void>;

  // Categories
  categories: string[];
  fetchCategories: () => Promise<void>;

  // Tasks
  tasks: PmTask[];
  tasksLoading: boolean;
  fetchTasks: (projectId?: string) => Promise<void>;
  createTask: (data: Parameters<typeof pmApi.createPmTask>[0]) => Promise<PmTask | null>;
  updateTask: (id: string, data: Partial<PmTask>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  reorderTask: (id: string, status: PmTask['status'], sortOrder: number) => Promise<void>;

  // Project Summaries (aggregated per-project stats)
  projectSummaries: ProjectSummary[];
  projectSummariesLoading: boolean;
  hideEmptySessions: boolean;
  setHideEmptySessions: (hide: boolean) => Promise<void>;
  fetchProjectSummaries: () => Promise<void>;

  // Sessions
  sessions: PmSession[];
  sessionsLoading: boolean;
  sessionsTotal: number;
  sessionStats: SessionStats | null;
  sessionDateRange: { start?: string; end?: string };
  fetchSessions: (projectId?: string) => Promise<void>;
  loadMoreSessions: (projectId?: string) => Promise<void>;
  fetchSessionStats: (projectId?: string) => Promise<void>;
  setSessionDateRange: (range: { start?: string; end?: string }, projectId?: string) => Promise<void>;

  // Notes
  notes: PmNote[];
  notesLoading: boolean;
  fetchNotes: (projectId?: string) => Promise<void>;
  createNote: (data: Parameters<typeof pmApi.createPmNote>[0]) => Promise<PmNote | null>;
  updateNote: (id: string, data: Partial<PmNote>) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;

  // Memory
  memoryFiles: MemoryFile[];
  memoryLoading: boolean;
  fetchMemoryFiles: (projectId: string) => Promise<void>;
  saveMemoryFile: (projectId: string, filename: string, content: string) => Promise<void>;
  deleteMemoryFile: (projectId: string, filename: string) => Promise<void>;

  // Rules
  rules: RulesFiles | null;
  rulesLoading: boolean;
  fetchRules: (projectId: string) => Promise<void>;
  saveRule: (projectId: string, scope: 'global' | 'project' | 'local', content: string) => Promise<void>;

  // CapEx
  capexEntries: PmCapexEntry[];
  capexSummary: CapexSummary | null;
  capexLoading: boolean;
  fetchCapex: (projectId: string) => Promise<void>;
  fetchCapexSummary: (projectId: string) => Promise<void>;
  updateCapexEntry: (projectId: string, entryId: string, data: Parameters<typeof pmApi.updateCapexEntry>[2]) => Promise<void>;
  confirmCapexEntry: (projectId: string, entryId: string) => Promise<void>;

  // Git
  gitStatus: GitStatus | null;
  gitStatusLoading: boolean;
  gitCommits: GitCommit[];
  gitCommitsLoading: boolean;
  fetchGitStatus: (projectId: string) => Promise<void>;
  fetchGitCommits: (projectId: string) => Promise<void>;
  stageFiles: (projectId: string, files?: string[]) => Promise<void>;
  unstageFiles: (projectId: string, files?: string[]) => Promise<void>;
  createGitCommit: (projectId: string, message: string) => Promise<boolean>;
}

export const usePmStore = create<PmState>((set, get) => ({
  // --- Projects ---
  projects: [],
  projectsLoading: false,
  fetchProjects: async () => {
    set({ projectsLoading: true });
    const projects = await pmApi.fetchPmProjects();
    set({ projects: projects ?? [], projectsLoading: false });
  },
  updateProject: async (id, data) => {
    await pmApi.updatePmProject(id, data);
    // Optimistic update
    set({ projects: get().projects.map((p) => (p.id === id ? { ...p, ...data } : p)) });
  },

  // --- Categories ---
  categories: [],
  fetchCategories: async () => {
    const cats = await pmApi.fetchCategories();
    set({ categories: cats ?? [] });
  },

  // --- Tasks ---
  tasks: [],
  tasksLoading: false,
  fetchTasks: async (projectId) => {
    set({ tasksLoading: true });
    const tasks = await pmApi.fetchPmTasks(projectId ? { project_id: projectId } : undefined);
    set({ tasks: tasks ?? [], tasksLoading: false });
  },
  createTask: async (data) => {
    const task = await pmApi.createPmTask(data);
    if (task) {
      set({ tasks: [...get().tasks, task] });
      RuntimeScope.track('task_created', {
        taskId: task.id,
        title: task.title,
        priority: task.priority,
        projectId: task.projectId,
      });
    }
    return task;
  },
  updateTask: async (id, data) => {
    const updated = await pmApi.updatePmTask(id, data);
    if (updated) {
      set({ tasks: get().tasks.map((t) => (t.id === id ? { ...t, ...updated } : t)) });
    }
  },
  deleteTask: async (id) => {
    const ok = await pmApi.deletePmTask(id);
    if (ok) set({ tasks: get().tasks.filter((t) => t.id !== id) });
  },
  reorderTask: async (id, status, sortOrder) => {
    const task = get().tasks.find((t) => t.id === id);
    const updated = await pmApi.reorderPmTask(id, { status, sortOrder });
    if (updated) {
      set({ tasks: get().tasks.map((t) => (t.id === id ? { ...t, ...updated } : t)) });
      if (status === 'done' && task?.status !== 'done') {
        RuntimeScope.track('task_completed', {
          taskId: id,
          title: task?.title,
          priority: task?.priority,
          projectId: task?.projectId,
        });
      }
    }
  },

  // --- Project Summaries ---
  projectSummaries: [],
  projectSummariesLoading: false,
  hideEmptySessions: true,
  setHideEmptySessions: async (hide) => {
    set({ hideEmptySessions: hide });
    // Re-fetch summaries and stats
    await Promise.all([
      get().fetchProjectSummaries(),
      get().fetchSessionStats(),
    ]);
  },
  fetchProjectSummaries: async () => {
    set({ projectSummariesLoading: true });
    const { start, end } = get().sessionDateRange;
    const hide = get().hideEmptySessions;
    const summaries = await pmApi.fetchProjectSummaries({
      ...(start ? { start_date: start } : {}),
      ...(end ? { end_date: end } : {}),
      ...(hide ? { hide_empty: true } : {}),
    });
    set({ projectSummaries: summaries ?? [], projectSummariesLoading: false });
  },

  // --- Sessions ---
  sessions: [],
  sessionsLoading: false,
  sessionsTotal: 0,
  sessionStats: null,
  sessionDateRange: {},
  fetchSessions: async (projectId) => {
    set({ sessionsLoading: true });
    const { start, end } = get().sessionDateRange;
    const hide = get().hideEmptySessions;
    const result = await pmApi.fetchPmSessions({
      ...(projectId ? { project_id: projectId } : {}),
      ...(start ? { start_date: start } : {}),
      ...(end ? { end_date: end } : {}),
      ...(hide ? { hide_empty: true } : {}),
    });
    set({ sessions: result?.sessions ?? [], sessionsTotal: result?.total ?? 0, sessionsLoading: false });
  },
  loadMoreSessions: async (projectId) => {
    const current = get().sessions;
    const { start, end } = get().sessionDateRange;
    const hide = get().hideEmptySessions;
    set({ sessionsLoading: true });
    const result = await pmApi.fetchPmSessions({
      ...(projectId ? { project_id: projectId } : {}),
      ...(start ? { start_date: start } : {}),
      ...(end ? { end_date: end } : {}),
      ...(hide ? { hide_empty: true } : {}),
      limit: 100,
      offset: current.length,
    });
    if (result) {
      set({ sessions: [...current, ...result.sessions], sessionsTotal: result.total, sessionsLoading: false });
    } else {
      set({ sessionsLoading: false });
    }
  },
  fetchSessionStats: async (projectId) => {
    const { start, end } = get().sessionDateRange;
    const hide = get().hideEmptySessions;
    const stats = await pmApi.fetchSessionStats({
      ...(projectId ? { project_id: projectId } : {}),
      ...(start ? { start_date: start } : {}),
      ...(end ? { end_date: end } : {}),
      ...(hide ? { hide_empty: true } : {}),
    });
    set({ sessionStats: stats });
  },
  setSessionDateRange: async (range, projectId) => {
    set({ sessionDateRange: range });
    const { start, end } = range;
    const hide = get().hideEmptySessions;
    set({ sessionsLoading: true, projectSummariesLoading: true });
    const [result, stats, summaries] = await Promise.all([
      pmApi.fetchPmSessions({
        ...(projectId ? { project_id: projectId } : {}),
        ...(start ? { start_date: start } : {}),
        ...(end ? { end_date: end } : {}),
        ...(hide ? { hide_empty: true } : {}),
      }),
      pmApi.fetchSessionStats({
        ...(projectId ? { project_id: projectId } : {}),
        ...(start ? { start_date: start } : {}),
        ...(end ? { end_date: end } : {}),
        ...(hide ? { hide_empty: true } : {}),
      }),
      pmApi.fetchProjectSummaries({
        ...(start ? { start_date: start } : {}),
        ...(end ? { end_date: end } : {}),
        ...(hide ? { hide_empty: true } : {}),
      }),
    ]);
    set({
      sessions: result?.sessions ?? [],
      sessionsTotal: result?.total ?? 0,
      sessionStats: stats,
      projectSummaries: summaries ?? [],
      sessionsLoading: false,
      projectSummariesLoading: false,
    });
  },

  // --- Notes ---
  notes: [],
  notesLoading: false,
  fetchNotes: async (projectId) => {
    set({ notesLoading: true });
    const notes = await pmApi.fetchPmNotes(projectId ? { project_id: projectId } : undefined);
    set({ notes: notes ?? [], notesLoading: false });
  },
  createNote: async (data) => {
    const note = await pmApi.createPmNote(data);
    if (note) set({ notes: [note, ...get().notes] });
    return note;
  },
  updateNote: async (id, data) => {
    const updated = await pmApi.updatePmNote(id, data);
    if (updated) {
      set({ notes: get().notes.map((n) => (n.id === id ? { ...n, ...updated } : n)) });
    }
  },
  deleteNote: async (id) => {
    const ok = await pmApi.deletePmNote(id);
    if (ok) set({ notes: get().notes.filter((n) => n.id !== id) });
  },

  // --- Memory ---
  memoryFiles: [],
  memoryLoading: false,
  fetchMemoryFiles: async (projectId) => {
    set({ memoryLoading: true });
    const files = await pmApi.fetchMemoryFiles(projectId);
    set({ memoryFiles: files ?? [], memoryLoading: false });
  },
  saveMemoryFile: async (projectId, filename, content) => {
    const saved = await pmApi.saveMemoryFile(projectId, filename, content);
    if (saved) {
      const files = get().memoryFiles;
      const idx = files.findIndex((f) => f.filename === filename);
      if (idx >= 0) {
        set({ memoryFiles: files.map((f, i) => (i === idx ? saved : f)) });
      } else {
        set({ memoryFiles: [...files, saved] });
      }
    }
  },
  deleteMemoryFile: async (projectId, filename) => {
    const ok = await pmApi.deleteMemoryFile(projectId, filename);
    if (ok) set({ memoryFiles: get().memoryFiles.filter((f) => f.filename !== filename) });
  },

  // --- Rules ---
  rules: null,
  rulesLoading: false,
  fetchRules: async (projectId) => {
    set({ rulesLoading: true });
    const rules = await pmApi.fetchRules(projectId);
    set({ rules, rulesLoading: false });
  },
  saveRule: async (projectId, scope, content) => {
    const saved = await pmApi.saveRule(projectId, scope, content);
    if (saved && get().rules) {
      set({
        rules: {
          ...get().rules!,
          [scope]: { ...get().rules![scope], content: saved.content, exists: true },
        },
      });
    }
  },

  // --- CapEx ---
  capexEntries: [],
  capexSummary: null,
  capexLoading: false,
  fetchCapex: async (projectId) => {
    set({ capexLoading: true });
    const entries = await pmApi.fetchCapexEntries(projectId);
    set({ capexEntries: entries ?? [], capexLoading: false });
  },
  fetchCapexSummary: async (projectId) => {
    const summary = await pmApi.fetchCapexSummary(projectId);
    set({ capexSummary: summary });
  },
  updateCapexEntry: async (projectId, entryId, data) => {
    const updated = await pmApi.updateCapexEntry(projectId, entryId, data);
    if (updated) {
      set({ capexEntries: get().capexEntries.map((e) => (e.id === entryId ? { ...e, ...updated } : e)) });
    }
  },
  confirmCapexEntry: async (projectId, entryId) => {
    const confirmed = await pmApi.confirmCapexEntry(projectId, entryId);
    if (confirmed) {
      set({ capexEntries: get().capexEntries.map((e) => (e.id === entryId ? { ...e, ...confirmed } : e)) });
    }
  },

  // --- Git ---
  gitStatus: null,
  gitStatusLoading: false,
  gitCommits: [],
  gitCommitsLoading: false,
  fetchGitStatus: async (projectId) => {
    set({ gitStatusLoading: true });
    const status = await pmApi.fetchGitStatus(projectId);
    set({ gitStatus: status, gitStatusLoading: false });
  },
  fetchGitCommits: async (projectId) => {
    set({ gitCommitsLoading: true });
    const commits = await pmApi.fetchGitLog(projectId);
    set({ gitCommits: commits ?? [], gitCommitsLoading: false });
  },
  stageFiles: async (projectId, files) => {
    await pmApi.stageGitFiles(projectId, files);
    // Re-fetch status
    const status = await pmApi.fetchGitStatus(projectId);
    set({ gitStatus: status });
  },
  unstageFiles: async (projectId, files) => {
    await pmApi.unstageGitFiles(projectId, files);
    const status = await pmApi.fetchGitStatus(projectId);
    set({ gitStatus: status });
  },
  createGitCommit: async (projectId, message) => {
    const result = await pmApi.createGitCommit(projectId, message);
    if (result?.ok) {
      // Re-fetch both status and commits
      const [status, commits] = await Promise.all([
        pmApi.fetchGitStatus(projectId),
        pmApi.fetchGitLog(projectId),
      ]);
      set({ gitStatus: status, gitCommits: commits ?? [] });
      return true;
    }
    return false;
  },
}));
