import type { WorkersRuntimeEvent, WorkersConfig, UserContext } from './types.js';
import { generateSessionId } from './utils.js';

// ============================================================
// Workers Transport
// Flush events via ctx.waitUntil(fetch(...)) — no timers, no intervals.
// Matches collector's POST /api/events endpoint.
// ============================================================

const SDK_VERSION = '0.10.4';
const DEFAULT_ENDPOINT = 'http://localhost:6768/api/events';

export class WorkersTransport {
  private buffer: WorkersRuntimeEvent[] = [];
  private maxQueueSize: number;
  private url: string;
  private authToken: string | undefined;
  private appName: string;
  private projectId?: string;
  private sessionRegistered = false;
  private _droppedCount = 0;

  readonly sessionId: string;

  constructor(config: WorkersConfig) {
    this.sessionId = generateSessionId();
    // Prefer the canonical `endpoint` field (consistent with the browser
    // and server SDKs). Fall back to the deprecated `httpEndpoint` for
    // backwards compatibility — without this fallback we'd silently break
    // every v0.10.x consumer on upgrade.
    this.url = config.endpoint ?? config.httpEndpoint ?? DEFAULT_ENDPOINT;
    this.appName = config.appName;
    this.projectId = config.projectId;
    this.authToken = config.authToken;
    this.maxQueueSize = config.maxQueueSize ?? 500;
  }

  get droppedCount(): number {
    return this._droppedCount;
  }

  queue(event: WorkersRuntimeEvent): void {
    if (this.buffer.length >= this.maxQueueSize) {
      this.buffer.shift();
      this._droppedCount++;
    }
    this.buffer.push(event);
  }

  /**
   * Flush all buffered events to the collector.
   * Call via ctx.waitUntil(transport.flush()) at the end of each request.
   * Retries once on failure with a short delay.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = this.buffer.splice(0);
    const payload: Record<string, unknown> = {
      sessionId: this.sessionId,
      events,
    };

    // Include appName/sdkVersion on first request to auto-register session
    if (!this.sessionRegistered) {
      payload.appName = this.appName;
      payload.sdkVersion = SDK_VERSION;
      if (this.projectId) payload.projectId = this.projectId;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const body = JSON.stringify(payload);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5_000);

        const response = await fetch(this.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          this.sessionRegistered = true;
          return;
        }

        // Server error (5xx) — retry once
        if (response.status >= 500 && attempt === 0) continue;
        // Client error (4xx) — don't retry
        return;
      } catch {
        // Network error or timeout — retry once
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        // Second attempt failed — events are lost (acceptable for edge observability)
      }
    }
  }
}
