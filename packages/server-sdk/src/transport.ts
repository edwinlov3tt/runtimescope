import WebSocket from 'ws';
import type { ServerRuntimeEvent, WSMessage } from './types.js';

export class ServerTransport {
  private ws: WebSocket | null = null;
  private url: string;
  private sessionId: string;
  private appName: string;
  private sdkVersion: string;
  private queue: ServerRuntimeEvent[] = [];
  private maxQueueSize: number;
  private _droppedCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    url: string;
    sessionId: string;
    appName: string;
    sdkVersion: string;
    maxQueueSize?: number;
  }) {
    this.url = options.url;
    this.sessionId = options.sessionId;
    this.appName = options.appName;
    this.sdkVersion = options.sdkVersion;
    this.maxQueueSize = options.maxQueueSize ?? 10_000;
  }

  get droppedCount(): number {
    return this._droppedCount;
  }

  connect(): void {
    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.connected = true;
        this.sendHandshake();
        this.flushQueue();

        // Start periodic flush
        this.flushTimer = setInterval(() => this.flushQueue(), 100);
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.cleanup();
        this.scheduleReconnect();
      });

      this.ws.on('error', () => {
        this.connected = false;
        this.cleanup();
        this.scheduleReconnect();
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private cleanup(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  private sendHandshake(): void {
    this.send({
      type: 'handshake',
      payload: {
        appName: this.appName,
        sdkVersion: this.sdkVersion,
        sessionId: this.sessionId,
      },
      timestamp: Date.now(),
      sessionId: this.sessionId,
    });
  }

  sendEvent(event: ServerRuntimeEvent): void {
    // Enforce queue cap — drop oldest events when full
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this._droppedCount++;
    }
    this.queue.push(event);
    if (this.connected && this.queue.length >= 10) {
      this.flushQueue();
    }
  }

  private flushQueue(): void {
    if (!this.connected || this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    this.send({
      type: 'event',
      payload: { events: batch },
      timestamp: Date.now(),
      sessionId: this.sessionId,
    });
  }

  private send(msg: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch {
        // Connection may have closed between check and send
      }
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanup();
    this.flushQueue();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}
