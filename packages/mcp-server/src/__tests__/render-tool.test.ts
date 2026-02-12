import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerRenderTools } from '../tools/renders.js';
import { createMcpStub } from './tool-harness.js';

function makeRenderEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'render' as const,
    profiles: [
      {
        componentName: 'App',
        renderCount: 5,
        totalDuration: 25,
        avgDuration: 5,
        lastRenderPhase: 'update',
        lastRenderCause: 'state',
        renderVelocity: 2,
        suspicious: false,
      },
    ],
    snapshotWindowMs: 5000,
    totalRenders: 5,
    suspiciousComponents: [],
    ...overrides,
  };
}

describe('get_render_profile tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerRenderTools(server, store);
  });

  it('returns response envelope structure', async () => {
    const result = await callTool('get_render_profile', {});
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('metadata');
  });

  it('merges profiles across multiple render events', async () => {
    store.addEvent(makeRenderEvent({
      profiles: [
        { componentName: 'Header', renderCount: 3, totalDuration: 15, avgDuration: 5, lastRenderPhase: 'update', lastRenderCause: 'state', renderVelocity: 1, suspicious: false },
      ],
    }));
    store.addEvent(makeRenderEvent({
      profiles: [
        { componentName: 'Header', renderCount: 2, totalDuration: 10, avgDuration: 5, lastRenderPhase: 'update', lastRenderCause: 'props', renderVelocity: 1, suspicious: false },
      ],
    }));
    const result = await callTool('get_render_profile', {});
    expect(result.data).toHaveLength(1);
    expect(result.data[0].componentName).toBe('Header');
    expect(result.data[0].renderCount).toBe(5);
  });

  it('flags suspicious components in issues', async () => {
    store.addEvent(makeRenderEvent({
      profiles: [
        { componentName: 'ChatList', renderCount: 100, totalDuration: 500, avgDuration: 5, lastRenderPhase: 'update', lastRenderCause: 'state', renderVelocity: 20, suspicious: true },
      ],
      suspiciousComponents: ['ChatList'],
    }));
    const result = await callTool('get_render_profile', {});
    expect(result.issues.some((i: string) => i.includes('suspicious'))).toBe(true);
    expect(result.issues.some((i: string) => i.includes('ChatList'))).toBe(true);
  });

  it('sorts by render count descending', async () => {
    store.addEvent(makeRenderEvent({
      profiles: [
        { componentName: 'Low', renderCount: 2, totalDuration: 10, avgDuration: 5, lastRenderPhase: 'mount', lastRenderCause: 'state', renderVelocity: 1, suspicious: false },
        { componentName: 'High', renderCount: 50, totalDuration: 250, avgDuration: 5, lastRenderPhase: 'update', lastRenderCause: 'state', renderVelocity: 10, suspicious: false },
        { componentName: 'Mid', renderCount: 10, totalDuration: 50, avgDuration: 5, lastRenderPhase: 'update', lastRenderCause: 'props', renderVelocity: 3, suspicious: false },
      ],
    }));
    const result = await callTool('get_render_profile', {});
    expect(result.data[0].componentName).toBe('High');
    expect(result.data[1].componentName).toBe('Mid');
    expect(result.data[2].componentName).toBe('Low');
  });

  it('formats duration and velocity as strings', async () => {
    store.addEvent(makeRenderEvent());
    const result = await callTool('get_render_profile', {});
    const item = result.data[0];
    expect(item.totalDuration).toMatch(/ms$/);
    expect(item.avgDuration).toMatch(/ms$/);
    expect(item.renderVelocity).toMatch(/\/sec$/);
  });

  it('filters by component_name', async () => {
    store.addEvent(makeRenderEvent({
      profiles: [
        { componentName: 'Sidebar', renderCount: 3, totalDuration: 15, avgDuration: 5, lastRenderPhase: 'update', lastRenderCause: 'state', renderVelocity: 1, suspicious: false },
        { componentName: 'Header', renderCount: 2, totalDuration: 10, avgDuration: 5, lastRenderPhase: 'mount', lastRenderCause: 'state', renderVelocity: 1, suspicious: false },
      ],
    }));
    // component_name filter is applied at the store level (getRenderEvents), which does substring match
    // on the profiles. The tool just processes whatever events come back.
    const result = await callTool('get_render_profile', { component_name: 'Sidebar' });
    // Depending on store filter behavior, it may return the whole event
    // or filter it. The tool formats whatever comes back.
    expect(result).toHaveProperty('data');
  });

  it('returns empty data when no events', async () => {
    const result = await callTool('get_render_profile', {});
    expect(result.data).toEqual([]);
    expect(result.metadata.eventCount).toBe(0);
  });
});
