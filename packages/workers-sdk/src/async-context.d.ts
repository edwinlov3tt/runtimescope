// Minimal type declarations for node:async_hooks
// Workers runtime supports AsyncLocalStorage with the nodejs_compat flag
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R;
  }
}
