import type {
  RuntimeEvent,
  NetworkEvent,
  ConsoleEvent,
  RenderEvent,
  StateEvent,
  PerformanceEvent,
  DatabaseEvent,
  DetectedIssue,
} from './types.js';

/**
 * Runs all pattern detectors against a set of events and returns
 * prioritized issues sorted by severity (high → medium → low).
 */
export function detectIssues(events: RuntimeEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const networkEvents = events.filter((e) => e.eventType === 'network') as NetworkEvent[];
  const consoleEvents = events.filter((e) => e.eventType === 'console') as ConsoleEvent[];
  const renderEvents = events.filter((e) => e.eventType === 'render') as RenderEvent[];
  const stateEvents = events.filter((e) => e.eventType === 'state') as StateEvent[];
  const perfEvents = events.filter((e) => e.eventType === 'performance') as PerformanceEvent[];
  const dbEvents = events.filter((e) => e.eventType === 'database') as DatabaseEvent[];

  issues.push(...detectFailedRequests(networkEvents));
  issues.push(...detectSlowRequests(networkEvents));
  issues.push(...detectN1Requests(networkEvents));
  issues.push(...detectConsoleErrorSpam(consoleEvents));
  issues.push(...detectHighErrorRate(consoleEvents));
  issues.push(...detectExcessiveRerenders(renderEvents));
  issues.push(...detectLargeStateUpdates(stateEvents));
  issues.push(...detectPoorWebVitals(perfEvents));
  issues.push(...detectSlowDbQueries(dbEvents));
  issues.push(...detectN1DbQueries(dbEvents));

  // Sort: high first, then medium, then low
  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return issues;
}

/** HTTP 4xx/5xx responses */
function detectFailedRequests(events: NetworkEvent[]): DetectedIssue[] {
  const failed = events.filter((e) => e.status >= 400);
  if (failed.length === 0) return [];

  const grouped = new Map<string, NetworkEvent[]>();
  for (const e of failed) {
    const key = `${e.status} ${e.method} ${e.url}`;
    const arr = grouped.get(key) ?? [];
    arr.push(e);
    grouped.set(key, arr);
  }

  return Array.from(grouped.entries()).map(([key, evts]) => ({
    id: `failed-request-${key}`,
    pattern: 'failed_requests',
    severity: evts[0].status >= 500 ? 'high' as const : 'medium' as const,
    title: `Failed request: ${key}`,
    description: `${evts.length} request(s) returned ${evts[0].status}`,
    evidence: evts.slice(0, 3).map(
      (e) => `${e.method} ${e.url} → ${e.status} (${e.duration.toFixed(0)}ms) at ${new Date(e.timestamp).toISOString()}`
    ),
    suggestion: evts[0].status >= 500
      ? 'Server error — check backend logs for this endpoint'
      : 'Client error — verify the request URL, auth headers, and payload',
  }));
}

/** Requests taking >3 seconds */
function detectSlowRequests(events: NetworkEvent[]): DetectedIssue[] {
  const slow = events.filter((e) => e.duration > 3000);
  if (slow.length === 0) return [];

  return [{
    id: 'slow-requests',
    pattern: 'slow_requests',
    severity: 'medium',
    title: `${slow.length} slow network request(s) (>3s)`,
    description: `Slowest: ${slow.sort((a, b) => b.duration - a.duration)[0].url} at ${(slow[0].duration / 1000).toFixed(1)}s`,
    evidence: slow.slice(0, 5).map(
      (e) => `${e.method} ${e.url} → ${(e.duration / 1000).toFixed(1)}s (status ${e.status})`
    ),
    suggestion: 'Consider adding loading states, pagination, or caching for these endpoints',
  }];
}

/** Same endpoint called >5 times within 2 seconds */
function detectN1Requests(events: NetworkEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  // Group by method + URL
  const grouped = new Map<string, NetworkEvent[]>();
  for (const e of events) {
    const key = `${e.method} ${e.url}`;
    const arr = grouped.get(key) ?? [];
    arr.push(e);
    grouped.set(key, arr);
  }

  for (const [key, evts] of grouped) {
    if (evts.length <= 5) continue;

    // Check if they cluster within 2-second windows
    const sorted = evts.sort((a, b) => a.timestamp - b.timestamp);
    let windowStart = sorted[0].timestamp;
    let windowCount = 1;

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].timestamp - windowStart <= 2000) {
        windowCount++;
      } else {
        windowStart = sorted[i].timestamp;
        windowCount = 1;
      }

      if (windowCount > 5) {
        issues.push({
          id: `n1-${key}`,
          pattern: 'n1_requests',
          severity: 'medium',
          title: `Possible N+1: ${key}`,
          description: `Called ${evts.length} times total, with ${windowCount}+ in a 2s window. This often happens when each list item fetches its own data.`,
          evidence: [
            `Total calls: ${evts.length}`,
            `Time span: ${((sorted[sorted.length - 1].timestamp - sorted[0].timestamp) / 1000).toFixed(1)}s`,
            `First call: ${new Date(sorted[0].timestamp).toISOString()}`,
          ],
          suggestion: 'Lift the data fetch to the parent component, use a batch endpoint, or add a shared cache (e.g. React Query with a shared cache key)',
        });
        break;
      }
    }
  }

  return issues;
}

/** Same error message repeated >5 times in 10 seconds */
function detectConsoleErrorSpam(events: ConsoleEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const errors = events.filter((e) => e.level === 'error');

  const grouped = new Map<string, ConsoleEvent[]>();
  for (const e of errors) {
    // Normalize message to group similar errors
    const key = e.message.slice(0, 200);
    const arr = grouped.get(key) ?? [];
    arr.push(e);
    grouped.set(key, arr);
  }

  for (const [msg, evts] of grouped) {
    if (evts.length <= 5) continue;

    const sorted = evts.sort((a, b) => a.timestamp - b.timestamp);
    const span = sorted[sorted.length - 1].timestamp - sorted[0].timestamp;

    if (span <= 10_000) {
      const truncated = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
      issues.push({
        id: `error-spam-${msg.slice(0, 50)}`,
        pattern: 'console_error_spam',
        severity: 'medium',
        title: `Error spam: "${truncated}"`,
        description: `Repeated ${evts.length} times in ${(span / 1000).toFixed(1)}s. This usually indicates a re-render loop or a recurring failed operation.`,
        evidence: [
          `Count: ${evts.length}`,
          `Time span: ${(span / 1000).toFixed(1)}s`,
          ...(evts[0].stackTrace ? [`Stack: ${evts[0].stackTrace.split('\n')[0]}`] : []),
        ],
        suggestion: 'Check for re-render loops, retry loops without backoff, or error boundaries that keep re-mounting',
      });
    }
  }

  return issues;
}

/** High overall error rate */
function detectHighErrorRate(events: ConsoleEvent[]): DetectedIssue[] {
  if (events.length < 10) return [];

  const errors = events.filter((e) => e.level === 'error');
  const errorRate = errors.length / events.length;

  if (errorRate > 0.3) {
    return [{
      id: 'high-error-rate',
      pattern: 'high_error_rate',
      severity: 'high',
      title: `High console error rate: ${(errorRate * 100).toFixed(0)}%`,
      description: `${errors.length} of ${events.length} console messages are errors. This suggests a systemic issue.`,
      evidence: [
        `Error count: ${errors.length}`,
        `Total console messages: ${events.length}`,
        `Error rate: ${(errorRate * 100).toFixed(0)}%`,
      ],
      suggestion: 'Check for unhandled promise rejections, missing error boundaries, or misconfigured API endpoints',
    }];
  }

  return [];
}

/** Components re-rendering excessively (velocity > 4/sec) */
function detectExcessiveRerenders(events: RenderEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    for (const profile of event.profiles) {
      if (profile.suspicious && !seen.has(profile.componentName)) {
        seen.add(profile.componentName);
        issues.push({
          id: `excessive-rerenders-${profile.componentName}`,
          pattern: 'excessive_rerenders',
          severity: 'medium',
          title: `Excessive re-renders: <${profile.componentName}>`,
          description: `Rendering at ${profile.renderVelocity.toFixed(1)}/sec (${profile.renderCount} renders in snapshot). Last cause: ${profile.lastRenderCause}.`,
          evidence: [
            `Render velocity: ${profile.renderVelocity.toFixed(1)}/sec`,
            `Render count: ${profile.renderCount}`,
            `Avg duration: ${profile.avgDuration.toFixed(1)}ms`,
            `Last cause: ${profile.lastRenderCause}`,
          ],
          suggestion: profile.lastRenderCause === 'parent'
            ? `Wrap <${profile.componentName}> with React.memo() to prevent unnecessary re-renders from parent`
            : profile.lastRenderCause === 'props'
              ? `Check if props passed to <${profile.componentName}> are stable (useMemo/useCallback for object/function props)`
              : `Audit state updates in <${profile.componentName}> — consider batching or debouncing`,
        });
      }
    }
  }

  return issues;
}

/** State snapshots exceeding 100KB */
function detectLargeStateUpdates(events: StateEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (event.phase !== 'update') continue;
    const stateStr = JSON.stringify(event.state);
    const sizeKB = Math.round(stateStr.length / 1024);

    if (sizeKB > 100 && !seen.has(event.storeId)) {
      seen.add(event.storeId);
      issues.push({
        id: `large-state-${event.storeId}`,
        pattern: 'large_state_update',
        severity: 'medium',
        title: `Large state update: ${event.storeId} (${sizeKB}KB)`,
        description: `Store "${event.storeId}" (${event.library}) has a state snapshot of ${sizeKB}KB. Large state can cause slow serialization and re-renders.`,
        evidence: [
          `Store: ${event.storeId}`,
          `Library: ${event.library}`,
          `State size: ${sizeKB}KB`,
          ...(event.diff ? [`Changed keys: ${Object.keys(event.diff).join(', ')}`] : []),
        ],
        suggestion: 'Consider normalizing or splitting the store, and use selectors to subscribe to specific slices',
      });
    }
  }

  return issues;
}

/** Database queries taking >500ms */
function detectSlowDbQueries(events: DatabaseEvent[]): DetectedIssue[] {
  const slow = events.filter((e) => e.duration > 500);
  if (slow.length === 0) return [];

  const sorted = slow.sort((a, b) => b.duration - a.duration);
  return [{
    id: 'slow-db-queries',
    pattern: 'slow_db_queries',
    severity: 'medium',
    title: `${slow.length} slow database quer${slow.length === 1 ? 'y' : 'ies'} (>500ms)`,
    description: `Slowest: ${sorted[0].query.slice(0, 100)} at ${sorted[0].duration.toFixed(0)}ms`,
    evidence: sorted.slice(0, 5).map(
      (e) => `${e.operation} on ${e.tablesAccessed.join(', ') || '?'} → ${e.duration.toFixed(0)}ms (${e.source})`
    ),
    suggestion: 'Add indexes on columns used in WHERE/ORDER BY clauses, or reduce result set size with LIMIT',
  }];
}

/** Same table queried >5 times within 2 seconds (N+1 pattern) */
function detectN1DbQueries(events: DatabaseEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  // Group SELECT queries by primary table
  const grouped = new Map<string, DatabaseEvent[]>();
  for (const e of events) {
    if (e.operation !== 'SELECT') continue;
    const table = e.tablesAccessed[0];
    if (!table) continue;
    const arr = grouped.get(table) ?? [];
    arr.push(e);
    grouped.set(table, arr);
  }

  for (const [table, evts] of grouped) {
    if (evts.length <= 5) continue;

    const sorted = evts.sort((a, b) => a.timestamp - b.timestamp);
    let windowStart = sorted[0].timestamp;
    let windowCount = 1;

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].timestamp - windowStart <= 2000) {
        windowCount++;
      } else {
        windowStart = sorted[i].timestamp;
        windowCount = 1;
      }

      if (windowCount > 5) {
        issues.push({
          id: `n1-db-${table}`,
          pattern: 'n1_db_queries',
          severity: 'high',
          title: `Possible N+1 DB queries on "${table}"`,
          description: `${evts.length} SELECT queries on "${table}" total, with ${windowCount}+ in a 2s window. This is a classic N+1 pattern.`,
          evidence: [
            `Table: ${table}`,
            `Total SELECTs: ${evts.length}`,
            `Peak burst: ${windowCount}+ in 2s`,
            `Sources: ${[...new Set(evts.map((e) => e.source))].join(', ')}`,
          ],
          suggestion: 'Use a JOIN, subquery, or batch fetch (e.g. WHERE id IN (...)) instead of querying per item',
        });
        break;
      }
    }
  }

  return issues;
}

/** Web Vitals rated as "poor" */
function detectPoorWebVitals(events: PerformanceEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (event.rating !== 'poor' || seen.has(event.metricName)) continue;
    seen.add(event.metricName);

    const isHighSeverity = event.metricName === 'LCP' || event.metricName === 'CLS';

    const suggestions: Record<string, string> = {
      LCP: 'Optimize largest image/text block — preload hero images, use next-gen formats, reduce server response time',
      FCP: 'Reduce render-blocking resources — inline critical CSS, defer non-essential JS',
      CLS: 'Set explicit dimensions on images/videos, avoid injecting content above the fold',
      TTFB: 'Improve server response time — add CDN, optimize database queries, enable caching',
      FID: 'Break up long tasks — use requestIdleCallback, code-split heavy modules',
      INP: 'Optimize event handlers — avoid synchronous layouts, defer non-critical work',
    };

    issues.push({
      id: `poor-vital-${event.metricName}`,
      pattern: 'poor_web_vital',
      severity: isHighSeverity ? 'high' : 'medium',
      title: `Poor ${event.metricName}: ${event.value}${event.metricName === 'CLS' ? '' : 'ms'}`,
      description: `${event.metricName} is rated "poor" (value: ${event.value}). This directly impacts user experience and SEO.`,
      evidence: [
        `Metric: ${event.metricName}`,
        `Value: ${event.value}${event.metricName === 'CLS' ? '' : 'ms'}`,
        `Rating: ${event.rating}`,
        ...(event.element ? [`Element: ${event.element}`] : []),
      ],
      suggestion: suggestions[event.metricName] ?? 'Review performance best practices at web.dev',
    });
  }

  return issues;
}
