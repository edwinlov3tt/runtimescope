// Save original console methods BEFORE any interceptors patch them.
// Used for SDK-internal logging to avoid recursion.
export const _log = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};
