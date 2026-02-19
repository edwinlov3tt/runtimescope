import type { SessionMetrics, SessionDiffResult } from './types';

const BASE = Date.now();

export const MOCK_SESSIONS: SessionMetrics[] = [
  {
    sessionId: 'sess_001', project: 'my-app', connectedAt: BASE - 3600000, disconnectedAt: BASE - 1800000,
    totalEvents: 342, errorCount: 5,
    endpoints: {
      'GET /api/campaigns': { avgLatency: 85, errorRate: 0, callCount: 12 },
      'POST /api/campaigns': { avgLatency: 210, errorRate: 0, callCount: 3 },
      'POST /graphql': { avgLatency: 370, errorRate: 0, callCount: 8 },
    },
    components: {
      'CampaignList': { renderCount: 47, avgDuration: 5.2 },
      'MetricCard': { renderCount: 156, avgDuration: 2.0 },
      'Dashboard': { renderCount: 23, avgDuration: 3.9 },
    },
    stores: { auth: { updateCount: 2 }, campaigns: { updateCount: 8 }, ui: { updateCount: 15 } },
    webVitals: {
      LCP: { value: 1200, rating: 'good' },
      FCP: { value: 820, rating: 'good' },
      CLS: { value: 0.08, rating: 'good' },
      INP: { value: 320, rating: 'needs-improvement' },
    },
    queries: {
      'SELECT campaigns': { avgDuration: 14, callCount: 24 },
      'SELECT ads': { avgDuration: 22, callCount: 18 },
    },
  },
  {
    sessionId: 'sess_002', project: 'my-app', connectedAt: BASE - 7200000, disconnectedAt: BASE - 5400000,
    totalEvents: 289, errorCount: 2,
    endpoints: {
      'GET /api/campaigns': { avgLatency: 92, errorRate: 0, callCount: 10 },
      'POST /graphql': { avgLatency: 410, errorRate: 0, callCount: 5 },
    },
    components: {
      'CampaignList': { renderCount: 35, avgDuration: 5.8 },
      'MetricCard': { renderCount: 120, avgDuration: 2.1 },
    },
    stores: { auth: { updateCount: 1 }, campaigns: { updateCount: 5 }, ui: { updateCount: 10 } },
    webVitals: {
      LCP: { value: 1400, rating: 'good' },
      FCP: { value: 950, rating: 'good' },
      CLS: { value: 0.12, rating: 'good' },
      INP: { value: 280, rating: 'needs-improvement' },
    },
    queries: {
      'SELECT campaigns': { avgDuration: 18, callCount: 20 },
      'SELECT ads': { avgDuration: 28, callCount: 14 },
    },
  },
  {
    sessionId: 'sess_003', project: 'my-app', connectedAt: BASE - 86400000, disconnectedAt: BASE - 82800000,
    totalEvents: 512, errorCount: 12,
    endpoints: {
      'GET /api/campaigns': { avgLatency: 145, errorRate: 0.05, callCount: 20 },
      'POST /api/campaigns': { avgLatency: 350, errorRate: 0.1, callCount: 10 },
      'POST /graphql': { avgLatency: 520, errorRate: 0.02, callCount: 12 },
    },
    components: {
      'CampaignList': { renderCount: 82, avgDuration: 7.1 },
      'MetricCard': { renderCount: 245, avgDuration: 2.8 },
      'Dashboard': { renderCount: 55, avgDuration: 5.2 },
    },
    stores: { auth: { updateCount: 4 }, campaigns: { updateCount: 18 }, ui: { updateCount: 25 } },
    webVitals: {
      LCP: { value: 2100, rating: 'needs-improvement' },
      FCP: { value: 1200, rating: 'needs-improvement' },
      CLS: { value: 0.22, rating: 'needs-improvement' },
      INP: { value: 450, rating: 'poor' },
    },
    queries: {
      'SELECT campaigns': { avgDuration: 32, callCount: 35 },
      'SELECT ads': { avgDuration: 45, callCount: 28 },
    },
  },
  {
    sessionId: 'sess_004', project: 'my-app', connectedAt: BASE - 172800000, disconnectedAt: BASE - 169200000,
    totalEvents: 198, errorCount: 1,
    endpoints: {
      'GET /api/campaigns': { avgLatency: 78, errorRate: 0, callCount: 8 },
    },
    components: {
      'CampaignList': { renderCount: 22, avgDuration: 4.5 },
      'MetricCard': { renderCount: 88, avgDuration: 1.8 },
    },
    stores: { auth: { updateCount: 1 }, campaigns: { updateCount: 3 }, ui: { updateCount: 6 } },
    webVitals: {
      LCP: { value: 1100, rating: 'good' },
      FCP: { value: 780, rating: 'good' },
      CLS: { value: 0.05, rating: 'good' },
      INP: { value: 190, rating: 'good' },
    },
    queries: {
      'SELECT campaigns': { avgDuration: 12, callCount: 15 },
    },
  },
  {
    sessionId: 'sess_005', project: 'my-app', connectedAt: BASE - 259200000, disconnectedAt: BASE - 255600000,
    totalEvents: 425, errorCount: 8,
    endpoints: {
      'GET /api/campaigns': { avgLatency: 125, errorRate: 0.03, callCount: 15 },
      'POST /api/campaigns': { avgLatency: 280, errorRate: 0.05, callCount: 8 },
    },
    components: {
      'CampaignList': { renderCount: 65, avgDuration: 6.2 },
      'MetricCard': { renderCount: 180, avgDuration: 2.4 },
    },
    stores: { auth: { updateCount: 3 }, campaigns: { updateCount: 12 }, ui: { updateCount: 18 } },
    webVitals: {
      LCP: { value: 1800, rating: 'good' },
      FCP: { value: 1050, rating: 'needs-improvement' },
      CLS: { value: 0.15, rating: 'good' },
      INP: { value: 380, rating: 'needs-improvement' },
    },
    queries: {
      'SELECT campaigns': { avgDuration: 25, callCount: 28 },
      'SELECT ads': { avgDuration: 35, callCount: 20 },
    },
  },
];

export const MOCK_SESSION_DIFF: SessionDiffResult = {
  sessionA: 'sess_003',
  sessionB: 'sess_001',
  endpointDeltas: [
    { key: 'GET /api/campaigns avgLatency', before: 145, after: 85, delta: -60, percentChange: -41.4, classification: 'improvement' },
    { key: 'POST /graphql avgLatency', before: 520, after: 370, delta: -150, percentChange: -28.8, classification: 'improvement' },
    { key: 'GET /api/campaigns errorRate', before: 0.05, after: 0, delta: -0.05, percentChange: -100, classification: 'improvement' },
  ],
  componentDeltas: [
    { key: 'CampaignList renderCount', before: 82, after: 47, delta: -35, percentChange: -42.7, classification: 'improvement' },
    { key: 'MetricCard renderCount', before: 245, after: 156, delta: -89, percentChange: -36.3, classification: 'improvement' },
    { key: 'CampaignList avgDuration', before: 7.1, after: 5.2, delta: -1.9, percentChange: -26.8, classification: 'improvement' },
  ],
  storeDeltas: [
    { key: 'campaigns updateCount', before: 18, after: 8, delta: -10, percentChange: -55.6, classification: 'improvement' },
    { key: 'ui updateCount', before: 25, after: 15, delta: -10, percentChange: -40.0, classification: 'improvement' },
  ],
  webVitalDeltas: [
    { key: 'LCP', before: 2100, after: 1200, delta: -900, percentChange: -42.9, classification: 'improvement' },
    { key: 'FCP', before: 1200, after: 820, delta: -380, percentChange: -31.7, classification: 'improvement' },
    { key: 'CLS', before: 0.22, after: 0.08, delta: -0.14, percentChange: -63.6, classification: 'improvement' },
    { key: 'INP', before: 450, after: 320, delta: -130, percentChange: -28.9, classification: 'improvement' },
  ],
  queryDeltas: [
    { key: 'SELECT campaigns avgDuration', before: 32, after: 14, delta: -18, percentChange: -56.3, classification: 'improvement' },
    { key: 'SELECT ads avgDuration', before: 45, after: 22, delta: -23, percentChange: -51.1, classification: 'improvement' },
  ],
  overallDelta: { errorCountDelta: -7, totalEventsDelta: 53 },
};
