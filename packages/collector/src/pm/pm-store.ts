import Database from 'better-sqlite3';
import type {
  PmProject,
  PmTask,
  PmSession,
  PmNote,
  PmCapexEntry,
  CapexSummary,
  SessionStats,
  TaskStatus,
  ProjectPhase,
  ProjectStatus,
} from './pm-types.js';

// ============================================================
// Project Management SQLite Store
// Global database at ~/.runtimescope/pm.db
// All tables prefixed with pm_ to avoid collision
// ============================================================

export interface PmStoreOptions {
  dbPath: string;
  walMode?: boolean;
}

export class PmStore {
  private db: InstanceType<typeof Database>;

  constructor(options: PmStoreOptions) {
    this.db = new Database(options.dbPath);

    if (options.walMode !== false) {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('synchronous = NORMAL');

    this.createSchema();
    this.runMigrations();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pm_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT,
        claude_project_key TEXT,
        runtimescope_project TEXT,
        phase TEXT NOT NULL DEFAULT 'preliminary',
        management_authorized INTEGER NOT NULL DEFAULT 0,
        probable_to_complete INTEGER NOT NULL DEFAULT 0,
        project_status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS pm_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'medium',
        labels TEXT,
        source TEXT DEFAULT 'manual',
        source_ref TEXT,
        sort_order REAL NOT NULL DEFAULT 0,
        assigned_to TEXT,
        due_date TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (project_id) REFERENCES pm_projects(id)
      );

      CREATE INDEX IF NOT EXISTS idx_pm_tasks_project ON pm_tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_pm_tasks_status ON pm_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_pm_tasks_sort ON pm_tasks(status, sort_order);

      CREATE TABLE IF NOT EXISTS pm_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        jsonl_path TEXT NOT NULL,
        jsonl_size INTEGER,
        first_prompt TEXT,
        summary TEXT,
        slug TEXT,
        model TEXT,
        version TEXT,
        git_branch TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        user_message_count INTEGER NOT NULL DEFAULT 0,
        assistant_message_count INTEGER NOT NULL DEFAULT 0,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cost_microdollars INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        active_minutes REAL NOT NULL DEFAULT 0,
        compaction_count INTEGER NOT NULL DEFAULT 0,
        pre_compaction_tokens INTEGER,
        permission_mode TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES pm_projects(id)
      );

      CREATE INDEX IF NOT EXISTS idx_pm_sessions_project ON pm_sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_pm_sessions_started ON pm_sessions(started_at DESC);

      CREATE TABLE IF NOT EXISTS pm_notes (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        session_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES pm_projects(id),
        FOREIGN KEY (session_id) REFERENCES pm_sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_pm_notes_project ON pm_notes(project_id);
      CREATE INDEX IF NOT EXISTS idx_pm_notes_pinned ON pm_notes(pinned DESC, updated_at DESC);

      CREATE TABLE IF NOT EXISTS pm_capex_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        classification TEXT NOT NULL DEFAULT 'expensed',
        work_type TEXT,
        active_minutes REAL NOT NULL DEFAULT 0,
        cost_microdollars INTEGER NOT NULL DEFAULT 0,
        adjustment_factor REAL NOT NULL DEFAULT 1.0,
        adjusted_cost_microdollars INTEGER NOT NULL DEFAULT 0,
        confirmed INTEGER NOT NULL DEFAULT 0,
        confirmed_at INTEGER,
        confirmed_by TEXT,
        notes TEXT,
        period TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES pm_projects(id),
        FOREIGN KEY (session_id) REFERENCES pm_sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_pm_capex_project ON pm_capex_entries(project_id);
      CREATE INDEX IF NOT EXISTS idx_pm_capex_period ON pm_capex_entries(period);
      CREATE INDEX IF NOT EXISTS idx_pm_capex_confirmed ON pm_capex_entries(confirmed);
    `);
  }

  private runMigrations(): void {
    // Add category and sdk_installed columns (added in v2)
    try { this.db.exec('ALTER TABLE pm_projects ADD COLUMN category TEXT DEFAULT NULL'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE pm_projects ADD COLUMN sdk_installed INTEGER DEFAULT 0'); } catch { /* already exists */ }
    // Add runtime_apps column (added in v3) — JSON array of associated SDK appNames
    try { this.db.exec('ALTER TABLE pm_projects ADD COLUMN runtime_apps TEXT DEFAULT NULL'); } catch { /* already exists */ }
  }

  // ============================================================
  // Projects
  // ============================================================

  upsertProject(project: PmProject): void {
    this.db.prepare(`
      INSERT INTO pm_projects (id, name, path, claude_project_key, runtimescope_project,
        phase, management_authorized, probable_to_complete, project_status,
        category, sdk_installed, runtime_apps,
        created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = COALESCE(excluded.path, pm_projects.path),
        claude_project_key = COALESCE(excluded.claude_project_key, pm_projects.claude_project_key),
        runtimescope_project = COALESCE(excluded.runtimescope_project, pm_projects.runtimescope_project),
        sdk_installed = CASE WHEN excluded.sdk_installed = 1 THEN 1 ELSE pm_projects.sdk_installed END,
        runtime_apps = COALESCE(excluded.runtime_apps, pm_projects.runtime_apps),
        updated_at = excluded.updated_at,
        metadata = COALESCE(excluded.metadata, pm_projects.metadata)
    `).run(
      project.id,
      project.name,
      project.path ?? null,
      project.claudeProjectKey ?? null,
      project.runtimescopeProject ?? null,
      project.phase,
      project.managementAuthorized ? 1 : 0,
      project.probableToComplete ? 1 : 0,
      project.projectStatus,
      project.category ?? null,
      project.sdkInstalled ? 1 : 0,
      project.runtimeApps?.length ? JSON.stringify(project.runtimeApps) : null,
      project.createdAt,
      project.updatedAt,
      project.metadata ? JSON.stringify(project.metadata) : null,
    );
  }

  getProject(id: string): PmProject | null {
    const row = this.db
      .prepare('SELECT * FROM pm_projects WHERE id = ?')
      .get(id) as PmProjectRow | undefined;
    return row ? this.mapProjectRow(row) : null;
  }

  listProjects(): PmProject[] {
    const rows = this.db
      .prepare('SELECT * FROM pm_projects ORDER BY name ASC')
      .all() as PmProjectRow[];
    return rows.map(r => this.mapProjectRow(r));
  }

  updateProject(id: string, updates: Partial<PmProject>): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
    if (updates.phase !== undefined) { sets.push('phase = ?'); params.push(updates.phase); }
    if (updates.managementAuthorized !== undefined) { sets.push('management_authorized = ?'); params.push(updates.managementAuthorized ? 1 : 0); }
    if (updates.probableToComplete !== undefined) { sets.push('probable_to_complete = ?'); params.push(updates.probableToComplete ? 1 : 0); }
    if (updates.projectStatus !== undefined) { sets.push('project_status = ?'); params.push(updates.projectStatus); }
    if (updates.category !== undefined) { sets.push('category = ?'); params.push(updates.category); }
    if (updates.sdkInstalled !== undefined) { sets.push('sdk_installed = ?'); params.push(updates.sdkInstalled ? 1 : 0); }
    if (updates.runtimeApps !== undefined) { sets.push('runtime_apps = ?'); params.push(updates.runtimeApps.length ? JSON.stringify(updates.runtimeApps) : null); }
    if (updates.runtimescopeProject !== undefined) { sets.push('runtimescope_project = ?'); params.push(updates.runtimescopeProject ?? null); }
    if (updates.metadata !== undefined) { sets.push('metadata = ?'); params.push(JSON.stringify(updates.metadata)); }

    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);

    this.db.prepare(`UPDATE pm_projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  listCategories(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT category FROM pm_projects WHERE category IS NOT NULL ORDER BY category ASC')
      .all() as { category: string }[];
    return rows.map(r => r.category);
  }

  private mapProjectRow(row: PmProjectRow): PmProject {
    return {
      id: row.id,
      name: row.name,
      path: row.path ?? undefined,
      claudeProjectKey: row.claude_project_key ?? undefined,
      runtimescopeProject: row.runtimescope_project ?? undefined,
      runtimeApps: row.runtime_apps ? JSON.parse(row.runtime_apps) : undefined,
      phase: row.phase as ProjectPhase,
      managementAuthorized: row.management_authorized === 1,
      probableToComplete: row.probable_to_complete === 1,
      projectStatus: row.project_status as ProjectStatus,
      category: row.category ?? undefined,
      sdkInstalled: row.sdk_installed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  // ============================================================
  // Tasks
  // ============================================================

  createTask(task: PmTask): PmTask {
    this.db.prepare(`
      INSERT INTO pm_tasks (id, project_id, title, description, status, priority,
        labels, source, source_ref, sort_order, assigned_to, due_date,
        created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.projectId ?? null,
      task.title,
      task.description ?? null,
      task.status,
      task.priority,
      JSON.stringify(task.labels),
      task.source,
      task.sourceRef ?? null,
      task.sortOrder,
      task.assignedTo ?? null,
      task.dueDate ?? null,
      task.createdAt,
      task.updatedAt,
      task.completedAt ?? null,
    );
    return task;
  }

  updateTask(id: string, updates: Partial<PmTask>): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
    if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
    if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
    if (updates.priority !== undefined) { sets.push('priority = ?'); params.push(updates.priority); }
    if (updates.labels !== undefined) { sets.push('labels = ?'); params.push(JSON.stringify(updates.labels)); }
    if (updates.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(updates.sortOrder); }
    if (updates.assignedTo !== undefined) { sets.push('assigned_to = ?'); params.push(updates.assignedTo); }
    if (updates.dueDate !== undefined) { sets.push('due_date = ?'); params.push(updates.dueDate); }
    if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }

    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);

    this.db.prepare(`UPDATE pm_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM pm_tasks WHERE id = ?').run(id);
  }

  listTasks(projectId?: string, status?: TaskStatus): PmTask[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (projectId) {
      conditions.push('project_id = ?');
      params.push(projectId);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM pm_tasks ${where} ORDER BY sort_order ASC`)
      .all(...params) as PmTaskRow[];

    return rows.map(r => this.mapTaskRow(r));
  }

  reorderTask(id: string, status: TaskStatus, sortOrder: number): void {
    const now = Date.now();
    const completedAt = status === 'done' ? now : null;
    this.db.prepare(`
      UPDATE pm_tasks SET status = ?, sort_order = ?, updated_at = ?, completed_at = COALESCE(?, completed_at)
      WHERE id = ?
    `).run(status, sortOrder, now, completedAt, id);
  }

  private mapTaskRow(row: PmTaskRow): PmTask {
    return {
      id: row.id,
      projectId: row.project_id ?? undefined,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status as TaskStatus,
      priority: row.priority as PmTask['priority'],
      labels: row.labels ? JSON.parse(row.labels) : [],
      source: (row.source ?? 'manual') as PmTask['source'],
      sourceRef: row.source_ref ?? undefined,
      sortOrder: row.sort_order,
      assignedTo: row.assigned_to ?? undefined,
      dueDate: row.due_date ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
    };
  }

  // ============================================================
  // Sessions
  // ============================================================

  upsertSession(session: PmSession): void {
    this.db.prepare(`
      INSERT INTO pm_sessions (id, project_id, jsonl_path, jsonl_size, first_prompt,
        summary, slug, model, version, git_branch,
        message_count, user_message_count, assistant_message_count,
        total_input_tokens, total_output_tokens,
        total_cache_creation_tokens, total_cache_read_tokens,
        cost_microdollars, started_at, ended_at, active_minutes,
        compaction_count, pre_compaction_tokens, permission_mode,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        jsonl_size = excluded.jsonl_size,
        first_prompt = COALESCE(excluded.first_prompt, pm_sessions.first_prompt),
        summary = COALESCE(excluded.summary, pm_sessions.summary),
        slug = COALESCE(excluded.slug, pm_sessions.slug),
        model = COALESCE(excluded.model, pm_sessions.model),
        version = COALESCE(excluded.version, pm_sessions.version),
        git_branch = COALESCE(excluded.git_branch, pm_sessions.git_branch),
        message_count = excluded.message_count,
        user_message_count = excluded.user_message_count,
        assistant_message_count = excluded.assistant_message_count,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cache_creation_tokens = excluded.total_cache_creation_tokens,
        total_cache_read_tokens = excluded.total_cache_read_tokens,
        cost_microdollars = excluded.cost_microdollars,
        ended_at = excluded.ended_at,
        active_minutes = excluded.active_minutes,
        compaction_count = excluded.compaction_count,
        pre_compaction_tokens = excluded.pre_compaction_tokens,
        permission_mode = excluded.permission_mode,
        updated_at = excluded.updated_at
    `).run(
      session.id,
      session.projectId,
      session.jsonlPath,
      session.jsonlSize ?? null,
      session.firstPrompt ?? null,
      session.summary ?? null,
      session.slug ?? null,
      session.model ?? null,
      session.version ?? null,
      session.gitBranch ?? null,
      session.messageCount,
      session.userMessageCount,
      session.assistantMessageCount,
      session.totalInputTokens,
      session.totalOutputTokens,
      session.totalCacheCreationTokens,
      session.totalCacheReadTokens,
      session.costMicrodollars,
      session.startedAt,
      session.endedAt ?? null,
      session.activeMinutes,
      session.compactionCount,
      session.preCompactionTokens ?? null,
      session.permissionMode ?? null,
      session.createdAt,
      session.updatedAt,
    );
  }

  getSession(id: string): PmSession | null {
    const row = this.db
      .prepare('SELECT * FROM pm_sessions WHERE id = ?')
      .get(id) as PmSessionRow | undefined;
    return row ? this.mapSessionRow(row) : null;
  }

  listSessions(projectId?: string, opts?: { limit?: number; offset?: number; startDate?: string; endDate?: string; hideEmpty?: boolean }): PmSession[] {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (projectId) {
      conditions.push('project_id = ?');
      params.push(projectId);
    }
    if (opts?.startDate) {
      conditions.push('started_at >= ?');
      params.push(new Date(opts.startDate).getTime());
    }
    if (opts?.endDate) {
      conditions.push('started_at <= ?');
      params.push(new Date(opts.endDate + 'T23:59:59.999Z').getTime());
    }
    if (opts?.hideEmpty) {
      conditions.push('(message_count > 0 OR total_input_tokens > 0 OR total_output_tokens > 0 OR cost_microdollars > 0 OR active_minutes > 0)');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM pm_sessions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as PmSessionRow[];
    return rows.map(r => this.mapSessionRow(r));
  }

  getSessionStats(projectId?: string, opts?: { startDate?: string; endDate?: string; hideEmpty?: boolean }): SessionStats {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (projectId) {
      conditions.push('project_id = ?');
      params.push(projectId);
    }
    if (opts?.startDate) {
      conditions.push('started_at >= ?');
      params.push(new Date(opts.startDate).getTime());
    }
    if (opts?.endDate) {
      conditions.push('started_at <= ?');
      params.push(new Date(opts.endDate + 'T23:59:59.999Z').getTime());
    }
    if (opts?.hideEmpty) {
      conditions.push('(message_count > 0 OR total_input_tokens > 0 OR total_output_tokens > 0 OR cost_microdollars > 0 OR active_minutes > 0)');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        COALESCE(SUM(active_minutes), 0) as total_active_minutes,
        COALESCE(SUM(cost_microdollars), 0) as total_cost,
        COALESCE(SUM(total_input_tokens), 0) as total_input,
        COALESCE(SUM(total_output_tokens), 0) as total_output,
        COALESCE(AVG(active_minutes), 0) as avg_minutes
      FROM pm_sessions ${whereClause}
    `).get(...params) as {
      total_sessions: number;
      total_active_minutes: number;
      total_cost: number;
      total_input: number;
      total_output: number;
      avg_minutes: number;
    };

    const modelConditions = [...conditions];
    if (!modelConditions.some(c => c.includes('model'))) {
      modelConditions.push('model IS NOT NULL');
    }
    const modelWhere = `WHERE ${modelConditions.join(' AND ')}`;
    const modelRows = this.db.prepare(`
      SELECT model, COUNT(*) as sessions, SUM(cost_microdollars) as cost
      FROM pm_sessions
      ${modelWhere}
      GROUP BY model
      ORDER BY cost DESC
    `).all(...params) as { model: string; sessions: number; cost: number }[];

    return {
      totalSessions: row.total_sessions,
      totalActiveMinutes: row.total_active_minutes,
      totalCostMicrodollars: row.total_cost,
      totalInputTokens: row.total_input,
      totalOutputTokens: row.total_output,
      avgSessionMinutes: row.avg_minutes,
      modelBreakdown: modelRows,
    };
  }

  getProjectSummaries(opts?: { startDate?: string; endDate?: string; hideEmpty?: boolean }): ProjectSummaryRow[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.startDate) {
      conditions.push('s.started_at >= ?');
      params.push(new Date(opts.startDate).getTime());
    }
    if (opts?.endDate) {
      conditions.push('s.started_at <= ?');
      params.push(new Date(opts.endDate + 'T23:59:59.999Z').getTime());
    }
    if (opts?.hideEmpty) {
      conditions.push('(s.message_count > 0 OR s.total_input_tokens > 0 OR s.total_output_tokens > 0 OR s.cost_microdollars > 0 OR s.active_minutes > 0)');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT
        p.id,
        p.name,
        p.path,
        p.category,
        p.sdk_installed,
        p.runtimescope_project,
        COUNT(s.id) as session_count,
        COALESCE(SUM(s.cost_microdollars), 0) as total_cost,
        COALESCE(SUM(s.active_minutes), 0) as total_active_minutes,
        MAX(s.started_at) as last_session_at,
        COALESCE(SUM(s.message_count), 0) as total_messages
      FROM pm_projects p
      LEFT JOIN pm_sessions s ON s.project_id = p.id ${where ? 'AND ' + conditions.join(' AND ') : ''}
      GROUP BY p.id
      ORDER BY last_session_at DESC NULLS LAST
    `).all(...params) as ProjectSummaryRow[];

    return rows;
  }

  private mapSessionRow(row: PmSessionRow): PmSession {
    return {
      id: row.id,
      projectId: row.project_id,
      jsonlPath: row.jsonl_path,
      jsonlSize: row.jsonl_size ?? undefined,
      firstPrompt: row.first_prompt ?? undefined,
      summary: row.summary ?? undefined,
      slug: row.slug ?? undefined,
      model: row.model ?? undefined,
      version: row.version ?? undefined,
      gitBranch: row.git_branch ?? undefined,
      messageCount: row.message_count,
      userMessageCount: row.user_message_count,
      assistantMessageCount: row.assistant_message_count,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalCacheCreationTokens: row.total_cache_creation_tokens,
      totalCacheReadTokens: row.total_cache_read_tokens,
      costMicrodollars: row.cost_microdollars,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      activeMinutes: row.active_minutes,
      compactionCount: row.compaction_count,
      preCompactionTokens: row.pre_compaction_tokens ?? undefined,
      permissionMode: row.permission_mode ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ============================================================
  // Notes
  // ============================================================

  createNote(note: PmNote): PmNote {
    this.db.prepare(`
      INSERT INTO pm_notes (id, project_id, session_id, title, content, pinned, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      note.id,
      note.projectId ?? null,
      note.sessionId ?? null,
      note.title,
      note.content,
      note.pinned ? 1 : 0,
      JSON.stringify(note.tags),
      note.createdAt,
      note.updatedAt,
    );
    return note;
  }

  updateNote(id: string, updates: Partial<PmNote>): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
    if (updates.content !== undefined) { sets.push('content = ?'); params.push(updates.content); }
    if (updates.pinned !== undefined) { sets.push('pinned = ?'); params.push(updates.pinned ? 1 : 0); }
    if (updates.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(updates.tags)); }

    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);

    this.db.prepare(`UPDATE pm_notes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteNote(id: string): void {
    this.db.prepare('DELETE FROM pm_notes WHERE id = ?').run(id);
  }

  listNotes(opts?: { projectId?: string; pinned?: boolean }): PmNote[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.projectId) {
      conditions.push('project_id = ?');
      params.push(opts.projectId);
    }
    if (opts?.pinned !== undefined) {
      conditions.push('pinned = ?');
      params.push(opts.pinned ? 1 : 0);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM pm_notes ${where} ORDER BY pinned DESC, updated_at DESC`)
      .all(...params) as PmNoteRow[];

    return rows.map(r => this.mapNoteRow(r));
  }

  private mapNoteRow(row: PmNoteRow): PmNote {
    return {
      id: row.id,
      projectId: row.project_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      title: row.title,
      content: row.content,
      pinned: row.pinned === 1,
      tags: row.tags ? JSON.parse(row.tags) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ============================================================
  // CapEx
  // ============================================================

  upsertCapexEntry(entry: PmCapexEntry): void {
    this.db.prepare(`
      INSERT INTO pm_capex_entries (id, project_id, session_id, classification, work_type,
        active_minutes, cost_microdollars, adjustment_factor, adjusted_cost_microdollars,
        confirmed, confirmed_at, confirmed_by, notes, period, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        classification = excluded.classification,
        work_type = excluded.work_type,
        active_minutes = excluded.active_minutes,
        cost_microdollars = excluded.cost_microdollars,
        adjustment_factor = excluded.adjustment_factor,
        adjusted_cost_microdollars = excluded.adjusted_cost_microdollars,
        confirmed = excluded.confirmed,
        confirmed_at = excluded.confirmed_at,
        confirmed_by = excluded.confirmed_by,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).run(
      entry.id,
      entry.projectId,
      entry.sessionId,
      entry.classification,
      entry.workType ?? null,
      entry.activeMinutes,
      entry.costMicrodollars,
      entry.adjustmentFactor,
      entry.adjustedCostMicrodollars,
      entry.confirmed ? 1 : 0,
      entry.confirmedAt ?? null,
      entry.confirmedBy ?? null,
      entry.notes ?? null,
      entry.period,
      entry.createdAt,
      entry.updatedAt,
    );
  }

  listCapexEntries(projectId: string, opts?: { month?: string; confirmed?: boolean }): PmCapexEntry[] {
    const conditions: string[] = ['project_id = ?'];
    const params: unknown[] = [projectId];

    if (opts?.month) {
      conditions.push('period = ?');
      params.push(opts.month);
    }
    if (opts?.confirmed !== undefined) {
      conditions.push('confirmed = ?');
      params.push(opts.confirmed ? 1 : 0);
    }

    const where = conditions.join(' AND ');
    const rows = this.db
      .prepare(`SELECT * FROM pm_capex_entries WHERE ${where} ORDER BY period DESC, created_at DESC`)
      .all(...params) as PmCapexRow[];

    return rows.map(r => this.mapCapexRow(r));
  }

  updateCapexEntry(id: string, updates: Partial<PmCapexEntry>): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.classification !== undefined) { sets.push('classification = ?'); params.push(updates.classification); }
    if (updates.workType !== undefined) { sets.push('work_type = ?'); params.push(updates.workType); }
    if (updates.adjustmentFactor !== undefined) {
      sets.push('adjustment_factor = ?');
      params.push(updates.adjustmentFactor);
      // Recalculate adjusted cost
      if (updates.costMicrodollars !== undefined) {
        sets.push('adjusted_cost_microdollars = ?');
        params.push(Math.round(updates.costMicrodollars * updates.adjustmentFactor));
      }
    }
    if (updates.notes !== undefined) { sets.push('notes = ?'); params.push(updates.notes); }

    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);

    this.db.prepare(`UPDATE pm_capex_entries SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  confirmCapexEntry(id: string, confirmedBy?: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE pm_capex_entries SET confirmed = 1, confirmed_at = ?, confirmed_by = ?, updated_at = ?
      WHERE id = ?
    `).run(now, confirmedBy ?? null, now, id);
  }

  getCapexSummary(projectId: string, opts?: { startDate?: string; endDate?: string }): CapexSummary {
    const conditions: string[] = ['project_id = ?'];
    const params: unknown[] = [projectId];

    if (opts?.startDate) {
      conditions.push('period >= ?');
      params.push(opts.startDate);
    }
    if (opts?.endDate) {
      conditions.push('period <= ?');
      params.push(opts.endDate);
    }

    const where = conditions.join(' AND ');

    const totals = this.db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        COALESCE(SUM(active_minutes), 0) as total_active_minutes,
        COALESCE(SUM(adjusted_cost_microdollars), 0) as total_cost,
        COALESCE(SUM(CASE WHEN classification = 'capitalizable' THEN adjusted_cost_microdollars ELSE 0 END), 0) as cap_cost,
        COALESCE(SUM(CASE WHEN classification = 'expensed' THEN adjusted_cost_microdollars ELSE 0 END), 0) as exp_cost,
        COALESCE(SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END), 0) as confirmed_count,
        COALESCE(SUM(CASE WHEN confirmed = 0 THEN 1 ELSE 0 END), 0) as unconfirmed_count
      FROM pm_capex_entries WHERE ${where}
    `).get(...params) as {
      total_sessions: number;
      total_active_minutes: number;
      total_cost: number;
      cap_cost: number;
      exp_cost: number;
      confirmed_count: number;
      unconfirmed_count: number;
    };

    const monthlyRows = this.db.prepare(`
      SELECT
        period,
        SUM(CASE WHEN classification = 'capitalizable' THEN adjusted_cost_microdollars ELSE 0 END) as capitalizable,
        SUM(CASE WHEN classification = 'expensed' THEN adjusted_cost_microdollars ELSE 0 END) as expensed,
        SUM(active_minutes) as activeMinutes
      FROM pm_capex_entries
      WHERE ${where}
      GROUP BY period
      ORDER BY period ASC
    `).all(...params) as { period: string; capitalizable: number; expensed: number; activeMinutes: number }[];

    return {
      projectId,
      period: opts?.startDate || opts?.endDate ? { start: opts.startDate ?? '', end: opts.endDate ?? '' } : undefined,
      totalSessions: totals.total_sessions,
      totalActiveMinutes: totals.total_active_minutes,
      totalCostMicrodollars: totals.total_cost,
      capitalizableCostMicrodollars: totals.cap_cost,
      expensedCostMicrodollars: totals.exp_cost,
      confirmedCount: totals.confirmed_count,
      unconfirmedCount: totals.unconfirmed_count,
      byMonth: monthlyRows,
    };
  }

  exportCapexCsv(projectId: string, opts?: { startDate?: string; endDate?: string }): string {
    const entries = this.listCapexEntries(projectId, { month: opts?.startDate });
    const sessions = new Map<string, PmSession>();
    for (const entry of entries) {
      if (!sessions.has(entry.sessionId)) {
        const s = this.getSession(entry.sessionId);
        if (s) sessions.set(entry.sessionId, s);
      }
    }

    const headers = [
      'Period', 'Session ID', 'Session Slug', 'Date', 'Model',
      'Active Minutes', 'Active Hours', 'Cost (USD)',
      'Classification', 'Work Type', 'Adjustment Factor',
      'Adjusted Cost (USD)', 'Confirmed', 'Confirmed By', 'Notes',
    ];

    const rows = entries.map(e => {
      const s = sessions.get(e.sessionId);
      const date = s?.startedAt ? new Date(s.startedAt).toISOString().split('T')[0] : '';
      return [
        e.period,
        e.sessionId,
        s?.slug ?? '',
        date,
        s?.model ?? '',
        e.activeMinutes.toFixed(2),
        (e.activeMinutes / 60).toFixed(2),
        (e.costMicrodollars / 1_000_000).toFixed(4),
        e.classification,
        e.workType ?? '',
        e.adjustmentFactor.toFixed(2),
        (e.adjustedCostMicrodollars / 1_000_000).toFixed(4),
        e.confirmed ? 'Yes' : 'No',
        e.confirmedBy ?? '',
        (e.notes ?? '').replace(/"/g, '""'),
      ].map(v => `"${v}"`).join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  private mapCapexRow(row: PmCapexRow): PmCapexEntry {
    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      classification: row.classification as PmCapexEntry['classification'],
      workType: (row.work_type ?? undefined) as PmCapexEntry['workType'],
      activeMinutes: row.active_minutes,
      costMicrodollars: row.cost_microdollars,
      adjustmentFactor: row.adjustment_factor,
      adjustedCostMicrodollars: row.adjusted_cost_microdollars,
      confirmed: row.confirmed === 1,
      confirmedAt: row.confirmed_at ?? undefined,
      confirmedBy: row.confirmed_by ?? undefined,
      notes: row.notes ?? undefined,
      period: row.period,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ============================================================
  // Cleanup
  // ============================================================

  close(): void {
    this.db.close();
  }
}

// ============================================================
// Row types (SQLite column names)
// ============================================================

interface PmProjectRow {
  id: string;
  name: string;
  path: string | null;
  claude_project_key: string | null;
  runtimescope_project: string | null;
  phase: string;
  management_authorized: number;
  probable_to_complete: number;
  project_status: string;
  category: string | null;
  sdk_installed: number;
  runtime_apps: string | null;
  created_at: number;
  updated_at: number;
  metadata: string | null;
}

interface PmTaskRow {
  id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  labels: string | null;
  source: string | null;
  source_ref: string | null;
  sort_order: number;
  assigned_to: string | null;
  due_date: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface ProjectSummaryRow {
  id: string;
  name: string;
  path: string | null;
  category: string | null;
  sdk_installed: number;
  runtimescope_project: string | null;
  session_count: number;
  total_cost: number;
  total_active_minutes: number;
  last_session_at: number | null;
  total_messages: number;
}

interface PmSessionRow {
  id: string;
  project_id: string;
  jsonl_path: string;
  jsonl_size: number | null;
  first_prompt: string | null;
  summary: string | null;
  slug: string | null;
  model: string | null;
  version: string | null;
  git_branch: string | null;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  cost_microdollars: number;
  started_at: number;
  ended_at: number | null;
  active_minutes: number;
  compaction_count: number;
  pre_compaction_tokens: number | null;
  permission_mode: string | null;
  created_at: number;
  updated_at: number;
}

interface PmNoteRow {
  id: string;
  project_id: string | null;
  session_id: string | null;
  title: string;
  content: string;
  pinned: number;
  tags: string | null;
  created_at: number;
  updated_at: number;
}

interface PmCapexRow {
  id: string;
  project_id: string;
  session_id: string;
  classification: string;
  work_type: string | null;
  active_minutes: number;
  cost_microdollars: number;
  adjustment_factor: number;
  adjusted_cost_microdollars: number;
  confirmed: number;
  confirmed_at: number | null;
  confirmed_by: string | null;
  notes: string | null;
  period: string;
  created_at: number;
  updated_at: number;
}
