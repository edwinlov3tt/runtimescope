/**
 * Conformance: WebSocket handshake.
 *
 * Locks the SDK→collector handshake contract any collector binary must honor:
 *   - a valid handshake registers a session (observable via /api/sessions + the
 *     /api/health connected-session count)
 *   - with auth enabled, a socket that doesn't authenticate is closed with WS
 *     close code 4001 within the 5s window (server.ts:776-800)
 *
 * Source of truth: packages/collector/src/server.ts (handshake handler),
 * packages/collector/src/types.ts (HandshakePayload).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { spawnCollector, SdkDriver, type SpawnedCollector } from '../harness/index.js';

let collector: SpawnedCollector | null = null;
afterEach(async () => { await collector?.stop(); collector = null; });

describe('handshake', () => {
  it('a valid handshake registers a connected session', async () => {
    collector = await spawnCollector();
    await collector.ready();

    const driver = new SdkDriver({
      wsPort: collector.wsPort,
      appName: 'conf-handshake',
      projectId: 'proj_conf_handshake',
    });
    await driver.connect();
    // Give the server a beat to process the handshake frame.
    await new Promise((r) => setTimeout(r, 200));

    const sessions = await fetch(`http://127.0.0.1:${collector.httpPort}/api/sessions`).then((r) => r.json()) as {
      data: Array<{ sessionId: string; appName: string; isConnected: boolean }>;
      count: number;
    };
    const mine = sessions.data.find((s) => s.sessionId === driver.sessionId);
    expect(mine, 'session should appear in /api/sessions').toBeTruthy();
    expect(mine!.appName).toBe('conf-handshake');
    expect(mine!.isConnected).toBe(true);

    const health = await fetch(`http://127.0.0.1:${collector.httpPort}/api/health`).then((r) => r.json()) as {
      sessions: number;
      authEnabled: boolean;
    };
    expect(health.sessions).toBeGreaterThanOrEqual(1);
    expect(health.authEnabled).toBe(false);

    await driver.close();
  });

  it('closes an unauthenticated socket with code 4001 when auth is enabled', async () => {
    collector = await spawnCollector({ authToken: 'tk_conformance_secret' });
    await collector.ready();

    // /api/health must report auth enabled.
    const health = await fetch(`http://127.0.0.1:${collector.httpPort}/api/health`).then((r) => r.json()) as {
      authEnabled: boolean;
    };
    expect(health.authEnabled).toBe(true);

    // Connect raw (no authToken in handshake) and capture the close code.
    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${collector!.wsPort}`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('no close within 8s')); }, 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'handshake',
          payload: { appName: 'no-auth', sdkVersion: '0.0.0', sessionId: 'conf-noauth' },
          timestamp: Date.now(),
          sessionId: 'conf-noauth',
        }));
      });
      ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
      ws.on('error', () => { /* close will follow */ });
    });

    expect(closeCode).toBe(4001);
  });

  it('accepts a correctly-authenticated handshake when auth is enabled', async () => {
    collector = await spawnCollector({ authToken: 'tk_conformance_secret' });
    await collector.ready();

    const driver = new SdkDriver({
      wsPort: collector.wsPort,
      appName: 'conf-authed',
      projectId: 'proj_conf_authed',
      authToken: 'tk_conformance_secret',
    });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 200));

    const sessions = await fetch(`http://127.0.0.1:${collector.httpPort}/api/sessions`, {
      headers: { Authorization: 'Bearer tk_conformance_secret' },
    }).then((r) => r.json()) as { data: Array<{ sessionId: string }> };
    expect(sessions.data.some((s) => s.sessionId === driver.sessionId)).toBe(true);

    await driver.close();
  });
});
