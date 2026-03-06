import { useDataStore } from '@/stores/use-data-store';
import { useAppStore } from '@/stores/use-app-store';
import { fetchProjects } from '@/lib/api';

const MAX_RECONNECT_DELAY = 30_000;

type DevServerHandler = (msg: any) => void;
let devServerHandler: DevServerHandler | null = null;

export function setDevServerHandler(fn: DevServerHandler): void {
  devServerHandler = fn;
}

// Debounced project refresh — coalesce rapid connect/disconnect bursts
let projectRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshProjectsSoon(): void {
  if (projectRefreshTimer) return;
  projectRefreshTimer = setTimeout(async () => {
    projectRefreshTimer = null;
    const projects = await fetchProjects();
    if (projects) {
      const store = useAppStore.getState();
      store.setProjects(projects);
      // Auto-select if none selected and exactly one connected
      if (!store.selectedProject) {
        const connected = projects.filter((p) => p.isConnected);
        if (connected.length === 1) store.setSelectedProject(connected[0].appName);
      }
    }
  }, 300);
}

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

      // Dev server status/log messages — route to handler
      if ((msg.type === 'dev_server_status' || msg.type === 'dev_server_log') && devServerHandler) {
        devServerHandler(msg);
        return;
      }

      // Session connect/disconnect — refresh projects immediately
      if (msg.type === 'session_connected' || msg.type === 'session_disconnected') {
        refreshProjectsSoon();
        return;
      }

      if (msg.type === 'event' && msg.data) {
        // Client-side project filtering: skip events not belonging to selected project
        const { selectedProject, projects } = useAppStore.getState();
        if (selectedProject) {
          const project = projects.find((p) => p.appName === selectedProject);
          // If the selected project isn't in the runtime list (SDK not connected),
          // drop all events — otherwise they leak from other apps
          if (!project || !project.sessions.includes(msg.data.sessionId)) {
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
