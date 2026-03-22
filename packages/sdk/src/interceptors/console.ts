import { generateId } from '../utils/id.js';
import { safeSerialize } from '../utils/serialize.js';
import type { ConsoleEvent, ConsoleLevel, RuntimeEvent } from '../types.js';

type EmitFn = (event: ConsoleEvent) => void;

const LEVELS: ConsoleLevel[] = ['log', 'warn', 'error', 'info', 'debug', 'trace'];

/** Extract the caller's source file from an Error stack trace. */
function extractSourceFile(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  // Skip first 3 lines: "Error", our interceptor, and the console wrapper
  const lines = stack.split('\n').slice(3);
  for (const line of lines) {
    // Match "at ... (file:line:col)" or "at file:line:col"
    const match = line.match(/(?:at\s+)?(?:.*?\()?(.+?):(\d+):(\d+)\)?/);
    if (match && !match[1].includes('interceptor') && !match[1].includes('runtimescope')) {
      return `${match[1]}:${match[2]}`;
    }
  }
  return undefined;
}

export function interceptConsole(
  emit: EmitFn,
  sessionId: string,
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null
): () => void {
  const originals: Record<string, (...args: unknown[]) => void> = {};
  const timers = new Map<string, number>();
  const counters = new Map<string, number>();

  // Standard log levels
  for (const level of LEVELS) {
    originals[level] = console[level].bind(console);

    console[level] = (...args: unknown[]) => {
      const stack = new Error().stack;
      const message = args
        .map((a) => (typeof a === 'string' ? a : stringifyArg(a)))
        .join(' ');

      const event: ConsoleEvent = {
        eventId: generateId(),
        sessionId,
        timestamp: Date.now(),
        eventType: 'console',
        level,
        message,
        args: args.map((a) => safeSerialize(a, 3)),
        stackTrace:
          level === 'error' || level === 'trace' ? stack?.split('\n').slice(2).join('\n') : undefined,
        sourceFile: extractSourceFile(stack),
        source: 'browser',
      };

      if (beforeSend) {
        const filtered = beforeSend(event);
        if (filtered) emit(filtered as ConsoleEvent);
      } else {
        emit(event);
      }

      originals[level](...args);
    };
  }

  // console.assert — logs error when condition is false
  const origAssert = console.assert?.bind(console);
  if (origAssert) {
    console.assert = (condition?: boolean, ...args: unknown[]) => {
      if (!condition) {
        const stack = new Error().stack;
        const message = `Assertion failed: ${args.map((a) => typeof a === 'string' ? a : stringifyArg(a)).join(' ')}`;
        emit({
          eventId: generateId(),
          sessionId,
          timestamp: Date.now(),
          eventType: 'console',
          level: 'error',
          message,
          args: args.map((a) => safeSerialize(a, 3)),
          stackTrace: stack?.split('\n').slice(2).join('\n'),
          sourceFile: extractSourceFile(stack),
          source: 'browser',
        });
      }
      origAssert(condition, ...args);
    };
  }

  // console.time / console.timeEnd — capture timing
  const origTime = console.time?.bind(console);
  const origTimeEnd = console.timeEnd?.bind(console);
  if (origTime) {
    console.time = (label = 'default') => {
      timers.set(label, performance.now());
      origTime(label);
    };
  }
  if (origTimeEnd) {
    console.timeEnd = (label = 'default') => {
      const start = timers.get(label);
      if (start !== undefined) {
        const duration = performance.now() - start;
        timers.delete(label);
        emit({
          eventId: generateId(),
          sessionId,
          timestamp: Date.now(),
          eventType: 'console',
          level: 'info',
          message: `${label}: ${duration.toFixed(2)}ms`,
          args: [{ label, duration }],
          source: 'browser',
        });
      }
      origTimeEnd(label);
    };
  }

  // console.count / console.countReset
  const origCount = console.count?.bind(console);
  const origCountReset = console.countReset?.bind(console);
  if (origCount) {
    console.count = (label = 'default') => {
      const count = (counters.get(label) ?? 0) + 1;
      counters.set(label, count);
      emit({
        eventId: generateId(),
        sessionId,
        timestamp: Date.now(),
        eventType: 'console',
        level: 'info',
        message: `${label}: ${count}`,
        args: [{ label, count }],
        source: 'browser',
      });
      origCount(label);
    };
  }
  if (origCountReset) {
    console.countReset = (label = 'default') => {
      counters.delete(label);
      origCountReset(label);
    };
  }

  // console.table — capture as info with structured data
  const origTable = console.table?.bind(console);
  if (origTable) {
    console.table = (data: unknown, columns?: string[]) => {
      emit({
        eventId: generateId(),
        sessionId,
        timestamp: Date.now(),
        eventType: 'console',
        level: 'info',
        message: `[table] ${Array.isArray(data) ? `${data.length} rows` : typeof data}`,
        args: [safeSerialize(data, 3)],
        source: 'browser',
      });
      origTable(data, columns);
    };
  }

  return () => {
    for (const level of LEVELS) {
      console[level] = originals[level];
    }
    if (origAssert) console.assert = origAssert;
    if (origTime) console.time = origTime;
    if (origTimeEnd) console.timeEnd = origTimeEnd;
    if (origCount) console.count = origCount;
    if (origCountReset) console.countReset = origCountReset;
    if (origTable) console.table = origTable;
  };
}

function stringifyArg(arg: unknown): string {
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
