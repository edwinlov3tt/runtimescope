/**
 * OpenTelemetry exporter — one-way bridge from RuntimeScope events to OTLP/HTTP.
 *
 * Each RuntimeScope event maps to one OTel signal:
 *   - `network`     → trace span (HTTP client, kind=CLIENT)
 *   - `database`    → trace span (DB client, kind=CLIENT)
 *   - `render`      → trace span (kind=INTERNAL, attr `react.component`)
 *   - `console`     → log record. `level=error` is severity=ERROR, with the
 *                     stack trace as an `exception.stacktrace` attribute.
 *   - `performance` → gauge metric (Web Vitals: LCP / FCP / CLS / INP / TTFB).
 *
 * State, session, ui-interaction, dom_snapshot, custom, navigation, and recon
 * events have no clean OTel mapping and are skipped — downstream tools can
 * still see everything via the RuntimeScope HTTP API directly.
 *
 * Session = trace. All events for one `sessionId` share a deterministic 16-byte
 * trace ID derived from `sha256(sessionId)`, so a downstream OTel UI groups
 * them. Span IDs are random per event.
 *
 * Wire format is OTLP/HTTP with JSON encoding — chosen specifically because it
 * needs no Protobuf compiler, no deps, and is supported by every modern
 * collector (otel-collector, Honeycomb refinery, Vector, Datadog, Tempo, etc.).
 *
 * Configuration is opt-in via env vars:
 *   - RUNTIMESCOPE_OTEL_ENDPOINT       — e.g. "http://localhost:4318" (no path)
 *   - RUNTIMESCOPE_OTEL_HEADERS        — "k1=v1,k2=v2" — for bearer tokens etc.
 *   - RUNTIMESCOPE_OTEL_SERVICE_NAME   — defaults to "runtimescope-collector"
 *
 * Failure semantics: best-effort. We batch in memory, flush on a timer or
 * size threshold, and drop on POST failure (logging at most once per failure).
 * If the OTel endpoint is down, RuntimeScope itself is unaffected — that's
 * the whole point of running this as a sidecar exporter.
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  RuntimeEvent,
  NetworkEvent,
  DatabaseEvent,
  ConsoleEvent,
  RenderEvent,
  PerformanceEvent,
} from './types.js';

export interface OtelExporterOptions {
  /** Base URL of the OTel collector — no path. e.g. "http://localhost:4318". */
  endpoint: string;
  /** `service.name` resource attribute. Default "runtimescope-collector". */
  serviceName?: string;
  /** `service.namespace` resource attribute — useful for projectId. */
  serviceNamespace?: string;
  /** Extra HTTP headers (auth tokens, tenant IDs, etc.). */
  headers?: Record<string, string>;
  /** Force flush after this many milliseconds even if the buffer is small. Default 10s. */
  flushIntervalMs?: number;
  /** Force flush once we've accumulated this many signals. Default 1000. */
  maxBatchSize?: number;
}

interface OtlpAttribute {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
  events?: { timeUnixNano: string; name: string; attributes: OtlpAttribute[] }[];
}

interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpAttribute[];
  traceId?: string;
  spanId?: string;
}

interface OtlpMetric {
  name: string;
  unit?: string;
  gauge: {
    dataPoints: {
      asDouble?: number;
      asInt?: string;
      timeUnixNano: string;
      attributes: OtlpAttribute[];
    }[];
  };
}

/** OTel span kind enum. */
const SpanKind = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
} as const;

/** OTel status code enum. */
const StatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export class OtelExporter {
  private spans: OtlpSpan[] = [];
  private logs: OtlpLogRecord[] = [];
  private metrics: OtlpMetric[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private lastFailureLog = 0;
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly serviceNamespace: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly maxBatchSize: number;

  constructor(options: OtelExporterOptions) {
    if (!options.endpoint) throw new Error('OtelExporter requires an endpoint');
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.serviceName = options.serviceName ?? 'runtimescope-collector';
    this.serviceNamespace = options.serviceNamespace;
    this.headers = options.headers ?? {};
    this.maxBatchSize = options.maxBatchSize ?? 1000;

    const interval = options.flushIntervalMs ?? 10_000;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => { /* logged inside flush */ });
    }, interval);
    // Don't keep the process alive solely for flushes — the collector owns
    // its lifecycle, and shutdown calls close() to drain.
    this.flushTimer.unref?.();
  }

  /** Convert a RuntimeScope event to its OTel signal(s) and buffer. */
  ingest(event: RuntimeEvent): void {
    if (this.closed) return;
    switch (event.eventType) {
      case 'network':
        this.spans.push(this.networkToSpan(event as NetworkEvent));
        break;
      case 'database':
        this.spans.push(this.databaseToSpan(event as DatabaseEvent));
        break;
      case 'render':
        this.spans.push(...this.renderToSpans(event as RenderEvent));
        break;
      case 'console':
        this.logs.push(this.consoleToLog(event as ConsoleEvent));
        break;
      case 'performance': {
        const m = this.performanceToMetric(event as PerformanceEvent);
        if (m) this.metrics.push(m);
        break;
      }
      default:
        // Other event types (state, session, ui-interaction, dom-snapshot) don't
        // map cleanly onto OTel signals. Skip rather than guess.
        break;
    }
    if (this.spans.length + this.logs.length + this.metrics.length >= this.maxBatchSize) {
      void this.flush().catch(() => { /* swallowed inside */ });
    }
  }

  /** POST any buffered signals to the OTLP endpoint. */
  async flush(): Promise<void> {
    if (this.closed) return;
    const spans = this.spans;
    const logs = this.logs;
    const metrics = this.metrics;
    this.spans = [];
    this.logs = [];
    this.metrics = [];

    const tasks: Promise<void>[] = [];
    if (spans.length) tasks.push(this.send('/v1/traces', { resourceSpans: this.wrapSpans(spans) }));
    if (logs.length) tasks.push(this.send('/v1/logs', { resourceLogs: this.wrapLogs(logs) }));
    if (metrics.length) tasks.push(this.send('/v1/metrics', { resourceMetrics: this.wrapMetrics(metrics) }));
    await Promise.all(tasks);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // ------------------------------------------------------------------------
  // Event-to-signal converters
  // ------------------------------------------------------------------------

  private networkToSpan(e: NetworkEvent): OtlpSpan {
    const start = (e.timestamp - (e.duration ?? 0)) * 1_000_000;
    const end = e.timestamp * 1_000_000;
    const isError = e.status >= 400 || e.status === 0;
    return {
      traceId: traceIdFromSession(e.sessionId),
      spanId: randomSpanId(),
      name: `${e.method} ${stripQuery(e.url)}`,
      kind: SpanKind.CLIENT,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(end),
      attributes: [
        attrStr('http.request.method', e.method),
        attrStr('url.full', e.url),
        attrInt('http.response.status_code', e.status),
        attrInt('http.request.body.size', e.requestBodySize ?? 0),
        attrInt('http.response.body.size', e.responseBodySize ?? 0),
        attrStr('runtimescope.session_id', e.sessionId),
      ],
      status: {
        code: isError ? StatusCode.ERROR : StatusCode.OK,
        message: isError ? `HTTP ${e.status}` : undefined,
      },
    };
  }

  private databaseToSpan(e: DatabaseEvent): OtlpSpan {
    const start = (e.timestamp - (e.duration ?? 0)) * 1_000_000;
    const end = e.timestamp * 1_000_000;
    const primaryTable = e.tablesAccessed?.[0] ?? '';
    return {
      traceId: traceIdFromSession(e.sessionId),
      spanId: randomSpanId(),
      name: `${(e.operation ?? 'query').toUpperCase()} ${primaryTable}`.trim(),
      kind: SpanKind.CLIENT,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(end),
      attributes: [
        attrStr('db.system', e.source ?? 'unknown'),
        attrStr('db.operation', e.operation ?? ''),
        attrStr('db.statement', e.query ?? ''),
        attrStr('db.sql.table', primaryTable),
        attrInt('db.response.returned_rows', e.rowsReturned ?? 0),
        attrStr('runtimescope.session_id', e.sessionId),
      ],
      status: { code: e.error ? StatusCode.ERROR : StatusCode.OK, message: e.error },
    };
  }

  /**
   * Render events bundle multiple component profiles in one event. We emit
   * one span per profile so the OTel UI can show each component's render
   * timing independently — sharing the same trace via the sessionId.
   */
  private renderToSpans(e: RenderEvent): OtlpSpan[] {
    const traceId = traceIdFromSession(e.sessionId);
    const profiles = e.profiles ?? [];
    const out: OtlpSpan[] = [];
    for (const p of profiles) {
      const dur = p.totalDuration ?? 0;
      const end = e.timestamp * 1_000_000;
      const start = end - Math.round(dur * 1_000_000);
      out.push({
        traceId,
        spanId: randomSpanId(),
        name: `render ${p.componentName}`,
        kind: SpanKind.INTERNAL,
        startTimeUnixNano: String(start),
        endTimeUnixNano: String(end),
        attributes: [
          attrStr('react.component', p.componentName),
          attrStr('react.phase', p.lastRenderPhase ?? ''),
          attrInt('react.render_count', p.renderCount ?? 0),
          attrStr('react.last_render_cause', p.lastRenderCause ?? ''),
          attrStr('runtimescope.session_id', e.sessionId),
        ],
        status: { code: p.suspicious ? StatusCode.ERROR : StatusCode.UNSET },
      });
    }
    return out;
  }

  /**
   * `console` events with `level: 'error'` carry stack traces; we surface them
   * via OTel's exception attributes so log-search backends can show them
   * inline. Lower-severity console events become plain log records.
   */
  private consoleToLog(e: ConsoleEvent): OtlpLogRecord {
    const attrs: OtlpAttribute[] = [attrStr('runtimescope.session_id', e.sessionId)];
    if (e.source) attrs.push(attrStr('runtimescope.source', e.source));
    if (e.level === 'error' && e.stackTrace) {
      attrs.push(attrStr('exception.message', e.message ?? ''));
      attrs.push(attrStr('exception.stacktrace', e.stackTrace));
    }
    return {
      timeUnixNano: String(e.timestamp * 1_000_000),
      severityNumber: severityFromConsole(e.level),
      severityText: e.level,
      body: { stringValue: e.message ?? '' },
      attributes: attrs,
      traceId: traceIdFromSession(e.sessionId),
    };
  }

  private performanceToMetric(e: PerformanceEvent): OtlpMetric | null {
    if (!e.metricName || typeof e.value !== 'number') return null;
    // Web Vitals (CLS / LCP / FCP / INP / FID / TTFB) are browser-side; the
    // rest are Node server metrics. Use distinct namespaces so dashboards
    // don't accidentally aggregate "memory.rss" into the same panel as LCP.
    const isWebVital = WEB_VITALS.has(e.metricName);
    const name = isWebVital
      ? `runtimescope.web_vitals.${e.metricName.toLowerCase()}`
      : `runtimescope.server.${e.metricName.toLowerCase()}`;
    return {
      name,
      unit: e.unit ?? webVitalUnit(e.metricName),
      gauge: {
        dataPoints: [
          {
            asDouble: e.value,
            timeUnixNano: String(e.timestamp * 1_000_000),
            attributes: [
              attrStr('rating', e.rating ?? 'unknown'),
              attrStr('runtimescope.session_id', e.sessionId),
            ],
          },
        ],
      },
    };
  }

  // ------------------------------------------------------------------------
  // OTLP envelope wrapping + transport
  // ------------------------------------------------------------------------

  private resourceAttributes(): OtlpAttribute[] {
    const attrs: OtlpAttribute[] = [
      attrStr('service.name', this.serviceName),
      attrStr('telemetry.sdk.name', 'runtimescope'),
      attrStr('telemetry.sdk.language', 'nodejs'),
    ];
    if (this.serviceNamespace) attrs.push(attrStr('service.namespace', this.serviceNamespace));
    return attrs;
  }

  private wrapSpans(spans: OtlpSpan[]) {
    return [
      {
        resource: { attributes: this.resourceAttributes() },
        scopeSpans: [{ scope: { name: 'runtimescope' }, spans }],
      },
    ];
  }

  private wrapLogs(logs: OtlpLogRecord[]) {
    return [
      {
        resource: { attributes: this.resourceAttributes() },
        scopeLogs: [{ scope: { name: 'runtimescope' }, logRecords: logs }],
      },
    ];
  }

  private wrapMetrics(metrics: OtlpMetric[]) {
    return [
      {
        resource: { attributes: this.resourceAttributes() },
        scopeMetrics: [{ scope: { name: 'runtimescope' }, metrics }],
      },
    ];
  }

  private async send(path: string, body: unknown): Promise<void> {
    try {
      const res = await fetch(this.endpoint + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.logFailure(`OTel POST ${path} → ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      this.logFailure(`OTel POST ${path} failed: ${(err as Error).message}`);
    }
  }

  /** Rate-limit failure logs to once every 60s — don't spam stderr. */
  private logFailure(msg: string): void {
    const now = Date.now();
    if (now - this.lastFailureLog < 60_000) return;
    this.lastFailureLog = now;
    console.error(`[RuntimeScope] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a deterministic 16-byte trace ID from the sessionId so every event
 * for one session belongs to the same trace in the downstream UI.
 */
export function traceIdFromSession(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

export function randomSpanId(): string {
  return randomBytes(8).toString('hex');
}

function attrStr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function attrInt(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function severityFromConsole(level: string): number {
  // OTel SeverityNumber: TRACE=1, DEBUG=5, INFO=9, WARN=13, ERROR=17, FATAL=21.
  switch (level) {
    case 'debug': return 5;
    case 'log':
    case 'info': return 9;
    case 'warn': return 13;
    case 'error': return 17;
    default: return 9;
  }
}

/** The Web Vital metric names browser SDKs emit. Server metrics route to a different namespace. */
const WEB_VITALS = new Set(['LCP', 'FCP', 'CLS', 'TTFB', 'FID', 'INP']);

function webVitalUnit(name: string): string {
  // CLS is unitless ratio; the rest are milliseconds.
  return name.toUpperCase() === 'CLS' ? '1' : 'ms';
}

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) : url;
}

/** Parse `RUNTIMESCOPE_OTEL_HEADERS="k1=v1,k2=v2"` into a header map. */
export function parseOtelHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Build options from environment variables. Returns null if OTel is not configured. */
export function otelOptionsFromEnv(): OtelExporterOptions | null {
  const endpoint = process.env.RUNTIMESCOPE_OTEL_ENDPOINT;
  if (!endpoint) return null;
  return {
    endpoint,
    serviceName: process.env.RUNTIMESCOPE_OTEL_SERVICE_NAME,
    headers: parseOtelHeaders(process.env.RUNTIMESCOPE_OTEL_HEADERS),
  };
}
