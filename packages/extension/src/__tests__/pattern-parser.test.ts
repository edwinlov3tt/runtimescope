import { describe, it, expect } from 'vitest';
import { parsePattern, extractVersion, parseImplies, toArray } from '../detect/pattern-parser.js';

describe('parsePattern', () => {
  it('parses a simple regex with no tags', () => {
    const p = parsePattern('react\\.js');
    expect(p.regex.source).toContain('react');
    expect(p.confidence).toBe(100);
    expect(p.version).toBe('');
  });

  it('parses version extraction tag', () => {
    const p = parsePattern('^([\\d.]+)$\\;version:\\1');
    expect(p.version).toBe('\\1');
    expect(p.confidence).toBe(100);
  });

  it('parses confidence tag', () => {
    const p = parsePattern('Shopify\\;confidence:25');
    expect(p.confidence).toBe(25);
    expect(p.version).toBe('');
  });

  it('parses version + confidence together', () => {
    const p = parsePattern('v([\\d.]+)\\;version:\\1\\;confidence:50');
    expect(p.version).toBe('\\1');
    expect(p.confidence).toBe(50);
  });

  it('creates case-insensitive regex', () => {
    const p = parsePattern('WordPress');
    expect(p.regex.test('wordpress')).toBe(true);
    expect(p.regex.test('WORDPRESS')).toBe(true);
  });

  it('handles empty string pattern', () => {
    const p = parsePattern('');
    expect(p.confidence).toBe(100);
    expect(p.rawValue).toBe('');
  });

  it('handles invalid regex gracefully', () => {
    const p = parsePattern('[invalid');
    // Should not throw, returns a never-matching regex
    expect(p.regex.test('anything')).toBe(false);
  });

  it('escapes forward slashes in regex', () => {
    const p = parsePattern('/wp-content/');
    expect(p.regex.test('/wp-content/')).toBe(true);
  });
});

describe('extractVersion', () => {
  it('extracts version from capture group \\1', () => {
    const match = 'react 18.2.0'.match(/react ([\d.]+)/i)!;
    expect(extractVersion('\\1', match)).toBe('18.2.0');
  });

  it('handles ternary syntax \\1?a:b (truthy)', () => {
    const match = 'Pro edition'.match(/(Pro)/i)!;
    expect(extractVersion('\\1?Enterprise:Community', match)).toBe('Enterprise');
  });

  it('handles ternary syntax \\1?a:b (falsy)', () => {
    const match = 'basic edition'.match(/(Pro)?/i)!;
    expect(extractVersion('\\1?Enterprise:Community', match)).toBe('Community');
  });

  it('concatenates multiple groups', () => {
    const match = 'v2.1'.match(/v(\d+)\.(\d+)/i)!;
    expect(extractVersion('\\1.\\2', match)).toBe('2.1');
  });

  it('discards versions longer than 15 characters', () => {
    const match = 'v1234567890123456'.match(/v(.+)/i)!;
    expect(extractVersion('\\1', match)).toBe('');
  });

  it('returns empty for no template', () => {
    const match = 'test'.match(/test/)!;
    expect(extractVersion('', match)).toBe('');
  });
});

describe('parseImplies', () => {
  it('parses simple name', () => {
    const result = parseImplies('PHP');
    expect(result.name).toBe('PHP');
    expect(result.confidence).toBe(100);
  });

  it('parses name with confidence', () => {
    const result = parseImplies('PHP\\;confidence:50');
    expect(result.name).toBe('PHP');
    expect(result.confidence).toBe(50);
  });
});

describe('toArray', () => {
  it('wraps string in array', () => {
    expect(toArray('hello')).toEqual(['hello']);
  });

  it('passes array through', () => {
    expect(toArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns empty array for undefined', () => {
    expect(toArray(undefined)).toEqual([]);
  });
});
