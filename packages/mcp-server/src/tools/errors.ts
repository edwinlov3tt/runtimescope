import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';

interface StackFrame {
  functionName: string;
  file: string;
  line: number;
  column: number;
}

interface ErrorWithContext {
  message: string;
  timestamp: string;
  frames: (StackFrame & { sourceContext?: string[] })[];
}

export function registerErrorTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_errors_with_source_context',
    'Get console errors with parsed stack traces and surrounding source code lines. Fetches the actual source files from the dev server (e.g. http://localhost:3000/src/...) and shows the lines around the error. This gives you the same context as clicking a stack frame in DevTools.',
    {
      since_seconds: z
        .number()
        .optional()
        .describe('Only return errors from the last N seconds'),
      fetch_source: z
        .boolean()
        .optional()
        .describe('Whether to fetch source files for context (default: true). Set false for faster results.'),
      context_lines: z
        .number()
        .optional()
        .describe('Number of source lines to show above and below the error line (default: 5)'),
    },
    async ({ since_seconds, fetch_source, context_lines }) => {
      const shouldFetch = fetch_source !== false;
      const contextSize = context_lines ?? 5;

      const events = store.getConsoleMessages({
        level: 'error',
        sinceSeconds: since_seconds,
      });

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      // Limit to 50 errors
      const limited = events.slice(0, 50);
      const sourceCache = new Map<string, string | null>();

      const errors: ErrorWithContext[] = [];

      for (const event of limited) {
        const frames = event.stackTrace ? parseStackTrace(event.stackTrace) : [];

        if (shouldFetch) {
          for (const frame of frames) {
            // Skip node_modules and non-http files
            if (frame.file.includes('node_modules')) continue;
            if (!frame.file.startsWith('http')) continue;

            if (!sourceCache.has(frame.file)) {
              sourceCache.set(frame.file, await fetchSource(frame.file));
            }

            const source = sourceCache.get(frame.file);
            if (source) {
              (frame as StackFrame & { sourceContext?: string[] }).sourceContext =
                extractContext(source, frame.line, contextSize);
            }
          }
        }

        errors.push({
          message: event.message,
          timestamp: new Date(event.timestamp).toISOString(),
          frames: frames as (StackFrame & { sourceContext?: string[] })[],
        });
      }

      const issues: string[] = [];
      if (events.length > 50) {
        issues.push(`Showing 50 of ${events.length} errors`);
      }

      // Group by unique message
      const uniqueMessages = new Set(limited.map((e) => e.message.slice(0, 100)));

      const response = {
        summary: `${limited.length} error(s)${since_seconds ? ` in the last ${since_seconds}s` : ''}, ${uniqueMessages.size} unique. ${shouldFetch ? 'Source context included.' : 'Source context disabled.'}`,
        data: errors,
        issues,
        metadata: {
          timeRange: {
            from: limited.length > 0 ? limited[0].timestamp : 0,
            to: limited.length > 0 ? limited[limited.length - 1].timestamp : 0,
          },
          eventCount: limited.length,
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}

/**
 * Parse stack traces from Chrome/V8 and Firefox formats.
 * Chrome: "    at functionName (file:line:col)"
 * Firefox: "functionName@file:line:col"
 */
function parseStackTrace(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];

  for (const line of stack.split('\n')) {
    const trimmed = line.trim();

    // Chrome/V8 format: "at functionName (file:line:col)"
    const chromeMatch = trimmed.match(
      /^at\s+(?:(.+?)\s+\()?(https?:\/\/[^)]+):(\d+):(\d+)\)?$/
    );
    if (chromeMatch) {
      frames.push({
        functionName: chromeMatch[1] ?? '<anonymous>',
        file: chromeMatch[2],
        line: parseInt(chromeMatch[3], 10),
        column: parseInt(chromeMatch[4], 10),
      });
      continue;
    }

    // Firefox format: "functionName@file:line:col"
    const firefoxMatch = trimmed.match(
      /^(.+?)@(https?:\/\/.+):(\d+):(\d+)$/
    );
    if (firefoxMatch) {
      frames.push({
        functionName: firefoxMatch[1] ?? '<anonymous>',
        file: firefoxMatch[2],
        line: parseInt(firefoxMatch[3], 10),
        column: parseInt(firefoxMatch[4], 10),
      });
    }
  }

  return frames;
}

/** Fetch source file with timeout */
async function fetchSource(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Extract lines around a target line */
function extractContext(
  source: string,
  targetLine: number,
  contextSize: number
): string[] {
  const lines = source.split('\n');
  const start = Math.max(0, targetLine - contextSize - 1);
  const end = Math.min(lines.length, targetLine + contextSize);

  return lines.slice(start, end).map((line, i) => {
    const lineNum = start + i + 1;
    const marker = lineNum === targetLine ? '>>>' : '   ';
    return `${marker} ${lineNum.toString().padStart(4)} | ${line}`;
  });
}
