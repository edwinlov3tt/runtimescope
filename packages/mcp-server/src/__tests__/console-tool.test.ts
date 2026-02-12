import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerConsoleTools } from '../tools/console.js';
import { createMcpStub } from './tool-harness.js';

function makeConsoleEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'console' as const,
    level: 'log',
    message: 'test message',
    args: [],
    ...overrides,
  };
}

describe('get_console_messages tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerConsoleTools(server, store);
  });

  it('returns response envelope structure', async () => {
    const result = await callTool('get_console_messages', {});
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('metadata');
  });

  it('summary includes level breakdown', async () => {
    store.addEvent(makeConsoleEvent({ level: 'error' }));
    store.addEvent(makeConsoleEvent({ level: 'error' }));
    store.addEvent(makeConsoleEvent({ level: 'log' }));
    const result = await callTool('get_console_messages', {});
    expect(result.summary).toContain('3 console message(s)');
    expect(result.summary).toContain('2 error');
    expect(result.summary).toContain('1 log');
  });

  it('data maps fields correctly', async () => {
    store.addEvent(makeConsoleEvent({
      level: 'warn',
      message: 'caution',
      stackTrace: 'at line 5',
    }));
    const result = await callTool('get_console_messages', {});
    expect(result.data[0].level).toBe('warn');
    expect(result.data[0].message).toBe('caution');
    expect(result.data[0].stackTrace).toBe('at line 5');
  });

  it('filters by level', async () => {
    store.addEvent(makeConsoleEvent({ level: 'error' }));
    store.addEvent(makeConsoleEvent({ level: 'log' }));
    const result = await callTool('get_console_messages', { level: 'error' });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].level).toBe('error');
  });

  it('filters by search', async () => {
    store.addEvent(makeConsoleEvent({ message: 'User logged in' }));
    store.addEvent(makeConsoleEvent({ message: 'Database error' }));
    const result = await callTool('get_console_messages', { search: 'database' });
    expect(result.data).toHaveLength(1);
  });

  it('returns empty data when no events', async () => {
    const result = await callTool('get_console_messages', {});
    expect(result.data).toEqual([]);
  });
});
