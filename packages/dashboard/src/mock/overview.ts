import type { ActivityItem } from '@/components/ui/activity-feed';

const BASE = Date.now();

export const MOCK_OVERVIEW_STATS = {
  requests: { value: 1247, change: 12, label: 'from last session', sparkline: [45, 52, 48, 65, 72, 58, 80, 95, 88, 102, 98, 110, 105, 115, 120, 108, 125, 130, 122, 135] },
  latency: { value: 145, suffix: 'ms', change: -8, label: 'faster', sparkline: [220, 200, 185, 175, 168, 160, 155, 150, 148, 145, 148, 152, 145, 142, 140, 145, 148, 145, 143, 145] },
  renders: { value: 3423, change: 565, label: 'regression', sparkline: [120, 135, 148, 180, 210, 245, 280, 310, 295, 320, 340, 355, 330, 345, 360, 370, 355, 365, 375, 380] },
  issues: { value: 7, change: 0, sparkline: [3, 3, 4, 5, 5, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7] },
};

export const MOCK_ACTIVITY: ActivityItem[] = [
  { id: 'act_01', type: 'network', message: 'GET /api/campaigns — 200 (85ms)', timestamp: BASE - 5000, meta: 'campaigns-api' },
  { id: 'act_02', type: 'console', message: 'Campaign created: "New Campaign"', timestamp: BASE - 12000, meta: 'src/api/campaigns.ts' },
  { id: 'act_03', type: 'render', message: 'MetricCard rendered 12 times in 2s', timestamp: BASE - 18000, meta: 'Suspicious render velocity' },
  { id: 'act_04', type: 'state', message: 'campaigns store: 3 items → 4 items', timestamp: BASE - 25000, meta: 'campaigns/created' },
  { id: 'act_05', type: 'database', message: 'SELECT campaigns — 12ms (15 rows)', timestamp: BASE - 30000, meta: 'prisma' },
  { id: 'act_06', type: 'issue', message: 'N+1 Query Pattern Detected', timestamp: BASE - 35000, meta: 'High severity' },
  { id: 'act_07', type: 'network', message: 'POST /api/process — 500 (3.2s)', timestamp: BASE - 40000, meta: 'Database connection timeout' },
  { id: 'act_08', type: 'console', message: 'TypeError: Cannot read "map" of undefined', timestamp: BASE - 45000, meta: 'src/components/campaign-stats.tsx' },
  { id: 'act_09', type: 'performance', message: 'INP: 320ms (needs improvement)', timestamp: BASE - 50000, meta: 'button.campaign-action' },
  { id: 'act_10', type: 'network', message: 'POST /graphql GetCharacter — 200 (429ms)', timestamp: BASE - 55000, meta: 'graphql-api' },
  { id: 'act_11', type: 'state', message: 'ui store: sidebar toggled', timestamp: BASE - 60000, meta: 'ui/toggleSidebar' },
  { id: 'act_12', type: 'database', message: 'JOIN campaigns + ads — 145ms (15 rows)', timestamp: BASE - 65000, meta: 'Slow query' },
  { id: 'act_13', type: 'console', message: 'Deprecated API: /api/v1/users', timestamp: BASE - 70000, meta: 'Warning' },
  { id: 'act_14', type: 'render', message: 'Sidebar: 42 renders (parent cause)', timestamp: BASE - 75000, meta: 'Cascading from context' },
  { id: 'act_15', type: 'network', message: 'POST /api/campaigns/search — 408 (timeout)', timestamp: BASE - 80000, meta: '30s timeout' },
  { id: 'act_16', type: 'issue', message: 'Excessive Re-renders: MetricCard', timestamp: BASE - 85000, meta: 'High severity' },
  { id: 'act_17', type: 'database', message: 'UPDATE campaigns SET budget — Error', timestamp: BASE - 90000, meta: 'Check constraint violation' },
  { id: 'act_18', type: 'console', message: 'Auth token refreshed', timestamp: BASE - 95000, meta: 'src/lib/auth.ts' },
  { id: 'act_19', type: 'performance', message: 'LCP: 1.2s (good)', timestamp: BASE - 100000, meta: 'main > img.hero' },
  { id: 'act_20', type: 'network', message: 'GET /api/users/me — 200 (45ms)', timestamp: BASE - 105000, meta: 'auth-api' },
];
