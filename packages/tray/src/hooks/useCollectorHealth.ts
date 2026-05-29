import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// The shape returned by the Rust `health_snapshot` command. Keep in sync with
// HealthSnapshot in src-tauri/src/collector_client.rs.
export interface SessionSummary {
  sessionId: string;
  appName: string;
  isConnected: boolean;
}

export type HealthState = 'green' | 'yellow' | 'red' | 'gray';

export interface HealthSnapshot {
  state: HealthState;
  /** Free-form status line — e.g. "PID 12345, port 6768, uptime 12h 4m, version 0.10.12". */
  statusLine: string;
  pid: number | null;
  port: number;
  uptimeSeconds: number | null;
  runningVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  sessions: SessionSummary[];
  /** Human-readable error to surface when state is red/yellow. */
  errorReason: string | null;
}

const EMPTY: HealthSnapshot = {
  state: 'gray',
  statusLine: 'Starting up…',
  pid: null,
  port: 6768,
  uptimeSeconds: null,
  runningVersion: null,
  latestVersion: null,
  updateAvailable: false,
  sessions: [],
  errorReason: null,
};

export function useCollectorHealth() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot>(EMPTY);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<HealthSnapshot>('health_snapshot');
      setSnapshot(next);
    } catch (e) {
      setSnapshot({
        ...EMPTY,
        state: 'red',
        statusLine: 'Tray failed to reach Rust shell',
        errorReason: String(e),
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Initial fetch immediately on mount; Rust polls in the background and
    // pushes via emit so we don't need to set up our own JS interval here.
    refresh();

    const unlisten = setupEventListener((next) => {
      if (!cancelled) setSnapshot(next);
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn?.());
    };
  }, [refresh]);

  return { snapshot, refresh };
}

async function setupEventListener(
  onSnapshot: (s: HealthSnapshot) => void
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<HealthSnapshot>('health-snapshot', (event) => {
    onSnapshot(event.payload);
  });
  return unlisten;
}
