import type { ServerRuntimeEvent } from './types.js';

// ============================================================
// HTTP Transport for Serverless Environments
// Fire-and-forget POST to collector's /api/events endpoint.
// Uses global fetch (Node 20+, Cloudflare Workers, Vercel Edge, Bun).
// ============================================================

export interface HttpTransportOptions {
  url: string;
  sessionId: string;
  appName: string;
  sdkVersion: string;
  authToken?: string;
  maxQueueSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export class HttpTransport {
  private queue: ServerRuntimeEvent[] = [];
  private url: string;
  private sessionId: string;
  private appName: string;
  private sdkVersion: string;
  private authToken: string | undefined;
  private maxQueueSize: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private _droppedCount = 0;
  private sessionRegistered = false;

  constructor(options: HttpTransportOptions) {
    this.url = options.url;
    this.sessionId = options.sessionId;
    this.appName = options.appName;
    this.sdkVersion = options.sdkVersion;
    this.authToken = options.authToken;
    this.maxQueueSize = options.maxQueueSize ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;

    const intervalMs = options.flushIntervalMs ?? 1000;
    this.flushTimer = setInterval(() => this.flush(), intervalMs);
    // Unref so the timer doesn't keep the process alive in serverless
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      this.flushTimer.unref();
    }
  }

  get droppedCount(): number {
    return this._droppedCount;
  }

  sendEvent(event: ServerRuntimeEvent): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this._droppedCount++;
    }
    this.queue.push(event);
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    const payload: Record<string, unknown> = {
      sessionId: this.sessionId,
      events: batch,
    };

    // Include appName/sdkVersion on first request to auto-register session
    if (!this.sessionRegistered) {
      payload.appName = this.appName;
      payload.sdkVersion = this.sdkVersion;
    }

    const body = JSON.stringify(payload);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (this.authToken) {
          headers['Authorization'] = `Bearer ${this.authToken}`;
        }

        const response = await fetch(this.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          this.sessionRegistered = true;
          return;
        }

        // Non-retryable errors — drop the batch
        if (response.status === 401 || response.status === 400) {
          return;
        }
      } catch {
        // Network error — retry
      }

      if (attempt < this.maxRetries) {
        await new Promise(r => setTimeout(r, this.retryDelayMs));
      }
    }

    // All retries exhausted — events are lost (fire-and-forget model)
  }

  async disconnect(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
