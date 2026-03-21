import { z } from 'zod';
import type { EventStore, SessionInfo } from '@runtimescope/collector';

/** Reusable zod param for project_id across all MCP tools. */
export const projectIdParam = z.string().optional().describe(
  'Scope to a specific project by its project ID (proj_xxx). Omit to query all sessions.'
);

/**
 * Resolve session context, optionally scoped to a projectId.
 * Returns the filtered session list and the first matching sessionId.
 */
export function resolveSessionContext(
  store: EventStore,
  projectId?: string,
): { sessions: SessionInfo[]; sessionId: string | null; projectId?: string } {
  const all = store.getSessionInfo();
  const sessions = projectId
    ? all.filter((s) => s.projectId === projectId)
    : all;
  return {
    sessions,
    sessionId: sessions[0]?.sessionId ?? null,
    projectId,
  };
}
