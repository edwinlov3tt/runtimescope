import { generateId } from '../utils/id.js';
import { safeSerialize } from '../utils/serialize.js';
import type { ConsoleEvent, RuntimeEvent } from '../types.js';

type EmitFn = (event: ConsoleEvent) => void;

/**
 * Captures uncaught errors and unhandled promise rejections that appear
 * in DevTools but don't go through the console.* API.
 *
 * - window 'error' (capture phase) — JS runtime errors + resource load failures
 * - window 'unhandledrejection' — unhandled async/await and Promise rejections
 *
 * Events are emitted as ConsoleEvents with level 'error' so they appear
 * alongside console.error() output in get_console_messages.
 */
export function interceptErrors(
  emit: EmitFn,
  sessionId: string,
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null
): () => void {
  // Capture uncaught JS errors and resource load failures
  const onError = (e: ErrorEvent | Event) => {
    let message: string;
    let stackTrace: string | undefined;
    let sourceFile: string | undefined;

    if (e instanceof ErrorEvent) {
      // Uncaught JS error
      message = e.message || 'Uncaught error';
      stackTrace = e.error?.stack;
      sourceFile = e.filename
        ? `${e.filename}:${e.lineno}:${e.colno}`
        : undefined;
    } else {
      // Resource load error (img, script, link, etc.)
      const target = e.target as HTMLElement | null;
      if (target && target !== window as unknown) {
        const tagName = target.tagName?.toLowerCase() ?? 'unknown';
        const src =
          (target as HTMLImageElement).src ??
          (target as HTMLScriptElement).src ??
          (target as HTMLLinkElement).href ??
          'unknown';
        message = `Failed to load resource: <${tagName}> ${src}`;
      } else {
        return; // Not a resource error we can identify
      }
    }

    const event: ConsoleEvent = {
      eventId: generateId(),
      sessionId,
      timestamp: Date.now(),
      eventType: 'console',
      level: 'error',
      message: `[Uncaught] ${message}`,
      args: [safeSerialize(message, 3)],
      stackTrace,
      sourceFile,
    };

    if (beforeSend) {
      const filtered = beforeSend(event);
      if (filtered) emit(filtered as ConsoleEvent);
    } else {
      emit(event);
    }
  };

  // Capture unhandled promise rejections
  const onUnhandledRejection = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
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
      sessionId,
      timestamp: Date.now(),
      eventType: 'console',
      level: 'error',
      message: `[Unhandled Rejection] ${message}`,
      args: [safeSerialize(reason, 3)],
      stackTrace,
      sourceFile: undefined,
    };

    if (beforeSend) {
      const filtered = beforeSend(event);
      if (filtered) emit(filtered as ConsoleEvent);
    } else {
      emit(event);
    }
  };

  // Use capture phase for 'error' to catch resource load failures on child elements
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  return () => {
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}
