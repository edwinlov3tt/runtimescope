/**
 * Conformance: WebSocket auth error frames (AUTH_FAILED vs AUTH_TIMEOUT).
 *
 * The existing handshake spec only locks the WS *close code* (4001). But both
 * auth-rejection paths close with 4001, so the close code alone cannot tell a
 * client WHY it was rejected. The collector emits a distinguishing `error`
 * frame BEFORE the close, and the server SDK keys off `payload.code` to decide
 * whether to stop reconnecting (a wrong/missing token is permanent — don't
 * retry; a handshake timeout is transient — retrying with a real token works).
 * A gate that asserts only the 4001 close lets a port that emits the wrong code
 * (or no frame at all) pass while breaking that SDK reconnect decision.
 *
 * This spec locks the exact pre-close error frames for both paths:
 *
 *   (1) BAD TOKEN  — a handshake carrying the WRONG authToken gets an
 *       `error` frame with payload.code === 'AUTH_FAILED' then close 4001.
 *       Source: packages/collector/src/server.ts (handleMessage 'handshake':
 *       authManager.isAuthorized() === false → send AUTH_FAILED, close(4001)).
 *
 *   (2) NO HANDSHAKE — a socket that authenticates with nothing gets, within
 *       the ~5s window, an `error` frame with payload.code === 'AUTH_TIMEOUT'
 *       then close 4001.
 *       Source: packages/collector/src/server.ts (setupConnectionHandler auth
 *       timeout: setTimeout(5000) → send AUTH_TIMEOUT, close(4001)).
 *
 * The two codes MUST differ (AUTH_FAILED !== AUTH_TIMEOUT) — that is the
 * contract the SDK depends on.
 *
 * Source of truth: packages/collector/src/server.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { spawnCollector, type SpawnedCollector } from '../harness/index.js';

let collector: SpawnedCollector | null = null;
afterEach(async () => { await collector?.stop(); collector = null; });

const AUTH_TOKEN = 'tk_phase_a';

interface ErrorFrame {
  type: string;
  payload: { code: string; message?: string };
  timestamp?: number;
}

/**
 * Open a raw WS, run `onOpen` once it's connected, then collect the first
 * `error` frame the server sends and the eventual close code. Resolves once
 * the socket closes (or rejects on timeout).
 */
function captureAuthRejection(
  wsPort: number,
  onOpen: (ws: WebSocket) => void,
  timeoutMs: number,
): Promise<{ frame: ErrorFrame | null; closeCode: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    let frame: ErrorFrame | null = null;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no close within ${timeoutMs}ms (frame so far: ${JSON.stringify(frame)})`));
    }, timeoutMs);

    ws.on('open', () => onOpen(ws));
    ws.on('message', (data) => {
      let msg: { type?: string; payload?: { code?: string } };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Latch the FIRST error frame the server sends pre-close.
      if (!frame && msg.type === 'error') {
        frame = msg as ErrorFrame;
      }
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve({ frame, closeCode: code });
    });
    ws.on('error', () => { /* a close event follows */ });
  });
}

describe('auth error frames', () => {
  it('reports /api/health authEnabled=true for an auth-enabled collector', async () => {
    collector = await spawnCollector({ authToken: AUTH_TOKEN });
    await collector.ready();

    const health = await fetch(`http://127.0.0.1:${collector.httpPort}/api/health`).then((r) => r.json()) as {
      authEnabled: boolean;
    };
    expect(health.authEnabled).toBe(true);
  });

  it('BAD TOKEN: sends an AUTH_FAILED error frame then closes 4001', async () => {
    collector = await spawnCollector({ authToken: AUTH_TOKEN });
    await collector.ready();

    const { frame, closeCode } = await captureAuthRejection(
      collector.wsPort,
      (ws) => {
        ws.send(JSON.stringify({
          type: 'handshake',
          payload: {
            appName: 'conf-bad-token',
            sdkVersion: '0.0.0',
            sessionId: 'conf-bad-token',
            authToken: 'tk_wrong_token', // deliberately not AUTH_TOKEN
          },
          timestamp: Date.now(),
          sessionId: 'conf-bad-token',
        }));
      },
      8000,
    );

    // The server MUST emit an error frame before closing — not just close.
    expect(frame, 'expected an error frame before close').toBeTruthy();
    expect(frame!.type).toBe('error');
    expect(frame!.payload.code).toBe('AUTH_FAILED');
    expect(closeCode).toBe(4001);
  });

  it('NO HANDSHAKE: sends an AUTH_TIMEOUT error frame then closes 4001 within the auth window', async () => {
    collector = await spawnCollector({ authToken: AUTH_TOKEN });
    await collector.ready();

    const started = Date.now();
    const { frame, closeCode } = await captureAuthRejection(
      collector.wsPort,
      () => { /* send nothing — never authenticate */ },
      12_000,
    );
    const elapsed = Date.now() - started;

    expect(frame, 'expected an error frame before close').toBeTruthy();
    expect(frame!.type).toBe('error');
    expect(frame!.payload.code).toBe('AUTH_TIMEOUT');
    expect(closeCode).toBe(4001);
    // The handshake timeout is ~5s — fire after a real delay, well before the
    // heartbeat (15s) could terminate the socket for an unrelated reason.
    expect(elapsed).toBeGreaterThanOrEqual(4000);
    expect(elapsed).toBeLessThan(10_000);
  });

  it('the two rejection codes are DISTINGUISHABLE (AUTH_FAILED !== AUTH_TIMEOUT)', async () => {
    collector = await spawnCollector({ authToken: AUTH_TOKEN });
    await collector.ready();

    const bad = await captureAuthRejection(
      collector.wsPort,
      (ws) => {
        ws.send(JSON.stringify({
          type: 'handshake',
          payload: {
            appName: 'conf-distinguish',
            sdkVersion: '0.0.0',
            sessionId: 'conf-distinguish',
            authToken: 'tk_wrong_token',
          },
          timestamp: Date.now(),
          sessionId: 'conf-distinguish',
        }));
      },
      8000,
    );
    const timeout = await captureAuthRejection(
      collector.wsPort,
      () => { /* never authenticate */ },
      12_000,
    );

    expect(bad.frame!.payload.code).toBe('AUTH_FAILED');
    expect(timeout.frame!.payload.code).toBe('AUTH_TIMEOUT');
    // The SDK keys off these codes to decide whether to keep reconnecting;
    // they MUST NOT collapse to the same value even though both close 4001.
    expect(bad.frame!.payload.code).not.toBe(timeout.frame!.payload.code);
    expect(bad.closeCode).toBe(4001);
    expect(timeout.closeCode).toBe(4001);
  });
});
