import type { ServerRuntimeEvent } from './types.js';

export interface SamplerConfig {
  /** Probabilistic sample rate: 0.0–1.0 (default: 1.0 = keep all) */
  sampleRate?: number;
  /** Max events per second before dropping (default: unlimited) */
  maxEventsPerSecond?: number;
}

export class Sampler {
  private windowCount = 0;
  private windowStart = Date.now();
  private _droppedCount = 0;

  constructor(private config: SamplerConfig) {}

  get droppedCount(): number {
    return this._droppedCount;
  }

  shouldSample(_event: ServerRuntimeEvent): boolean {
    // 1. Probabilistic sampling
    const rate = this.config.sampleRate;
    if (rate !== undefined && rate < 1) {
      if (Math.random() > rate) {
        this._droppedCount++;
        return false;
      }
    }

    // 2. Rate limiting (1-second sliding window)
    const maxPerSec = this.config.maxEventsPerSecond;
    if (maxPerSec !== undefined) {
      const now = Date.now();
      if (now - this.windowStart >= 1000) {
        this.windowCount = 0;
        this.windowStart = now;
      }
      if (this.windowCount >= maxPerSec) {
        this._droppedCount++;
        return false;
      }
      this.windowCount++;
    }

    return true;
  }

  reset(): void {
    this.windowCount = 0;
    this.windowStart = Date.now();
    this._droppedCount = 0;
  }
}
