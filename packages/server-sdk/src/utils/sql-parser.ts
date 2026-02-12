import type { DatabaseOperation } from '../types.js';

const OPERATION_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|WITH)\b/i;
const TABLE_RE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+["'`]?(\w+)["'`]?/gi;
const PARAM_RE = /\$\d+|\?|:\w+/g;
const STRING_LITERAL_RE = /'[^']*'/g;
const NUMBER_LITERAL_RE = /\b\d+\.?\d*\b/g;

export function parseOperation(query: string): DatabaseOperation {
  const match = query.match(OPERATION_RE);
  if (!match) return 'OTHER';
  const op = match[1].toUpperCase();
  if (op === 'SELECT' || op === 'WITH') return 'SELECT';
  if (op === 'INSERT') return 'INSERT';
  if (op === 'UPDATE') return 'UPDATE';
  if (op === 'DELETE') return 'DELETE';
  return 'OTHER';
}

export function parseTablesAccessed(query: string): string[] {
  const tables = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(TABLE_RE.source, TABLE_RE.flags);
  while ((match = re.exec(query)) !== null) {
    const table = match[1].toLowerCase();
    // Skip SQL keywords that might be false positives
    if (!['select', 'where', 'and', 'or', 'not', 'null', 'set', 'values'].includes(table)) {
      tables.add(table);
    }
  }
  return [...tables];
}

export function normalizeQuery(query: string): string {
  return query
    .replace(STRING_LITERAL_RE, '?')
    .replace(NUMBER_LITERAL_RE, '?')
    .replace(PARAM_RE, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

export function redactParams(params: unknown[]): string {
  return JSON.stringify(
    params.map((p) => {
      if (p === null) return 'NULL';
      if (typeof p === 'string') return '<string>';
      if (typeof p === 'number') return '<number>';
      if (typeof p === 'boolean') return '<boolean>';
      if (p instanceof Date) return '<date>';
      if (Buffer.isBuffer(p)) return '<buffer>';
      return '<object>';
    })
  );
}
