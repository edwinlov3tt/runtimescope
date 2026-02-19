import type { PerformanceEvent } from './types';

const SESSION = 'sess_mock_001';
const BASE = Date.now() - 300_000;

export const MOCK_PERFORMANCE: PerformanceEvent[] = [
  { eventId: 'perf_001', sessionId: SESSION, timestamp: BASE + 1200, eventType: 'performance', metricName: 'FCP', value: 820, rating: 'good', element: 'body > div#root' },
  { eventId: 'perf_002', sessionId: SESSION, timestamp: BASE + 2500, eventType: 'performance', metricName: 'LCP', value: 1200, rating: 'good', element: 'main > div.campaign-list > img.hero' },
  { eventId: 'perf_003', sessionId: SESSION, timestamp: BASE + 500, eventType: 'performance', metricName: 'TTFB', value: 180, rating: 'good' },
  { eventId: 'perf_004', sessionId: SESSION, timestamp: BASE + 5000, eventType: 'performance', metricName: 'CLS', value: 0.08, rating: 'good' },
  { eventId: 'perf_005', sessionId: SESSION, timestamp: BASE + 8000, eventType: 'performance', metricName: 'FID', value: 45, rating: 'good' },
  { eventId: 'perf_006', sessionId: SESSION, timestamp: BASE + 10000, eventType: 'performance', metricName: 'INP', value: 320, rating: 'needs-improvement', element: 'button.campaign-action' },
];

// Historical sparkline data for each metric (20 data points each)
export const MOCK_PERF_HISTORY: Record<string, number[]> = {
  LCP: [1800, 1650, 1400, 1350, 1500, 1200, 1300, 1100, 1250, 1200, 1150, 1300, 1200, 1100, 1250, 1200, 1180, 1220, 1200, 1200],
  FCP: [1200, 1100, 950, 900, 1000, 850, 880, 820, 850, 830, 810, 850, 820, 800, 830, 820, 810, 825, 820, 820],
  TTFB: [350, 310, 280, 250, 220, 200, 210, 190, 195, 185, 180, 190, 185, 180, 185, 182, 180, 181, 180, 180],
  CLS: [0.25, 0.22, 0.18, 0.15, 0.12, 0.10, 0.09, 0.08, 0.09, 0.08, 0.07, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08],
  FID: [120, 100, 85, 75, 65, 55, 50, 48, 46, 45, 44, 45, 45, 44, 45, 45, 45, 45, 45, 45],
  INP: [580, 520, 480, 450, 420, 400, 380, 360, 350, 340, 335, 330, 325, 322, 320, 320, 320, 320, 320, 320],
};
