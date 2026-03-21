import { randomBytes } from 'node:crypto';
import type { ProjectManager } from './project-manager.js';

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
