import { describe, it, expect, vi, afterEach } from 'vitest';
import { interceptConsole } from '../interceptors/console.js';
import type { ConsoleEvent } from '../types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('interceptConsole', () => {
  it('should capture console.log calls', () => {
    const events: ConsoleEvent[] = [];
    const restore = interceptConsole((e) => events.push(e), { sessionId: 'sess-1' });

    console.log('hello world');

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('console');
    expect(events[0].level).toBe('log');
    expect(events[0].message).toBe('hello world');
    expect(events[0].sessionId).toBe('sess-1');

    restore();
  });

  it('should capture multiple log levels', () => {
    const events: ConsoleEvent[] = [];
    const restore = interceptConsole((e) => events.push(e), { sessionId: 'sess-1' });

    console.log('log');
    console.warn('warn');
    console.error('error');
    console.info('info');
    console.debug('debug');

    expect(events).toHaveLength(5);
    expect(events.map((e) => e.level)).toEqual(['log', 'warn', 'error', 'info', 'debug']);

    restore();
  });

  it('should include stack trace for error level', () => {
    const events: ConsoleEvent[] = [];
    const restore = interceptConsole((e) => events.push(e), { sessionId: 'sess-1' });

    console.error('something failed');

    expect(events[0].stackTrace).toBeDefined();
    expect(events[0].stackTrace).toContain('console.test.ts');

    restore();
  });

  it('should serialize object arguments', () => {
    const events: ConsoleEvent[] = [];
    const restore = interceptConsole((e) => events.push(e), { sessionId: 'sess-1' });

    console.log('user:', { id: 1, name: 'Alice' });

    expect(events[0].message).toContain('user:');
    expect(events[0].message).toContain('"id":1');
    expect(events[0].args).toHaveLength(2);

    restore();
  });

  it('should still call the original console method', () => {
    const originalLog = console.log;
    const spy = vi.fn();
    console.log = spy;

    const events: ConsoleEvent[] = [];
    const restore = interceptConsole((e) => events.push(e), { sessionId: 'sess-1' });

    console.log('test');

    expect(spy).toHaveBeenCalledWith('test');
    expect(events).toHaveLength(1);

    restore();
    console.log = originalLog;
  });

  it('should restore original methods on cleanup', () => {
    const events: ConsoleEvent[] = [];
    const restore = interceptConsole((e) => events.push(e), { sessionId: 'sess-1' });

    console.log('during intercept');
    expect(events).toHaveLength(1);

    restore();

    console.log('after restore');
    // No new events captured — interceptor is removed
    expect(events).toHaveLength(1);
  });

  it('should only intercept specified levels', () => {
    const events: ConsoleEvent[] = [];
    const restore = interceptConsole((e) => events.push(e), {
      sessionId: 'sess-1',
      levels: ['error', 'warn'],
    });

    console.log('ignored');
    console.warn('captured');
    console.error('captured too');

    // Only warn and error should be captured
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.level)).toEqual(['warn', 'error']);

    restore();
  });
});
