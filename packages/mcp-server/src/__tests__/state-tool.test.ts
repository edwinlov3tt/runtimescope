import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerStateTools } from '../tools/state.js';
import { createMcpStub } from './tool-harness.js';

function makeStateEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'state' as const,
    storeId: 'main-store',
    library: 'zustand',
    phase: 'update',
    state: { count: 1 },
    ...overrides,
  };
}

describe('get_state_snapshots tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerStateTools(server, store);
  });

  it('returns response envelope structure', async () => {
    const result = await callTool('get_state_snapshots', {});
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('metadata');
  });

  it('maps fields correctly', async () => {
    store.addEvent(makeStateEvent({
      storeId: 'cart',
      library: 'redux',
      phase: 'update',
      state: { items: [1, 2, 3] },
    }));
    const result = await callTool('get_state_snapshots', {});
    const item = result.data[0];
    expect(item.storeId).toBe('cart');
    expect(item.library).toBe('redux');
    expect(item.phase).toBe('update');
    expect(item.state).toEqual({ items: [1, 2, 3] });
  });

  it('detects store thrashing (>10 updates in 1s window)', async () => {
    const now = Date.now();
    for (let i = 0; i < 15; i++) {
      store.addEvent(makeStateEvent({
        storeId: 'rapid-store',
        phase: 'update',
        timestamp: now + i * 50, // 15 updates in 750ms
      }));
    }
    const result = await callTool('get_state_snapshots', {});
    expect(result.issues.some((i: string) => i.includes('thrashing'))).toBe(true);
  });

  it('does not flag normal update frequency', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      store.addEvent(makeStateEvent({
        storeId: 'normal-store',
        phase: 'update',
        timestamp: now + i * 1000,
      }));
    }
    const result = await callTool('get_state_snapshots', {});
    expect(result.issues).toHaveLength(0);
  });

  it('filters by store_name', async () => {
    store.addEvent(makeStateEvent({ storeId: 'auth' }));
    store.addEvent(makeStateEvent({ storeId: 'cart' }));
    const result = await callTool('get_state_snapshots', { store_name: 'auth' });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].storeId).toBe('auth');
  });

  it('returns empty data when no events', async () => {
    const result = await callTool('get_state_snapshots', {});
    expect(result.data).toEqual([]);
    expect(result.metadata.eventCount).toBe(0);
  });
});
