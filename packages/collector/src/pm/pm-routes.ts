import { readdir, readFile, writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execSync, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PmStore } from './pm-store.js';
import type { ProjectDiscovery } from './project-discovery.js';
import type { TaskStatus, PmTask, PmNote, GitFileStatus, GitFileChange, GitStatus, GitCommit } from './pm-types.js';

// ============================================================
// Managed Dev Server Processes
// ============================================================

type DevServerStatus = 'starting' | 'running' | 'stopped' | 'crashed';

interface ManagedProcess {
  pid: number;
  command: string;
  projectId: string;
  startedAt: number;
  status: DevServerStatus;
  child: ChildProcess;
  logs: string[];
  exitCode: number | null;
}

const LOG_RING_SIZE = 500;
const managedProcesses = new Map<string, ManagedProcess>();

function pushLog(mp: ManagedProcess, stream: 'stdout' | 'stderr', line: string): void {
  const entry = `[${stream}] ${line}`;
  if (mp.logs.length >= LOG_RING_SIZE) mp.logs.shift();
  mp.logs.push(entry);
}

export type DevServerBroadcast = (msg: unknown) => void;

// ============================================================
// Project Management HTTP Routes
// All routes under /api/pm/* — registered as pattern routes
// ============================================================

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams,
) => void | Promise<void>;

interface RouteHelpers {
  json: (res: ServerResponse, data: unknown, status?: number) => void;
  readBody: (req: IncomingMessage, maxBytes: number) => Promise<string | null>;
}

interface PatternRoute {
  method: string;
  pattern: string;        // e.g. '/api/pm/projects/:id'
  segments: string[];     // split pattern for matching
  handler: RouteHandler;
}

export function createPmRouter(
  pmStore: PmStore,
  discovery: ProjectDiscovery,
  helpers: RouteHelpers,
  broadcastDevServer?: DevServerBroadcast,
): { match: (method: string, pathname: string) => { handler: RouteHandler; pathParams: Record<string, string> } | null } {
  const routes: PatternRoute[] = [];

  function route(method: string, pattern: string, handler: RouteHandler): void {
    routes.push({ method, pattern, segments: pattern.split('/'), handler });
  }

  // ============================================================
  // Discovery
  // ============================================================

  route('POST', '/api/pm/discover', async (_req, res) => {
    try {
      const result = await discovery.discoverAll();
      helpers.json(res, result);
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  // ============================================================
  // Projects
  // ============================================================

  route('GET', '/api/pm/categories', (_req, res) => {
    const categories = pmStore.listCategories();
    helpers.json(res, { data: categories });
  });

  route('GET', '/api/pm/projects', (_req, res, params) => {
    const id = params.get('id');
    if (id) {
      const project = pmStore.getProject(id);
      if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }
      const stats = pmStore.getSessionStats(id);
      helpers.json(res, { ...project, stats });
      return;
    }
    const projects = pmStore.listProjects();
    helpers.json(res, { data: projects, count: projects.length });
  });

  route('GET', '/api/pm/projects/export-csv', (_req, res, params) => {
    const startDate = params.get('start_date') ?? undefined;
    const endDate = params.get('end_date') ?? undefined;
    const hideEmpty = params.get('hide_empty') === '1' || params.get('hide_empty') === 'true';
    const projectIdsRaw = params.get('project_ids') ?? '';
    const projectIds = projectIdsRaw ? projectIdsRaw.split(',').filter(Boolean) : undefined;

    // Get summaries
    const allSummaries = pmStore.getProjectSummaries({ startDate, endDate, hideEmpty });
    const summaries = projectIds
      ? allSummaries.filter((s) => projectIds.includes(s.id))
      : allSummaries;

    // Get sessions for these projects
    const projectIdSet = new Set(summaries.map((s) => s.id));
    const allSessions: ReturnType<typeof pmStore.listSessions> = [];
    for (const pid of projectIdSet) {
      const sessions = pmStore.listSessions(pid, { limit: 10000, offset: 0, startDate, endDate, hideEmpty });
      allSessions.push(...sessions);
    }
    // Sort sessions newest first
    allSessions.sort((a, b) => b.startedAt - a.startedAt);

    // Build CSV
    const csvEscape = (val: string | number | null | undefined): string => {
      if (val === null || val === undefined) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines: string[] = [];

    // Projects section
    lines.push('=== PROJECTS ===');
    lines.push('Project,Category,Sessions,Messages,Cost ($),Active Time (min),Last Session');
    for (const p of summaries) {
      lines.push([
        csvEscape(p.name),
        csvEscape(p.category),
        p.session_count,
        p.total_messages,
        (p.total_cost / 1_000_000).toFixed(2),
        Math.round(p.total_active_minutes),
        p.last_session_at ? new Date(p.last_session_at).toISOString().split('T')[0] : '',
      ].join(','));
    }

    lines.push('');

    // Sessions section
    lines.push('=== SESSIONS ===');
    lines.push('Project,Session ID,Slug,Model,Date,Messages,Tokens In,Tokens Out,Cost ($),Active Time (min),Branch');
    for (const s of allSessions) {
      const proj = summaries.find((p) => p.id === s.projectId);
      lines.push([
        csvEscape(proj?.name ?? s.projectId),
        csvEscape(s.id),
        csvEscape(s.slug),
        csvEscape(s.model),
        new Date(s.startedAt).toISOString().split('T')[0],
        s.messageCount,
        s.totalInputTokens,
        s.totalOutputTokens,
        (s.costMicrodollars / 1_000_000).toFixed(2),
        Math.round(s.activeMinutes),
        csvEscape(s.gitBranch),
      ].join(','));
    }

    const csv = lines.join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="runtimescope-export-${new Date().toISOString().split('T')[0]}.csv"`,
    });
    res.end(csv);
  });

  route('GET', '/api/pm/projects/summaries', (_req, res, params) => {
    const startDate = params.get('start_date') ?? undefined;
    const endDate = params.get('end_date') ?? undefined;
    const hideEmpty = params.get('hide_empty') === '1' || params.get('hide_empty') === 'true';
    const summaries = pmStore.getProjectSummaries({ startDate, endDate, hideEmpty });
    helpers.json(res, { data: summaries, count: summaries.length });
  });

  route('GET', '/api/pm/projects/:id', (_req, res, params) => {
    const id = params.get('id')!;
    const project = pmStore.getProject(id);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }
    const stats = pmStore.getSessionStats(id);
    helpers.json(res, { ...project, stats });
  });

  route('PUT', '/api/pm/projects/:id', async (req, res, params) => {
    const id = params.get('id')!;
    const body = await helpers.readBody(req, 65536);
    if (!body) { helpers.json(res, { error: 'Body required' }, 400); return; }
    try {
      const updates = JSON.parse(body);
      pmStore.updateProject(id, updates);
      helpers.json(res, { ok: true });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 400);
    }
  });

  // ============================================================
  // Tasks
  // ============================================================

  route('GET', '/api/pm/tasks', (_req, res, params) => {
    const projectId = params.get('project_id') ?? undefined;
    const status = (params.get('status') ?? undefined) as TaskStatus | undefined;
    const tasks = pmStore.listTasks(projectId, status);
    helpers.json(res, { data: tasks, count: tasks.length });
  });

  route('POST', '/api/pm/tasks', async (req, res) => {
    const body = await helpers.readBody(req, 65536);
    if (!body) { helpers.json(res, { error: 'Body required' }, 400); return; }
    try {
      const data = JSON.parse(body);
      const now = Date.now();
      const task: PmTask = {
        id: crypto.randomUUID(),
        projectId: data.projectId ?? undefined,
        title: data.title,
        description: data.description ?? undefined,
        status: data.status ?? 'todo',
        priority: data.priority ?? 'medium',
        labels: data.labels ?? [],
        source: data.source ?? 'manual',
        sourceRef: data.sourceRef ?? undefined,
        sortOrder: data.sortOrder ?? now,
        assignedTo: data.assignedTo ?? undefined,
        dueDate: data.dueDate ?? undefined,
        createdAt: now,
        updatedAt: now,
        completedAt: undefined,
      };
      pmStore.createTask(task);
      helpers.json(res, task, 201);
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 400);
    }
  });

  route('PUT', '/api/pm/tasks/:id', async (req, res, params) => {
    const id = params.get('id')!;
    const body = await helpers.readBody(req, 65536);
    if (!body) { helpers.json(res, { error: 'Body required' }, 400); return; }
    try {
      const updates = JSON.parse(body);
      pmStore.updateTask(id, updates);
      helpers.json(res, { ok: true });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 400);
    }
  });

  route('DELETE', '/api/pm/tasks/:id', (_req, res, params) => {
    const id = params.get('id')!;
    pmStore.deleteTask(id);
    helpers.json(res, { ok: true });
  });

  route('PUT', '/api/pm/tasks/:id/reorder', async (req, res, params) => {
    const id = params.get('id')!;
    const body = await helpers.readBody(req, 4096);
    if (!body) { helpers.json(res, { error: 'Body required' }, 400); return; }
    try {
      const { status, sortOrder } = JSON.parse(body);
      pmStore.reorderTask(id, status, sortOrder);
      helpers.json(res, { ok: true });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 400);
    }
  });

  // ============================================================
  // Sessions
  // ============================================================

  route('GET', '/api/pm/sessions', (_req, res, params) => {
    const projectId = params.get('project_id') ?? undefined;
    const limit = parseInt(params.get('limit') ?? '100', 10);
    const offset = parseInt(params.get('offset') ?? '0', 10);
    const startDate = params.get('start_date') ?? undefined;
    const endDate = params.get('end_date') ?? undefined;
    const hideEmpty = params.get('hide_empty') === '1' || params.get('hide_empty') === 'true';
    const sessions = pmStore.listSessions(projectId, { limit, offset, startDate, endDate, hideEmpty });
    const stats = pmStore.getSessionStats(projectId, { startDate, endDate, hideEmpty });
    helpers.json(res, { data: sessions, count: sessions.length, total: stats.totalSessions });
  });

  route('GET', '/api/pm/sessions/stats', (_req, res, params) => {
    const projectId = params.get('project_id') || undefined;
    const startDate = params.get('start_date') ?? undefined;
    const endDate = params.get('end_date') ?? undefined;
    const hideEmpty = params.get('hide_empty') === '1' || params.get('hide_empty') === 'true';
    const stats = pmStore.getSessionStats(projectId, { startDate, endDate, hideEmpty });
    helpers.json(res, stats);
  });

  route('GET', '/api/pm/sessions/:id', (_req, res, params) => {
    const id = params.get('id')!;
    const session = pmStore.getSession(id);
    if (!session) { helpers.json(res, { error: 'Session not found' }, 404); return; }
    helpers.json(res, session);
  });

  route('POST', '/api/pm/sessions/:id/refresh', async (_req, res, params) => {
    const id = params.get('id')!;
    const session = pmStore.getSession(id);
    if (!session) { helpers.json(res, { error: 'Session not found' }, 404); return; }
    try {
      await discovery.indexProjectSessions(session.projectId);
      const updated = pmStore.getSession(id);
      helpers.json(res, updated);
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  // ============================================================
  // Notes
  // ============================================================

  route('GET', '/api/pm/notes', (_req, res, params) => {
    const projectId = params.get('project_id') ?? undefined;
    const pinned = params.get('pinned') === '1' ? true : undefined;
    const notes = pmStore.listNotes({ projectId, pinned });
    helpers.json(res, { data: notes, count: notes.length });
  });

  route('POST', '/api/pm/notes', async (req, res) => {
    const body = await helpers.readBody(req, 1_048_576); // 1MB for note content
    if (!body) { helpers.json(res, { error: 'Body required' }, 400); return; }
    try {
      const data = JSON.parse(body);
      const now = Date.now();
      const note: PmNote = {
        id: crypto.randomUUID(),
        projectId: data.projectId ?? undefined,
        sessionId: data.sessionId ?? undefined,
        title: data.title ?? 'Untitled',
        content: data.content ?? '',
        pinned: data.pinned ?? false,
        tags: data.tags ?? [],
        createdAt: now,
        updatedAt: now,
      };
      pmStore.createNote(note);
      helpers.json(res, note, 201);
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 400);
    }
  });

  route('PUT', '/api/pm/notes/:id', async (req, res, params) => {
    const id = params.get('id')!;
    const body = await helpers.readBody(req, 1_048_576);
    if (!body) { helpers.json(res, { error: 'Body required' }, 400); return; }
    try {
      const updates = JSON.parse(body);
      pmStore.updateNote(id, updates);
      helpers.json(res, { ok: true });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 400);
    }
  });

  route('DELETE', '/api/pm/notes/:id', (_req, res, params) => {
    const id = params.get('id')!;
    pmStore.deleteNote(id);
    helpers.json(res, { ok: true });
  });

  // ============================================================
  // Memory Files
  // ============================================================

  route('GET', '/api/pm/memory/:projectId', async (_req, res, params) => {
    const projectId = params.get('projectId')!;
    const project = pmStore.getProject(projectId);
    if (!project?.claudeProjectKey) {
      helpers.json(res, { data: [], count: 0 });
      return;
    }

    const memoryDir = join(homedir(), '.claude', 'projects', project.claudeProjectKey, 'memory');
    try {
      const files = await readdir(memoryDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      const result = await Promise.all(
        mdFiles.map(async (filename) => {
          const content = await readFile(join(memoryDir, filename), 'utf-8');
          return { filename, content, sizeBytes: Buffer.byteLength(content) };
        }),
      );
      helpers.json(res, { data: result, count: result.length });
    } catch {
      helpers.json(res, { data: [], count: 0 });
    }
  });

  route('GET', '/api/pm/memory/:projectId/:filename', async (_req, res, params) => {
    const projectId = params.get('projectId')!;
    const filename = sanitizeFilename(params.get('filename')!);
    const project = pmStore.getProject(projectId);
    if (!project?.claudeProjectKey) { helpers.json(res, { error: 'Project not found' }, 404); return; }

    const filePath = join(homedir(), '.claude', 'projects', project.claudeProjectKey, 'memory', filename);
    try {
      const content = await readFile(filePath, 'utf-8');
      helpers.json(res, { filename, content, sizeBytes: Buffer.byteLength(content) });
    } catch {
      helpers.json(res, { error: 'File not found' }, 404);
    }
  });

  route('PUT', '/api/pm/memory/:projectId/:filename', async (req, res, params) => {
    const projectId = params.get('projectId')!;
    const filename = sanitizeFilename(params.get('filename')!);
    const project = pmStore.getProject(projectId);
    if (!project?.claudeProjectKey) { helpers.json(res, { error: 'Project not found' }, 404); return; }

    const body = await helpers.readBody(req, 1_048_576); // 1MB limit
    if (!body) { helpers.json(res, { error: 'Body required' }, 400); return; }

    try {
      const { content } = JSON.parse(body);
      const memoryDir = join(homedir(), '.claude', 'projects', project.claudeProjectKey, 'memory');
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, filename), content, 'utf-8');
      helpers.json(res, { ok: true });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  route('DELETE', '/api/pm/memory/:projectId/:filename', async (_req, res, params) => {
    const projectId = params.get('projectId')!;
    const filename = sanitizeFilename(params.get('filename')!);
    const project = pmStore.getProject(projectId);
    if (!project?.claudeProjectKey) { helpers.json(res, { error: 'Project not found' }, 404); return; }

    const filePath = join(homedir(), '.claude', 'projects', project.claudeProjectKey, 'memory', filename);
    try {
      await unlink(filePath);
      helpers.json(res, { ok: true });
    } catch {
      helpers.json(res, { error: 'File not found' }, 404);
    }
  });

  // ============================================================
  // Rules (CLAUDE.md at 3 scopes)
  // ============================================================

  route('GET', '/api/pm/rules/:projectId', async (_req, res, params) => {
    const projectId = params.get('projectId')!;
    const project = pmStore.getProject(projectId);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }

    const paths = getRulesPaths(project.claudeProjectKey, project.path);
    const result = {
      global: await readRuleFile(paths.global),
      project: await readRuleFile(paths.project),
      local: await readRuleFile(paths.local),
    };
    helpers.json(res, result);
  });

  route('GET', '/api/pm/rules/:projectId/:scope', async (_req, res, params) => {
    const projectId = params.get('projectId')!;
    const scope = params.get('scope')!;
    if (!['global', 'project', 'local'].includes(scope)) {
      helpers.json(res, { error: 'Invalid scope. Must be: global, project, or local' }, 400);
      return;
    }
    const project = pmStore.getProject(projectId);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }

    const paths = getRulesPaths(project.claudeProjectKey, project.path);
    const filePath = paths[scope as keyof typeof paths];
    helpers.json(res, await readRuleFile(filePath));
  });

  route('PUT', '/api/pm/rules/:projectId/:scope', async (req, res, params) => {
    const projectId = params.get('projectId')!;
    const scope = params.get('scope')!;
    if (!['global', 'project', 'local'].includes(scope)) {
      helpers.json(res, { error: 'Invalid scope' }, 400);
      return;
    }
    const project = pmStore.getProject(projectId);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }

    const body = await helpers.readBody(req, 1_048_576);
    if (!body) { helpers.json(res, { error: 'Body required' }, 400); return; }

    try {
      const { content } = JSON.parse(body);
      const paths = getRulesPaths(project.claudeProjectKey, project.path);
      const filePath = paths[scope as keyof typeof paths];

      // Ensure parent directory exists
      const dir = join(filePath, '..');
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, content, 'utf-8');
      helpers.json(res, { ok: true });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  // ============================================================
  // Dev Server Management
  // ============================================================

  route('GET', '/api/pm/projects/:id/scripts', async (_req, res, params) => {
    const id = params.get('id')!;
    const project = pmStore.getProject(id);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }
    if (!project.path) { helpers.json(res, { data: { scripts: {}, recommended: null } }); return; }

    try {
      const pkgPath = join(project.path, 'package.json');
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      const scripts: Record<string, string> = pkg.scripts ?? {};
      const recommended = ['dev', 'start', 'serve'].find((s) => s in scripts) ?? null;
      helpers.json(res, { data: { scripts, recommended } });
    } catch {
      helpers.json(res, { data: { scripts: {}, recommended: null } });
    }
  });

  route('GET', '/api/pm/projects/:id/dev-server', (_req, res, params) => {
    const id = params.get('id')!;
    const mp = managedProcesses.get(id);
    if (!mp) { helpers.json(res, { data: { status: 'stopped' } }); return; }
    // Verify PID still alive
    try { process.kill(mp.pid, 0); } catch {
      managedProcesses.delete(id);
      helpers.json(res, { data: { status: 'stopped' } });
      return;
    }
    helpers.json(res, {
      data: {
        status: mp.status,
        pid: mp.pid,
        command: mp.command,
        startedAt: mp.startedAt,
        exitCode: mp.exitCode,
        logs: mp.logs.slice(-100),
      },
    });
  });

  route('POST', '/api/pm/projects/:id/dev-server', async (req, res, params) => {
    const id = params.get('id')!;
    const project = pmStore.getProject(id);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }
    if (!project.path) { helpers.json(res, { error: 'Project has no filesystem path' }, 400); return; }

    // Check if already running
    const existing = managedProcesses.get(id);
    if (existing) {
      try { process.kill(existing.pid, 0); helpers.json(res, { error: 'Dev server already running', data: { pid: existing.pid, status: existing.status } }, 409); return; } catch { managedProcesses.delete(id); }
    }

    const body = await helpers.readBody(req, 4096);
    let script: string | undefined;
    let command: string | undefined;
    if (body) {
      try {
        const data = JSON.parse(body);
        script = data.script;
        command = data.command;
      } catch { /* use defaults */ }
    }

    const finalCommand = command ?? (script ? `npm run ${script}` : 'npm run dev');
    const broadcast = broadcastDevServer ?? (() => {});

    try {
      const child = spawn(finalCommand, {
        cwd: project.path,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const pid = child.pid;
      if (!pid) { helpers.json(res, { error: 'Failed to spawn process' }, 500); return; }

      const managed: ManagedProcess = {
        pid,
        command: finalCommand,
        projectId: id,
        startedAt: Date.now(),
        status: 'starting',
        child,
        logs: [],
        exitCode: null,
      };
      managedProcesses.set(id, managed);

      // Broadcast starting status
      broadcast({ type: 'dev_server_status', projectId: id, status: 'starting', pid });

      // Flip to 'running' on first output or after 500ms
      let detectedPort: number | null = null;
      const flipTimer = setTimeout(() => {
        if (managed.status === 'starting') {
          managed.status = 'running';
          broadcast({ type: 'dev_server_status', projectId: id, status: 'running', pid, port: detectedPort });
        }
      }, 500);

      // Detect port from log output (e.g. "localhost:3000", "http://localhost:5173")
      const PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})/;

      // Capture stdout/stderr and broadcast log lines
      for (const [stream, src] of [['stdout', child.stdout!], ['stderr', child.stderr!]] as const) {
        let buf = '';
        src.on('data', (chunk: Buffer) => {
          if (managed.status === 'starting') {
            managed.status = 'running';
            clearTimeout(flipTimer);
            broadcast({ type: 'dev_server_status', projectId: id, status: 'running', pid, port: detectedPort });
          }
          buf += chunk.toString('utf-8');
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            // Detect port from output
            if (!detectedPort) {
              const portMatch = line.match(PORT_RE);
              if (portMatch) {
                detectedPort = parseInt(portMatch[1], 10);
                broadcast({ type: 'dev_server_status', projectId: id, status: 'running', pid, port: detectedPort });
              }
            }
            pushLog(managed, stream, line);
            broadcast({ type: 'dev_server_log', projectId: id, stream, line, ts: Date.now() });
          }
        });
      }

      child.on('exit', (code) => {
        clearTimeout(flipTimer);
        managed.status = code === 0 ? 'stopped' : 'crashed';
        managed.exitCode = code;
        broadcast({ type: 'dev_server_status', projectId: id, status: managed.status, pid, exitCode: code });
        // Keep in map briefly so status can be queried, then clean up
        setTimeout(() => managedProcesses.delete(id), 5000);
      });

      child.on('error', (err) => {
        clearTimeout(flipTimer);
        managed.status = 'crashed';
        pushLog(managed, 'stderr', `[error] ${err.message}`);
        broadcast({ type: 'dev_server_status', projectId: id, status: 'crashed', pid, error: err.message });
        setTimeout(() => managedProcesses.delete(id), 5000);
      });

      helpers.json(res, { data: { pid, command: finalCommand, cwd: project.path, status: 'starting' } });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  route('DELETE', '/api/pm/projects/:id/dev-server', async (req, res, params) => {
    const id = params.get('id')!;
    const project = pmStore.getProject(id);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }

    // Read optional signal from body
    let signal: NodeJS.Signals = 'SIGTERM';
    const body = await helpers.readBody(req, 1024);
    if (body) {
      try {
        const data = JSON.parse(body);
        if (data.signal === 'SIGKILL') signal = 'SIGKILL';
      } catch { /* use default */ }
    }

    // Find the process — check managed map first, then scan by cwd
    let pid: number | null = null;

    const managed = managedProcesses.get(id);
    if (managed) {
      pid = managed.pid;
      // Kill the child process tree if we have the reference
      try { managed.child.kill(signal); } catch { /* fallthrough to process.kill */ }
      managedProcesses.delete(id);
    } else if (project.path) {
      // Try to find a dev server process in the project's directory
      try {
        const output = execSync(
          `lsof -t +D "${project.path}" 2>/dev/null | head -5`,
          { encoding: 'utf-8', timeout: 5000 },
        ).trim();
        const pids = output.split('\n').filter(Boolean).map(Number).filter((n) => n > 1 && n !== process.pid);
        if (pids.length > 0) pid = pids[0];
      } catch { /* no process found */ }
    }

    if (!pid) { helpers.json(res, { error: 'No running dev server found for this project' }, 404); return; }

    try {
      process.kill(pid, signal);
      managedProcesses.delete(id);
      helpers.json(res, { data: { killed: true, pid, signal } });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      managedProcesses.delete(id);
      if (code === 'ESRCH') {
        // Process already exited — treat as success
        helpers.json(res, { data: { killed: true, pid, signal, note: 'Process already exited' } });
      } else {
        helpers.json(res, { error: `Failed to kill PID ${pid}: ${(err as Error).message}` }, 500);
      }
    }
  });

  // ============================================================
  // Git
  // ============================================================

  route('GET', '/api/pm/projects/:id/git/status', (_req, res, params) => {
    const id = params.get('id')!;
    const project = pmStore.getProject(id);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }
    if (!project.path) { helpers.json(res, { data: { isGitRepo: false, branch: '', staged: [], unstaged: [], untracked: [] } }); return; }

    if (!isGitRepo(project.path)) {
      helpers.json(res, { data: { isGitRepo: false, branch: '', staged: [], unstaged: [], untracked: [] } });
      return;
    }

    try {
      const branch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], project.path).trim();
      const porcelain = execGit(['status', '--porcelain'], project.path);
      const { staged, unstaged, untracked } = parseGitStatus(porcelain);
      helpers.json(res, { data: { isGitRepo: true, branch, staged, unstaged, untracked } });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  route('GET', '/api/pm/projects/:id/git/log', (_req, res, params) => {
    const id = params.get('id')!;
    const project = pmStore.getProject(id);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }
    if (!project.path || !isGitRepo(project.path)) { helpers.json(res, { data: [] }); return; }

    try {
      const raw = execGit(['log', '-30', '--format=%H%x00%h%x00%B%x00%an%x00%cr%x00%D%x01'], project.path);
      const commits: GitCommit[] = raw.trim().split('\x01').filter(Boolean).map((entry) => {
        const [hash, shortHash, message, author, relativeDate, refs] = entry.trim().split('\0');
        const fullMsg = (message ?? '').trim();
        const subject = fullMsg.split('\n')[0];
        return { hash, shortHash, subject, message: fullMsg, author, relativeDate, refs: refs?.trim() || '' };
      });
      helpers.json(res, { data: commits });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  route('POST', '/api/pm/projects/:id/git/stage', async (req, res, params) => {
    const id = params.get('id')!;
    const project = pmStore.getProject(id);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }
    if (!project.path || !isGitRepo(project.path)) { helpers.json(res, { error: 'Not a git repo' }, 400); return; }

    const body = await helpers.readBody(req, 65536);
    let files: string[] | undefined;
    if (body) {
      try { files = JSON.parse(body).files; } catch { /* stage all */ }
    }

    try {
      if (files && files.length > 0) {
        execGit(['add', '--', ...files], project.path);
      } else {
        execGit(['add', '-A'], project.path);
      }
      helpers.json(res, { ok: true });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  route('POST', '/api/pm/projects/:id/git/unstage', async (req, res, params) => {
    const id = params.get('id')!;
    const project = pmStore.getProject(id);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }
    if (!project.path || !isGitRepo(project.path)) { helpers.json(res, { error: 'Not a git repo' }, 400); return; }

    const body = await helpers.readBody(req, 65536);
    let files: string[] | undefined;
    if (body) {
      try { files = JSON.parse(body).files; } catch { /* unstage all */ }
    }

    try {
      if (files && files.length > 0) {
        execGit(['restore', '--staged', '--', ...files], project.path);
      } else {
        execGit(['reset', 'HEAD'], project.path);
      }
      helpers.json(res, { ok: true });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  route('POST', '/api/pm/projects/:id/git/commit', async (req, res, params) => {
    const id = params.get('id')!;
    const project = pmStore.getProject(id);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }
    if (!project.path || !isGitRepo(project.path)) { helpers.json(res, { error: 'Not a git repo' }, 400); return; }

    const body = await helpers.readBody(req, 65536);
    if (!body) { helpers.json(res, { error: 'Body required' }, 400); return; }

    try {
      const { message } = JSON.parse(body);
      if (!message || !message.trim()) { helpers.json(res, { error: 'Commit message required' }, 400); return; }
      const output = execGit(['commit', '-m', message], project.path);
      // Extract hash from output
      const hashMatch = output.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
      helpers.json(res, { ok: true, hash: hashMatch?.[1] ?? '' });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  route('GET', '/api/pm/projects/:id/git/diff', (_req, res, params) => {
    const id = params.get('id')!;
    const project = pmStore.getProject(id);
    if (!project) { helpers.json(res, { error: 'Project not found' }, 404); return; }
    if (!project.path || !isGitRepo(project.path)) { helpers.json(res, { data: { diff: '' } }); return; }

    const staged = params.get('staged') === '1' || params.get('staged') === 'true';
    const file = params.get('file') ?? undefined;

    try {
      const args = ['diff'];
      if (staged) args.push('--staged');
      if (file) args.push('--', file);
      const diff = execGit(args, project.path);
      helpers.json(res, { data: { diff } });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 500);
    }
  });

  // ============================================================
  // CapEx
  // ============================================================

  route('GET', '/api/pm/capex/:projectId', (_req, res, params) => {
    const projectId = params.get('projectId')!;
    const month = params.get('month') ?? undefined;
    const confirmed = params.get('confirmed') === '1' ? true : params.get('confirmed') === '0' ? false : undefined;
    const entries = pmStore.listCapexEntries(projectId, { month, confirmed });
    helpers.json(res, { data: entries, count: entries.length });
  });

  route('GET', '/api/pm/capex/:projectId/summary', (_req, res, params) => {
    const projectId = params.get('projectId')!;
    const startDate = params.get('start_date') ?? undefined;
    const endDate = params.get('end_date') ?? undefined;
    const summary = pmStore.getCapexSummary(projectId, { startDate, endDate });
    helpers.json(res, summary);
  });

  route('PUT', '/api/pm/capex/:projectId/:entryId', async (req, res, params) => {
    const entryId = params.get('entryId')!;
    const body = await helpers.readBody(req, 65536);
    if (!body) { helpers.json(res, { error: 'Body required' }, 400); return; }
    try {
      const updates = JSON.parse(body);
      pmStore.updateCapexEntry(entryId, updates);
      helpers.json(res, { ok: true });
    } catch (err) {
      helpers.json(res, { error: (err as Error).message }, 400);
    }
  });

  route('POST', '/api/pm/capex/:projectId/:entryId/confirm', (_req, res, params) => {
    const entryId = params.get('entryId')!;
    pmStore.confirmCapexEntry(entryId);
    helpers.json(res, { ok: true });
  });

  route('GET', '/api/pm/capex/:projectId/export', (_req, res, params) => {
    const projectId = params.get('projectId')!;
    const startDate = params.get('start_date') ?? undefined;
    const endDate = params.get('end_date') ?? undefined;
    const csv = pmStore.exportCapexCsv(projectId, { startDate, endDate });
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="capex-${projectId}.csv"`,
    });
    res.end(csv);
  });

  // ============================================================
  // Pattern matcher
  // ============================================================

  return {
    match(method: string, pathname: string) {
      const pathSegments = pathname.split('/');

      for (const r of routes) {
        if (r.method !== method) continue;
        if (r.segments.length !== pathSegments.length) continue;

        const pathParams: Record<string, string> = {};
        let matched = true;

        for (let i = 0; i < r.segments.length; i++) {
          if (r.segments[i].startsWith(':')) {
            pathParams[r.segments[i].slice(1)] = decodeURIComponent(pathSegments[i]);
          } else if (r.segments[i] !== pathSegments[i]) {
            matched = false;
            break;
          }
        }

        if (matched) {
          return { handler: r.handler, pathParams };
        }
      }

      return null;
    },
  };
}

// ============================================================
// Helpers
// ============================================================

function sanitizeFilename(name: string): string {
  // Strip path separators and double dots to prevent traversal
  return name.replace(/[/\\]/g, '').replace(/\.\./g, '');
}

function getRulesPaths(claudeProjectKey?: string, projectPath?: string) {
  const home = homedir();
  return {
    global: join(home, '.claude', 'CLAUDE.md'),
    project: claudeProjectKey
      ? join(home, '.claude', 'projects', claudeProjectKey, 'CLAUDE.md')
      : join(projectPath ?? '', '.claude', 'CLAUDE.md'),
    local: projectPath
      ? join(projectPath, 'CLAUDE.md')
      : join(home, 'CLAUDE.md'),
  };
}

function execGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
}

function isGitRepo(path: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: path, encoding: 'utf-8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function parseGitStatus(porcelain: string): { staged: GitFileChange[]; unstaged: GitFileChange[]; untracked: GitFileChange[] } {
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];

  for (const line of porcelain.split('\n')) {
    if (!line || line.length < 4) continue;
    const x = line[0]; // index (staging area) status
    const y = line[1]; // worktree status
    const filepath = line.slice(3);

    // Handle renames: "R  old -> new"
    let path = filepath;
    let oldPath: string | undefined;
    if (filepath.includes(' -> ')) {
      const parts = filepath.split(' -> ');
      oldPath = parts[0];
      path = parts[1];
    }

    // Untracked
    if (x === '?' && y === '?') {
      untracked.push({ path, status: '?' });
      continue;
    }

    // Staged changes (index column)
    if (x !== ' ' && x !== '?') {
      staged.push({ path, status: x as GitFileStatus, oldPath });
    }

    // Unstaged changes (worktree column)
    if (y !== ' ' && y !== '?') {
      unstaged.push({ path, status: y as GitFileStatus });
    }
  }

  return { staged, unstaged, untracked };
}

async function readRuleFile(filePath: string): Promise<{ path: string; content: string; exists: boolean }> {
  try {
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      return { path: filePath, content, exists: true };
    }
  } catch { /* ignore */ }
  return { path: filePath, content: '', exists: false };
}
