import type { EventStore } from '../store.js';
import type { ProjectManager } from '../project-manager.js';
import type {
  DeployLog,
  RuntimeLog,
  BuildStatus,
  InfraOverview,
} from '../types.js';

// ============================================================
// Infrastructure Connector Engine
// Connects to deployment platform APIs (Vercel, Cloudflare, Railway)
// ============================================================

interface PlatformClient {
  name: string;
  getDeployments(opts?: { limit?: number; deployId?: string }): Promise<DeployLog[]>;
  getRuntimeLogs(opts?: { since?: number; level?: string }): Promise<RuntimeLog[]>;
  getBuildStatus(): Promise<BuildStatus | null>;
}

// --- Vercel Client ---

function createVercelClient(projectId: string, token: string): PlatformClient {
  const baseUrl = 'https://api.vercel.com';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  return {
    name: 'Vercel',
    async getDeployments(opts) {
      const limit = opts?.limit ?? 10;
      const url = opts?.deployId
        ? `${baseUrl}/v13/deployments/${opts.deployId}`
        : `${baseUrl}/v6/deployments?projectId=${projectId}&limit=${limit}`;

      const res = await fetch(url, { headers });
      if (!res.ok) return [];

      const data = await res.json() as Record<string, unknown>;

      if (opts?.deployId) {
        return [mapVercelDeployment(data, projectId)];
      }

      const deployments = (data.deployments ?? []) as Record<string, unknown>[];
      return deployments.map((d) => mapVercelDeployment(d, projectId));
    },

    async getRuntimeLogs(opts) {
      // Vercel runtime logs require specific deployment ID — return empty for now
      void opts;
      return [];
    },

    async getBuildStatus() {
      const res = await fetch(`${baseUrl}/v6/deployments?projectId=${projectId}&limit=1`, { headers });
      if (!res.ok) return null;

      const data = await res.json() as Record<string, unknown>;
      const deployments = (data.deployments ?? []) as Record<string, unknown>[];
      if (deployments.length === 0) return null;

      const latest = deployments[0];
      return {
        platform: 'Vercel',
        project: projectId,
        latestDeployId: latest.uid as string,
        status: mapVercelStatus(latest.state as string),
        url: latest.url ? `https://${latest.url}` : undefined,
        lastDeployed: latest.created as number,
      };
    },
  };
}

function mapVercelDeployment(d: Record<string, unknown>, projectId: string): DeployLog {
  return {
    id: d.uid as string,
    platform: 'Vercel',
    project: projectId,
    status: mapVercelStatus(d.state as string ?? d.readyState as string),
    url: d.url ? `https://${d.url}` : undefined,
    branch: (d.meta as Record<string, unknown>)?.githubCommitRef as string | undefined,
    commit: (d.meta as Record<string, unknown>)?.githubCommitSha as string | undefined,
    createdAt: d.created as number ?? d.createdAt as number,
    readyAt: d.ready as number | undefined,
    errorMessage: undefined,
  };
}

function mapVercelStatus(state: string): DeployLog['status'] {
  if (state === 'READY' || state === 'ready') return 'ready';
  if (state === 'ERROR' || state === 'error') return 'error';
  if (state === 'CANCELED' || state === 'canceled') return 'canceled';
  return 'building';
}

// --- Cloudflare Client ---

function createCloudflareClient(accountId: string, workerName: string, token: string): PlatformClient {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  return {
    name: 'Cloudflare Workers',
    async getDeployments(opts) {
      void opts;
      // Cloudflare doesn't have a direct deployments list for workers
      // We can check the worker script upload history
      const res = await fetch(`${baseUrl}/workers/scripts/${workerName}`, { headers });
      if (!res.ok) return [];

      const data = await res.json() as Record<string, unknown>;
      const result = data.result as Record<string, unknown> | undefined;
      if (!result) return [];

      return [{
        id: result.id as string ?? workerName,
        platform: 'Cloudflare Workers',
        project: workerName,
        status: 'ready' as const,
        createdAt: new Date(result.modified_on as string).getTime(),
      }];
    },

    async getRuntimeLogs(opts) {
      void opts;
      // Cloudflare worker logs require WebSocket connection to tail endpoint
      return [];
    },

    async getBuildStatus() {
      const res = await fetch(`${baseUrl}/workers/scripts/${workerName}`, { headers });
      if (!res.ok) return null;

      const data = await res.json() as Record<string, unknown>;
      const result = data.result as Record<string, unknown> | undefined;
      if (!result) return null;

      return {
        platform: 'Cloudflare Workers',
        project: workerName,
        latestDeployId: result.id as string ?? workerName,
        status: 'ready' as const,
        lastDeployed: new Date(result.modified_on as string).getTime(),
      };
    },
  };
}

// --- Railway Client ---

function createRailwayClient(projectId: string, token: string): PlatformClient {
  const graphqlUrl = 'https://backboard.railway.app/graphql/v2';

  async function gql(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return {};
    return await res.json() as Record<string, unknown>;
  }

  return {
    name: 'Railway',
    async getDeployments(opts) {
      const limit = opts?.limit ?? 10;
      const data = await gql(`
        query($projectId: String!, $first: Int) {
          deployments(input: { projectId: $projectId }, first: $first) {
            edges {
              node {
                id
                status
                createdAt
                url
                meta { branch commitHash }
              }
            }
          }
        }
      `, { projectId, first: limit });

      const edges = ((data.data as Record<string, unknown>)?.deployments as Record<string, unknown>)?.edges as { node: Record<string, unknown> }[] ?? [];

      return edges.map((edge) => {
        const d = edge.node;
        const meta = d.meta as Record<string, unknown> | undefined;
        return {
          id: d.id as string,
          platform: 'Railway',
          project: projectId,
          status: mapRailwayStatus(d.status as string),
          url: d.url as string | undefined,
          branch: meta?.branch as string | undefined,
          commit: meta?.commitHash as string | undefined,
          createdAt: new Date(d.createdAt as string).getTime(),
        };
      });
    },

    async getRuntimeLogs(opts) {
      void opts;
      // Railway logs require specific deployment ID and streaming
      return [];
    },

    async getBuildStatus() {
      const data = await gql(`
        query($projectId: String!) {
          deployments(input: { projectId: $projectId }, first: 1) {
            edges {
              node { id status createdAt url }
            }
          }
        }
      `, { projectId });

      const edges = ((data.data as Record<string, unknown>)?.deployments as Record<string, unknown>)?.edges as { node: Record<string, unknown> }[] ?? [];
      if (edges.length === 0) return null;

      const d = edges[0].node;
      return {
        platform: 'Railway',
        project: projectId,
        latestDeployId: d.id as string,
        status: mapRailwayStatus(d.status as string),
        url: d.url as string | undefined,
        lastDeployed: new Date(d.createdAt as string).getTime(),
      };
    },
  };
}

function mapRailwayStatus(status: string): DeployLog['status'] {
  if (status === 'SUCCESS') return 'ready';
  if (status === 'FAILED') return 'error';
  if (status === 'REMOVED' || status === 'CANCELLED') return 'canceled';
  return 'building';
}

// ============================================================
// Main Engine
// ============================================================

export class InfraConnector {
  private store: EventStore;
  private clients: Map<string, PlatformClient> = new Map();

  constructor(store: EventStore) {
    this.store = store;
  }

  loadFromConfig(projectManager: ProjectManager, projectName: string): void {
    const config = projectManager.getInfrastructureConfig(projectName);
    if (!config?.deployments) return;

    for (const [key, deployment] of Object.entries(config.deployments)) {
      switch (deployment.platform) {
        case 'vercel': {
          const token = process.env.VERCEL_TOKEN ?? '';
          if (token && deployment.project_id) {
            this.clients.set(key, createVercelClient(deployment.project_id, token));
          }
          break;
        }
        case 'cloudflare': {
          const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
          if (token && deployment.account_id && deployment.worker_name) {
            this.clients.set(key, createCloudflareClient(deployment.account_id, deployment.worker_name, token));
          }
          break;
        }
        case 'railway': {
          const token = process.env.RAILWAY_TOKEN ?? '';
          if (token && deployment.project_id) {
            this.clients.set(key, createRailwayClient(deployment.project_id, token));
          }
          break;
        }
      }
    }
  }

  async getDeployLogs(project: string, platform?: string, deployId?: string): Promise<DeployLog[]> {
    const results: DeployLog[] = [];

    for (const [key, client] of this.clients) {
      if (platform && client.name.toLowerCase() !== platform.toLowerCase()) continue;
      void key;

      try {
        const logs = await client.getDeployments({ deployId, limit: 10 });
        results.push(...logs);
      } catch {
        // Platform API may be unavailable
      }
    }

    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  async getRuntimeLogs(project: string, opts?: { platform?: string; since?: number; level?: string }): Promise<RuntimeLog[]> {
    const results: RuntimeLog[] = [];

    for (const [, client] of this.clients) {
      if (opts?.platform && client.name.toLowerCase() !== opts.platform.toLowerCase()) continue;

      try {
        const logs = await client.getRuntimeLogs(opts);
        results.push(...logs);
      } catch {
        // Platform API may be unavailable
      }
    }

    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  async getBuildStatus(project: string): Promise<BuildStatus[]> {
    const results: BuildStatus[] = [];

    for (const [, client] of this.clients) {
      try {
        const status = await client.getBuildStatus();
        if (status) results.push(status);
      } catch {
        // Platform API may be unavailable
      }
    }

    return results;
  }

  getInfraOverview(project?: string): InfraOverview[] {
    // Detect services from network traffic
    const networkEvents = this.store.getNetworkRequests();
    const detectedPlatforms = new Set<string>();

    for (const event of networkEvents) {
      try {
        const hostname = new URL(event.url).hostname;
        if (hostname.includes('vercel')) detectedPlatforms.add('Vercel');
        if (hostname.includes('cloudflare') || hostname.includes('workers.dev')) detectedPlatforms.add('Cloudflare');
        if (hostname.includes('railway')) detectedPlatforms.add('Railway');
        if (hostname.includes('supabase')) detectedPlatforms.add('Supabase');
        if (hostname.includes('firebase')) detectedPlatforms.add('Firebase');
        if (hostname.includes('netlify')) detectedPlatforms.add('Netlify');
      } catch { /* ignore */ }
    }

    const platforms = Array.from(this.clients.entries()).map(([, client]) => ({
      name: client.name,
      configured: true,
      deployCount: 0,
      status: 'configured',
    }));

    return [{
      project: project ?? 'default',
      platforms,
      detectedFromTraffic: [...detectedPlatforms],
    }];
  }
}
