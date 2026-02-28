// ============================================================
// Per-Session Rate Limiter
// Sliding-window counters to prevent any single SDK from
// flooding the collector with events
// ============================================================

export interface RateLimitConfig {
  maxEventsPerSecond?: number;
  maxEventsPerMinute?: number;
}

interface SessionWindow {
  secondCount: number;
  secondStart: number;
  minuteCount: number;
  minuteStart: number;
  lastWarning: number;
}

export class SessionRateLimiter {
  private windows: Map<string, SessionWindow> = new Map();
  private maxPerSecond: number;
  private maxPerMinute: number;
  private _droppedTotal = 0;

  constructor(config: RateLimitConfig = {}) {
    this.maxPerSecond = config.maxEventsPerSecond ?? Infinity;
    this.maxPerMinute = config.maxEventsPerMinute ?? Infinity;
  }

  get droppedTotal(): number {
    return this._droppedTotal;
  }

  isEnabled(): boolean {
    return this.maxPerSecond !== Infinity || this.maxPerMinute !== Infinity;
  }

  /** Returns true if the event should be accepted, false if rate-limited. */
  allow(sessionId: string): boolean {
    if (!this.isEnabled()) return true;

    const now = Date.now();
    let w = this.windows.get(sessionId);

    if (!w) {
      w = {
        secondCount: 0,
        secondStart: now,
        minuteCount: 0,
        minuteStart: now,
        lastWarning: 0,
      };
      this.windows.set(sessionId, w);
    }

    // Reset second window
    if (now - w.secondStart >= 1000) {
      w.secondCount = 0;
      w.secondStart = now;
    }

    // Reset minute window
    if (now - w.minuteStart >= 60_000) {
      w.minuteCount = 0;
      w.minuteStart = now;
    }

    // Check per-second limit
    if (w.secondCount >= this.maxPerSecond) {
      this._droppedTotal++;
      this.maybeWarn(sessionId, w, now);
      return false;
    }

    // Check per-minute limit
    if (w.minuteCount >= this.maxPerMinute) {
      this._droppedTotal++;
      this.maybeWarn(sessionId, w, now);
      return false;
    }

    w.secondCount++;
    w.minuteCount++;
    return true;
  }

  /** Allow a batch of N events. Returns the number accepted. */
  allowBatch(sessionId: string, count: number): number {
    let accepted = 0;
    for (let i = 0; i < count; i++) {
      if (this.allow(sessionId)) accepted++;
      else break; // once limited, remaining events in batch are also limited
    }
    return accepted;
  }

  /** Remove tracking for sessions that haven't been seen in maxAgeMs. */
  prune(maxAgeMs = 300_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, w] of this.windows) {
      if (w.minuteStart < cutoff) {
        this.windows.delete(id);
      }
    }
  }

  private maybeWarn(sessionId: string, w: SessionWindow, now: number): void {
    // Log at most once per minute per session
    if (now - w.lastWarning >= 60_000) {
      w.lastWarning = now;
      console.error(
        `[RuntimeScope] Rate limiting session ${sessionId.slice(0, 8)}... (dropped ${this._droppedTotal} total)`
      );
    }
  }
}
