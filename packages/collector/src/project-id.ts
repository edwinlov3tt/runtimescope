import { randomBytes } from 'node:crypto';
import type { ProjectManager } from './project-manager.js';

/** Minimal interface for PmStore to avoid circular dependencies. */
export interface PmStoreLike {
  findProjectIdByApp(appName: string): string | null;
  getWorkspaceByApiKey?(key: string): { id: string; slug: string; name: string } | null;
  listProjects?(): Array<{ id: string; runtimeProjectId?: string; workspaceId?: string }>;
  setProjectWorkspace?(projectId: string, workspaceId: string): void;
  autoLinkApp?(appName: string, projectId?: string): string | null;
}

// ============================================================
// Project ID — stable identifier for grouping all SDKs in a project
// Format: proj_ + 12 alphanumeric chars (e.g., proj_a1b2c3d4e5f6)
// ============================================================

const PROJECT_ID_PREFIX = 'proj_';
const PROJECT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PROJECT_ID_LENGTH = 12;
const PROJECT_ID_REGEX = /^proj_[a-z0-9]{12}$/;

/** Generate a new project ID (proj_ + 12 random alphanumeric chars). */
export function generateProjectId(): string {
  const bytes = randomBytes(PROJECT_ID_LENGTH);
  let id = PROJECT_ID_PREFIX;
  for (let i = 0; i < PROJECT_ID_LENGTH; i++) {
    id += PROJECT_ID_CHARS[bytes[i] % PROJECT_ID_CHARS.length];
  }
  return id;
}

/** Validate that a string is a well-formed project ID. */
export function isValidProjectId(id: string): boolean {
  return PROJECT_ID_REGEX.test(id);
}

/**
 * Look up or create a project ID for a given appName.
 * Persists the ID in the ProjectManager config so the same appName
 * always returns the same project ID (idempotent).
 */
export function getOrCreateProjectId(projectManager: ProjectManager, appName: string): string {
  // Check if this app already has a project ID
  const existing = projectManager.getProjectIdForApp(appName);
  if (existing) return existing;

  // Generate and persist a new one
  const projectId = generateProjectId();
  projectManager.ensureProjectDir(appName);
  projectManager.setProjectIdForApp(appName, projectId);
  return projectId;
}

/**
 * Resolve a projectId for an appName using a priority chain:
 * 1. ProjectManager cached index (fastest — scans project configs)
 * 2. PmStore lookup (PM project's runtimeProjectId)
 * 3. Existing per-appName config (~/.runtimescope/projects/<appName>/)
 * 4. Generate new (last resort)
 */
export function resolveProjectId(
  projectManager: ProjectManager,
  appName: string,
  pmStore?: PmStoreLike | null,
): string {
  // Step 1: Check cached reverse index
  const fromIndex = projectManager.resolveAppProjectId(appName);
  if (fromIndex) return fromIndex;

  // Step 2: Check PM store
  if (pmStore) {
    const fromPm = pmStore.findProjectIdByApp(appName);
    if (fromPm) {
      // Cache it for next time
      projectManager.setProjectIdForApp(appName, fromPm);
      return fromPm;
    }
  }

  // Step 3+4: Existing or generate new (original behavior)
  return getOrCreateProjectId(projectManager, appName);
}
