import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InfraConnector } from '@runtimescope/collector';

export function registerInfraTools(
  server: McpServer,
  infraConnector: InfraConnector
): void {
  // --- get_deploy_logs ---
  server.tool(
    'get_deploy_logs',
    'Get deployment history from connected platforms (Vercel, Cloudflare, Railway). Shows build status, branch, commit, and timing.',
    {
      project: z.string().optional().describe('Project name'),
      platform: z.string().optional().describe('Filter by platform (vercel, cloudflare, railway)'),
      deploy_id: z.string().optional().describe('Get details for a specific deployment'),
    },
    async ({ project, platform, deploy_id }) => {
      const logs = await infraConnector.getDeployLogs(project ?? 'default', platform, deploy_id);

      const response = {
        summary: `${logs.length} deployment(s) found.`,
        data: logs.map((l) => ({
          id: l.id,
          platform: l.platform,
          status: l.status,
          url: l.url ?? null,
          branch: l.branch ?? null,
          commit: l.commit?.slice(0, 8) ?? null,
          createdAt: new Date(l.createdAt).toISOString(),
          readyAt: l.readyAt ? new Date(l.readyAt).toISOString() : null,
          error: l.errorMessage ?? null,
        })),
        issues: logs.filter((l) => l.status === 'error').map((l) => `Deploy ${l.id.slice(0, 8)} failed on ${l.platform}`),
        metadata: {
          timeRange: logs.length > 0
            ? { from: Math.min(...logs.map((l) => l.createdAt)), to: Math.max(...logs.map((l) => l.createdAt)) }
            : { from: 0, to: 0 },
          eventCount: logs.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_runtime_logs ---
  server.tool(
    'get_runtime_logs',
    'Get runtime error/info logs from connected deployment platforms.',
    {
      project: z.string().optional().describe('Project name'),
      platform: z.string().optional().describe('Filter by platform'),
      level: z.string().optional().describe('Filter by log level (info, warn, error)'),
      since_seconds: z.number().optional().describe('Only return logs from the last N seconds'),
    },
    async ({ project, platform, level, since_seconds }) => {
      const since = since_seconds ? Date.now() - since_seconds * 1000 : undefined;
      const logs = await infraConnector.getRuntimeLogs(project ?? 'default', { platform, since, level });

      const response = {
        summary: `${logs.length} runtime log(s) found.`,
        data: logs.map((l) => ({
          timestamp: new Date(l.timestamp).toISOString(),
          level: l.level,
          message: l.message,
          source: l.source ?? null,
          platform: l.platform,
        })),
        issues: logs.filter((l) => l.level === 'error').length > 0
          ? [`${logs.filter((l) => l.level === 'error').length} error(s) in runtime logs`]
          : [],
        metadata: {
          timeRange: logs.length > 0
            ? { from: logs[logs.length - 1].timestamp, to: logs[0].timestamp }
            : { from: 0, to: 0 },
          eventCount: logs.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_build_status ---
  server.tool(
    'get_build_status',
    'Get the current deployment status for each connected platform.',
    {
      project: z.string().optional().describe('Project name'),
    },
    async ({ project }) => {
      const statuses = await infraConnector.getBuildStatus(project ?? 'default');

      const response = {
        summary: `${statuses.length} platform(s) reporting build status.`,
        data: statuses.map((s) => ({
          platform: s.platform,
          project: s.project,
          status: s.status,
          url: s.url ?? null,
          lastDeployed: new Date(s.lastDeployed).toISOString(),
          deployId: s.latestDeployId,
        })),
        issues: statuses.filter((s) => s.status === 'error').map((s) => `${s.platform}: latest deploy failed`),
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: statuses.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_infra_overview ---
  server.tool(
    'get_infra_overview',
    'Overview of which platforms a project uses, combining explicit configuration with auto-detection from network traffic.',
    {
      project: z.string().optional().describe('Project name'),
    },
    async ({ project }) => {
      const overview = infraConnector.getInfraOverview(project);

      const response = {
        summary: overview.length > 0
          ? `Infrastructure overview: ${overview[0].platforms.length} configured platform(s), ${overview[0].detectedFromTraffic.length} detected from traffic.`
          : 'No infrastructure information available.',
        data: overview,
        issues: [] as string[],
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: overview.length,
          sessionId: null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
