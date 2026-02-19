/**
 * Browser port of packages/collector/src/issue-detector.ts
 * Pure function: events → DetectedIssue[]
 */
import type {
  NetworkEvent,
  ConsoleEvent,
  RenderEvent,
  StateEvent,
  PerformanceEvent,
  DatabaseEvent,
  DetectedIssue,
} from '@/mock/types';

type RuntimeEvent = NetworkEvent | ConsoleEvent | RenderEvent | StateEvent | PerformanceEvent | DatabaseEvent;

export function detectIssues(events: RuntimeEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const network = events.filter((e) => e.eventType === 'network') as NetworkEvent[];
  const console_ = events.filter((e) => e.eventType === 'console') as ConsoleEvent[];
  const renders = events.filter((e) => e.eventType === 'render') as RenderEvent[];
  const state = events.filter((e) => e.eventType === 'state') as StateEvent[];
  const perf = events.filter((e) => e.eventType === 'performance') as PerformanceEvent[];
  const db = events.filter((e) => e.eventType === 'database') as DatabaseEvent[];

  issues.push(...detectFailedRequests(network));
  issues.push(...detectSlowRequests(network));
  issues.push(...detectN1Requests(network));
  issues.push(...detectConsoleErrorSpam(console_));
  issues.push(...detectHighErrorRate(console_));
  issues.push(...detectExcessiveRerenders(renders));
  issues.push(...detectLargeStateUpdates(state));
  issues.push(...detectPoorWebVitals(perf));
  issues.push(...detectSlowDbQueries(db));
  issues.push(...detectN1DbQueries(db));

  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return issues;
}

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
      (e) => `${e.method} ${e.url} → ${e.status} (${e.duration.toFixed(0)}ms)`
    ),
    suggestion: evts[0].status >= 500
      ? 'Server error — check backend logs for this endpoint'
      : 'Client error — verify the request URL, auth headers, and payload',
  }));
}

function detectSlowRequests(events: NetworkEvent[]): DetectedIssue[] {
  const slow = events.filter((e) => e.duration > 3000);
  if (slow.length === 0) return [];
  return [{
    id: 'slow-requests',
    pattern: 'slow_requests',
    severity: 'medium',
    title: `${slow.length} slow network request(s) (>3s)`,
    description: `Slowest: ${slow.sort((a, b) => b.duration - a.duration)[0].url}`,
    evidence: slow.slice(0, 5).map(
      (e) => `${e.method} ${e.url} → ${(e.duration / 1000).toFixed(1)}s`
    ),
    suggestion: 'Consider adding loading states, pagination, or caching',
  }];
}

function detectN1Requests(events: NetworkEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const grouped = new Map<string, NetworkEvent[]>();
  for (const e of events) {
    const key = `${e.method} ${e.url}`;
    const arr = grouped.get(key) ?? [];
    arr.push(e);
    grouped.set(key, arr);
  }
  for (const [key, evts] of grouped) {
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
          id: `n1-${key}`,
          pattern: 'n1_requests',
          severity: 'medium',
          title: `Possible N+1: ${key}`,
          description: `Called ${evts.length} times, ${windowCount}+ in a 2s window`,
          evidence: [`Total calls: ${evts.length}`],
          suggestion: 'Lift the data fetch to the parent component or use a batch endpoint',
        });
        break;
      }
    }
  }
  return issues;
}

function detectConsoleErrorSpam(events: ConsoleEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const errors = events.filter((e) => e.level === 'error');
  const grouped = new Map<string, ConsoleEvent[]>();
  for (const e of errors) {
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
        description: `Repeated ${evts.length} times in ${(span / 1000).toFixed(1)}s`,
        evidence: [`Count: ${evts.length}`, `Span: ${(span / 1000).toFixed(1)}s`],
        suggestion: 'Check for re-render loops or retry loops without backoff',
      });
    }
  }
  return issues;
}

function detectHighErrorRate(events: ConsoleEvent[]): DetectedIssue[] {
  if (events.length < 10) return [];
  const errors = events.filter((e) => e.level === 'error');
  const rate = errors.length / events.length;
  if (rate > 0.3) {
    return [{
      id: 'high-error-rate',
      pattern: 'high_error_rate',
      severity: 'high',
      title: `High console error rate: ${(rate * 100).toFixed(0)}%`,
      description: `${errors.length} of ${events.length} console messages are errors`,
      evidence: [`Error rate: ${(rate * 100).toFixed(0)}%`],
      suggestion: 'Check for unhandled promise rejections or misconfigured API endpoints',
    }];
  }
  return [];
}

function detectExcessiveRerenders(events: RenderEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    for (const p of event.profiles) {
      if (p.suspicious && !seen.has(p.componentName)) {
        seen.add(p.componentName);
        issues.push({
          id: `excessive-rerenders-${p.componentName}`,
          pattern: 'excessive_rerenders',
          severity: 'medium',
          title: `Excessive re-renders: <${p.componentName}>`,
          description: `${p.renderVelocity.toFixed(1)}/sec (${p.renderCount} renders)`,
          evidence: [`Velocity: ${p.renderVelocity.toFixed(1)}/sec`, `Avg: ${p.avgDuration.toFixed(1)}ms`],
          suggestion: `Consider React.memo() or stable props for <${p.componentName}>`,
        });
      }
    }
  }
  return issues;
}

function detectLargeStateUpdates(events: StateEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.phase !== 'update') continue;
    const sizeKB = Math.round(JSON.stringify(event.state).length / 1024);
    if (sizeKB > 100 && !seen.has(event.storeId)) {
      seen.add(event.storeId);
      issues.push({
        id: `large-state-${event.storeId}`,
        pattern: 'large_state_update',
        severity: 'medium',
        title: `Large state update: ${event.storeId} (${sizeKB}KB)`,
        description: `Store "${event.storeId}" snapshot is ${sizeKB}KB`,
        evidence: [`Size: ${sizeKB}KB`],
        suggestion: 'Consider normalizing or splitting the store',
      });
    }
  }
  return issues;
}

function detectPoorWebVitals(events: PerformanceEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.rating !== 'poor' || seen.has(event.metricName)) continue;
    seen.add(event.metricName);
    const isHigh = event.metricName === 'LCP' || event.metricName === 'CLS';
    issues.push({
      id: `poor-vital-${event.metricName}`,
      pattern: 'poor_web_vital',
      severity: isHigh ? 'high' : 'medium',
      title: `Poor ${event.metricName}: ${event.value}${event.metricName === 'CLS' ? '' : 'ms'}`,
      description: `${event.metricName} is rated "poor"`,
      evidence: [`Value: ${event.value}`, `Rating: ${event.rating}`],
      suggestion: 'Review performance best practices at web.dev',
    });
  }
  return issues;
}

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
      (e) => `${e.operation} on ${e.tablesAccessed.join(', ') || '?'} → ${e.duration.toFixed(0)}ms`
    ),
    suggestion: 'Add indexes on columns in WHERE/ORDER BY clauses',
  }];
}

function detectN1DbQueries(events: DatabaseEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
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
          description: `${evts.length} SELECTs on "${table}", ${windowCount}+ in a 2s window`,
          evidence: [`Table: ${table}`, `Total: ${evts.length}`],
          suggestion: 'Use a JOIN, subquery, or WHERE id IN (...) instead',
        });
        break;
      }
    }
  }
  return issues;
}
