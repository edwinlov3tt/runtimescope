/**
 * Diagnostic logging for the sidecar.
 *
 * CRITICAL: stdout is the JSON line protocol channel — every byte written to
 * stdout must be a protocol response. All diagnostics therefore go to stderr.
 */
export const log = {
  error(...args: unknown[]): void {
    process.stderr.write(`[recon-sidecar] ${args.map((a) => String(a)).join(' ')}\n`);
  },
};
