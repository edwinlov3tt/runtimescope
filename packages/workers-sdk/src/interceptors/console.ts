import type { ConsoleEvent, ConsoleLevel } from '../types.js';
import { generateId, safeSerialize } from '../utils.js';

// ============================================================
// Console Interceptor — Workers-safe
// Patches console.log/warn/error/info/debug/trace.
// Returns a restore function for cleanup.
// ============================================================

type EmitFn = (event: ConsoleEvent) => void;

const LEVELS: ConsoleLevel[] = ['log', 'warn', 'error', 'info', 'debug', 'trace'];

export interface ConsoleInterceptorOptions {
  levels?: ConsoleLevel[];
  sessionId: string;
}

export function interceptConsole(
  emit: EmitFn,
  options: ConsoleInterceptorOptions
): () => void {
  const levels = options.levels ?? LEVELS;
  const originals: Record<string, (...args: unknown[]) => void> = {};

  for (const level of levels) {
    originals[level] = console[level].bind(console);

    console[level] = (...args: unknown[]) => {
      const message = args
        .map((a) => (typeof a === 'string' ? a : stringifyArg(a)))
        .join(' ');

      const event: ConsoleEvent = {
        eventId: generateId(),
        sessionId: options.sessionId,
        timestamp: Date.now(),
        eventType: 'console',
        level,
        message,
        args: args.map((a) => safeSerialize(a, 3)),
        stackTrace:
          level === 'error' || level === 'trace'
            ? new Error().stack?.split('\n').slice(2).join('\n')
            : undefined,
        source: 'workers',
      };

      // emit() already applies beforeSend — don't double-filter
      emit(event);

      // Call original — MUST use saved reference
      originals[level](...args);
    };
  }

  return () => {
    for (const level of levels) {
      console[level] = originals[level];
    }
  };
}

function stringifyArg(arg: unknown): string {
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
