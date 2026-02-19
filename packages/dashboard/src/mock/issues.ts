import type { DetectedIssue } from './types';

export const MOCK_ISSUES: DetectedIssue[] = [
  {
    id: 'issue_001', pattern: 'n_plus_one', severity: 'high',
    title: 'N+1 Query Pattern Detected',
    description: 'The CampaignList component triggers individual SELECT queries for each campaign\'s ads, resulting in 15 separate queries instead of a single JOIN.',
    evidence: ['SELECT ... FROM ads WHERE campaign_id = 1', 'SELECT ... FROM ads WHERE campaign_id = 2', '... repeated 15 times in 2.3s window'],
    suggestion: 'Use a single query with JOIN or batch the IDs: SELECT * FROM ads WHERE campaign_id IN ($1, $2, ...)',
  },
  {
    id: 'issue_002', pattern: 'excessive_renders', severity: 'high',
    title: 'Excessive Re-renders: MetricCard',
    description: 'MetricCard component rendered 156 times in the last 5 minutes. The component receives new props on every parent render due to unstable object references.',
    evidence: ['156 renders, avg 2.0ms each', 'Render velocity: 31.2/min', 'Cause: props (unstable reference)'],
    suggestion: 'Memoize the props object or use React.memo with a custom comparison function.',
  },
  {
    id: 'issue_003', pattern: 'slow_query', severity: 'medium',
    title: 'Slow Query: Campaign Stats Join',
    description: 'Query joining campaigns and ads tables averages 135ms with P95 at 245ms. Missing index on ads.campaign_id may be contributing.',
    evidence: ['Avg: 135ms, P95: 245ms, Max: 280ms', '8 calls in session', 'Tables: campaigns, ads'],
    suggestion: 'Add index: CREATE INDEX idx_ads_campaign_id ON ads(campaign_id)',
  },
  {
    id: 'issue_004', pattern: 'unhandled_error', severity: 'high',
    title: 'Unhandled TypeError in CampaignStats',
    description: 'TypeError: Cannot read properties of undefined (reading "map"). The component doesn\'t handle the case when stats data is undefined.',
    evidence: ['TypeError at src/components/campaign-stats.tsx:32', 'Occurs when campaign has no stats yet', 'No error boundary catches this'],
    suggestion: 'Add optional chaining: stats?.map(...) or provide a default empty array.',
  },
  {
    id: 'issue_005', pattern: 'api_timeout', severity: 'medium',
    title: 'API Request Timeout',
    description: 'POST /api/campaigns/search timed out after 30 seconds. The search endpoint may need pagination or query optimization.',
    evidence: ['Duration: 30,000ms', 'Status: 408 (timeout)', 'No response body received'],
    suggestion: 'Add server-side pagination, implement cursor-based search, or add a search index.',
  },
  {
    id: 'issue_006', pattern: 'cascade_renders', severity: 'medium',
    title: 'Cascading Renders from Sidebar',
    description: 'Sidebar re-renders cause Header and 5 child components to re-render unnecessarily. The parent re-renders propagate through the tree.',
    evidence: ['Sidebar: 42 renders', 'Header: 38 renders (parent cause)', 'CampaignCard: 89 renders (parent cause)'],
    suggestion: 'Extract state that causes Sidebar re-renders into a separate context or use composition pattern.',
  },
  {
    id: 'issue_007', pattern: 'deprecated_api', severity: 'low',
    title: 'Deprecated API Endpoint In Use',
    description: 'The application is calling /api/v1/users which has been deprecated. This endpoint may be removed in future API versions.',
    evidence: ['Console warning: "Deprecated API endpoint /api/v1/users used"', 'Called from src/api/users.ts'],
    suggestion: 'Migrate to /api/v2/users endpoint.',
  },
  {
    id: 'issue_008', pattern: 'inp_threshold', severity: 'medium',
    title: 'INP Exceeds "Good" Threshold',
    description: 'Interaction to Next Paint (INP) measured at 320ms, exceeding the 200ms "good" threshold. The campaign-action button handler is slow.',
    evidence: ['INP: 320ms (needs-improvement)', 'Element: button.campaign-action', 'Threshold: <200ms for "good"'],
    suggestion: 'Optimize the click handler — defer non-critical work with requestIdleCallback or split into smaller tasks.',
  },
];
