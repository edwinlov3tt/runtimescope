import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../ring-buffer.js';

describe('RingBuffer', () => {
  describe('push and count', () => {
    it('starts empty with count 0', () => {
      const rb = new RingBuffer<number>(5);
      expect(rb.count).toBe(0);
    });

    it('increments count on push', () => {
      const rb = new RingBuffer<number>(5);
      rb.push(1);
      expect(rb.count).toBe(1);
      rb.push(2);
      expect(rb.count).toBe(2);
    });

    it('count stops at capacity', () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      rb.push(4); // overflow
      expect(rb.count).toBe(3);
    });
  });

  describe('toArray', () => {
    it('returns empty array when empty', () => {
      const rb = new RingBuffer<number>(5);
      expect(rb.toArray()).toEqual([]);
    });

    it('returns items in insertion order (oldest to newest)', () => {
      const rb = new RingBuffer<number>(5);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      expect(rb.toArray()).toEqual([1, 2, 3]);
    });

    it('after overflow, still returns oldest to newest', () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      rb.push(4); // overwrites 1
      rb.push(5); // overwrites 2
      expect(rb.toArray()).toEqual([3, 4, 5]);
    });

    it('returns exactly capacity items after many pushes', () => {
      const rb = new RingBuffer<number>(3);
      for (let i = 0; i < 100; i++) rb.push(i);
      const arr = rb.toArray();
      expect(arr).toHaveLength(3);
      expect(arr).toEqual([97, 98, 99]);
    });
  });

  describe('overflow behavior', () => {
    it('overwrites oldest items when capacity exceeded', () => {
      const rb = new RingBuffer<string>(2);
      rb.push('a');
      rb.push('b');
      rb.push('c'); // overwrites 'a'
      expect(rb.toArray()).toEqual(['b', 'c']);
    });

    it('pushing capacity+1 items drops the first item', () => {
      const rb = new RingBuffer<number>(4);
      rb.push(10);
      rb.push(20);
      rb.push(30);
      rb.push(40);
      rb.push(50); // drops 10
      expect(rb.toArray()).toEqual([20, 30, 40, 50]);
    });
  });

  describe('query', () => {
    it('returns empty array on empty buffer', () => {
      const rb = new RingBuffer<number>(5);
      expect(rb.query(() => true)).toEqual([]);
    });

    it('returns matching items in newest-to-oldest order', () => {
      const rb = new RingBuffer<number>(5);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      expect(rb.query(() => true)).toEqual([3, 2, 1]);
    });

    it('returns only matching items with selective predicate', () => {
      const rb = new RingBuffer<number>(5);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      rb.push(4);
      rb.push(5);
      expect(rb.query((n) => n % 2 === 0)).toEqual([4, 2]);
    });

    it('works correctly after overflow', () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      rb.push(4);
      rb.push(5);
      // Buffer: [3, 4, 5], query newest first
      expect(rb.query((n) => n > 3)).toEqual([5, 4]);
    });
  });

  describe('clear', () => {
    it('resets count to 0', () => {
      const rb = new RingBuffer<number>(5);
      rb.push(1);
      rb.push(2);
      rb.clear();
      expect(rb.count).toBe(0);
    });

    it('toArray returns empty after clear', () => {
      const rb = new RingBuffer<number>(5);
      rb.push(1);
      rb.clear();
      expect(rb.toArray()).toEqual([]);
    });

    it('can push new items after clear', () => {
      const rb = new RingBuffer<number>(5);
      rb.push(1);
      rb.push(2);
      rb.clear();
      rb.push(10);
      expect(rb.toArray()).toEqual([10]);
      expect(rb.count).toBe(1);
    });
  });
});
