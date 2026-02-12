import type {
  DatabaseEvent,
  NormalizedQueryStats,
  DetectedIssue,
  IndexSuggestion,
} from '../types.js';

// ============================================================
// Query Monitor Engine
// Analyzes captured database queries for performance patterns
// ============================================================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * (p / 100)) - 1;
  return sorted[Math.max(0, idx)];
}

export function aggregateQueryStats(events: DatabaseEvent[]): NormalizedQueryStats[] {
  const groups = new Map<string, DatabaseEvent[]>();
  for (const e of events) {
    const key = e.normalizedQuery;
    const group = groups.get(key) ?? [];
    group.push(e);
    groups.set(key, group);
  }

  const stats: NormalizedQueryStats[] = [];
  for (const [normalizedQuery, groupEvents] of groups) {
    const durations = groupEvents.map((e) => e.duration).sort((a, b) => a - b);
    const totalDuration = durations.reduce((s, d) => s + d, 0);
    const tables = new Set<string>();
    for (const e of groupEvents) {
      for (const t of e.tablesAccessed) tables.add(t);
    }

    const rowCounts = groupEvents
      .filter((e) => e.rowsReturned !== undefined)
      .map((e) => e.rowsReturned!);

    stats.push({
      normalizedQuery,
      tables: [...tables],
      operation: groupEvents[0].operation,
      callCount: groupEvents.length,
      avgDuration: totalDuration / groupEvents.length,
      maxDuration: Math.max(...durations),
      p95Duration: percentile(durations, 95),
      totalDuration,
      avgRowsReturned: rowCounts.length > 0
        ? rowCounts.reduce((s, r) => s + r, 0) / rowCounts.length
        : 0,
    });
  }

  return stats.sort((a, b) => b.totalDuration - a.totalDuration);
}

export function detectN1Queries(events: DatabaseEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  // Group by table and look for rapid-fire same-table queries within 2s windows
  const tableWindows = new Map<string, { timestamps: number[]; queries: string[] }>();

  for (const e of events) {
    if (e.operation !== 'SELECT') continue;
    for (const table of e.tablesAccessed) {
      const entry = tableWindows.get(table) ?? { timestamps: [], queries: [] };
      entry.timestamps.push(e.timestamp);
      entry.queries.push(e.query);
      tableWindows.set(table, entry);
    }
  }

  for (const [table, data] of tableWindows) {
    // Sort by timestamp and find windows with >5 queries in 2s
    const sorted = data.timestamps.sort((a, b) => a - b);
    let windowStart = 0;

    for (let i = 0; i < sorted.length; i++) {
      while (sorted[i] - sorted[windowStart] > 2000) windowStart++;
      const windowSize = i - windowStart + 1;

      if (windowSize > 5) {
        issues.push({
          id: `n1-${table}-${sorted[windowStart]}`,
          pattern: 'n1_db_query',
          severity: 'high',
          title: `N+1 Query Pattern: ${table}`,
          description: `${windowSize} SELECT queries on table "${table}" within 2 seconds. This is a classic N+1 query pattern.`,
          evidence: [
            `${windowSize} queries in ${((sorted[i] - sorted[windowStart]) / 1000).toFixed(1)}s`,
            `Sample: ${data.queries[windowStart]?.slice(0, 100)}`,
          ],
          suggestion: `Use a JOIN or batch query (e.g., WHERE id IN (...)) instead of querying "${table}" in a loop.`,
        });
        // Skip ahead to avoid duplicate detections for overlapping windows
        windowStart = i + 1;
      }
    }
  }

  return issues;
}

export function detectSlowQueries(events: DatabaseEvent[], thresholdMs = 500): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const seen = new Set<string>();

  for (const e of events) {
    if (e.duration >= thresholdMs && !seen.has(e.normalizedQuery)) {
      seen.add(e.normalizedQuery);
      issues.push({
        id: `slow-query-${e.eventId}`,
        pattern: 'slow_db_query',
        severity: e.duration > 2000 ? 'high' : 'medium',
        title: `Slow Query: ${e.duration.toFixed(0)}ms`,
        description: `Query took ${e.duration.toFixed(0)}ms (threshold: ${thresholdMs}ms). Tables: ${e.tablesAccessed.join(', ') || 'unknown'}.`,
        evidence: [
          `Duration: ${e.duration.toFixed(0)}ms`,
          `Query: ${e.query.slice(0, 150)}`,
          e.rowsReturned !== undefined ? `Rows returned: ${e.rowsReturned}` : '',
        ].filter(Boolean),
        suggestion: 'Consider adding indexes, reducing the result set, or optimizing the query.',
      });
    }
  }

  return issues;
}

export function suggestIndexes(events: DatabaseEvent[]): IndexSuggestion[] {
  const suggestions: IndexSuggestion[] = [];
  const seen = new Set<string>();

  // Parse WHERE and ORDER BY columns from slow queries
  const WHERE_COL_RE = /WHERE\s+.*?["'`]?(\w+)["'`]?\s*(=|>|<|>=|<=|!=|LIKE|IN|IS)\s/gi;
  const ORDER_COL_RE = /ORDER\s+BY\s+["'`]?(\w+)["'`]?/gi;

  for (const e of events) {
    if (e.duration < 100) continue; // Only suggest for queries taking >100ms

    for (const table of e.tablesAccessed) {
      const columns: string[] = [];

      // Extract WHERE columns
      let match: RegExpExecArray | null;
      const whereRe = new RegExp(WHERE_COL_RE.source, WHERE_COL_RE.flags);
      while ((match = whereRe.exec(e.query)) !== null) {
        columns.push(match[1]);
      }

      // Extract ORDER BY columns
      const orderRe = new RegExp(ORDER_COL_RE.source, ORDER_COL_RE.flags);
      while ((match = orderRe.exec(e.query)) !== null) {
        columns.push(match[1]);
      }

      if (columns.length === 0) continue;

      const key = `${table}:${columns.sort().join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);

      suggestions.push({
        table,
        columns,
        reason: `Query taking ${e.duration.toFixed(0)}ms uses these columns in WHERE/ORDER BY`,
        estimatedImpact: e.duration > 1000 ? 'high' : e.duration > 300 ? 'medium' : 'low',
        queryPattern: e.normalizedQuery.slice(0, 150),
      });
    }
  }

  return suggestions;
}

export function detectOverfetching(events: DatabaseEvent[]): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const seen = new Set<string>();

  for (const e of events) {
    if (e.operation !== 'SELECT') continue;
    if (e.query.match(/SELECT\s+\*/i) && e.rowsReturned !== undefined && e.rowsReturned > 100) {
      const key = e.normalizedQuery;
      if (seen.has(key)) continue;
      seen.add(key);

      issues.push({
        id: `overfetch-${e.eventId}`,
        pattern: 'overfetching',
        severity: e.rowsReturned > 1000 ? 'high' : 'medium',
        title: `Overfetching: SELECT * returning ${e.rowsReturned} rows`,
        description: `Query uses SELECT * and returns ${e.rowsReturned} rows. Tables: ${e.tablesAccessed.join(', ')}.`,
        evidence: [
          `Query: ${e.query.slice(0, 150)}`,
          `Rows: ${e.rowsReturned}`,
        ],
        suggestion: 'Select only the columns you need and add LIMIT if appropriate.',
      });
    }
  }

  return issues;
}
