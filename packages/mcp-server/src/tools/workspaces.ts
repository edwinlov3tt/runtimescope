/**
 * Workspace management MCP tools.
 *
 * Workspaces are the top-level tenancy boundary: every project belongs to
 * exactly one workspace, and every API key is scoped to one workspace.
 * On a fresh install there's just a "Personal" workspace; these tools let
 * Claude create more (e.g. "Work", "Production") and move projects around.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PmStore } from '@runtimescope/collector';

interface ListWorkspacesData {
  id: string;
  name: string;
  slug: string;
  description?: string;
  isDefault: boolean;
  projectCount: number;
  apiKeyCount: number;
  createdAt: string;
}

export function registerWorkspaceTools(server: McpServer, pmStore: PmStore | undefined): void {
  if (!pmStore) {
    // No PM store configured — these tools can't function. Register nothing.
    return;
  }

  server.tool(
    'list_workspaces',
    'List all workspaces (tenancy containers). Every project belongs to exactly one workspace. The default workspace is usually called "Personal" — create additional ones (e.g. "Work", "Production") to isolate different contexts or teams.',
    {},
    async () => {
      const workspaces = pmStore.listWorkspaces();
      const projects = pmStore.listProjects();
      const data: ListWorkspacesData[] = workspaces.map((ws) => {
        const projectsInWs = projects.filter((p) => p.workspaceId === ws.id);
        const keys = pmStore.listApiKeys(ws.id);
        return {
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          description: ws.description,
          isDefault: ws.isDefault === true,
          projectCount: projectsInWs.length,
          apiKeyCount: keys.length,
          createdAt: new Date(ws.createdAt).toISOString(),
        };
      });

      const response = {
        summary: `${workspaces.length} workspace(s). ${projects.length} project(s) total.`,
        data,
        issues: [],
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: 0,
          sessionId: null,
          projectId: null,
        },
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'create_workspace',
    'Create a new workspace. Useful for separating personal projects from work, or keeping different customers/environments isolated. Returns the new workspace id — use it with move_project_to_workspace and create_workspace_api_key.',
    {
      name: z.string().min(1).describe('Display name, e.g. "Work" or "Acme Corp"'),
      slug: z
        .string()
        .optional()
        .describe(
          'Optional URL-safe slug. Auto-derived from the name if omitted. Must be unique.',
        ),
      description: z.string().optional().describe('Optional description'),
    },
    async ({ name, slug, description }) => {
      try {
        const ws = pmStore.createWorkspace({ name, slug, description });
        const response = {
          summary: `Created workspace "${ws.name}" (${ws.id}).`,
          data: ws,
          issues: [],
          metadata: {
            timeRange: { from: 0, to: Date.now() },
            eventCount: 0,
            sessionId: null,
            projectId: null,
          },
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                summary: `Failed to create workspace: ${(err as Error).message}`,
                data: null,
                issues: [(err as Error).message],
              }, null, 2),
            },
          ],
        };
      }
    },
  );

  server.tool(
    'move_project_to_workspace',
    'Move a project from its current workspace to a different one. Does not move or delete any data — only changes the tenancy pointer.',
    {
      project_id: z.string().describe('PM project id (e.g. "edwinlovettiii--flighting-docs"). Not the runtime projectId.'),
      workspace_id: z.string().describe('Target workspace id (e.g. "ws_abc123").'),
    },
    async ({ project_id, workspace_id }) => {
      try {
        const project = pmStore.getProject(project_id);
        if (!project) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                summary: `Project ${project_id} not found.`,
                data: null,
                issues: ['project-not-found'],
              }, null, 2),
            }],
          };
        }
        pmStore.setProjectWorkspace(project_id, workspace_id);
        const response = {
          summary: `Moved project "${project.name}" to workspace ${workspace_id}.`,
          data: pmStore.getProject(project_id),
          issues: [],
          metadata: {
            timeRange: { from: 0, to: Date.now() },
            eventCount: 0,
            sessionId: null,
            projectId: null,
          },
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: `Failed: ${(err as Error).message}`,
              data: null,
              issues: [(err as Error).message],
            }, null, 2),
          }],
        };
      }
    },
  );

  server.tool(
    'create_workspace_api_key',
    'Create a new API key scoped to the given workspace. The secret is returned EXACTLY ONCE — record it, because we cannot show it again. Use this key as the Bearer token in the SDK DSN: `runtimescope://proj_xxx:TOKEN@host:port/app`.',
    {
      workspace_id: z.string().describe('Workspace id (e.g. "ws_abc123").'),
      label: z
        .string()
        .describe('Human-readable label, e.g. "CI server", "Production backend", "Local dev key".'),
      expires_at: z
        .number()
        .optional()
        .describe('Optional Unix timestamp (ms) after which the key is no longer valid.'),
    },
    async ({ workspace_id, label, expires_at }) => {
      try {
        const apiKey = pmStore.createApiKey(workspace_id, label, expires_at);
        const response = {
          summary: `Created API key for workspace ${workspace_id}. Store the \`key\` field securely — it will not be shown again.`,
          data: apiKey,
          issues: [],
          metadata: {
            timeRange: { from: 0, to: Date.now() },
            eventCount: 0,
            sessionId: null,
            projectId: null,
          },
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: `Failed: ${(err as Error).message}`,
              data: null,
              issues: [(err as Error).message],
            }, null, 2),
          }],
        };
      }
    },
  );
}
