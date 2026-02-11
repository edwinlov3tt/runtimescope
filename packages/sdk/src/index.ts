import { Transport } from './transport.js';
import { interceptFetch } from './interceptors/fetch.js';
import { interceptConsole } from './interceptors/console.js';
import { generateId, generateSessionId } from './utils/id.js';
import type { RuntimeScopeConfig, RuntimeEvent } from './types.js';

const SDK_VERSION = '0.1.0';

// Save original console.error BEFORE interceptors patch it
const _log = console.error.bind(console);

export class RuntimeScope {
  private static transport: Transport | null = null;
  private static restoreFns: (() => void)[] = [];
  private static _sessionId: string | null = null;

  static get sessionId(): string | null {
    return this._sessionId;
  }

  static connect(config: RuntimeScopeConfig = {}): void {
    if (config.enabled === false) return;
    if (this.transport) this.disconnect();

    const resolved = {
      serverUrl: config.serverUrl ?? 'ws://localhost:9090',
      appName: config.appName ?? 'unknown',
      captureNetwork: config.captureNetwork ?? true,
      captureConsole: config.captureConsole ?? true,
      redactHeaders: config.redactHeaders ?? ['authorization', 'cookie'],
      batchSize: config.batchSize ?? 50,
      flushIntervalMs: config.flushIntervalMs ?? 100,
    };

    this._sessionId = generateSessionId();

    this.transport = new Transport({
      serverUrl: resolved.serverUrl,
      appName: resolved.appName,
      sessionId: this._sessionId,
      sdkVersion: SDK_VERSION,
      batchSize: resolved.batchSize,
      flushIntervalMs: resolved.flushIntervalMs,
    });

    this.transport.connect();
    _log(`[RuntimeScope] SDK v${SDK_VERSION} initializing — app: ${resolved.appName}, server: ${resolved.serverUrl}`);

    const emit = (event: RuntimeEvent) => this.transport?.send(event);

    // Send session event
    emit({
      eventId: generateId(),
      sessionId: this._sessionId,
      timestamp: Date.now(),
      eventType: 'session',
      appName: resolved.appName,
      connectedAt: Date.now(),
      sdkVersion: SDK_VERSION,
    });

    if (resolved.captureNetwork) {
      this.restoreFns.push(
        interceptFetch(emit, this._sessionId, resolved.redactHeaders)
      );
    }

    if (resolved.captureConsole) {
      this.restoreFns.push(interceptConsole(emit, this._sessionId));
    }

    _log(`[RuntimeScope] Interceptors active — network: ${resolved.captureNetwork}, console: ${resolved.captureConsole}`);
  }

  static disconnect(): void {
    for (const fn of this.restoreFns) fn();
    this.restoreFns = [];
    this.transport?.disconnect();
    this.transport = null;
    this._sessionId = null;
  }
}

export default RuntimeScope;
export type {
  RuntimeScopeConfig,
  NetworkEvent,
  ConsoleEvent,
  SessionEvent,
  RuntimeEvent,
} from './types.js';
