import { useDataStore } from '@/stores/use-data-store';
import { useAppStore } from '@/stores/use-app-store';

const MAX_RECONNECT_DELAY = 30_000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let stopped = false;

function getWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/ws/events`;
}

function doConnect(): void {
  if (stopped) return;

  try {
    ws = new WebSocket(getWsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = 1000;
    useDataStore.getState().setConnected(true);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'event' && msg.data) {
        // Client-side project filtering: skip events not belonging to selected project
        const { selectedProject, projects } = useAppStore.getState();
        if (selectedProject) {
          const project = projects.find((p) => p.appName === selectedProject);
          if (project && msg.data.sessionId && !project.sessions.includes(msg.data.sessionId)) {
            return;
          }
        }
        useDataStore.getState().appendEvent(msg.data);
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    useDataStore.getState().setConnected(false);
    if (!stopped) scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  const jitter = reconnectDelay * 0.25 * (Math.random() * 2 - 1);
  const delay = Math.min(reconnectDelay + jitter, MAX_RECONNECT_DELAY);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    doConnect();
  }, delay);
}

export function connectWs(): void {
  stopped = false;
  doConnect();
}

export function disconnectWs(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  useDataStore.getState().setConnected(false);
}
