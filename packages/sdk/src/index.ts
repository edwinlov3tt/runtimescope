import { Transport, setTransportDebug } from './transport.js';
import { interceptFetch } from './interceptors/fetch.js';
import { interceptConsole } from './interceptors/console.js';
import { interceptXhr } from './interceptors/xhr.js';
import { interceptStateStores } from './interceptors/state-stores.js';
import { interceptPerformance } from './interceptors/performance.js';
import { interceptReactRenders } from './interceptors/react-renders.js';
import { interceptErrors } from './interceptors/errors.js';
import { interceptNavigation } from './interceptors/navigation.js';
import { interceptClicks } from './interceptors/clicks.js';
import { generateId, generateSessionId } from './utils/id.js';
import { parseDsn } from './dsn.js';
import type { RuntimeScopeConfig, RuntimeEvent, DomSnapshotEvent, CustomEvent, UIInteractionEvent, UserContext } from './types.js';

const SDK_VERSION = '0.10.4';

// Save original console methods BEFORE interceptors patch them. The SDK uses
// these for its own diagnostics so its messages don't loop back through the
// console interceptor (which would emit a console event for every internal log).
const _origDebug = console.debug.bind(console);
const _origWarn = console.warn.bind(console);

/**
 * Internal-only debug logging. Quiet by default — set
 * `localStorage.RUNTIMESCOPE_DEBUG = '1'` or pass `verbose: true` to
 * `RuntimeScope.init()` to see them. Most users never need to see SDK
 * lifecycle chatter, and seeing it stacks up fast in DevTools.
 */
let _debugEnabled = false;
function _log(...args: unknown[]): void {
  if (_debugEnabled) _origDebug(...args);
}

/**
 * Always-visible warning. Reserved for things the user genuinely needs to
 * see: config mistakes, repeated init with conflicting DSN, auth failure.
 * Deduped — the same warning text only fires once per page load so a noisy
 * caller can't fill the console with the same message.
 */
const _warnedOnce = new Set<string>();
function _warn(message: string, ...rest: unknown[]): void {
  if (_warnedOnce.has(message)) return;
  _warnedOnce.add(message);
  _origWarn(message, ...rest);
}

// --- Double-init safety: Symbol.for() originals store ---
// Survives HMR module reloads because Symbol.for() returns the same symbol across realms.
// True originals are saved exactly once — never overwritten by subsequent connect() calls.
const ORIGINALS_KEY = Symbol.for('__runtimescope_originals__');

interface SavedOriginals {
  fetch: typeof globalThis.fetch;
  xhrOpen: typeof XMLHttpRequest.prototype.open;
  xhrSend: typeof XMLHttpRequest.prototype.send;
  xhrSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader;
  consoleMethods: Record<string, (...args: unknown[]) => void>;
}

function getOrSaveOriginals(): SavedOriginals {
  const g = globalThis as Record<symbol, SavedOriginals>;
  if (!g[ORIGINALS_KEY]) {
    g[ORIGINALS_KEY] = {
      fetch: window.fetch,
      xhrOpen: XMLHttpRequest.prototype.open,
      xhrSend: XMLHttpRequest.prototype.send,
      xhrSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
      consoleMethods: {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        info: console.info.bind(console),
        debug: console.debug.bind(console),
        trace: console.trace.bind(console),
      },
    };
  }
  return g[ORIGINALS_KEY];
}

export class RuntimeScope {
  private static transport: Transport | null = null;
  private static restoreFns: (() => void)[] = [];
  private static _sessionId: string | null = null;
  private static _state: 'stopped' | 'started' = 'stopped';
  /** Cached config fingerprint from the last init() call — used to detect double-init with conflicting config. */
  private static _initSignature: string | null = null;
  private static _sampleRate: number = 1;
  private static _maxEventsPerSecond: number | undefined;
  private static _windowCount = 0;
  private static _windowStart = 0;
  private static _user: UserContext | undefined;

  static get sessionId(): string | null {
    return this._sessionId;
  }

  /** Returns true if the SDK is currently connected */
  static get isConnected(): boolean {
    return this._state === 'started';
  }

  /** Probabilistic + rate-limit sampling. Returns true if the event should be sent. */
  private static shouldSample(): boolean {
    // Probabilistic sampling
    if (this._sampleRate < 1 && Math.random() > this._sampleRate) {
      return false;
    }
    // Rate limiting
    if (this._maxEventsPerSecond !== undefined) {
      const now = Date.now();
      if (now - this._windowStart >= 1000) {
        this._windowCount = 0;
        this._windowStart = now;
      }
      if (this._windowCount >= this._maxEventsPerSecond) {
        return false;
      }
      this._windowCount++;
    }
    return true;
  }

  static connect(config: RuntimeScopeConfig = {}): void {
    if (config.enabled === false) return;

    // DSN resolution: single string replaces projectId + endpoint + appName
    let hasDsn = false;
    if (config.dsn) {
      try {
        const parsed = parseDsn(config.dsn);
        config = {
          ...config,
          serverUrl: parsed.wsEndpoint,
          projectId: parsed.projectId,
          // DSN-embedded token takes precedence over an explicit authToken,
          // so pasting a new DSN is the single action users need to do
          ...(parsed.authToken ? { authToken: parsed.authToken } : {}),
          ...(parsed.appName && !config.appName ? { appName: parsed.appName } : {}),
        };
        hasDsn = true;
      } catch (e) {
        _log('[RuntimeScope] Invalid DSN:', (e as Error).message);
      }
    }

    // Auto-disable in production: if no explicit endpoint was configured and
    // we're not on localhost, become a no-op. Users with a hosted collector
    // set serverUrl/endpoint explicitly, so this only catches the default case.
    const hasExplicitEndpoint = !!(config.serverUrl || config.endpoint) || hasDsn;
    if (!hasExplicitEndpoint && typeof window !== 'undefined') {
      const host = window.location?.hostname;
      if (host && host !== 'localhost' && host !== '127.0.0.1' && !host.startsWith('192.168.') && !host.startsWith('10.')) {
        _log('[RuntimeScope] No endpoint configured and not on localhost — SDK disabled for production');
        return;
      }
    }

    // Resolve `verbose` early so the rest of init logs go through the right path.
    if (config.verbose === true) _debugEnabled = true;
    else if (typeof localStorage !== 'undefined') {
      try {
        if (localStorage.getItem('RUNTIMESCOPE_DEBUG') === '1') _debugEnabled = true;
      } catch {
        // localStorage can throw in sandboxed iframes — just ignore.
      }
    }
    // Propagate to the transport — it has its own _log because it lives in a
    // separate module and the user might construct a Transport directly.
    setTransportDebug(_debugEnabled);

    // Idempotent re-init: a second init() call with the same effective config
    // is a silent no-op. With a *different* serverUrl/appName/projectId we
    // warn loudly — that's almost always a footgun where the user has the
    // SDK initialized by the Vite plugin AND by their own bootstrap code,
    // and the second call silently overrides the first to a wrong endpoint.
    const sigCandidate = `${config.appName ?? ''}|${config.serverUrl ?? config.endpoint ?? ''}|${config.dsn ?? ''}|${config.projectId ?? ''}`;
    if (this._state === 'started') {
      if (this._initSignature === sigCandidate) {
        // Same config — nothing to do. Stay connected.
        return;
      }
      _warn(
        `[RuntimeScope] init() called twice with different config — disconnecting and re-initializing.\n` +
          `  previous: ${this._initSignature}\n` +
          `  next:     ${sigCandidate}\n` +
          `If the SDK is loaded by @runtimescope/vite, drop your manual RuntimeScope.init() call — the plugin handles it.`,
      );
      this.disconnect();
    }
    this._initSignature = sigCandidate;

    const resolved = {
      serverUrl: config.serverUrl ?? config.endpoint ?? 'ws://localhost:6767',
      appName: config.appName ?? 'unknown',
      captureNetwork: config.captureNetwork ?? true,
      captureConsole: config.captureConsole ?? true,
      captureXhr: config.captureXhr ?? true,
      captureBody: config.captureBody ?? false,
      maxBodySize: config.maxBodySize ?? 65536,
      capturePerformance: config.capturePerformance ?? true,
      captureRenders: config.captureRenders ?? true,
      captureNavigation: config.captureNavigation ?? true,
      captureClicks: config.captureClicks ?? true,
      stores: config.stores ?? {},
      beforeSend: config.beforeSend,
      redactHeaders: config.redactHeaders ?? ['authorization', 'cookie'],
      batchSize: config.batchSize ?? 50,
      flushIntervalMs: config.flushIntervalMs ?? 100,
      dedupeConsole: config.dedupeConsole ?? false,
    };

    // Save true originals before any patching (idempotent — only saves on first call ever)
    getOrSaveOriginals();

    this._sessionId = generateSessionId();
    this._state = 'started';

    this.transport = new Transport({
      serverUrl: resolved.serverUrl,
      appName: resolved.appName,
      sessionId: this._sessionId,
      sdkVersion: SDK_VERSION,
      authToken: config.authToken,
      projectId: config.projectId,
      batchSize: resolved.batchSize,
      flushIntervalMs: resolved.flushIntervalMs,
    });

    // Sampling config
    this._sampleRate = config.sampleRate ?? 1;
    this._maxEventsPerSecond = config.maxEventsPerSecond;
    this._windowCount = 0;
    this._windowStart = Date.now();
    this._user = config.user;

    this.transport.connect();
    _log(`[RuntimeScope] SDK v${SDK_VERSION} initializing — app: ${resolved.appName}, server: ${resolved.serverUrl}`);

    // If the transport isn't connected within 10s, emit a visible warning so
    // Claude Code (and humans) see the problem. We use console.warn once —
    // not the patched console (that routes to RuntimeScope itself, which is
    // pointless here) — so the message appears in the user's terminal /
    // browser DevTools.
    const originalWarn = getOrSaveOriginals().consoleMethods.warn;
    const warnTransportRef = this.transport;
    const warnServerUrl = resolved.serverUrl;
    setTimeout(() => {
      // Only warn if init wasn't replaced (user didn't disconnect) AND the
      // transport still hasn't connected. `isConnected()` is a cheap check.
      if (this.transport !== warnTransportRef) return;
      if (warnTransportRef.isConnected?.()) return;
      const isLocalUrl = /localhost|127\.0\.0\.1/.test(warnServerUrl);
      const fix = isLocalUrl
        ? 'Run `npx runtimescope start` in a terminal.'
        : `Check that ${warnServerUrl} is reachable and the collector is running.`;
      originalWarn(
        `[RuntimeScope] Couldn't connect to ${warnServerUrl} after 10s. No events are being captured.`,
        `\n  Fix: ${fix}`,
      );
    }, 10_000);

    const emit = (event: RuntimeEvent) => {
      // Session, custom, and UI events always pass through (never sampled out)
      if (event.eventType !== 'session' && event.eventType !== 'custom' && event.eventType !== 'ui') {
        if (!this.shouldSample()) return;
      }
      this.transport?.send(event);
    };

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
      user: this._user,
      projectId: config.projectId,
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
        interceptConsole(emit, this._sessionId, resolved.beforeSend, resolved.dedupeConsole)
      );
    }

    // Error interceptor (uncaught errors, resource failures, unhandled rejections)
    // Independent from captureConsole — these don't go through console.* API
    if (config.captureErrors !== false) {
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

    // Navigation / routing events (pushState, popstate, hashchange)
    if (resolved.captureNavigation) {
      this.restoreFns.push(
        interceptNavigation(emit, this._sessionId)
      );
    }

    // Click tracking (UI interaction breadcrumbs)
    if (resolved.captureClicks) {
      this.restoreFns.push(
        interceptClicks(emit, this._sessionId)
      );
    }

    const features = [
      resolved.captureNetwork && 'fetch',
      resolved.captureXhr && 'xhr',
      resolved.captureConsole && 'console, errors',
      Object.keys(resolved.stores).length > 0 && 'state',
      resolved.capturePerformance && 'performance',
      resolved.captureRenders && 'renders',
      resolved.captureNavigation && 'navigation',
      resolved.captureClicks && 'clicks',
    ].filter(Boolean);
    _log(`[RuntimeScope] Interceptors active — ${features.join(', ')}`);
    if (this._sampleRate < 1) {
      _log(`[RuntimeScope] Sampling at ${(this._sampleRate * 100).toFixed(0)}%`);
    }
    if (this._maxEventsPerSecond !== undefined) {
      _log(`[RuntimeScope] Rate limited to ${this._maxEventsPerSecond} events/sec`);
    }
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

  /** Alias for `connect` — used by script-tag snippets */
  static init(config: RuntimeScopeConfig = {}): void {
    return this.connect(config);
  }

  /**
   * Track a custom business/product event.
   * Use this to mark meaningful moments in your app (e.g. user actions, conversions).
   * These events are correlated with all other telemetry (network, console, state)
   * to build causal chains and detect failures.
   */
  static track(name: string, properties?: Record<string, unknown>): void {
    if (!this.transport || !this._sessionId) return;

    const event: CustomEvent = {
      eventId: generateId(),
      sessionId: this._sessionId,
      timestamp: Date.now(),
      eventType: 'custom',
      name,
      properties,
    };

    this.transport.send(event);
  }

  /**
   * Set user context attached to the current session.
   * Call this after login to associate events with a specific user.
   * Pass null to clear user context.
   */
  static setUser(user: UserContext | null): void {
    this._user = user ?? undefined;

    // Send an updated session event so the collector picks up the user context
    if (this.transport && this._sessionId) {
      this.transport.send({
        eventId: generateId(),
        sessionId: this._sessionId,
        timestamp: Date.now(),
        eventType: 'session',
        appName: 'user_update',
        connectedAt: Date.now(),
        sdkVersion: SDK_VERSION,
        user: this._user,
      });
    }
  }

  /**
   * Add a manual breadcrumb to the event trail.
   * Use this to mark meaningful moments that help debug errors
   * (e.g., "user opened settings", "form validated", "retry attempt 2").
   */
  static addBreadcrumb(
    message: string,
    data?: Record<string, unknown>
  ): void {
    if (!this.transport || !this._sessionId) return;

    const event: UIInteractionEvent = {
      eventId: generateId(),
      sessionId: this._sessionId,
      timestamp: Date.now(),
      eventType: 'ui',
      action: 'breadcrumb',
      target: 'manual',
      text: message,
      ...(data && { data }),
    };

    this.transport.send(event);
  }

  static disconnect(): void {
    // Run all interceptor restore functions
    for (const fn of this.restoreFns) {
      try { fn(); } catch { /* ensure all restores run */ }
    }
    this.restoreFns = [];

    // Safety net: if restore functions didn't fully unwind (e.g. another library
    // patched over us), fall back to true originals saved via Symbol.for()
    const originals = (globalThis as Record<symbol, SavedOriginals>)[ORIGINALS_KEY];
    if (originals) {
      // Only restore if current value is NOT the original (i.e. we or nobody else patched)
      if (window.fetch !== originals.fetch) {
        window.fetch = originals.fetch;
      }
      for (const [level, fn] of Object.entries(originals.consoleMethods)) {
        const c = console as unknown as Record<string, unknown>;
        if (c[level] !== fn) {
          c[level] = fn;
        }
      }
    }

    this.transport?.disconnect();
    this.transport = null;
    this._sessionId = null;
    this._state = 'stopped';
  }
}

export default RuntimeScope;
export { parseDsn, buildDsn } from './dsn.js';
export type { ParsedDsn } from './dsn.js';
export type {
  RuntimeScopeConfig,
  BuildMeta,
  UserContext,
  NetworkEvent,
  ConsoleEvent,
  SessionEvent,
  StateEvent,
  RenderEvent,
  DomSnapshotEvent,
  PerformanceEvent,
  NavigationEvent,
  CustomEvent,
  UIInteractionEvent,
  RuntimeEvent,
} from './types.js';
