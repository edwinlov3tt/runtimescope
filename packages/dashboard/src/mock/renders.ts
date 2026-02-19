import type { RenderComponentProfile } from './types';

export const MOCK_RENDER_PROFILES: RenderComponentProfile[] = [
  { componentName: 'CampaignList', renderCount: 47, totalDuration: 245, avgDuration: 5.2, lastRenderPhase: 'update', lastRenderCause: 'state', renderVelocity: 9.4, suspicious: true },
  { componentName: 'Dashboard', renderCount: 23, totalDuration: 89, avgDuration: 3.9, lastRenderPhase: 'update', lastRenderCause: 'props', renderVelocity: 4.6, suspicious: false },
  { componentName: 'Sidebar', renderCount: 42, totalDuration: 168, avgDuration: 4.0, lastRenderPhase: 'update', lastRenderCause: 'parent', renderVelocity: 8.4, suspicious: true },
  { componentName: 'MetricCard', renderCount: 156, totalDuration: 312, avgDuration: 2.0, lastRenderPhase: 'update', lastRenderCause: 'props', renderVelocity: 31.2, suspicious: true },
  { componentName: 'AdCreative', renderCount: 12, totalDuration: 96, avgDuration: 8.0, lastRenderPhase: 'update', lastRenderCause: 'state', renderVelocity: 2.4, suspicious: false },
  { componentName: 'Header', renderCount: 38, totalDuration: 76, avgDuration: 2.0, lastRenderPhase: 'update', lastRenderCause: 'context', renderVelocity: 7.6, suspicious: true },
  { componentName: 'CampaignCard', renderCount: 89, totalDuration: 267, avgDuration: 3.0, lastRenderPhase: 'update', lastRenderCause: 'parent', renderVelocity: 17.8, suspicious: true },
  { componentName: 'AnalyticsChart', renderCount: 8, totalDuration: 120, avgDuration: 15.0, lastRenderPhase: 'update', lastRenderCause: 'props', renderVelocity: 1.6, suspicious: false },
  { componentName: 'NotificationBell', renderCount: 95, totalDuration: 95, avgDuration: 1.0, lastRenderPhase: 'update', lastRenderCause: 'state', renderVelocity: 19.0, suspicious: true },
  { componentName: 'SearchBar', renderCount: 34, totalDuration: 34, avgDuration: 1.0, lastRenderPhase: 'update', lastRenderCause: 'state', renderVelocity: 6.8, suspicious: false },
  { componentName: 'UserAvatar', renderCount: 15, totalDuration: 15, avgDuration: 1.0, lastRenderPhase: 'mount', lastRenderCause: 'props', renderVelocity: 3.0, suspicious: false },
  { componentName: 'Modal', renderCount: 4, totalDuration: 48, avgDuration: 12.0, lastRenderPhase: 'mount', lastRenderCause: 'state', renderVelocity: 0.8, suspicious: false },
];

// Timeline sparkline data (renders per 5-second bucket over 5 minutes)
export const MOCK_RENDER_TIMELINE: number[] = [
  12, 15, 8, 23, 45, 32, 18, 28, 56, 42,
  35, 22, 15, 48, 67, 38, 25, 19, 31, 44,
  52, 28, 16, 20, 35, 42, 55, 38, 24, 18,
  29, 36, 48, 58, 42, 31, 22, 17, 25, 33,
  41, 52, 38, 27, 19, 24, 36, 45, 55, 42,
  35, 28, 20, 32, 48, 62, 45, 33, 25, 18,
];
