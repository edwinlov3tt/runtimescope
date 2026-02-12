import { describe, it, expect } from 'vitest';
import { detectIssues } from '../issue-detector.js';
import {
  makeNetworkEvent,
  makeConsoleEvent,
  makeRenderEvent,
  makeRenderProfile,
  makeStateEvent,
  makePerformanceEvent,
  makeDatabaseEvent,
} from './factories.js';
import type { RuntimeEvent } from '../types.js';

describe('detectIssues', () => {
  it('returns empty array when no events', () => {
    expect(detectIssues([])).toEqual([]);
  });

  it('returns issues sorted by severity (high first)', () => {
    const events: RuntimeEvent[] = [
      // High: 5xx errors
      makeNetworkEvent({ status: 500, url: 'https://api.com/fail' }),
      // Medium: slow request
      makeNetworkEvent({ duration: 4000, url: 'https://api.com/slow' }),
    ];
    const issues = detectIssues(events);
    expect(issues.length).toBeGreaterThan(0);
    const severities = issues.map((i) => i.severity);
    const order = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(order[severities[i]]).toBeGreaterThanOrEqual(order[severities[i - 1]]);
    }
  });

  describe('failed requests', () => {
    it('detects 5xx as high severity', () => {
      const events = [makeNetworkEvent({ status: 500 })];
      const issues = detectIssues(events);
      const failed = issues.find((i) => i.pattern === 'failed_requests');
      expect(failed).toBeDefined();
      expect(failed!.severity).toBe('high');
    });

    it('detects 4xx as medium severity', () => {
      const events = [makeNetworkEvent({ status: 404 })];
      const issues = detectIssues(events);
      const failed = issues.find((i) => i.pattern === 'failed_requests');
      expect(failed).toBeDefined();
      expect(failed!.severity).toBe('medium');
    });

    it('does not flag 2xx/3xx', () => {
      const events = [
        makeNetworkEvent({ status: 200 }),
        makeNetworkEvent({ status: 301 }),
      ];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'failed_requests')).toBeUndefined();
    });
  });

  describe('slow requests', () => {
    it('detects requests >3000ms', () => {
      const events = [makeNetworkEvent({ duration: 4000 })];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'slow_requests')).toBeDefined();
    });

    it('does not flag requests <=3000ms', () => {
      const events = [makeNetworkEvent({ duration: 2000 })];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'slow_requests')).toBeUndefined();
    });
  });

  describe('N+1 requests', () => {
    it('detects >5 calls to same endpoint within 2s window', () => {
      const now = Date.now();
      const events = Array.from({ length: 8 }, (_, i) =>
        makeNetworkEvent({
          url: 'https://api.com/users/1',
          method: 'GET',
          timestamp: now + i * 100, // 100ms apart
        })
      );
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'n1_requests')).toBeDefined();
    });

    it('does not flag <=5 calls', () => {
      const now = Date.now();
      const events = Array.from({ length: 4 }, (_, i) =>
        makeNetworkEvent({
          url: 'https://api.com/users/1',
          method: 'GET',
          timestamp: now + i * 100,
        })
      );
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'n1_requests')).toBeUndefined();
    });
  });

  describe('console error spam', () => {
    it('detects >5 same error in <=10s', () => {
      const now = Date.now();
      const events = Array.from({ length: 8 }, (_, i) =>
        makeConsoleEvent({
          level: 'error',
          message: 'Connection failed',
          timestamp: now + i * 500, // 500ms apart
        })
      );
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'console_error_spam')).toBeDefined();
    });

    it('only considers level "error"', () => {
      const now = Date.now();
      const events = Array.from({ length: 8 }, (_, i) =>
        makeConsoleEvent({
          level: 'warn',
          message: 'Same warning',
          timestamp: now + i * 500,
        })
      );
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'console_error_spam')).toBeUndefined();
    });
  });

  describe('high error rate', () => {
    it('detects >30% error rate', () => {
      const events: RuntimeEvent[] = [];
      // 5 errors, 10 total = 50% error rate
      for (let i = 0; i < 5; i++) events.push(makeConsoleEvent({ level: 'error' }));
      for (let i = 0; i < 5; i++) events.push(makeConsoleEvent({ level: 'log' }));
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'high_error_rate')).toBeDefined();
    });

    it('requires minimum 10 console events', () => {
      const events: RuntimeEvent[] = [];
      // 3 errors, 5 total = 60% but under minimum
      for (let i = 0; i < 3; i++) events.push(makeConsoleEvent({ level: 'error' }));
      for (let i = 0; i < 2; i++) events.push(makeConsoleEvent({ level: 'log' }));
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'high_error_rate')).toBeUndefined();
    });
  });

  describe('excessive rerenders', () => {
    it('detects components with suspicious=true', () => {
      const events = [
        makeRenderEvent({
          profiles: [makeRenderProfile({ componentName: 'App', suspicious: true, renderVelocity: 10 })],
          suspiciousComponents: ['App'],
        }),
      ];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'excessive_rerenders')).toBeDefined();
    });

    it('suggests React.memo for parent cause', () => {
      const events = [
        makeRenderEvent({
          profiles: [makeRenderProfile({
            componentName: 'Child',
            suspicious: true,
            lastRenderCause: 'parent',
          })],
          suspiciousComponents: ['Child'],
        }),
      ];
      const issues = detectIssues(events);
      const issue = issues.find((i) => i.pattern === 'excessive_rerenders');
      expect(issue!.suggestion).toContain('React.memo');
    });
  });

  describe('large state updates', () => {
    it('detects state >100KB', () => {
      const bigState = { data: 'x'.repeat(120_000) };
      const events = [makeStateEvent({ state: bigState, phase: 'update' })];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'large_state_update')).toBeDefined();
    });

    it('does not flag small states', () => {
      const events = [makeStateEvent({ state: { count: 1 }, phase: 'update' })];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'large_state_update')).toBeUndefined();
    });

    it('only checks phase=update', () => {
      const bigState = { data: 'x'.repeat(120_000) };
      const events = [makeStateEvent({ state: bigState, phase: 'init' })];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'large_state_update')).toBeUndefined();
    });
  });

  describe('poor web vitals', () => {
    it('detects rating="poor" metrics', () => {
      const events = [makePerformanceEvent({ metricName: 'LCP', rating: 'poor', value: 5000 })];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'poor_web_vital')).toBeDefined();
    });

    it('LCP is high severity', () => {
      const events = [makePerformanceEvent({ metricName: 'LCP', rating: 'poor' })];
      const issues = detectIssues(events);
      const issue = issues.find((i) => i.pattern === 'poor_web_vital');
      expect(issue!.severity).toBe('high');
    });

    it('FCP is medium severity', () => {
      const events = [makePerformanceEvent({ metricName: 'FCP', rating: 'poor' })];
      const issues = detectIssues(events);
      const issue = issues.find((i) => i.pattern === 'poor_web_vital');
      expect(issue!.severity).toBe('medium');
    });

    it('does not flag "good" rating', () => {
      const events = [makePerformanceEvent({ rating: 'good' })];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'poor_web_vital')).toBeUndefined();
    });
  });

  describe('slow DB queries', () => {
    it('detects queries >500ms', () => {
      const events = [makeDatabaseEvent({ duration: 600 })];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'slow_db_queries')).toBeDefined();
    });

    it('does not flag <=500ms', () => {
      const events = [makeDatabaseEvent({ duration: 400 })];
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'slow_db_queries')).toBeUndefined();
    });
  });

  describe('N+1 DB queries', () => {
    it('detects >5 SELECTs on same table within 2s', () => {
      const now = Date.now();
      const events = Array.from({ length: 8 }, (_, i) =>
        makeDatabaseEvent({
          operation: 'SELECT',
          tablesAccessed: ['users'],
          timestamp: now + i * 100,
        })
      );
      const issues = detectIssues(events);
      const n1 = issues.find((i) => i.pattern === 'n1_db_queries');
      expect(n1).toBeDefined();
      expect(n1!.severity).toBe('high');
    });

    it('only considers SELECT operations', () => {
      const now = Date.now();
      const events = Array.from({ length: 8 }, (_, i) =>
        makeDatabaseEvent({
          operation: 'INSERT',
          tablesAccessed: ['users'],
          timestamp: now + i * 100,
        })
      );
      const issues = detectIssues(events);
      expect(issues.find((i) => i.pattern === 'n1_db_queries')).toBeUndefined();
    });
  });
});
