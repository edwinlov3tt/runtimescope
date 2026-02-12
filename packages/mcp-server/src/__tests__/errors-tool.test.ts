import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerErrorTools } from '../tools/errors.js';
import { createMcpStub } from './tool-harness.js';

function makeConsoleEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'console' as const,
    level: 'error' as const,
    message: 'Uncaught TypeError: Cannot read properties of null',
    args: [],
    ...overrides,
  };
}

describe('get_errors_with_source_context tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerErrorTools(server, store);
  });

  it('returns response envelope structure', async () => {
    const result = await callTool('get_errors_with_source_context', {});
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('metadata');
  });

  it('returns empty data when no errors', async () => {
    const result = await callTool('get_errors_with_source_context', {});
    expect(result.data).toEqual([]);
    expect(result.metadata.eventCount).toBe(0);
  });

  it('only captures console errors, not logs/warnings', async () => {
    store.addEvent(makeConsoleEvent({ level: 'log', message: 'info message' }));
    store.addEvent(makeConsoleEvent({ level: 'warn', message: 'warning message' }));
    store.addEvent(makeConsoleEvent({ level: 'error', message: 'error message' }));
    const result = await callTool('get_errors_with_source_context', {});
    // Only errors are returned
    expect(result.data.length).toBe(1);
    expect(result.data[0].message).toBe('error message');
  });

  it('maps error fields correctly', async () => {
    store.addEvent(makeConsoleEvent({ message: 'TypeError: x is not a function' }));
    const result = await callTool('get_errors_with_source_context', {});
    const error = result.data[0];
    expect(error.message).toBe('TypeError: x is not a function');
    expect(error).toHaveProperty('timestamp');
    expect(error).toHaveProperty('frames');
  });

  it('parses Chrome V8 stack traces', async () => {
    const stack = `TypeError: Cannot read properties of null
    at handleClick (http://localhost:3000/src/App.tsx:25:10)
    at HTMLButtonElement.dispatch (http://localhost:3000/node_modules/react-dom/cjs/react-dom.development.js:3942:9)`;

    store.addEvent(makeConsoleEvent({ stackTrace: stack }));
    // fetch_source=false to avoid actual HTTP calls
    const result = await callTool('get_errors_with_source_context', { fetch_source: false });
    const frames = result.data[0].frames;
    // First frame: handleClick — node_modules frame is also parsed
    expect(frames).toHaveLength(2);
    expect(frames[0].functionName).toBe('handleClick');
    expect(frames[0].file).toBe('http://localhost:3000/src/App.tsx');
    expect(frames[0].line).toBe(25);
    expect(frames[0].column).toBe(10);
  });

  it('parses Firefox stack traces', async () => {
    const stack = `handleClick@http://localhost:3000/src/App.tsx:25:10
dispatch@http://localhost:3000/node_modules/react-dom/cjs/react-dom.development.js:3942:9`;

    store.addEvent(makeConsoleEvent({ stackTrace: stack }));
    const result = await callTool('get_errors_with_source_context', { fetch_source: false });
    const frames = result.data[0].frames;
    expect(frames).toHaveLength(2);
    expect(frames[0].functionName).toBe('handleClick');
    expect(frames[0].file).toBe('http://localhost:3000/src/App.tsx');
    expect(frames[0].line).toBe(25);
  });

  it('returns empty frames when no stack trace', async () => {
    store.addEvent(makeConsoleEvent({ message: 'Runtime error', stackTrace: undefined }));
    const result = await callTool('get_errors_with_source_context', { fetch_source: false });
    expect(result.data[0].frames).toEqual([]);
  });

  it('summary includes error count and unique count', async () => {
    store.addEvent(makeConsoleEvent({ message: 'Error A' }));
    store.addEvent(makeConsoleEvent({ message: 'Error A' }));
    store.addEvent(makeConsoleEvent({ message: 'Error B' }));
    const result = await callTool('get_errors_with_source_context', {});
    expect(result.summary).toContain('3 error(s)');
    expect(result.summary).toContain('2 unique');
  });

  it('limits to 50 errors', async () => {
    for (let i = 0; i < 60; i++) {
      store.addEvent(makeConsoleEvent({ message: `Error ${i}` }));
    }
    const result = await callTool('get_errors_with_source_context', {});
    expect(result.data.length).toBeLessThanOrEqual(50);
    expect(result.issues.some((i: string) => i.includes('Showing 50'))).toBe(true);
  });

  it('summary indicates source context status', async () => {
    store.addEvent(makeConsoleEvent());
    const resultWith = await callTool('get_errors_with_source_context', { fetch_source: false });
    expect(resultWith.summary).toContain('Source context disabled');
  });
});
