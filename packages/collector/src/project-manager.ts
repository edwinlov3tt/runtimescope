import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ApiKeyEntry } from './auth.js';

// ============================================================
// Project Manager — manages ~/.runtimescope/ directory structure
// ============================================================

export interface GlobalConfig {
  defaultPort: number;
  bufferSize: number;
  httpPort: number;
  /** Authentication configuration */
  auth?: {
    enabled: boolean;
    apiKeys: ApiKeyEntry[];
  };
  /** TLS certificate paths */
  tls?: {
    certPath: string;
    keyPath: string;
    caPath?: string;
  };
  /** CORS allowed origins (defaults to '*' when not set) */
  corsOrigins?: string[];
  /** Rate limiting configuration */
  rateLimits?: {
    maxEventsPerSecond?: number;
    maxEventsPerMinute?: number;
  };
  /** Payload redaction configuration */
  redaction?: {
    enabled: boolean;
    rules?: { name: string; pattern: string; replacement: string }[];
  };
}

export interface ProjectConfig {
  name: string;
  createdAt: string;
  sdkVersion?: string;
  projectId?: string;
  settings: {
    bufferSize?: number;
    retentionDays?: number;
  };
}

export interface InfrastructureConfig {
  project?: string;
  databases?: Record<string, {
    type: string;
    connection_string?: string;
    project_ref?: string;
    service_key?: string;
    label?: string;
  }>;
  deployments?: Record<string, {
    platform: string;
    project_id?: string;
    team_id?: string;
    worker_name?: string;
    account_id?: string;
  }>;
  services?: Record<string, string>;
}

const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  defaultPort: 9090,
  bufferSize: 10_000,
  httpPort: 9091,
};

/** Minimal interface for PmStore used by rebuildAppIndex (avoids circular deps). */
export interface PmStoreIndexSource {
  listProjects(): Array<{ runtimeApps?: string[]; runtimeProjectId?: string; path?: string }>;
}

export class ProjectManager {
  private readonly baseDir: string;
  private appProjectIndex: Map<string, string> = new Map();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.runtimescope');
  }

  get rootDir(): string {
    return this.baseDir;
  }

  // --- Directory helpers ---

  getProjectDir(projectName: string): string {
    // Sanitize to prevent path traversal (e.g., ../../etc)
    const safe = projectName.replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (!safe || safe === '.' || safe === '..') {
      return join(this.baseDir, 'projects', '_invalid');
    }
    return join(this.baseDir, 'projects', safe);
  }

  getProjectDbPath(projectName: string): string {
    return join(this.getProjectDir(projectName), 'events.db');
  }

  // --- Lifecycle (idempotent) ---

  ensureGlobalDir(): void {
    this.mkdirp(this.baseDir);
    this.mkdirp(join(this.baseDir, 'projects'));

    // Create default global config if it doesn't exist
    const configPath = join(this.baseDir, 'config.json');
    if (!existsSync(configPath)) {
      this.writeJson(configPath, DEFAULT_GLOBAL_CONFIG);
    }
  }

  ensureProjectDir(projectName: string): void {
    const projectDir = this.getProjectDir(projectName);
    this.mkdirp(projectDir);
    // Create default project config if it doesn't exist
    const configPath = join(projectDir, 'config.json');
    if (!existsSync(configPath)) {
      const config: ProjectConfig = {
        name: projectName,
        createdAt: new Date().toISOString(),
        settings: {
          retentionDays: 30,
        },
      };
      this.writeJson(configPath, config);
    }
  }

  // --- Config ---

  getGlobalConfig(): GlobalConfig {
    const configPath = join(this.baseDir, 'config.json');
    if (!existsSync(configPath)) return { ...DEFAULT_GLOBAL_CONFIG };
    return { ...DEFAULT_GLOBAL_CONFIG, ...(this.readJson(configPath) as Partial<GlobalConfig>) };
  }

  saveGlobalConfig(config: GlobalConfig): void {
    this.writeJson(join(this.baseDir, 'config.json'), config);
  }

  getProjectConfig(projectName: string): ProjectConfig | null {
    const configPath = join(this.getProjectDir(projectName), 'config.json');
    if (!existsSync(configPath)) return null;
    return this.readJson(configPath) as ProjectConfig;
  }

  saveProjectConfig(projectName: string, config: ProjectConfig): void {
    this.writeJson(join(this.getProjectDir(projectName), 'config.json'), config);
  }

  getInfrastructureConfig(projectName: string): InfrastructureConfig | null {
    // Try JSON first, then YAML (if js-yaml is available)
    const jsonPath = join(this.getProjectDir(projectName), 'infrastructure.json');
    if (existsSync(jsonPath)) {
      const config = this.readJson(jsonPath) as InfrastructureConfig;
      return this.resolveConfigEnvVars(config);
    }

    // Try YAML (loaded lazily to avoid hard dependency)
    const yamlPath = join(this.getProjectDir(projectName), 'infrastructure.yaml');
    if (existsSync(yamlPath)) {
      try {
        // Dynamic import for optional js-yaml dependency
        const content = readFileSync(yamlPath, 'utf-8');
        // Simple YAML parsing for key: value pairs — full YAML support via js-yaml
        return this.resolveConfigEnvVars(this.parseSimpleYaml(content));
      } catch {
        return null;
      }
    }

    return null;
  }

  getClaudeInstructions(projectName: string): string | null {
    const filePath = join(this.getProjectDir(projectName), 'claude-instructions.md');
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  }

  // --- Discovery ---

  listProjects(): string[] {
    const projectsDir = join(this.baseDir, 'projects');
    if (!existsSync(projectsDir)) return [];
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  projectExists(projectName: string): boolean {
    return existsSync(this.getProjectDir(projectName));
  }

  // --- Project ID helpers ---

  /** Look up the stored projectId for an appName. Returns null if none set. */
  getProjectIdForApp(appName: string): string | null {
    const config = this.getProjectConfig(appName);
    return config?.projectId ?? null;
  }

  /** Persist a projectId for an appName in its project config. */
  setProjectIdForApp(appName: string, projectId: string): void {
    this.ensureProjectDir(appName);
    const config = this.getProjectConfig(appName);
    if (config) {
      config.projectId = projectId;
      this.saveProjectConfig(appName, config);
    }
  }

  /** Resolve a projectId to an appName by scanning all project configs. Returns null if not found. */
  getAppForProjectId(projectId: string): string | null {
    for (const name of this.listProjects()) {
      const config = this.getProjectConfig(name);
      if (config?.projectId === projectId) return name;
    }
    return null;
  }

  // --- Reverse index: appName → projectId ---

  /**
   * Build reverse index: appName -> projectId.
   * Scans all project configs, PM projects with runtimeApps + runtimeProjectId,
   * and project-level .runtimescope/config.json files from PM project paths.
   */
  rebuildAppIndex(pmStore?: PmStoreIndexSource): void {
    this.appProjectIndex.clear();

    // Source 1: ~/.runtimescope/projects/*/config.json
    for (const name of this.listProjects()) {
      const config = this.getProjectConfig(name);
      if (config?.projectId) {
        this.appProjectIndex.set(name.toLowerCase(), config.projectId);
      }
    }

    // Source 2: PM projects with runtimeApps + runtimeProjectId
    if (pmStore) {
      for (const p of pmStore.listProjects()) {
        if (p.runtimeProjectId && p.runtimeApps) {
          for (const app of p.runtimeApps) {
            this.appProjectIndex.set(app.toLowerCase(), p.runtimeProjectId);
          }
        }
      }
    }

    // Source 3: Project-level .runtimescope/config.json files
    if (pmStore) {
      for (const p of pmStore.listProjects()) {
        if (p.path) {
          try {
            const configPath = join(p.path, '.runtimescope', 'config.json');
            if (existsSync(configPath)) {
              const content = readFileSync(configPath, 'utf-8');
              const config = JSON.parse(content);
              if (config.projectId) {
                // Index the top-level appName
                if (config.appName) {
                  this.appProjectIndex.set(config.appName.toLowerCase(), config.projectId);
                }
                // Index all SDK appNames
                if (Array.isArray(config.sdks)) {
                  for (const sdk of config.sdks) {
                    if (sdk.appName) {
                      this.appProjectIndex.set(sdk.appName.toLowerCase(), config.projectId);
                    }
                  }
                }
              }
            }
          } catch { /* non-fatal */ }
        }
      }
    }
  }

  /** O(1) lookup from the cached index. */
  resolveAppProjectId(appName: string): string | null {
    return this.appProjectIndex.get(appName.toLowerCase()) ?? null;
  }

  // --- Environment variable resolution ---

  resolveEnvVars(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? '';
    });
  }

  // --- Private helpers ---

  private mkdirp(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private readJson(path: string): unknown {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  }

  private writeJson(path: string, data: unknown): void {
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  private resolveConfigEnvVars(config: unknown): InfrastructureConfig {
    // Deep-resolve ${VAR} patterns in all string values
    const resolve = (obj: unknown): unknown => {
      if (typeof obj === 'string') return this.resolveEnvVars(obj);
      if (Array.isArray(obj)) return obj.map(resolve);
      if (obj && typeof obj === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = resolve(value);
        }
        return result;
      }
      return obj;
    };
    return resolve(config) as InfrastructureConfig;
  }

  /**
   * Minimal YAML parser for simple infrastructure config files.
   * Handles flat key-value pairs and one level of nesting.
   * For full YAML support, install js-yaml.
   */
  private parseSimpleYaml(content: string): InfrastructureConfig {
    try {
      // Try to use js-yaml if available
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const yaml = require('js-yaml');
      return yaml.load(content) as InfrastructureConfig;
    } catch {
      // Fallback: try JSON.parse in case it's JSON with .yaml extension
      try {
        return JSON.parse(content) as InfrastructureConfig;
      } catch {
        return {};
      }
    }
  }
}
