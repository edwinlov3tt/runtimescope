import { generateId } from '../utils/id.js';
import type { PerformanceEvent, WebVitalRating, RuntimeEvent } from '../types.js';

type EmitFn = (event: PerformanceEvent) => void;

export interface PerformanceInterceptorOptions {
  beforeSend?: (event: RuntimeEvent) => RuntimeEvent | null;
}

// Web Vitals thresholds from web.dev
const THRESHOLDS: Record<string, [number, number]> = {
  LCP: [2500, 4000],
  FCP: [1800, 3000],
  CLS: [0.1, 0.25],
  TTFB: [800, 1800],
  FID: [100, 300],
  INP: [200, 500],
};

function rate(metric: string, value: number): WebVitalRating {
  const [good, poor] = THRESHOLDS[metric] ?? [Infinity, Infinity];
  if (value <= good) return 'good';
  if (value <= poor) return 'needs-improvement';
  return 'poor';
}

export function interceptPerformance(
  emit: EmitFn,
  sessionId: string,
  options?: PerformanceInterceptorOptions
): () => void {
  const observers: PerformanceObserver[] = [];

  const emitMetric = (
    metricName: PerformanceEvent['metricName'],
    value: number,
    element?: string
  ) => {
    const event: PerformanceEvent = {
      eventId: generateId(),
      sessionId,
      timestamp: Date.now(),
      eventType: 'performance',
      metricName,
      value: Math.round(value * 100) / 100,
      rating: rate(metricName, value),
      element,
    };

    if (options?.beforeSend) {
      const filtered = options.beforeSend(event);
      if (filtered) emit(filtered as PerformanceEvent);
    } else {
      emit(event);
    }
  };

  // LCP — Largest Contentful Paint
  tryObserve(observers, 'largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (!last) return;
    const el = (last as PerformanceEntry & { element?: Element }).element;
    emitMetric('LCP', last.startTime, el?.tagName?.toLowerCase());
  });

  // FCP — First Contentful Paint
  tryObserve(observers, 'paint', (entries) => {
    for (const entry of entries) {
      if (entry.name === 'first-contentful-paint') {
        emitMetric('FCP', entry.startTime);
      }
    }
  });

  // CLS — Cumulative Layout Shift
  let clsValue = 0;
  tryObserve(observers, 'layout-shift', (entries) => {
    for (const entry of entries) {
      const ls = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
      if (!ls.hadRecentInput && ls.value) {
        clsValue += ls.value;
        emitMetric('CLS', clsValue);
      }
    }
  });

  // FID — First Input Delay
  tryObserve(observers, 'first-input', (entries) => {
    const first = entries[0];
    if (!first) return;
    const fi = first as PerformanceEntry & { processingStart?: number };
    if (fi.processingStart) {
      emitMetric('FID', fi.processingStart - first.startTime);
    }
  });

  // TTFB — Time to First Byte
  tryObserve(observers, 'navigation', (entries) => {
    const nav = entries[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      emitMetric('TTFB', nav.responseStart - nav.requestStart);
    }
  });

  // INP — Interaction to Next Paint
  let inpMax = 0;
  tryObserve(
    observers,
    'event',
    (entries) => {
      for (const entry of entries) {
        if (entry.duration > inpMax) {
          inpMax = entry.duration;
          emitMetric('INP', inpMax);
        }
      }
    },
    { durationThreshold: 16 }
  );

  return () => {
    for (const obs of observers) {
      try {
        obs.disconnect();
      } catch {
        // Already disconnected
      }
    }
  };
}

function tryObserve(
  observers: PerformanceObserver[],
  entryType: string,
  callback: (entries: PerformanceEntryList) => void,
  observeOptions?: Record<string, unknown>
): void {
  try {
    const obs = new PerformanceObserver((list) => {
      callback(list.getEntries());
    });
    obs.observe({
      type: entryType,
      buffered: true,
      ...observeOptions,
    } as PerformanceObserverInit);
    observers.push(obs);
  } catch {
    // Observer type not supported in this browser
  }
}
