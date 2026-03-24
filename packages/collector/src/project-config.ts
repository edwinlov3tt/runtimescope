import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateProjectId } from './project-id.js';
import type { ProjectManager } from './project-manager.js';

// ============================================================
// .runtimescope/config.json — project-level config
//
// Lives at <project-root>/.runtimescope/config.json
// Committable to git (no secrets). Secrets go in ~/.runtimescope/.
// ============================================================

export interface RuntimeScopeProjectConfig {
  /** Stable project identifier (proj_xxx). Groups all SDKs for this project. */
  projectId: string;

  /** Human-readable project name. */
  appName: string;

  /** Optional description for dashboard/reports. */
  description?: string;

  /** SDKs installed in this project. Each entry is a target (browser, server, worker, etc.). */
  sdks: SdkEntry[];

  /** Default capture settings. Used by /setup to generate snippets and by server-sdk for auto-config. */
  capture: CaptureConfig;

  /** Project phase for CapEx tracking. */
  phase?: 'preliminary' | 'application_development' | 'post_implementation';

  /** Category for grouping in dashboard (e.g., "work", "personal", "internal"). */
  category?: string;

  /** Infrastructure references (no tokens — those live in ~/.runtimescope/config.json). */
  infra?: {
    vercel?: { projectId?: string };
    cloudflare?: { workerName?: string; accountId?: string };
    railway?: { projectId?: string };
  };
}

export interface SdkEntry {
  /** Which SDK is installed. */
  type: 'browser' | 'server' | 'workers';

  /** Where the SDK init code lives (e.g., "src/main.tsx", "src/server.ts"). */
  entryFile?: string;

  /** Framework detected during setup. */
  framework?: string;

  /** The appName used in this SDK's init (can differ from project appName for multi-SDK). */
  appName?: string;
}

export interface CaptureConfig {
  network?: boolean;
  console?: boolean;
  xhr?: boolean;
  body?: boolean;
  performance?: boolean;
  renders?: boolean;
  navigation?: boolean;
  clicks?: boolean;
  /** Server SDK specific */
  http?: boolean;
  errors?: boolean;
  stackTraces?: boolean;
}

const DEFAULT_CAPTURE: CaptureConfig = {
  network: true,
  console: true,
  xhr: true,
  body: false,
  performance: true,
  renders: true,
  navigation: true,
  clicks: false,
  http: false,
  errors: true,
  stackTraces: false,
};

// ============================================================
// Read / Write / Scaffold
// ============================================================

/** Read .runtimescope/config.json from a project directory. Returns null if not found. */
export function readProjectConfig(projectDir: string): RuntimeScopeProjectConfig | null {
  const configPath = join(projectDir, '.runtimescope', 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as RuntimeScopeProjectConfig;
  } catch {
    return null;
  }
}

/** Write .runtimescope/config.json to a project directory. Creates the directory if needed. */
export function writeProjectConfig(projectDir: string, config: RuntimeScopeProjectConfig): void {
  const dir = join(projectDir, '.runtimescope');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Scaffold the .runtimescope/ directory for a project.
 * Creates config.json with a generated projectId and default capture settings.
 * If config already exists, returns the existing one (idempotent).
 */
export function scaffoldProjectConfig(
  projectDir: string,
  opts: {
    appName: string;
    framework?: string;
    sdkType?: SdkEntry['type'];
    description?: string;
    category?: string;
  },
): RuntimeScopeProjectConfig {
  const existing = readProjectConfig(projectDir);
  if (existing) {
    // If a new SDK type is being added, merge it in
    if (opts.sdkType) {
      const alreadyHas = existing.sdks.some((s) => s.type === opts.sdkType);
      if (!alreadyHas) {
        existing.sdks.push({
          type: opts.sdkType,
          framework: opts.framework,
          appName: opts.appName !== existing.appName ? opts.appName : undefined,
        });
        writeProjectConfig(projectDir, existing);
      }
    }
    return existing;
  }

  const config: RuntimeScopeProjectConfig = {
    projectId: generateProjectId(),
    appName: opts.appName,
    description: opts.description,
    sdks: opts.sdkType
      ? [{ type: opts.sdkType, framework: opts.framework }]
      : [],
    capture: { ...DEFAULT_CAPTURE },
    category: opts.category,
  };

  writeProjectConfig(projectDir, config);

  // Also create .gitignore for the directory (keep config, ignore local state)
  const gitignorePath = join(projectDir, '.runtimescope', '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '# Keep config.json committed, ignore local state\n*.log\n*.db\n.env\n', 'utf-8');
  }

  return config;
}

/**
 * Resolve all appNames associated with a project config.
 * Returns the main appName plus any SDK-specific appNames.
 */
export function resolveProjectAppNames(config: RuntimeScopeProjectConfig): string[] {
  const names = new Set<string>([config.appName]);
  for (const sdk of config.sdks) {
    if (sdk.appName) names.add(sdk.appName);
  }
  return Array.from(names);
}

// ============================================================
// Project ID Migration
// ============================================================

interface MigratablePmStore {
  listProjects(): Array<{
    id: string;
    name: string;
    path?: string;
    runtimeApps?: string[];
    runtimeProjectId?: string;
  }>;
  updateProject(id: string, updates: Record<string, unknown>): void;
}

interface MigrationResult {
  unified: number;
  skipped: number;
  details: string[];
}

/**
 * Scan PM projects with multiple runtimeApps and ensure all their
 * appNames share the same canonical projectId (from .runtimescope/config.json).
 */
export function migrateProjectIds(
  projectManager: ProjectManager,
  pmStore?: MigratablePmStore | null,
): MigrationResult {
  const result: MigrationResult = { unified: 0, skipped: 0, details: [] };
  if (!pmStore) return result;

  for (const project of pmStore.listProjects()) {
    // Only migrate multi-app projects
    if (!project.runtimeApps || project.runtimeApps.length < 2) continue;
    if (!project.path) { result.skipped++; continue; }

    // Read the project-level .runtimescope/config.json
    let canonicalId: string | null = null;
    try {
      const configPath = join(project.path, '.runtimescope', 'config.json');
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (config.projectId) canonicalId = config.projectId;
      }
    } catch { /* non-fatal */ }

    // If no project-level config, try the PM project's runtimeProjectId
    if (!canonicalId && project.runtimeProjectId) {
      canonicalId = project.runtimeProjectId;
    }

    // If still no canonical ID, use the first appName's existing projectId
    if (!canonicalId) {
      for (const appName of project.runtimeApps) {
        const existing = projectManager.getProjectIdForApp(appName);
        if (existing) { canonicalId = existing; break; }
      }
    }

    if (!canonicalId) { result.skipped++; continue; }

    // Unify: set ALL appNames to the canonical projectId
    for (const appName of project.runtimeApps) {
      const current = projectManager.getProjectIdForApp(appName);
      if (current !== canonicalId) {
        projectManager.setProjectIdForApp(appName, canonicalId);
        result.details.push(`Unified ${appName}: ${current ?? 'none'} → ${canonicalId}`);
        result.unified++;
      }
    }

    // Update PM project's runtimeProjectId if different
    if (project.runtimeProjectId !== canonicalId) {
      pmStore.updateProject(project.id, { runtimeProjectId: canonicalId });
      result.details.push(`PM project ${project.name}: runtimeProjectId → ${canonicalId}`);
    }
  }

  return result;
}
