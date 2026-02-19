import type { DeployLog, BuildStatus, InfraOverview } from './types';

const BASE = Date.now() - 300_000;

export const MOCK_DEPLOYS: DeployLog[] = [
  { id: 'dpl_001', platform: 'Vercel', project: 'my-app', status: 'ready', url: 'https://my-app-abc123.vercel.app', branch: 'main', commit: 'a1b2c3d', createdAt: BASE - 3600000, readyAt: BASE - 3540000 },
  { id: 'dpl_002', platform: 'Vercel', project: 'my-app', status: 'ready', url: 'https://my-app-feat-xyz.vercel.app', branch: 'feature/campaign-editor', commit: 'e4f5g6h', createdAt: BASE - 7200000, readyAt: BASE - 7140000 },
  { id: 'dpl_003', platform: 'Vercel', project: 'my-app', status: 'error', branch: 'feature/broken-build', commit: 'i7j8k9l', createdAt: BASE - 10800000, errorMessage: 'Build failed: TypeScript error in src/pages/index.tsx' },
  { id: 'dpl_004', platform: 'Cloudflare Workers', project: 'api-worker', status: 'ready', url: 'https://api.example.com', branch: 'main', commit: 'm0n1o2p', createdAt: BASE - 14400000, readyAt: BASE - 14340000 },
  { id: 'dpl_005', platform: 'Cloudflare Workers', project: 'api-worker', status: 'building', branch: 'feature/new-endpoint', commit: 'q3r4s5t', createdAt: BASE - 60000 },
  { id: 'dpl_006', platform: 'Railway', project: 'background-jobs', status: 'ready', url: 'https://bg-jobs.up.railway.app', branch: 'main', commit: 'u6v7w8x', createdAt: BASE - 21600000, readyAt: BASE - 21480000 },
  { id: 'dpl_007', platform: 'Vercel', project: 'my-app', status: 'canceled', branch: 'experiment/dark-mode', commit: 'y9z0a1b', createdAt: BASE - 28800000 },
  { id: 'dpl_008', platform: 'Railway', project: 'background-jobs', status: 'error', branch: 'feature/queue-rework', commit: 'c2d3e4f', createdAt: BASE - 43200000, errorMessage: 'Container health check failed after 5 attempts' },
];

export const MOCK_BUILD_STATUS: BuildStatus[] = [
  { platform: 'Vercel', project: 'my-app', latestDeployId: 'dpl_001', status: 'ready', url: 'https://my-app.vercel.app', lastDeployed: BASE - 3540000 },
  { platform: 'Cloudflare Workers', project: 'api-worker', latestDeployId: 'dpl_005', status: 'building', lastDeployed: BASE - 60000 },
  { platform: 'Railway', project: 'background-jobs', latestDeployId: 'dpl_006', status: 'ready', url: 'https://bg-jobs.up.railway.app', lastDeployed: BASE - 21480000 },
];

export const MOCK_INFRA_OVERVIEW: InfraOverview = {
  project: 'my-app',
  platforms: [
    { name: 'Vercel', configured: true, deployCount: 47, lastDeploy: BASE - 3540000, status: 'ready' },
    { name: 'Cloudflare Workers', configured: true, deployCount: 23, lastDeploy: BASE - 60000, status: 'building' },
    { name: 'Railway', configured: true, deployCount: 12, lastDeploy: BASE - 21480000, status: 'ready' },
    { name: 'AWS', configured: false, deployCount: 0 },
    { name: 'Fly.io', configured: false, deployCount: 0 },
  ],
  detectedFromTraffic: ['Supabase', 'Mixpanel', 'Cloudflare CDN'],
};
