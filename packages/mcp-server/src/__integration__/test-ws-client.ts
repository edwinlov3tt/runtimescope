import WebSocket from 'ws';

interface HandshakeOpts {
  appName: string;
  sdkVersion: string;
  sessionId: string;
}

/**
 * Lightweight WebSocket client that speaks the RuntimeScope SDK protocol.
 * Used in integration tests to simulate a browser/server SDK.
 */
export class TestWsClient {
  private ws: WebSocket | null = null;
  private commandHandler: ((cmd: any) => unknown) | null = null;

  constructor(private url: string) {}

  /** Open the WebSocket connection */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => reject(err));

      // Handle incoming messages (commands from server)
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'command' && msg.payload && this.commandHandler) {
            const result = this.commandHandler(msg.payload);
            // Send command_response back
            this.ws!.send(JSON.stringify({
              type: 'command_response',
              requestId: msg.payload.requestId,
              command: msg.payload.command,
              payload: result,
              timestamp: Date.now(),
              sessionId: msg.sessionId,
            }));
          }
        } catch {
          // Ignore parse errors in test client
        }
      });
    });
  }

  /** Send a handshake message (first message after connecting) */
  handshake(opts: HandshakeOpts): void {
    this.send({
      type: 'handshake',
      payload: {
        appName: opts.appName,
        sdkVersion: opts.sdkVersion,
        sessionId: opts.sessionId,
      },
      timestamp: Date.now(),
      sessionId: opts.sessionId,
    });
  }

  /** Send a batch of events */
  sendEvents(events: unknown[]): void {
    this.send({
      type: 'event',
      payload: { events },
      timestamp: Date.now(),
      sessionId: '',
    });
  }

  /** Send a heartbeat */
  sendHeartbeat(): void {
    this.send({
      type: 'heartbeat',
      payload: null,
      timestamp: Date.now(),
      sessionId: '',
    });
  }

  /** Register a handler for server commands (e.g., capture_dom_snapshot) */
  onCommand(handler: (cmd: any) => unknown): void {
    this.commandHandler = handler;
  }

  /** Close the WebSocket connection */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.on('close', () => resolve());
      this.ws.close();
    });
  }

  /** Wait for the server to process messages (async tick) */
  waitForServerProcessing(ms = 50): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }
}
