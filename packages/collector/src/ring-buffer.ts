/**
 * Fixed-size circular buffer. When full, new items overwrite the oldest.
 * Optimized for append-heavy workloads with periodic filtered scans.
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number = 0;
  private _count: number = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  get count(): number {
    return this._count;
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this._count < this.capacity) this._count++;
  }

  /** Returns all items from oldest to newest. */
  toArray(): T[] {
    if (this._count === 0) return [];
    const result: T[] = [];
    const start = this._count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this._count; i++) {
      const idx = (start + i) % this.capacity;
      result.push(this.buffer[idx] as T);
    }
    return result;
  }

  /** Returns matching items from newest to oldest (most recent first). */
  query(predicate: (item: T) => boolean): T[] {
    if (this._count === 0) return [];
    const result: T[] = [];
    const start = this._count < this.capacity ? 0 : this.head;
    for (let i = this._count - 1; i >= 0; i--) {
      const idx = (start + i) % this.capacity;
      const item = this.buffer[idx] as T;
      if (predicate(item)) result.push(item);
    }
    return result;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this._count = 0;
  }
}
