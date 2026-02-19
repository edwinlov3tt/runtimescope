import type { ParsedPattern, ImpliesEntry } from './types.js';

/**
 * Parse a wappalyzer pattern string into a compiled regex with metadata.
 *
 * Format: "regex\\;version:\\1\\;confidence:50"
 * - First segment before \; is the regex (case-insensitive)
 * - Remaining segments are key:value tags
 * - "version" tag uses backreference syntax (\\1, \\2, ternary \\1?a:b)
 * - "confidence" tag is a number 0-100 (default 100)
 */
export function parsePattern(pattern: string): ParsedPattern {
  const attrs: { value: string; confidence: number; version: string } = {
    value: '',
    confidence: 100,
    version: '',
  };

  const parts = pattern.split('\\;');

  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      attrs.value = parts[i];
    } else {
      const colonIdx = parts[i].indexOf(':');
      if (colonIdx === -1) continue;
      const key = parts[i].slice(0, colonIdx);
      const val = parts[i].slice(colonIdx + 1);
      if (key === 'confidence') {
        attrs.confidence = parseInt(val, 10) || 100;
      } else if (key === 'version') {
        attrs.version = val;
      }
    }
  }

  let regex: RegExp;
  try {
    // Escape forward slashes in the pattern for regex compatibility
    regex = new RegExp(attrs.value.replace(/\//g, '\\/'), 'i');
  } catch {
    // If the regex is invalid, use a pattern that never matches
    regex = /(?!)/;
  }

  return {
    regex,
    confidence: attrs.confidence,
    version: attrs.version,
    rawValue: pattern,
  };
}

/**
 * Extract a version string from a regex match using a wappalyzer version template.
 *
 * Templates use \\1, \\2, etc. for capture group backreferences.
 * Supports ternary: \\1?a:b (if group 1 matched, use "a", else "b")
 */
export function extractVersion(template: string, match: RegExpMatchArray): string {
  if (!template || !match) return '';

  let version = template;

  // Replace backreferences \\1 through \\9 with capture group values
  // Handle ternary syntax: \\1?trueVal:falseVal
  version = version.replace(
    /\\(\d)\?([^:]*):([^\\]*)/g,
    (_full, groupIdx, trueVal, falseVal) => {
      const groupValue = match[parseInt(groupIdx, 10)];
      return groupValue ? trueVal : falseVal;
    },
  );

  // Handle simple backreferences: \\1, \\2, etc.
  version = version.replace(/\\(\d)/g, (_full, groupIdx) => {
    return match[parseInt(groupIdx, 10)] || '';
  });

  // Clean up: trim, discard if too long or empty
  version = version.trim();
  if (version.length > 15) return '';

  return version;
}

/**
 * Parse an "implies" entry which may have confidence tags.
 * e.g. "PHP\\;confidence:50" → { name: "PHP", confidence: 50 }
 */
export function parseImplies(raw: string): ImpliesEntry {
  const parts = raw.split('\\;');
  const entry: ImpliesEntry = { name: parts[0], confidence: 100 };

  for (let i = 1; i < parts.length; i++) {
    const colonIdx = parts[i].indexOf(':');
    if (colonIdx === -1) continue;
    const key = parts[i].slice(0, colonIdx);
    const val = parts[i].slice(colonIdx + 1);
    if (key === 'confidence') {
      entry.confidence = parseInt(val, 10) || 100;
    }
  }

  return entry;
}

/**
 * Normalize a value that can be string | string[] into string[].
 */
export function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
