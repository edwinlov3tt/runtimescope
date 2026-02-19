import { generateId } from '../utils/id.js';
import { safeSerialize } from '../utils/serialize.js';
import { getSessionId } from '../context.js';
import type { ConsoleEvent, ConsoleLevel, ServerRuntimeEvent } from '../types.js';

type EmitFn = (event: ConsoleEvent) => void;

const LEVELS: ConsoleLevel[] = ['log', 'warn', 'error', 'info', 'debug', 'trace'];

export interface ConsoleInterceptorOptions {
  levels?: ConsoleLevel[];
  captureStackTraces?: boolean;
  beforeSend?: (event: ServerRuntimeEvent) => ServerRuntimeEvent | null;
}

export function interceptConsole(
  emit: EmitFn,
  sessionId: string,
  options?: ConsoleInterceptorOptions
): () => void {
  const levels = options?.levels ?? LEVELS;
  const captureStack = options?.captureStackTraces ?? true;
  const originals: Record<string, (...args: unknown[]) => void> = {};

  for (const level of levels) {
    originals[level] = console[level].bind(console);

    console[level] = (...args: unknown[]) => {
      const message = args
        .map((a) => (typeof a === 'string' ? a : stringifyArg(a)))
        .join(' ');

      const event: ConsoleEvent = {
        eventId: generateId(),
        sessionId: getSessionId(sessionId),
        timestamp: Date.now(),
        eventType: 'console',
        level,
        message,
        args: args.map((a) => safeSerialize(a, 3)),
        stackTrace:
          captureStack && (level === 'error' || level === 'trace')
            ? new Error().stack?.split('\n').slice(2).join('\n')
            : undefined,
        sourceFile: undefined,
      };

      if (options?.beforeSend) {
        const filtered = options.beforeSend(event);
        if (filtered) emit(filtered as ConsoleEvent);
      } else {
        emit(event);
      }

      // Call original — MUST come after emit, and MUST use saved reference
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
