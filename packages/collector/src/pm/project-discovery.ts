import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { PmStore } from './pm-store.js';
import type { ProjectManager } from '../project-manager.js';
import type { PmProject, PmSession, PmCapexEntry } from './pm-types.js';
import { parseSessionJsonl, calculateActiveMinutes, calculateCostMicrodollars } from './session-parser.js';

// ============================================================
// Project Discovery — scans filesystem for Claude Code and
// RuntimeScope projects, merges them, populates PM database
// ============================================================

const LOG_PREFIX = '[RuntimeScope PM]';

export interface DiscoveryResult {
  projectsDiscovered: number;
  projectsUpdated: number;
  sessionsDiscovered: number;
  sessionsUpdated: number;
  errors: string[];
}

/** Shape of entries in ~/.claude/projects/<key>/sessions-index.json */
interface ClaudeSessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt?: string;
  summary?: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

interface ClaudeSessionIndex {
  version: number;
  entries: ClaudeSessionIndexEntry[];
}

/**
 * Check if a project has @runtimescope/sdk or @runtimescope/server-sdk installed.
 * Checks package.json deps first, then falls back to checking node_modules.
 */
async function detectSdkInstalled(projectPath: string): Promise<boolean> {
  // Check package.json dependencies
  try {
    const pkgPath = join(projectPath, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if ('@runtimescope/sdk' in allDeps || '@runtimescope/server-sdk' in allDeps) {
      return true;
    }
    // Check workspace packages (monorepo root may list it as a workspace)
    if (pkg.workspaces) {
      const workspaces: string[] = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages ?? [];
      for (const ws of workspaces) {
        // Resolve simple workspace patterns like "packages/*"
        const wsBase = ws.replace(/\/?\*$/, '');
        const wsDir = join(projectPath, wsBase);
        try {
          const entries = await readdir(wsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            try {
              const wsPkg = JSON.parse(await readFile(join(wsDir, entry.name, 'package.json'), 'utf-8'));
              const wsDeps = { ...wsPkg.dependencies, ...wsPkg.devDependencies };
              if ('@runtimescope/sdk' in wsDeps || '@runtimescope/server-sdk' in wsDeps) {
                return true;
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* no package.json */ }

  // Fallback: check if node_modules/@runtimescope exists
  try {
    await stat(join(projectPath, 'node_modules', '@runtimescope'));
    return true;
  } catch {
    return false;
  }
}

function emptyResult(): DiscoveryResult {
  return {
    projectsDiscovered: 0,
    projectsUpdated: 0,
    sessionsDiscovered: 0,
    sessionsUpdated: 0,
    errors: [],
  };
}

function mergeResults(a: Partial<DiscoveryResult>, b: Partial<DiscoveryResult>): DiscoveryResult {
  return {
    projectsDiscovered: (a.projectsDiscovered ?? 0) + (b.projectsDiscovered ?? 0),
    projectsUpdated: (a.projectsUpdated ?? 0) + (b.projectsUpdated ?? 0),
    sessionsDiscovered: (a.sessionsDiscovered ?? 0) + (b.sessionsDiscovered ?? 0),
    sessionsUpdated: (a.sessionsUpdated ?? 0) + (b.sessionsUpdated ?? 0),
    errors: [...(a.errors ?? []), ...(b.errors ?? [])],
  };
}

/**
 * Slugify a filesystem path into a unique project ID.
 * Uses the last two path segments to avoid collisions between projects
 * with the same directory name in different locations.
 * e.g. `/Users/edwinlovettiii/runtime-profiler` → `edwinlovettiii--runtime-profiler`
 * e.g. `/Users/alice/frontend` vs `/Users/bob/frontend` → different IDs
 *
 * Single-segment paths (e.g. just `frontend`) use basename only.
 * The double-hyphen `--` separates parent from basename for readability.
 */
function slugifyPath(fsPath: string): string {
  const parts = fsPath.replace(/\/+$/, '').split('/').filter(Boolean);
  // Use last 2 segments for uniqueness (parent + basename)
  const segments = parts.length >= 2 ? parts.slice(-2) : parts;
  return segments
    .join('--')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{3,}/g, '--')
    .replace(/^-|-$/g, '');
}

/**
 * Decode a Claude project key back to a filesystem path.
 *
 * Claude Code encodes project paths by replacing `/` with `-`.
 * e.g. `-Users-edwinlovettiii-runtime-profiler` → `/Users/edwinlovettiii/runtime-profiler`
 *
 * The tricky part: real directory names can also contain hyphens.
 * Strategy: try the naive full replacement first (`-` → `/`), then
 * progressively try keeping certain `-` characters intact by checking
 * if candidate paths actually exist on the filesystem.
 *
 * Returns null if no valid path can be resolved.
 */
function decodeClaudeKey(key: string): string | null {
  // The key starts with `-` which represents the root `/`
  // Naive decode: replace all `-` with `/`
  const naive = '/' + key.slice(1).replace(/-/g, '/');
  if (existsSync(naive)) return naive;

  // The naive approach fails when directory names contain hyphens.
  // Try a segment-based approach: split by `-`, then greedily combine
  // segments to form valid directory paths.
  const parts = key.slice(1).split('-'); // remove leading `-`
  return resolvePathSegments(parts);
}

/**
 * Greedy path resolver: given parts split by `-`, try to reconstruct the
 * filesystem path by testing whether joining adjacent segments with `-`
 * forms an existing directory at each level.
 */
function resolvePathSegments(parts: string[]): string | null {
  if (parts.length === 0) return null;

  function tryResolve(prefix: string, remaining: string[]): string | null {
    if (remaining.length === 0) {
      return existsSync(prefix) ? prefix : null;
    }

    // Try consuming 1..N segments as the next directory component
    // Prefer longer matches first (greedy) to handle names with hyphens
    for (let count = remaining.length; count >= 1; count--) {
      const segment = remaining.slice(0, count).join('-');
      const candidate = join(prefix, segment);

      if (count === remaining.length) {
        // Last segment(s) — this would be the full path
        if (existsSync(candidate)) return candidate;
      } else {
        // Intermediate segment — must be a directory
        try {
          if (existsSync(candidate)) {
            const result = tryResolve(candidate, remaining.slice(count));
            if (result) return result;
          }
        } catch {
          // stat failed, skip
        }
      }
    }

    return null;
  }

  return tryResolve('/', parts);
}

/**
 * Derive the YYYY-MM period string from a timestamp.
 */
function toPeriod(timestampMs: number): string {
  const d = new Date(timestampMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export class ProjectDiscovery {
  private readonly claudeBaseDir: string;

  constructor(
    private pmStore: PmStore,
    private projectManager: ProjectManager,
    claudeBaseDir?: string,
  ) {
    this.claudeBaseDir = claudeBaseDir ?? join(homedir(), '.claude');
  }

  /**
   * Run full discovery: Claude Code projects + RuntimeScope projects.
   * Never throws — all errors are captured in the result.
   */
  async discoverAll(): Promise<DiscoveryResult> {
    const result = emptyResult();

    try {
      const [claudeResult, runtimeResult] = await Promise.all([
        this.discoverClaudeProjects(),
        this.discoverRuntimeScopeProjects(),
      ]);
      return mergeResults(claudeResult, runtimeResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Fatal discovery error: ${msg}`);
      result.errors.push(`Fatal discovery error: ${msg}`);
      return result;
    }
  }

  /**
   * Discover Claude Code projects from ~/.claude/projects/.
   */
  async discoverClaudeProjects(): Promise<Partial<DiscoveryResult>> {
    const result: Partial<DiscoveryResult> = {
      projectsDiscovered: 0,
      projectsUpdated: 0,
      sessionsDiscovered: 0,
      sessionsUpdated: 0,
      errors: [],
    };

    const projectsDir = join(this.claudeBaseDir, 'projects');

    try {
      await stat(projectsDir);
    } catch {
      // ~/.claude/projects/ doesn't exist — nothing to discover
      return result;
    }

    let entries: string[];
    try {
      const dirEntries = await readdir(projectsDir, { withFileTypes: true });
      entries = dirEntries.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Failed to read Claude projects dir: ${msg}`);
      result.errors!.push(`Failed to read Claude projects dir: ${msg}`);
      return result;
    }

    for (const key of entries) {
      try {
        await this.processClaudeProject(key, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} Error processing Claude project ${key}: ${msg}`);
        result.errors!.push(`Claude project ${key}: ${msg}`);
      }
    }

    return result;
  }

  /**
   * Discover RuntimeScope projects from ~/.runtimescope/projects/.
   */
  async discoverRuntimeScopeProjects(): Promise<Partial<DiscoveryResult>> {
    const result: Partial<DiscoveryResult> = {
      projectsDiscovered: 0,
      projectsUpdated: 0,
      sessionsDiscovered: 0,
      sessionsUpdated: 0,
      errors: [],
    };

    try {
      const runtimeProjects = this.projectManager.listProjects();

      for (const projectName of runtimeProjects) {
        try {
          const projectDir = this.projectManager.getProjectDir(projectName);

          const id = projectName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

          // Check if this project already exists in PM store (may have been
          // created by Claude discovery and needs merging)
          const existingProjects = await this.pmStore.listProjects();
          const nameLower = projectName.toLowerCase();
          const existing = existingProjects.find(
            (p) => p.id === id
              || p.runtimescopeProject === projectName
              || p.name.toLowerCase() === nameLower,
          );

          const now = Date.now();
          // Use the existing source path if available (projectDir is the data dir, not source)
          const sourcePath = existing?.path ?? projectDir;
          const sdkInstalled = await detectSdkInstalled(sourcePath);

          if (existing) {
            // Merge: add runtimescopeProject reference
            const updated: PmProject = {
              ...existing,
              runtimescopeProject: projectName,
              sdkInstalled: sdkInstalled || existing.sdkInstalled,
              updatedAt: now,
            };
            await this.pmStore.upsertProject(updated);
            result.projectsUpdated = (result.projectsUpdated ?? 0) + 1;
          } else {
            // Resolve filesystem path from project dir
            const fsPath = projectDir;

            const project: PmProject = {
              id,
              name: projectName,
              path: fsPath,
              runtimescopeProject: projectName,
              phase: 'application_development',
              managementAuthorized: false,
              probableToComplete: true,
              projectStatus: 'active',
              sdkInstalled,
              createdAt: now,
              updatedAt: now,
            };
            await this.pmStore.upsertProject(project);
            result.projectsDiscovered = (result.projectsDiscovered ?? 0) + 1;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${LOG_PREFIX} Error processing RuntimeScope project ${projectName}: ${msg}`);
          result.errors!.push(`RuntimeScope project ${projectName}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Failed to list RuntimeScope projects: ${msg}`);
      result.errors!.push(`Failed to list RuntimeScope projects: ${msg}`);
    }

    return result;
  }

  /**
   * Index all sessions for a given project.
   * Returns the number of sessions indexed (new or updated).
   */
  async indexProjectSessions(projectId: string): Promise<number> {
    const existingProjects = await this.pmStore.listProjects();
    const project = existingProjects.find((p) => p.id === projectId);
    if (!project) {
      console.error(`${LOG_PREFIX} Project not found: ${projectId}`);
      return 0;
    }

    if (!project.claudeProjectKey) {
      // No Claude project associated — nothing to index
      return 0;
    }

    const projectDir = join(this.claudeBaseDir, 'projects', project.claudeProjectKey);
    let sessionsIndexed = 0;

    try {
      // Try sessions-index.json first for fast metadata
      const indexPath = join(projectDir, 'sessions-index.json');
      let indexEntries: ClaudeSessionIndexEntry[] | null = null;

      try {
        const indexContent = await readFile(indexPath, 'utf-8');
        const index: ClaudeSessionIndex = JSON.parse(indexContent);
        indexEntries = index.entries ?? [];
      } catch {
        // No index file — will fall back to scanning .jsonl files
      }

      // Scan for .jsonl files
      const dirEntries = await readdir(projectDir, { withFileTypes: true });
      const jsonlFiles = dirEntries
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
        .map((d) => d.name);

      for (const jsonlFile of jsonlFiles) {
        try {
          const sessionId = jsonlFile.replace('.jsonl', '');
          const jsonlPath = join(projectDir, jsonlFile);

          // Check if session already exists and if file size changed
          const fileStat = await stat(jsonlPath);
          const fileSize = fileStat.size;

          const existingSession = await this.pmStore.getSession(sessionId);
          if (existingSession && existingSession.jsonlSize === fileSize) {
            // File hasn't changed — skip
            continue;
          }

          // Try to get metadata from sessions-index.json first
          const indexEntry = indexEntries?.find((e) => e.sessionId === sessionId);

          let session: PmSession;

          if (indexEntry) {
            // Build session from index metadata (fast path)
            session = this.buildSessionFromIndex(indexEntry, projectId, jsonlPath, fileSize);
          } else {
            // Full parse of the JSONL file
            session = await this.buildSessionFromJsonl(sessionId, projectId, jsonlPath, fileSize);
          }

          await this.pmStore.upsertSession(session);

          // Create a CapEx entry stub for this session
          await this.upsertCapexStub(session);

          sessionsIndexed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${LOG_PREFIX} Error indexing session ${jsonlFile}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Error indexing sessions for project ${projectId}: ${msg}`);
    }

    return sessionsIndexed;
  }

  // ---------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------

  /**
   * Process a single Claude project directory key.
   */
  private async processClaudeProject(
    key: string,
    result: Partial<DiscoveryResult>,
  ): Promise<void> {
    const projectDir = join(this.claudeBaseDir, 'projects', key);

    // Decode key to filesystem path
    let fsPath = decodeClaudeKey(key);

    // If decoding fails, try to get path from sessions-index.json
    if (!fsPath) {
      fsPath = await this.resolvePathFromIndex(projectDir);
    }

    const id = fsPath ? slugifyPath(fsPath) : slugifyPath(key);
    const name = fsPath ? basename(fsPath) : key;
    const now = Date.now();

    // Check if this project already exists (by ID, Claude key, or name)
    const existingProjects = await this.pmStore.listProjects();
    const nameLower = name.toLowerCase();
    const existing = existingProjects.find(
      (p) => p.id === id || p.claudeProjectKey === key || p.name.toLowerCase() === nameLower,
    );

    // Detect SDK installation if we have a filesystem path
    const resolvedPath = fsPath ?? existing?.path;
    const sdkInstalled = resolvedPath ? await detectSdkInstalled(resolvedPath) : false;

    if (existing) {
      // Update/merge: add Claude key, path, SDK status
      const updated: PmProject = {
        ...existing,
        claudeProjectKey: key,
        path: fsPath ?? existing.path,
        sdkInstalled: sdkInstalled || existing.sdkInstalled,
        updatedAt: now,
      };
      await this.pmStore.upsertProject(updated);
      result.projectsUpdated = (result.projectsUpdated ?? 0) + 1;
    } else {
      const project: PmProject = {
        id,
        name,
        path: fsPath ?? undefined,
        claudeProjectKey: key,
        phase: 'application_development',
        managementAuthorized: false,
        probableToComplete: true,
        projectStatus: 'active',
        sdkInstalled,
        createdAt: now,
        updatedAt: now,
      };
      await this.pmStore.upsertProject(project);
      result.projectsDiscovered = (result.projectsDiscovered ?? 0) + 1;
    }

    // Index sessions for this project — use the actual stored project ID
    const actualId = existing ? existing.id : id;
    const sessionsIndexed = await this.indexSessionsForClaudeProject(actualId, key);
    result.sessionsDiscovered = (result.sessionsDiscovered ?? 0) + sessionsIndexed.discovered;
    result.sessionsUpdated = (result.sessionsUpdated ?? 0) + sessionsIndexed.updated;
  }

  /**
   * Try to resolve the filesystem path from the sessions-index.json projectPath field.
   */
  private async resolvePathFromIndex(projectDir: string): Promise<string | null> {
    try {
      const indexPath = join(projectDir, 'sessions-index.json');
      const content = await readFile(indexPath, 'utf-8');
      const index: ClaudeSessionIndex = JSON.parse(content);

      // Find the first entry with a projectPath
      const entry = index.entries?.find((e) => e.projectPath);
      return entry?.projectPath ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Index sessions for a Claude project directly (used during discovery).
   * Returns counts of discovered and updated sessions.
   */
  private async indexSessionsForClaudeProject(
    projectId: string,
    claudeKey: string,
  ): Promise<{ discovered: number; updated: number }> {
    const counts = { discovered: 0, updated: 0 };
    const projectDir = join(this.claudeBaseDir, 'projects', claudeKey);

    try {
      // Try sessions-index.json first
      let indexEntries: ClaudeSessionIndexEntry[] | null = null;
      try {
        const indexPath = join(projectDir, 'sessions-index.json');
        const indexContent = await readFile(indexPath, 'utf-8');
        const index: ClaudeSessionIndex = JSON.parse(indexContent);
        indexEntries = index.entries ?? [];
      } catch {
        // No index file
      }

      // Scan for .jsonl files (only top-level, skip subdirectories)
      const dirEntries = await readdir(projectDir, { withFileTypes: true });
      const jsonlFiles = dirEntries
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
        .map((d) => d.name);

      for (const jsonlFile of jsonlFiles) {
        try {
          const sessionId = jsonlFile.replace('.jsonl', '');
          const jsonlPath = join(projectDir, jsonlFile);

          const fileStat = await stat(jsonlPath);
          const fileSize = fileStat.size;

          const existingSession = await this.pmStore.getSession(sessionId);

          if (existingSession && existingSession.jsonlSize === fileSize) {
            // Unchanged — skip
            continue;
          }

          const indexEntry = indexEntries?.find((e) => e.sessionId === sessionId);

          let session: PmSession;
          if (indexEntry) {
            session = this.buildSessionFromIndex(indexEntry, projectId, jsonlPath, fileSize);
          } else {
            session = await this.buildSessionFromJsonl(sessionId, projectId, jsonlPath, fileSize);
          }

          await this.pmStore.upsertSession(session);
          await this.upsertCapexStub(session);

          if (existingSession) {
            counts.updated++;
          } else {
            counts.discovered++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${LOG_PREFIX} Error indexing session ${jsonlFile} in ${claudeKey}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Error scanning sessions for ${claudeKey}: ${msg}`);
    }

    return counts;
  }

  /**
   * Build a PmSession from the fast sessions-index.json entry.
   * Token counts and cost are zeroed since the index doesn't contain them;
   * they will be populated on a subsequent full parse if needed.
   */
  private buildSessionFromIndex(
    entry: ClaudeSessionIndexEntry,
    projectId: string,
    jsonlPath: string,
    jsonlSize: number,
  ): PmSession {
    const now = Date.now();
    const startedAt = new Date(entry.created).getTime();
    const endedAt = entry.modified ? new Date(entry.modified).getTime() : undefined;
    const activeMinutes = endedAt
      ? Math.max(1, Math.round((endedAt - startedAt) / 60_000))
      : 0;

    return {
      id: entry.sessionId,
      projectId,
      jsonlPath,
      jsonlSize,
      firstPrompt: entry.firstPrompt ?? undefined,
      summary: entry.summary ?? undefined,
      slug: undefined,
      model: undefined,
      version: undefined,
      gitBranch: entry.gitBranch ?? undefined,
      messageCount: entry.messageCount ?? 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      costMicrodollars: 0,
      startedAt,
      endedAt,
      activeMinutes,
      compactionCount: 0,
      preCompactionTokens: undefined,
      permissionMode: undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Build a PmSession by fully parsing a .jsonl file.
   */
  private async buildSessionFromJsonl(
    sessionId: string,
    projectId: string,
    jsonlPath: string,
    jsonlSize: number,
  ): Promise<PmSession> {
    const now = Date.now();

    // Use file mtime as fallback timestamp (more accurate than Date.now())
    let fileMtime = now;
    try {
      const fstat = await stat(jsonlPath);
      fileMtime = fstat.mtimeMs;
    } catch { /* use now */ }

    try {
      const { session: parsed, messageTimestamps } = await parseSessionJsonl(jsonlPath, sessionId, projectId);
      const activeMinutes = calculateActiveMinutes(messageTimestamps);
      const costMicrodollars = parsed.costMicrodollars ?? calculateCostMicrodollars(
        parsed.model ?? '',
        parsed.totalInputTokens ?? 0,
        parsed.totalOutputTokens ?? 0,
        parsed.totalCacheCreationTokens ?? 0,
        parsed.totalCacheReadTokens ?? 0,
      );

      return {
        id: sessionId,
        projectId,
        jsonlPath,
        jsonlSize,
        firstPrompt: parsed.firstPrompt ?? undefined,
        summary: parsed.summary ?? undefined,
        slug: parsed.slug ?? undefined,
        model: parsed.model ?? undefined,
        version: parsed.version ?? undefined,
        gitBranch: parsed.gitBranch ?? undefined,
        messageCount: parsed.messageCount ?? 0,
        userMessageCount: parsed.userMessageCount ?? 0,
        assistantMessageCount: parsed.assistantMessageCount ?? 0,
        totalInputTokens: parsed.totalInputTokens ?? 0,
        totalOutputTokens: parsed.totalOutputTokens ?? 0,
        totalCacheCreationTokens: parsed.totalCacheCreationTokens ?? 0,
        totalCacheReadTokens: parsed.totalCacheReadTokens ?? 0,
        costMicrodollars,
        startedAt: parsed.startedAt ?? fileMtime,
        endedAt: parsed.endedAt ?? undefined,
        activeMinutes,
        compactionCount: parsed.compactionCount ?? 0,
        preCompactionTokens: parsed.preCompactionTokens ?? undefined,
        permissionMode: parsed.permissionMode ?? undefined,
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Failed to parse session ${sessionId}: ${msg}`);

      // Return a minimal session record — use file mtime instead of Date.now()
      // to avoid all failed sessions appearing with today's date
      return {
        id: sessionId,
        projectId,
        jsonlPath,
        jsonlSize,
        messageCount: 0,
        userMessageCount: 0,
        assistantMessageCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        costMicrodollars: 0,
        startedAt: fileMtime,
        activeMinutes: 0,
        compactionCount: 0,
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  /**
   * Create or update a CapEx entry stub for a session.
   * Defaults to 'expensed' classification, unconfirmed.
   */
  private async upsertCapexStub(session: PmSession): Promise<void> {
    try {
      const now = Date.now();
      const entry: PmCapexEntry = {
        id: `capex-${session.id}`,
        projectId: session.projectId,
        sessionId: session.id,
        classification: 'expensed',
        workType: undefined,
        activeMinutes: session.activeMinutes,
        costMicrodollars: session.costMicrodollars,
        adjustmentFactor: 1.0,
        adjustedCostMicrodollars: session.costMicrodollars,
        confirmed: false,
        confirmedAt: undefined,
        confirmedBy: undefined,
        notes: undefined,
        period: toPeriod(session.startedAt),
        createdAt: now,
        updatedAt: now,
      };

      await this.pmStore.upsertCapexEntry(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Failed to create CapEx stub for session ${session.id}: ${msg}`);
    }
  }
}
