import type { RuntimeEvent } from './types.js';

// Save original console.debug BEFORE any interceptors patch it.
// debug-level messages are hidden by default in Chrome DevTools.
const _log = console.debug.bind(console);

interface TransportConfig {
  serverUrl: string;
  appName: string;
  sessionId: string;
  sdkVersion: string;
  batchSize: number;
  flushIntervalMs: number;
}

export class Transport {
  private ws: WebSocket | null = null;
  private batch: RuntimeEvent[] = [];
  private offlineQueue: RuntimeEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private connected = false;
  private stopped = false;
  private config: TransportConfig;
  private commandHandler: ((cmd: { command: string; requestId: string; params?: Record<string, unknown> }) => void) | null = null;

  private static readonly MAX_OFFLINE_QUEUE = 1000;
  private static readonly MAX_RECONNECT_DELAY = 30_000;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  connect(): void {
    this.stopped = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.stopped) return;

    try {
      this.ws = new WebSocket(this.config.serverUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.type === 'command' && msg.payload && this.commandHandler) {
          this.commandHandler(msg.payload);
        }
      } catch {
        // Ignore unparseable messages
      }
    };

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      _log(`[RuntimeScope] Connected to ${this.config.serverUrl}`);

      // Send handshake
      this.sendRaw({
        type: 'handshake',
        payload: {
          appName: this.config.appName,
          sdkVersion: this.config.sdkVersion,
          sessionId: this.config.sessionId,
        },
        timestamp: Date.now(),
        sessionId: this.config.sessionId,
      });

      // Flush offline queue
      if (this.offlineQueue.length > 0) {
        const queued = this.offlineQueue.splice(0);
        for (const event of queued) {
          this.batch.push(event);
        }
        this.flush();
      }

      // Start periodic flush
      this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.clearFlushTimer();
      if (!this.stopped) {
        _log(`[RuntimeScope] Disconnected, will reconnect...`);
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      _log(`[RuntimeScope] WebSocket error connecting to ${this.config.serverUrl}`);
    };
  }

  send(event: RuntimeEvent): void {
    if (this.connected) {
      this.batch.push(event);
      if (this.batch.length >= this.config.batchSize) {
        this.flush();
      }
    } else {
      // Queue for when we reconnect
      if (this.offlineQueue.length < Transport.MAX_OFFLINE_QUEUE) {
        this.offlineQueue.push(event);
      }
    }
  }

  private flush(): void {
    if (this.batch.length === 0 || !this.connected || !this.ws) return;

    const events = this.batch.splice(0);
    this.sendRaw({
      type: 'event',
      payload: { events },
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
    });
  }

  private sendRaw(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch {
        // Drop silently — reconnect will handle it
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    // Exponential backoff with jitter
    const jitter = this.reconnectDelay * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.min(this.reconnectDelay + jitter, Transport.MAX_RECONNECT_DELAY);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, Transport.MAX_RECONNECT_DELAY);
      this.doConnect();
    }, delay);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  onCommand(handler: (cmd: { command: string; requestId: string; params?: Record<string, unknown> }) => void): void {
    this.commandHandler = handler;
  }

  sendCommandResponse(requestId: string, command: string, payload: unknown): void {
    this.sendRaw({
      type: 'command_response',
      requestId,
      command,
      payload,
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.clearFlushTimer();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Final flush before closing
    this.flush();

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    this.batch = [];
    this.offlineQueue = [];
  }
}
