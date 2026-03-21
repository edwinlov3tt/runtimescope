import type { WorkersRuntimeEvent } from './types.js';

// ============================================================
// Sampler — probabilistic + rate limiting
// Adapted from server-sdk, no Node.js APIs.
// ============================================================

export interface SamplerConfig {
  /** Probabilistic sample rate: 0.0–1.0 (default: 1.0 = keep all) */
  sampleRate?: number;
}

export class Sampler {
  private _droppedCount = 0;

  constructor(private config: SamplerConfig) {}

  get droppedCount(): number {
    return this._droppedCount;
  }

  shouldSample(_event: WorkersRuntimeEvent): boolean {
    const rate = this.config.sampleRate;
    if (rate !== undefined && rate < 1) {
      if (Math.random() > rate) {
        this._droppedCount++;
        return false;
      }
    }
    return true;
  }
}
