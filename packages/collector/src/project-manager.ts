import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ============================================================
// Project Manager — manages ~/.runtimescope/ directory structure
// ============================================================

export interface GlobalConfig {
  defaultPort: number;
  bufferSize: number;
  httpPort: number;
}

export interface ProjectConfig {
  name: string;
  createdAt: string;
  sdkVersion?: string;
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

export class ProjectManager {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.runtimescope');
  }

  get rootDir(): string {
    return this.baseDir;
  }

  // --- Directory helpers ---

  getProjectDir(projectName: string): string {
    return join(this.baseDir, 'projects', projectName);
  }

  getProjectDbPath(projectName: string): string {
    return join(this.getProjectDir(projectName), 'events.db');
  }

  getSessionsDir(projectName: string): string {
    return join(this.getProjectDir(projectName), 'sessions');
  }

  getSessionSnapshotPath(
    projectName: string,
    sessionId: string,
    timestamp: number
  ): string {
    const date = new Date(timestamp);
    const dateStr = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const shortId = sessionId.slice(0, 8);
    return join(this.getSessionsDir(projectName), `${dateStr}_${shortId}.db`);
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
    this.mkdirp(this.getSessionsDir(projectName));

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
