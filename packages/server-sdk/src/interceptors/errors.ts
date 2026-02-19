import { generateId } from '../utils/id.js';
import { safeSerialize } from '../utils/serialize.js';
import { getSessionId } from '../context.js';
import type { ConsoleEvent, ServerRuntimeEvent } from '../types.js';

type EmitFn = (event: ConsoleEvent) => void;

export interface ErrorInterceptorOptions {
  beforeSend?: (event: ServerRuntimeEvent) => ServerRuntimeEvent | null;
}

export function interceptErrors(
  emit: EmitFn,
  sessionId: string,
  options?: ErrorInterceptorOptions
): () => void {
  const onUncaughtException = (error: Error) => {
    const event: ConsoleEvent = {
      eventId: generateId(),
      sessionId: getSessionId(sessionId),
      timestamp: Date.now(),
      eventType: 'console',
      level: 'error',
      message: `[Uncaught] ${error.message}`,
      args: [safeSerialize(error, 3)],
      stackTrace: error.stack,
      sourceFile: extractSourceFile(error.stack),
    };

    if (options?.beforeSend) {
      const filtered = options.beforeSend(event);
      if (filtered) emit(filtered as ConsoleEvent);
    } else {
      emit(event);
    }

    // Preserve Node.js default crash behavior — set exit code so the
    // process still terminates after all listeners have run
    process.exitCode = 1;
  };

  const onUnhandledRejection = (reason: unknown) => {
    let message: string;
    let stackTrace: string | undefined;

    if (reason instanceof Error) {
      message = reason.message;
      stackTrace = reason.stack;
    } else if (typeof reason === 'string') {
      message = reason;
    } else {
      try {
        message = JSON.stringify(reason);
      } catch {
        message = String(reason);
      }
    }

    const event: ConsoleEvent = {
      eventId: generateId(),
      sessionId: getSessionId(sessionId),
      timestamp: Date.now(),
      eventType: 'console',
      level: 'error',
      message: `[Unhandled Rejection] ${message}`,
      args: [safeSerialize(reason, 3)],
      stackTrace,
      sourceFile: undefined,
    };

    if (options?.beforeSend) {
      const filtered = options.beforeSend(event);
      if (filtered) emit(filtered as ConsoleEvent);
    } else {
      emit(event);
    }
  };

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  return () => {
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
  };
}

function extractSourceFile(stack?: string): string | undefined {
  if (!stack) return undefined;
  // Find first non-internal frame
  const lines = stack.split('\n');
  for (const line of lines.slice(1)) {
    const match = line.match(/at\s+.*?\((.+?):(\d+):(\d+)\)/);
    if (match && !match[1].includes('node_modules') && !match[1].includes('node:')) {
      return `${match[1]}:${match[2]}:${match[3]}`;
    }
  }
  return undefined;
}
