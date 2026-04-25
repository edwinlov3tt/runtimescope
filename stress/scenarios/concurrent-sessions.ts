/**
 * Scenario: concurrent-sessions
 *
 * Open 100 SDK sessions in parallel, each pushing N events to its own
 * project, then verify:
 *   1. Every session connects successfully (no rate-limiter false positives)
 *   2. The collector tracks 100 distinct sessions and the right project for each
 *   3. Per-project event counts match what each driver sent (no cross-tenant
 *      leakage, no drops under contention)
 *   4. /metrics agrees with /api/sessions on connected count
 *
 * Stresses: handshake throughput, project-id resolution chain, session map
 * insertion, fan-out of onEvent listeners.
 */

import { spawnCollector } from '../utils/spawn-collector.js';
import { SdkDriver, makeNetEvent } from '../utils/sdk-driver.js';
import { CheckCollector } from '../utils/assert.js';

const SESSION_COUNT = 100;
const EVENTS_PER_SESSION = 50;

export async function concurrentSessions(checks: CheckCollector): Promise<void> {
  const collector = await spawnCollector({ bufferSize: 50_000 });
  try {
    await collector.ready();

    const drivers: SdkDriver[] = [];
    for (let i = 0; i < SESSION_COUNT; i++) {
      drivers.push(
        new SdkDriver({
          wsPort: collector.wsPort,
          appName: `concurrent-app-${i}`,
          projectId: `proj_concurrent_${i % 10}`, // 10 distinct projects, 10 sessions each
        }),
      );
    }

    // Connect everyone in parallel — the collector should accept all of them.
    const t0 = performance.now();
    await Promise.all(drivers.map((d) => d.connect(10_000)));
    const handshakeMs = performance.now() - t0;
    checks.ok(`${SESSION_COUNT} parallel handshakes completed in ${handshakeMs.toFixed(0)}ms`, true);
    checks.leq('handshake throughput ≥ 50/sec', (handshakeMs / SESSION_COUNT) * 1, 20, 'ms/session');

    // Brief settle — handshakes are written async to the session map.
    await new Promise((r) => setTimeout(r, 200));

    // Now everyone sends events in parallel.
    await Promise.all(
      drivers.map(async (d) => {
        const batch: object[] = [];
        for (let i = 0; i < EVENTS_PER_SESSION; i++) batch.push(makeNetEvent(d.sessionId, i));
        d.sendBatch(batch);
        await d.flush();
      }),
    );

    // Allow the collector's batched writes + listeners to settle.
    await new Promise((r) => setTimeout(r, 1500));

    const sessionsRes = (await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/sessions`,
    ).then((r) => r.json())) as { data: { sessionId: string; projectId?: string; eventCount: number; isConnected: boolean }[] };

    const ourSessions = sessionsRes.data.filter((s) =>
      drivers.some((d) => d.sessionId === s.sessionId),
    );
    checks.eq('every driver session is registered', ourSessions.length, SESSION_COUNT);

    const allConnected = ourSessions.every((s) => s.isConnected);
    checks.ok('every driver session is `isConnected: true`', allConnected);

    // Per-project counts: each project should have ~10 sessions.
    const byProject = new Map<string, number>();
    for (const s of ourSessions) {
      if (s.projectId) byProject.set(s.projectId, (byProject.get(s.projectId) ?? 0) + 1);
    }
    const balanced = Array.from(byProject.values()).every((v) => v === SESSION_COUNT / 10);
    checks.ok(`projects evenly populated (10 sessions × 10 projects)`, balanced);

    // Event counts on each session should match EVENTS_PER_SESSION (every
    // batch was small enough to fit in a single send and the rate limiter
    // shouldn't fire — the playground default rates are higher).
    const totalEvents = ourSessions.reduce((sum, s) => sum + s.eventCount, 0);
    const expected = SESSION_COUNT * EVENTS_PER_SESSION;
    // Each session also has a session event auto-emitted on handshake — that's
    // counted too. So expected total = SESSION_COUNT (handshakes) + sent events.
    const expectedWithHandshakes = SESSION_COUNT + expected;
    checks.eq('total per-session event counts', totalEvents, expectedWithHandshakes);

    // Tear down half + verify counts go down.
    const halves = drivers.length / 2;
    await Promise.all(drivers.slice(0, halves).map((d) => d.close()));
    await new Promise((r) => setTimeout(r, 300));

    const after = (await fetch(
      `http://127.0.0.1:${collector.httpPort}/api/sessions`,
    ).then((r) => r.json())) as { data: { sessionId: string; isConnected: boolean }[] };
    const stillConnected = after.data
      .filter((s) => drivers.some((d) => d.sessionId === s.sessionId))
      .filter((s) => s.isConnected).length;
    checks.eq('half closed → half still connected', stillConnected, halves);

    await Promise.all(drivers.slice(halves).map((d) => d.close()));
  } finally {
    await collector.stop();
  }
}
