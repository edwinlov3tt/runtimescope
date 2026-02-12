import { describe, it, expect } from 'vitest';
import {
  aggregateQueryStats,
  detectN1Queries,
  detectSlowQueries,
  suggestIndexes,
  detectOverfetching,
} from '../engines/query-monitor.js';
import { makeDatabaseEvent } from './factories.js';

describe('aggregateQueryStats', () => {
  it('groups by normalizedQuery', () => {
    const events = [
      makeDatabaseEvent({ normalizedQuery: 'SELECT * FROM users WHERE id = ?' }),
      makeDatabaseEvent({ normalizedQuery: 'SELECT * FROM users WHERE id = ?' }),
      makeDatabaseEvent({ normalizedQuery: 'INSERT INTO posts VALUES (?)' }),
    ];
    const stats = aggregateQueryStats(events);
    expect(stats).toHaveLength(2);
  });

  it('computes avgDuration correctly', () => {
    const events = [
      makeDatabaseEvent({ normalizedQuery: 'Q1', duration: 100 }),
      makeDatabaseEvent({ normalizedQuery: 'Q1', duration: 200 }),
      makeDatabaseEvent({ normalizedQuery: 'Q1', duration: 300 }),
    ];
    const stats = aggregateQueryStats(events);
    expect(stats[0].avgDuration).toBe(200);
  });

  it('computes maxDuration correctly', () => {
    const events = [
      makeDatabaseEvent({ normalizedQuery: 'Q1', duration: 100 }),
      makeDatabaseEvent({ normalizedQuery: 'Q1', duration: 500 }),
    ];
    const stats = aggregateQueryStats(events);
    expect(stats[0].maxDuration).toBe(500);
  });

  it('collects all tables across events in a group', () => {
    const events = [
      makeDatabaseEvent({ normalizedQuery: 'Q1', tablesAccessed: ['users'] }),
      makeDatabaseEvent({ normalizedQuery: 'Q1', tablesAccessed: ['users', 'profiles'] }),
    ];
    const stats = aggregateQueryStats(events);
    expect(stats[0].tables).toContain('users');
    expect(stats[0].tables).toContain('profiles');
  });

  it('sorts by totalDuration descending', () => {
    const events = [
      makeDatabaseEvent({ normalizedQuery: 'FAST', duration: 10 }),
      makeDatabaseEvent({ normalizedQuery: 'SLOW', duration: 1000 }),
    ];
    const stats = aggregateQueryStats(events);
    expect(stats[0].normalizedQuery).toBe('SLOW');
  });

  it('handles avgRowsReturned with undefined rowsReturned', () => {
    const events = [
      makeDatabaseEvent({ normalizedQuery: 'Q1', rowsReturned: undefined }),
    ];
    const stats = aggregateQueryStats(events);
    expect(stats[0].avgRowsReturned).toBe(0);
  });
});

describe('detectN1Queries', () => {
  it('detects >5 SELECTs on same table within 2s', () => {
    const now = Date.now();
    const events = Array.from({ length: 8 }, (_, i) =>
      makeDatabaseEvent({
        operation: 'SELECT',
        tablesAccessed: ['users'],
        timestamp: now + i * 100,
      })
    );
    const issues = detectN1Queries(events);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe('high');
  });

  it('only considers SELECT operations', () => {
    const now = Date.now();
    const events = Array.from({ length: 8 }, (_, i) =>
      makeDatabaseEvent({
        operation: 'INSERT',
        tablesAccessed: ['users'],
        timestamp: now + i * 100,
      })
    );
    expect(detectN1Queries(events)).toHaveLength(0);
  });

  it('does not flag <=5 queries', () => {
    const now = Date.now();
    const events = Array.from({ length: 4 }, (_, i) =>
      makeDatabaseEvent({
        operation: 'SELECT',
        tablesAccessed: ['users'],
        timestamp: now + i * 100,
      })
    );
    expect(detectN1Queries(events)).toHaveLength(0);
  });
});

describe('detectSlowQueries', () => {
  it('detects queries >= 500ms (default threshold)', () => {
    const events = [makeDatabaseEvent({ duration: 600 })];
    const issues = detectSlowQueries(events);
    expect(issues).toHaveLength(1);
  });

  it('accepts custom threshold', () => {
    const events = [makeDatabaseEvent({ duration: 200 })];
    expect(detectSlowQueries(events, 100)).toHaveLength(1);
    expect(detectSlowQueries(events, 300)).toHaveLength(0);
  });

  it('deduplicates by normalizedQuery', () => {
    const events = [
      makeDatabaseEvent({ normalizedQuery: 'Q1', duration: 600 }),
      makeDatabaseEvent({ normalizedQuery: 'Q1', duration: 700 }),
    ];
    const issues = detectSlowQueries(events);
    expect(issues).toHaveLength(1);
  });

  it('assigns high severity for >2000ms', () => {
    const events = [makeDatabaseEvent({ duration: 3000 })];
    const issues = detectSlowQueries(events);
    expect(issues[0].severity).toBe('high');
  });

  it('assigns medium severity for 500-2000ms', () => {
    const events = [makeDatabaseEvent({ duration: 800 })];
    const issues = detectSlowQueries(events);
    expect(issues[0].severity).toBe('medium');
  });
});

describe('suggestIndexes', () => {
  it('extracts WHERE clause columns', () => {
    const events = [
      makeDatabaseEvent({
        query: 'SELECT * FROM users WHERE "email" = $1',
        tablesAccessed: ['users'],
        duration: 200,
      }),
    ];
    const suggestions = suggestIndexes(events);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].columns).toContain('email');
  });

  it('only considers queries >100ms', () => {
    const events = [
      makeDatabaseEvent({
        query: 'SELECT * FROM users WHERE id = 1',
        tablesAccessed: ['users'],
        duration: 50,
      }),
    ];
    expect(suggestIndexes(events)).toHaveLength(0);
  });

  it('assigns high impact for >1000ms', () => {
    const events = [
      makeDatabaseEvent({
        query: 'SELECT * FROM users WHERE email = $1',
        tablesAccessed: ['users'],
        duration: 1500,
      }),
    ];
    const suggestions = suggestIndexes(events);
    expect(suggestions[0].estimatedImpact).toBe('high');
  });
});

describe('detectOverfetching', () => {
  it('detects SELECT * with >100 rows', () => {
    const events = [
      makeDatabaseEvent({
        query: 'SELECT * FROM users',
        operation: 'SELECT',
        rowsReturned: 500,
      }),
    ];
    const issues = detectOverfetching(events);
    expect(issues).toHaveLength(1);
  });

  it('does not flag when rowsReturned <= 100', () => {
    const events = [
      makeDatabaseEvent({
        query: 'SELECT * FROM users',
        operation: 'SELECT',
        rowsReturned: 50,
      }),
    ];
    expect(detectOverfetching(events)).toHaveLength(0);
  });

  it('assigns high severity for >1000 rows', () => {
    const events = [
      makeDatabaseEvent({
        query: 'SELECT * FROM users',
        operation: 'SELECT',
        rowsReturned: 2000,
      }),
    ];
    const issues = detectOverfetching(events);
    expect(issues[0].severity).toBe('high');
  });
});
