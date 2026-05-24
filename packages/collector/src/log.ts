// ============================================================
// safeLog — EPIPE-resilient stderr writes
//
// Why this exists:
//   v0.10.8 fixed a class of bug where the npx-spawned MCP server got
//   reparented to init when Claude Code exited, then entered a tight
//   uncaughtException → console.error → uncaughtException loop against
//   a closed stderr pipe. The fix wrapped the two handler entry points,
//   but the codebase has 100+ raw `console.error` / `process.stderr.write`
//   sites in ordinary code paths (PM discovery, otel exporter, WAL
//   recovery, etc.). Any one of those can re-trigger the same loop if
//   it fires while stderr is broken — the v0.10.8 fix is necessary but
//   not sufficient.
//
//   See audit: docs/audits/0001-collector-process-lifetime.md F1
//   See ADR:   docs/decisions/0001-audit-then-rust.md
//
// Contract:
//   - Synchronous writes to stderr, formatted similarly to console.error.
//   - If stderr is unwritable (parent died, pipe closed), the call exits
//     the process with code 1 rather than throwing. We cannot meaningfully
//     surface anything to a dead pipe; the only behavior that doesn't
//     cascade into a CPU-pegged loop is to bail.
//   - Drop-in replacement for console.error / console.warn — supports
//     multi-arg format (`safeLog.error('foo:', err.message)`).
//   - Never throws; never re-enters. Safe to call from inside an
//     uncaughtException handler.
// ============================================================

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  if (a === null || a === undefined) return String(a);
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a);
    } catch {
      // Circular refs or non-serializable values — fall back to toString.
      return String(a);
    }
  }
  return String(a);
}

function write(stream: NodeJS.WriteStream, args: unknown[]): void {
  try {
    if (!stream.writable) {
      // Pipe is gone. Don't try to log anything else, just exit.
      // We use code 1 to distinguish "I exited because my stderr broke"
      // from "I exited because my stdin closed" (which uses code 0).
      process.exit(1);
    }
    const formatted = args.map(formatArg).join(' ');
    stream.write(formatted + '\n');
  } catch {
    // The write itself threw (EPIPE landed between the writable check and
    // the write). Same conclusion: exit, do not loop.
    process.exit(1);
  }
}

export const safeLog = {
  error(...args: unknown[]): void {
    write(process.stderr, args);
  },
  warn(...args: unknown[]): void {
    write(process.stderr, args);
  },
};
