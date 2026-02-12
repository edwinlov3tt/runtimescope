import { Transport } from './transport.js';
import { interceptFetch } from './interceptors/fetch.js';
import { interceptConsole } from './interceptors/console.js';
import { interceptXhr } from './interceptors/xhr.js';
import { interceptStateStores } from './interceptors/state-stores.js';
import { interceptPerformance } from './interceptors/performance.js';
import { interceptReactRenders } from './interceptors/react-renders.js';
import { interceptErrors } from './interceptors/errors.js';
import { generateId, generateSessionId } from './utils/id.js';
import type { RuntimeScopeConfig, RuntimeEvent, DomSnapshotEvent } from './types.js';

const SDK_VERSION = '0.2.0';

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
      captureXhr: config.captureXhr ?? true,
      captureBody: config.captureBody ?? false,
      maxBodySize: config.maxBodySize ?? 65536,
      capturePerformance: config.capturePerformance ?? false,
      captureRenders: config.captureRenders ?? false,
      stores: config.stores ?? {},
      beforeSend: config.beforeSend,
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
      buildMeta: config.buildMeta,
    });

    // Register command handler for server→SDK commands
    const sessionId = this._sessionId;
    this.transport.onCommand((cmd: { command: string; requestId: string; params?: Record<string, unknown> }) => {
      this.handleCommand(cmd, emit, sessionId);
    });

    // Fetch interceptor
    if (resolved.captureNetwork) {
      this.restoreFns.push(
        interceptFetch(emit, this._sessionId, resolved.redactHeaders, {
          captureBody: resolved.captureBody,
          maxBodySize: resolved.maxBodySize,
          beforeSend: resolved.beforeSend,
        })
      );
    }

    // XHR interceptor
    if (resolved.captureXhr) {
      this.restoreFns.push(
        interceptXhr(emit, this._sessionId, resolved.redactHeaders, {
          captureBody: resolved.captureBody,
          maxBodySize: resolved.maxBodySize,
          beforeSend: resolved.beforeSend,
        })
      );
    }

    // Console interceptor
    if (resolved.captureConsole) {
      this.restoreFns.push(
        interceptConsole(emit, this._sessionId, resolved.beforeSend)
      );
      // Also capture uncaught errors, resource load failures, and unhandled rejections
      // These appear in DevTools console but don't go through console.* API
      this.restoreFns.push(
        interceptErrors(emit, this._sessionId, resolved.beforeSend)
      );
    }

    // State store inspection
    if (Object.keys(resolved.stores).length > 0) {
      this.restoreFns.push(
        interceptStateStores(emit, this._sessionId, resolved.stores, {
          beforeSend: resolved.beforeSend,
        })
      );
    }

    // Performance metrics (Web Vitals)
    if (resolved.capturePerformance) {
      this.restoreFns.push(
        interceptPerformance(emit, this._sessionId, {
          beforeSend: resolved.beforeSend,
        })
      );
    }

    // React render tracking
    if (resolved.captureRenders) {
      this.restoreFns.push(
        interceptReactRenders(emit, this._sessionId, {
          beforeSend: resolved.beforeSend,
        })
      );
    }

    const features = [
      resolved.captureNetwork && 'fetch',
      resolved.captureXhr && 'xhr',
      resolved.captureConsole && 'console, errors',
      Object.keys(resolved.stores).length > 0 && 'state',
      resolved.capturePerformance && 'performance',
      resolved.captureRenders && 'renders',
    ].filter(Boolean);
    _log(`[RuntimeScope] Interceptors active — ${features.join(', ')}`);
  }

  private static handleCommand(
    cmd: { command: string; requestId: string; params?: Record<string, unknown> },
    emit: (event: RuntimeEvent) => void,
    sessionId: string
  ): void {
    switch (cmd.command) {
      case 'capture_dom_snapshot': {
        const maxSize = (cmd.params?.maxSize as number) ?? 500_000;
        let html = document.documentElement.outerHTML;
        const truncated = html.length > maxSize;
        if (truncated) html = html.slice(0, maxSize);

        const snapshot: DomSnapshotEvent = {
          eventId: generateId(),
          sessionId,
          timestamp: Date.now(),
          eventType: 'dom_snapshot',
          html,
          url: window.location.href,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          scrollPosition: { x: window.scrollX, y: window.scrollY },
          elementCount: document.querySelectorAll('*').length,
          truncated,
        };

        emit(snapshot);
        this.transport?.sendCommandResponse(cmd.requestId, cmd.command, snapshot);
        break;
      }
      default:
        this.transport?.sendCommandResponse(cmd.requestId, cmd.command, { error: 'Unknown command' });
    }
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
  BuildMeta,
  NetworkEvent,
  ConsoleEvent,
  SessionEvent,
  StateEvent,
  RenderEvent,
  DomSnapshotEvent,
  PerformanceEvent,
  RuntimeEvent,
} from './types.js';
