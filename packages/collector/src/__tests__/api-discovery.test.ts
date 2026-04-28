import { describe, it, expect, beforeEach } from 'vitest';
import { ApiDiscoveryEngine } from '../engines/api-discovery.js';
import { EventStore } from '../store.js';
import { makeNetworkEvent, makeSessionEvent } from './factories.js';

describe('ApiDiscoveryEngine', () => {
  let store: EventStore;
  let engine: ApiDiscoveryEngine;

  beforeEach(() => {
    store = new EventStore(1000);
    engine = new ApiDiscoveryEngine(store);
  });

  describe('URL normalization (via getCatalog)', () => {
    it('replaces UUIDs with :id', () => {
      store.addEvent(makeNetworkEvent({
        url: 'https://api.example.com/users/550e8400-e29b-41d4-a716-446655440000',
      }));
      engine.rebuild();
      const catalog = engine.getCatalog();
      expect(catalog[0].normalizedPath).toBe('/users/:id');
    });

    it('replaces numeric IDs with :id', () => {
      store.addEvent(makeNetworkEvent({
        url: 'https://api.example.com/posts/12345',
      }));
      engine.rebuild();
      const catalog = engine.getCatalog();
      expect(catalog[0].normalizedPath).toBe('/posts/:id');
    });

    it('replaces MongoDB ObjectIDs with :id', () => {
      store.addEvent(makeNetworkEvent({
        url: 'https://api.example.com/docs/507f1f77bcf86cd799439011',
      }));
      engine.rebuild();
      const catalog = engine.getCatalog();
      expect(catalog[0].normalizedPath).toBe('/docs/:id');
    });

    it('replaces short hex hashes with :id', () => {
      store.addEvent(makeNetworkEvent({
        url: 'https://api.example.com/commits/a1b2c3d4e5f6',
      }));
      engine.rebuild();
      const catalog = engine.getCatalog();
      expect(catalog[0].normalizedPath).toBe('/commits/:id');
    });

    it('preserves normal path segments', () => {
      store.addEvent(makeNetworkEvent({
        url: 'https://api.example.com/api/v1/users',
      }));
      engine.rebuild();
      const catalog = engine.getCatalog();
      expect(catalog[0].normalizedPath).toBe('/api/v1/users');
    });
  });

  describe('service detection (via getServiceMap)', () => {
    it('detects Supabase', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://abc.supabase.co/rest/v1/users' }));
      engine.rebuild();
      const services = engine.getServiceMap();
      expect(services.some((s) => s.name === 'Supabase')).toBe(true);
    });

    it('detects Stripe', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.stripe.com/v1/charges' }));
      engine.rebuild();
      const services = engine.getServiceMap();
      expect(services.some((s) => s.name === 'Stripe')).toBe(true);
    });

    it('detects localhost as "Your API"', () => {
      store.addEvent(makeNetworkEvent({ url: 'http://localhost:3000/api/data' }));
      engine.rebuild();
      const services = engine.getServiceMap();
      expect(services.some((s) => s.name === 'Your API')).toBe(true);
    });

    it('falls back to domain for unknown hosts', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.custom-service.io/data' }));
      engine.rebuild();
      const services = engine.getServiceMap();
      expect(services.some((s) => s.name === 'custom-service.io')).toBe(true);
    });
  });

  describe('getCatalog', () => {
    it('groups events by normalized method+path+baseUrl', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/users/1', method: 'GET' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/users/2', method: 'GET' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/posts', method: 'POST' }));
      engine.rebuild();
      const catalog = engine.getCatalog();
      // /users/:id (2 calls) and /posts (1 call)
      expect(catalog).toHaveLength(2);
    });

    it('returns callCount per endpoint', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/data' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/data' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/data' }));
      engine.rebuild();
      const catalog = engine.getCatalog();
      expect(catalog[0].callCount).toBe(3);
    });

    it('filters by minCalls', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/a' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/b' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/b' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/b' }));
      engine.rebuild();
      const catalog = engine.getCatalog({ minCalls: 3 });
      expect(catalog).toHaveLength(1);
    });
  });

  describe('getHealth', () => {
    it('computes successRate correctly', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/data', status: 200 }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/data', status: 200 }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/data', status: 500 }));
      engine.rebuild();
      const health = engine.getHealth();
      expect(health[0].successRate).toBeCloseTo(2 / 3, 2);
    });

    it('computes avgLatency', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/data', duration: 100 }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/data', duration: 200 }));
      engine.rebuild();
      const health = engine.getHealth();
      expect(health[0].avgLatency).toBe(150);
    });
  });

  describe('getServiceMap', () => {
    it('groups endpoints by service', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.stripe.com/v1/charges' }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.stripe.com/v1/customers' }));
      store.addEvent(makeNetworkEvent({ url: 'http://localhost:3000/api/data' }));
      engine.rebuild();
      const services = engine.getServiceMap();
      expect(services.length).toBe(2); // Stripe + Your API
    });
  });

  describe('detectIssues', () => {
    it('detects API degradation (>50% error rate with >=3 calls)', () => {
      // 3 calls, 2 failures = 67% error rate
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/bad', status: 500 }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/bad', status: 500 }));
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/bad', status: 200 }));
      engine.rebuild();
      const issues = engine.detectIssues();
      expect(issues.some((i) => i.pattern === 'api_degradation')).toBe(true);
    });

    it('does not flag low-call endpoints', () => {
      store.addEvent(makeNetworkEvent({ url: 'https://api.com/rare', status: 500 }));
      engine.rebuild();
      const issues = engine.detectIssues();
      expect(issues.some((i) => i.pattern === 'api_degradation')).toBe(false);
    });
  });

  // Regression: cross-project bleed. Before this fix, the engine's endpoint
  // map was built from ALL sessions and getCatalog/getHealth/getServiceMap/
  // detectIssues took no projectId filter. A query scoped to project A
  // returned endpoints, error rates, and degradation issues from project B.
  describe('projectId filtering (cross-project bleed regression)', () => {
    function setupTwoProjects() {
      // Project A: 3 calls to /good (all 200)
      store.addEvent(makeSessionEvent({ sessionId: 'sess-a', projectId: 'proj_aaa', appName: 'app-a' }));
      for (let i = 0; i < 3; i++) {
        store.addEvent(makeNetworkEvent({
          sessionId: 'sess-a',
          url: 'https://api.example.com/good',
          status: 200,
        }));
      }
      // Project B: 4 calls to /broken (all 500 — would trigger api_degradation)
      store.addEvent(makeSessionEvent({ sessionId: 'sess-b', projectId: 'proj_bbb', appName: 'app-b' }));
      for (let i = 0; i < 4; i++) {
        store.addEvent(makeNetworkEvent({
          sessionId: 'sess-b',
          url: 'https://api.broken.com/broken',
          status: 500,
        }));
      }
      engine.markDirty();
      engine.rebuild();
    }

    it('getCatalog scoped to a project excludes other projects\' endpoints', () => {
      setupTwoProjects();
      const aOnly = engine.getCatalog({ projectId: 'proj_aaa' });
      expect(aOnly.map((ep) => ep.normalizedPath)).toEqual(['/good']);
      const bOnly = engine.getCatalog({ projectId: 'proj_bbb' });
      expect(bOnly.map((ep) => ep.normalizedPath)).toEqual(['/broken']);
      // Without filter, both endpoints visible
      const all = engine.getCatalog();
      expect(all.map((ep) => ep.normalizedPath).sort()).toEqual(['/broken', '/good']);
    });

    it('getHealth scoped to a project does not leak other-project error rates', () => {
      setupTwoProjects();
      const aHealth = engine.getHealth({ projectId: 'proj_aaa' });
      // Project A has 100% success — no /broken endpoint should appear
      expect(aHealth.map((h) => h.normalizedPath)).toEqual(['/good']);
      expect(aHealth[0].errorRate).toBe(0);
    });

    it('getServiceMap scoped to a project excludes other-project services', () => {
      setupTwoProjects();
      const aServices = engine.getServiceMap({ projectId: 'proj_aaa' });
      // example.com only — broken.com belongs to project B
      const hosts = aServices.map((s) => new URL(s.baseUrl).hostname);
      expect(hosts).toContain('api.example.com');
      expect(hosts).not.toContain('api.broken.com');
    });

    it('detectIssues scoped to a project does not flag other-project degradation', () => {
      setupTwoProjects();
      // Project B's /broken would trigger api_degradation (100% error, ≥3 calls).
      // Querying project A must NOT see that issue.
      const aIssues = engine.detectIssues('proj_aaa');
      expect(aIssues.some((i) => i.pattern === 'api_degradation')).toBe(false);
      const bIssues = engine.detectIssues('proj_bbb');
      expect(bIssues.some((i) => i.pattern === 'api_degradation')).toBe(true);
    });

    it('returns empty results for an unknown projectId', () => {
      setupTwoProjects();
      expect(engine.getCatalog({ projectId: 'proj_nope' })).toEqual([]);
      expect(engine.getHealth({ projectId: 'proj_nope' })).toEqual([]);
      expect(engine.getServiceMap({ projectId: 'proj_nope' })).toEqual([]);
      expect(engine.detectIssues('proj_nope')).toEqual([]);
    });
  });
});
