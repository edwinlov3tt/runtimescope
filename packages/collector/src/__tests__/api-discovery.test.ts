import { describe, it, expect, beforeEach } from 'vitest';
import { ApiDiscoveryEngine } from '../engines/api-discovery.js';
import { EventStore } from '../store.js';
import { makeNetworkEvent } from './factories.js';

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
});
