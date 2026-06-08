// Analytics endpoint response types — mirror the live collector handlers
// (crates/collector-core/src/{server.rs,analytics_rollups.rs,analytics_roi.rs,
// analytics_store.rs}). These are the wire shapes; keep in sync with the spec
// (docs/specs/analytics-data-model.md). camelCase per the Rust serde renames.

/** `[{role, users, value, hours}]` from the ROI by-role rollup. */
export interface RoleValue {
  role: string;
  users: number;
  value: number;
  hours: number;
}

/** GET /api/analytics/overview → singleton. ROI fields (valueSaved/hoursSaved/
 *  valueByRole) are 0/empty until baselines+roles+identify data exist. */
export interface OverviewData {
  activeUsers: number;
  invited: number;
  adoptionPct: number;
  totalEvents: number;
  eventsPerDay: number;
  dau: number;
  wau: number;
  mau: number;
  stickinessPct: number;
  valueSaved: number;
  hoursSaved: number;
  valueByRole: RoleValue[];
}

/** GET /api/analytics/users → list (anonymized; NO PII). */
export interface AnalyticsUser {
  anonId: string;
  role: string;
  consent: boolean;
  firstSeen: number;
  lastSeen: number;
  events: number;
  features: number;
  sessions: number;
  value: number;
  hours: number;
}

/** GET /api/analytics/users/{anonId} → the bare user record (no rollup/$). */
export interface AnalyticsUserDetail {
  anonId: string;
  role: string;
  consent: boolean;
  firstSeen: number;
  lastSeen: number;
}

/** GET /api/analytics/features → list. */
export interface FeatureRollup {
  feature: string;
  users: number;
  events: number;
  adoptionPct: number;
  lastSeen: number;
  value: number;
  hours: number;
}

/** GET /api/analytics/trends → singleton (parallel arrays). */
export interface TrendsData {
  bucketStartMs: number[];
  users: number[];
  events: number[];
}

/** GET /api/analytics/feature-trends → singleton (stacked top-N + "other"). */
export interface FeatureTrendsData {
  bucketStartMs: number[];
  series: { feature: string; data: number[] }[];
}

/** GET /api/analytics/event-mix → list (only types with count>0). */
export interface EventMixItem {
  type: string;
  count: number;
}

/** GET /api/analytics/cohorts → list (triangular; nulls for future weeks). */
export interface CohortRow {
  cohortStartMs: number;
  size: number;
  cells: (number | null)[];
}

/** GET /api/analytics/funnel → singleton. identified = invited. */
export interface FunnelData {
  identified: number;
  activated: number;
  repeat: number;
  power: number;
}

/** GET /api/analytics/compare?by=role|app → list. Carries one of role/app. */
export interface CompareRow {
  role?: string;
  app?: string;
  users: number;
  events: number;
  prevUsers: number;
  prevEvents: number;
  value: number;
  prevValue: number;
}

/** GET /api/analytics/roles → list. */
export interface Role {
  role: string;
  hourlyRate: number;
}

/** GET /api/analytics/baselines → list (uses/value enriched). */
export interface Baseline {
  fn: string;
  manualMin: number;
  toolMin: number;
  perItem: boolean;
  source: string;
  updatedAt: number;
  uses: number;
  value: number;
}

/** GET /api/analytics/baselines/history?fn= → list. */
export interface BaselineHistoryEntry {
  manualMin: number;
  toolMin: number;
  perItem: boolean;
  changedAt: number;
  changedBy: string | null;
  reason: string | null;
}

/** GET /api/analytics/baselines/submissions → list (+ divergence flag). */
export interface Submission {
  id: number;
  fn: string;
  estManualMin: number;
  anonId: string | null;
  submittedAt: number;
  currentManualMin: number | null;
  diffPct?: number;
  flagged?: boolean;
}

/** GET /api/analytics/projections → list (actuals live-derived). */
export interface Projection {
  quarter: string;
  projHours: number;
  projValue: number;
  notes: string | null;
  setBy: string | null;
  actualHours: number;
  actualValue: number;
}

export type AnalyticsWindow = '7d' | '30d' | '90d' | '12w' | '12mo' | 'all';
