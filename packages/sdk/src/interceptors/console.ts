import { generateId } from '../utils/id.js';
import { safeSerialize } from '../utils/serialize.js';
import type { ConsoleEvent, ConsoleLevel, RuntimeEvent } from '../types.js';

type EmitFn = (event: ConsoleEvent) => void;

const LEVELS: ConsoleLevel[] = ['log', 'warn', 'error', 'info', 'debug', 'trace'];

export interface ConsoleDedupeOptions {
  /** Window during which identical messages are considered duplicates. Default 5000ms. */
  windowMs?: number;
  /** First N occurrences of a duplicate burst still print normally. Default 3 — gives users a sense of frequency without an explosion. */
  maxBurst?: number;
  /** How often to flush the "suppressed N messages" summary line. Default 5000ms. */
  summaryIntervalMs?: number;
}

interface DedupeState {
  count: number;
  firstAt: number;
  suppressed: number;
  level: ConsoleLevel;
  preview: string;
}

/**
 * Build a dedupe gate for the console interceptor.
 *
 * The collector still receives every event — this only filters what reaches
 * the actual browser DevTools, keeping the console clean in production.
 *
 * Returns:
 *   - shouldPrint(level, message): true if this call should pass through to
 *     the original console method, false if it's been suppressed.
 *   - dispose(): clears the summary timer (called on interceptor teardown).
 */
function makeDedupeGate(
  options: Required<ConsoleDedupeOptions>,
  printSummary: (text: string) => void,
): { shouldPrint: (level: ConsoleLevel, message: string) => boolean; dispose: () => void } {
  const seen = new Map<string, DedupeState>();

  const summaryTimer = setInterval(() => {
    let totalSuppressed = 0;
    for (const state of seen.values()) {
      if (state.suppressed > 0) {
        totalSuppressed += state.suppressed;
        state.suppressed = 0;
      }
    }
    if (totalSuppressed > 0) {
      printSummary(
        `[RuntimeScope] suppressed ${totalSuppressed} duplicate console message${totalSuppressed === 1 ? '' : 's'} in the last ${options.summaryIntervalMs / 1000}s — full data in the dashboard.`,
      );
    }
    // Garbage-collect entries older than the dedupe window so the map doesn't
    // grow forever for unique-but-rare messages.
    const cutoff = Date.now() - options.windowMs;
    for (const [key, state] of seen) {
      if (state.firstAt < cutoff && state.suppressed === 0) seen.delete(key);
    }
  }, options.summaryIntervalMs);
  // Don't keep the page alive if everything else has shut down.
  if (typeof (summaryTimer as { unref?: () => void }).unref === 'function') {
    (summaryTimer as { unref: () => void }).unref();
  }

  return {
    shouldPrint(level, message) {
      const now = Date.now();
      const key = `${level}|${message}`;
      let state = seen.get(key);
      if (state && now - state.firstAt > options.windowMs) {
        // Window elapsed — start fresh.
        state = undefined;
      }
      if (!state) {
        seen.set(key, {
          count: 1,
          firstAt: now,
          suppressed: 0,
          level,
          preview: message.slice(0, 80),
        });
        return true;
      }
      state.count++;
      if (state.count <= options.maxBurst) return true;
      state.suppressed++;
      return false;
    },
    dispose() { clearInterval(summaryTimer); },
  };
}

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
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null,
  dedupe?: ConsoleDedupeOptions | boolean
): () => void {
  const originals: Record<string, (...args: unknown[]) => void> = {};
  const timers = new Map<string, number>();
  const counters = new Map<string, number>();

  // Optional dedupe gate — when enabled, identical messages within `windowMs`
  // print at most `maxBurst` times before being suppressed. The collector
  // still receives every event so the dashboard stays accurate.
  const dedupeOptions: Required<ConsoleDedupeOptions> | null = dedupe
    ? {
        windowMs: (typeof dedupe === 'object' ? dedupe.windowMs : undefined) ?? 5000,
        maxBurst: (typeof dedupe === 'object' ? dedupe.maxBurst : undefined) ?? 3,
        summaryIntervalMs:
          (typeof dedupe === 'object' ? dedupe.summaryIntervalMs : undefined) ?? 5000,
      }
    : null;
  // We need the original console.info ahead of any patching for the summary,
  // captured BEFORE the loop below replaces it. Otherwise the summary line
  // itself loops through the interceptor.
  const summarySink = console.info.bind(console);
  const dedupeGate = dedupeOptions
    ? makeDedupeGate(dedupeOptions, (text) => summarySink(text))
    : null;

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

      // Always emit to the collector — the dashboard wants the full count.
      if (beforeSend) {
        const filtered = beforeSend(event);
        if (filtered) emit(filtered as ConsoleEvent);
      } else {
        emit(event);
      }

      // Only suppress the visible browser output, not the collected event.
      if (dedupeGate && !dedupeGate.shouldPrint(level, message)) return;

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
    dedupeGate?.dispose();
  };
}

function stringifyArg(arg: unknown): string {
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
