import { WebSocketServer, type WebSocket } from 'ws';
import { EventStore } from './store.js';
import type {
  WSMessage,
  HandshakePayload,
  EventBatchPayload,
} from './types.js';

export interface CollectorServerOptions {
  port?: number;
  host?: string;
  bufferSize?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export class CollectorServer {
  private wss: WebSocketServer | null = null;
  private store: EventStore;
  private clients: Map<WebSocket, string> = new Map();

  constructor(options: CollectorServerOptions = {}) {
    this.store = new EventStore(options.bufferSize ?? 10_000);
  }

  getStore(): EventStore {
    return this.store;
  }

  start(options: CollectorServerOptions = {}): Promise<void> {
    const port = options.port ?? 9090;
    const host = options.host ?? '127.0.0.1';
    const maxRetries = options.maxRetries ?? 5;
    const retryDelayMs = options.retryDelayMs ?? 1000;

    return this.tryStart(port, host, maxRetries, retryDelayMs);
  }

  private tryStart(
    port: number,
    host: string,
    retriesLeft: number,
    retryDelayMs: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host });

      wss.on('listening', () => {
        this.wss = wss;
        this.setupConnectionHandler(wss);
        console.error(`[RuntimeScope] Collector listening on ws://${host}:${port}`);
        resolve();
      });

      wss.on('error', (err: NodeJS.ErrnoException) => {
        wss.close();

        if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
          console.error(
            `[RuntimeScope] Port ${port} in use, retrying in ${retryDelayMs}ms (${retriesLeft} attempts left)...`
          );
          setTimeout(() => {
            this.tryStart(port, host, retriesLeft - 1, retryDelayMs)
              .then(resolve)
              .catch(reject);
          }, retryDelayMs);
        } else {
          console.error('[RuntimeScope] WebSocket server error:', err.message);
          reject(err);
        }
      });
    });
  }

  private setupConnectionHandler(wss: WebSocketServer): void {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());
          this.handleMessage(ws, msg);
        } catch {
          console.error('[RuntimeScope] Malformed WebSocket message, ignoring');
        }
      });

      ws.on('close', () => {
        const sessionId = this.clients.get(ws);
        if (sessionId) {
          this.store.markDisconnected(sessionId);
          console.error(`[RuntimeScope] Session ${sessionId} disconnected`);
        }
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.error('[RuntimeScope] WebSocket client error:', err.message);
      });
    });
  }

  private handleMessage(ws: WebSocket, msg: WSMessage): void {
    switch (msg.type) {
      case 'handshake': {
        const payload = msg.payload as HandshakePayload;
        this.clients.set(ws, payload.sessionId);
        console.error(
          `[RuntimeScope] Session ${payload.sessionId} connected (${payload.appName} v${payload.sdkVersion})`
        );
        break;
      }
      case 'event': {
        const payload = msg.payload as EventBatchPayload;
        if (Array.isArray(payload.events)) {
          for (const event of payload.events) {
            this.store.addEvent(event);
          }
        }
        break;
      }
      case 'heartbeat':
        // No-op for M1
        break;
    }
  }

  stop(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
      console.error('[RuntimeScope] Collector stopped');
    }
  }
}
