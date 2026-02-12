import { describe, it, expect, vi } from 'vitest';
import { registerInfraTools } from '../tools/infra-connector.js';
import { createMcpStub } from './tool-harness.js';

function stubInfraConnector(options: {
  deployLogs?: any[];
  runtimeLogs?: any[];
  buildStatuses?: any[];
  infraOverview?: any[];
} = {}) {
  return {
    getDeployLogs: vi.fn(async () => options.deployLogs ?? []),
    getRuntimeLogs: vi.fn(async () => options.runtimeLogs ?? []),
    getBuildStatus: vi.fn(async () => options.buildStatuses ?? []),
    getInfraOverview: vi.fn(() => options.infraOverview ?? []),
    loadConfig: vi.fn(async () => {}),
  } as any;
}

describe('infrastructure MCP tools', () => {
  describe('get_deploy_logs', () => {
    it('returns response envelope structure', async () => {
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector());
      const result = await callTool('get_deploy_logs', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('metadata');
    });

    it('returns empty data when no deployments', async () => {
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector());
      const result = await callTool('get_deploy_logs', {});
      expect(result.data).toEqual([]);
      expect(result.summary).toContain('0 deployment');
    });

    it('maps deploy log fields correctly', async () => {
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector({
        deployLogs: [{
          id: 'dpl_abc123def456',
          platform: 'vercel',
          status: 'ready',
          url: 'https://myapp.vercel.app',
          branch: 'main',
          commit: 'a1b2c3d4e5f6g7h8',
          createdAt: Date.now() - 60000,
          readyAt: Date.now(),
          errorMessage: null,
        }],
      }));
      const result = await callTool('get_deploy_logs', {});
      expect(result.data).toHaveLength(1);
      const d = result.data[0];
      expect(d.id).toBe('dpl_abc123def456');
      expect(d.platform).toBe('vercel');
      expect(d.status).toBe('ready');
      expect(d.url).toBe('https://myapp.vercel.app');
      expect(d.branch).toBe('main');
      expect(d.commit).toBe('a1b2c3d4'); // truncated to 8 chars
    });

    it('flags failed deploys in issues', async () => {
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector({
        deployLogs: [{
          id: 'dpl_failed123',
          platform: 'vercel',
          status: 'error',
          url: null,
          branch: 'main',
          commit: 'abc12345',
          createdAt: Date.now(),
          readyAt: null,
          errorMessage: 'Build failed',
        }],
      }));
      const result = await callTool('get_deploy_logs', {});
      expect(result.issues.some((i: string) => i.includes('failed'))).toBe(true);
    });
  });

  describe('get_runtime_logs', () => {
    it('returns response envelope', async () => {
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector());
      const result = await callTool('get_runtime_logs', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
    });

    it('maps runtime log fields', async () => {
      const now = Date.now();
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector({
        runtimeLogs: [
          { timestamp: now, level: 'error', message: 'Unhandled rejection', source: 'api/route.ts', platform: 'vercel' },
          { timestamp: now - 1000, level: 'info', message: 'Server started', source: null, platform: 'vercel' },
        ],
      }));
      const result = await callTool('get_runtime_logs', {});
      expect(result.data).toHaveLength(2);
      expect(result.data[0].level).toBe('error');
      expect(result.data[0].message).toBe('Unhandled rejection');
    });

    it('flags errors in issues', async () => {
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector({
        runtimeLogs: [
          { timestamp: Date.now(), level: 'error', message: 'Error!', source: null, platform: 'vercel' },
        ],
      }));
      const result = await callTool('get_runtime_logs', {});
      expect(result.issues.some((i: string) => i.includes('error'))).toBe(true);
    });
  });

  describe('get_build_status', () => {
    it('returns platform statuses', async () => {
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector({
        buildStatuses: [
          { platform: 'vercel', project: 'myapp', status: 'ready', url: 'https://myapp.vercel.app', lastDeployed: Date.now(), latestDeployId: 'dpl_123' },
        ],
      }));
      const result = await callTool('get_build_status', {});
      expect(result.data).toHaveLength(1);
      expect(result.data[0].platform).toBe('vercel');
      expect(result.data[0].status).toBe('ready');
    });

    it('flags error statuses in issues', async () => {
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector({
        buildStatuses: [
          { platform: 'cloudflare', project: 'myapp', status: 'error', url: null, lastDeployed: Date.now(), latestDeployId: 'dpl_456' },
        ],
      }));
      const result = await callTool('get_build_status', {});
      expect(result.issues.some((i: string) => i.includes('cloudflare'))).toBe(true);
    });
  });

  describe('get_infra_overview', () => {
    it('returns overview with platforms and traffic detection', async () => {
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector({
        infraOverview: [{
          project: 'myapp',
          platforms: ['vercel'],
          detectedFromTraffic: ['Supabase', 'Stripe'],
        }],
      }));
      const result = await callTool('get_infra_overview', {});
      expect(result.data).toHaveLength(1);
      expect(result.summary).toContain('1 configured platform');
      expect(result.summary).toContain('2 detected from traffic');
    });

    it('handles empty overview', async () => {
      const { server, callTool } = createMcpStub();
      registerInfraTools(server, stubInfraConnector());
      const result = await callTool('get_infra_overview', {});
      expect(result.summary).toContain('No infrastructure information');
    });
  });
});
