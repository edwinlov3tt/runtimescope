/**
 * Minimal in-process driver that simulates an SDK client without actually
 * loading any of the @runtimescope/* SDKs. We speak the WebSocket wire
 * protocol directly so we can:
 *   - control timing precisely (no batch/flush jitter)
 *   - bypass SDK-side guards we want to stress (rate limits, dedup)
 *   - construct events with pathological payloads
 *   - measure pure collector behavior, not SDK overhead
 *
 * For a "real SDK" stress test, the framework-smoke scenario uses the
 * actual SDKs — but for the collector-side stress, we want a thin client.
 */

import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';

export interface DriverConfig {
  wsPort: number;
  appName: string;
  projectId: string;
  sessionId?: string;
  authToken?: string;
}

export class SdkDriver {
  ws: WebSocket | null = null;
  readonly sessionId: string;

  constructor(public config: DriverConfig) {
    this.sessionId = config.sessionId ?? `stress-${randomBytes(8).toString('hex')}`;
  }

  async connect(timeoutMs: number = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.config.wsPort}`);
      const t = setTimeout(() => {
        ws.close();
        reject(new Error(`Driver connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.on('open', () => {
        clearTimeout(t);
        ws.send(
          JSON.stringify({
            type: 'handshake',
            payload: {
              appName: this.config.appName,
              sdkVersion: '0.10.0-stress',
              sessionId: this.sessionId,
              ...(this.config.projectId ? { projectId: this.config.projectId } : {}),
              ...(this.config.authToken ? { authToken: this.config.authToken } : {}),
            },
            timestamp: Date.now(),
            sessionId: this.sessionId,
          }),
        );
        this.ws = ws;
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
  }

  /** Send N events in a single batch. Synchronous from the driver's perspective. */
  sendBatch(events: object[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Driver not connected (state=${this.ws?.readyState})`);
    }
    this.ws.send(
      JSON.stringify({
        type: 'event',
        payload: { events },
        timestamp: Date.now(),
        sessionId: this.sessionId,
      }),
    );
  }

  /** Wait for the underlying WS to drain its outgoing buffer. */
  async flush(): Promise<void> {
    if (!this.ws) return;
    while (this.ws.bufferedAmount > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

/**
 * Build a synthetic network event with a stable shape. Cheap to build, easy
 * to count downstream — used by flood/burst tests.
 */
export function makeNetEvent(sessionId: string, i: number): object {
  return {
    eventId: `evt-${i}-${randomBytes(4).toString('hex')}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'network',
    url: `https://example.com/api/test/${i}`,
    method: 'GET',
    status: 200,
    requestHeaders: {},
    responseHeaders: { 'content-type': 'application/json' },
    requestBodySize: 0,
    responseBodySize: 1024,
    duration: 5 + (i % 50),
    ttfb: 1 + (i % 10),
    source: 'stress',
  };
}
