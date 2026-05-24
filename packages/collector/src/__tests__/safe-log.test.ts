/**
 * Tests for the EPIPE-safe stderr logger.
 *
 * This locks the contract that prevents the v0.10.8 zombie-loop bug from
 * recurring: any write to stderr from inside an error handler must either
 * succeed quietly or exit the process — it must NEVER throw, because the
 * throw would land back in the same handler and create a CPU-pegged loop.
 *
 * See: docs/audits/0001-collector-process-lifetime.md F1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { safeLog } from '../log.js';

describe('safeLog', () => {
  let writeMock: ReturnType<typeof vi.fn>;
  let originalWrite: typeof process.stderr.write;
  let originalWritable: boolean;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalWrite = process.stderr.write.bind(process.stderr);
    originalWritable = process.stderr.writable;
    writeMock = vi.fn(() => true);
    process.stderr.write = writeMock as unknown as typeof process.stderr.write;
    // process.exit must be stubbed because safeLog calls it when stderr breaks
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_called__(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    Object.defineProperty(process.stderr, 'writable', { value: originalWritable, configurable: true });
    exitSpy.mockRestore();
  });

  describe('happy path', () => {
    it('writes a single string arg followed by a newline', () => {
      safeLog.error('hello');
      expect(writeMock).toHaveBeenCalledOnce();
      expect(writeMock).toHaveBeenCalledWith('hello\n');
    });

    it('joins multiple args with spaces (drop-in for console.error semantics)', () => {
      safeLog.error('[RuntimeScope]', 'Session', 'sess-1', 'disconnected');
      expect(writeMock).toHaveBeenCalledWith('[RuntimeScope] Session sess-1 disconnected\n');
    });

    it('serializes Error instances to stack (or message fallback)', () => {
      const err = new Error('boom');
      safeLog.error('caught:', err);
      const call = writeMock.mock.calls[0]![0] as string;
      expect(call).toMatch(/^caught: Error: boom/);
      expect(call.endsWith('\n')).toBe(true);
    });

    it('serializes plain objects via JSON.stringify', () => {
      safeLog.error('payload:', { sessionId: 'sess-1', count: 3 });
      expect(writeMock).toHaveBeenCalledWith('payload: {"sessionId":"sess-1","count":3}\n');
    });

    it('falls back to String() on circular objects without throwing', () => {
      const circular: { self?: unknown } = {};
      circular.self = circular;
      expect(() => safeLog.error('circ:', circular)).not.toThrow();
      // Just verify we wrote something — the exact representation isn't part of the contract
      expect(writeMock).toHaveBeenCalledOnce();
    });

    it('handles null and undefined args', () => {
      safeLog.error('values:', null, undefined);
      expect(writeMock).toHaveBeenCalledWith('values: null undefined\n');
    });
  });

  describe('EPIPE safety (the regression bar)', () => {
    it('exits the process when stderr is not writable', () => {
      Object.defineProperty(process.stderr, 'writable', { value: false, configurable: true });
      // exitSpy throws to escape the call — wrap so the test continues
      expect(() => safeLog.error('this should not be logged')).toThrow('__exit_called__(1)');
      expect(writeMock).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits the process when stderr.write() throws (EPIPE between check and write)', () => {
      writeMock.mockImplementationOnce(() => {
        const e = new Error('EPIPE') as NodeJS.ErrnoException;
        e.code = 'EPIPE';
        throw e;
      });
      expect(() => safeLog.error('this throws')).toThrow('__exit_called__(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('does NOT re-enter recursively when the write throws', () => {
      // The whole point: a throw from inside safeLog must NOT trigger another
      // safeLog call (which would loop forever in the wild). The exit path
      // proves we bail rather than retry/log.
      let recursionDepth = 0;
      writeMock.mockImplementation(() => {
        recursionDepth++;
        if (recursionDepth > 1) {
          throw new Error('REGRESSION: safeLog re-entered itself');
        }
        throw new Error('EPIPE');
      });
      try { safeLog.error('first'); } catch { /* exitSpy threw */ }
      expect(recursionDepth).toBe(1);
    });
  });

  describe('warn() is a synonym for error()', () => {
    it('writes via the same EPIPE-safe path', () => {
      safeLog.warn('a warning');
      expect(writeMock).toHaveBeenCalledWith('a warning\n');
    });
  });
});
