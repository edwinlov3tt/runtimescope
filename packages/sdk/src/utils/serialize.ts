/** Safely serialize a value, handling circular references, functions, symbols, and errors. */
export function safeSerialize(value: unknown, maxDepth = 5): unknown {
  const seen = new WeakSet();

  function walk(val: unknown, depth: number): unknown {
    if (depth > maxDepth) return '[max depth]';
    if (val === null || val === undefined) return val;
    if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`;
    if (typeof val === 'symbol') return val.toString();
    if (typeof val === 'bigint') return val.toString();
    if (typeof val !== 'object') return val;

    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack };
    }
    if (val instanceof Date) {
      return val.toISOString();
    }
    if (val instanceof RegExp) {
      return val.toString();
    }

    if (seen.has(val as object)) return '[Circular]';
    seen.add(val as object);

    if (Array.isArray(val)) {
      return val.map((v) => walk(v, depth + 1));
    }

    const result: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(val as Record<string, unknown>);
    } catch {
      return '[Object]';
    }
    // Limit keys to avoid huge React fiber-like objects
    const maxKeys = 50;
    for (let i = 0; i < Math.min(keys.length, maxKeys); i++) {
      try {
        result[keys[i]] = walk((val as Record<string, unknown>)[keys[i]], depth + 1);
      } catch {
        result[keys[i]] = '[Error accessing property]';
      }
    }
    if (keys.length > maxKeys) result['...'] = `${keys.length - maxKeys} more keys`;
    return result;
  }

  return walk(value, 0);
}
