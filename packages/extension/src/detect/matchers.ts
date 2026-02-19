import type {
  ParsedPattern,
  DomSpec,
  DomSignals,
  MatchResult,
} from './types.js';
import { extractVersion } from './pattern-parser.js';

/**
 * Test a single parsed pattern against a value string.
 * Returns a MatchResult if the pattern matches, or null.
 */
function testPattern(pattern: ParsedPattern, value: string): MatchResult | null {
  const match = pattern.regex.exec(value);
  if (!match) return null;
  return {
    confidence: pattern.confidence,
    version: extractVersion(pattern.version, match),
  };
}

/**
 * Match JS global variable patterns.
 * techJs: { "React.version": ParsedPattern, "jQuery": ParsedPattern }
 * signalJs: { "React.version": "18.2.0", "jQuery": "" }
 *
 * Key matching: if the signal has a key matching the tech's JS key,
 * test the pattern against the signal value (or just confirm existence if pattern is empty).
 */
export function matchJs(
  techJs: Record<string, ParsedPattern>,
  signalJs: Record<string, string>,
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const [path, pattern] of Object.entries(techJs)) {
    if (!(path in signalJs)) continue;

    const value = signalJs[path];

    // Empty pattern regex (from empty string) = existence check
    if (pattern.rawValue === '' || pattern.rawValue === '\\;version:\\1') {
      // Existence confirmed — check if we can extract version from value
      if (pattern.version && value) {
        const fakeMatch = [value, value] as unknown as RegExpMatchArray;
        results.push({
          confidence: pattern.confidence,
          version: extractVersion(pattern.version, fakeMatch),
        });
      } else {
        results.push({ confidence: pattern.confidence, version: '' });
      }
      continue;
    }

    const result = testPattern(pattern, value);
    if (result) results.push(result);
  }

  return results;
}

/**
 * Match DOM selector patterns.
 * techDom: normalized DomSpec with selectors as keys
 * signalDom: pre-queried DOM results from the page
 */
export function matchDom(
  techDom: DomSpec,
  signalDom: DomSignals,
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const [selector, check] of Object.entries(techDom)) {
    const elements = signalDom[selector];
    if (!elements || elements.length === 0) continue;

    for (const el of elements) {
      // Existence check
      if (check.exists !== undefined && el.exists) {
        results.push({ confidence: 100, version: '' });
      }

      // Attribute checks
      if (check.attributes) {
        for (const [attr, pattern] of Object.entries(check.attributes)) {
          const value = el.attributes[attr];
          if (value === undefined) continue;
          const result = testPattern(pattern, value);
          if (result) results.push(result);
        }
      }

      // Property checks
      if (check.properties) {
        for (const [prop, pattern] of Object.entries(check.properties)) {
          const value = el.properties[prop];
          if (value === undefined) continue;

          // Empty pattern = existence check for property
          if (pattern.rawValue === '') {
            results.push({ confidence: pattern.confidence, version: '' });
          } else {
            const result = testPattern(pattern, value);
            if (result) results.push(result);
          }
        }
      }

      // Text content check
      if (check.text) {
        const result = testPattern(check.text, el.text);
        if (result) results.push(result);
      }
    }
  }

  return results;
}

/**
 * Match HTTP response header patterns.
 * Headers should have lowercase keys in signals.
 */
export function matchHeaders(
  techHeaders: Record<string, ParsedPattern>,
  signalHeaders: Record<string, string>,
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const [header, pattern] of Object.entries(techHeaders)) {
    const value = signalHeaders[header.toLowerCase()];
    if (value === undefined) continue;

    if (pattern.rawValue === '') {
      results.push({ confidence: pattern.confidence, version: '' });
    } else {
      const result = testPattern(pattern, value);
      if (result) results.push(result);
    }
  }

  return results;
}

/**
 * Match <meta> tag patterns.
 * techMeta: { "generator": ParsedPattern }
 * signalMeta: { "generator": "WordPress 6.4" }
 */
export function matchMeta(
  techMeta: Record<string, ParsedPattern>,
  signalMeta: Record<string, string>,
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const [name, pattern] of Object.entries(techMeta)) {
    const value = signalMeta[name.toLowerCase()];
    if (value === undefined) continue;

    if (pattern.rawValue === '') {
      results.push({ confidence: pattern.confidence, version: '' });
    } else {
      const result = testPattern(pattern, value);
      if (result) results.push(result);
    }
  }

  return results;
}

/**
 * Match script src URL patterns against collected <script src="..."> values.
 */
export function matchScriptSrc(
  patterns: ParsedPattern[],
  scriptSrcs: string[],
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const pattern of patterns) {
    for (const src of scriptSrcs) {
      const result = testPattern(pattern, src);
      if (result) {
        results.push(result);
        break; // One match per pattern is enough
      }
    }
  }

  return results;
}

/**
 * Match inline script content patterns.
 */
export function matchScripts(
  patterns: ParsedPattern[],
  inlineScripts: string[],
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const pattern of patterns) {
    for (const script of inlineScripts) {
      const result = testPattern(pattern, script);
      if (result) {
        results.push(result);
        break;
      }
    }
  }

  return results;
}

/**
 * Match raw HTML source patterns.
 */
export function matchHtml(
  patterns: ParsedPattern[],
  html: string,
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const pattern of patterns) {
    const result = testPattern(pattern, html);
    if (result) results.push(result);
  }

  return results;
}

/**
 * Match CSS patterns (custom properties, selectors in stylesheet text).
 */
export function matchCss(
  patterns: ParsedPattern[],
  cssTexts: string[],
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const pattern of patterns) {
    for (const css of cssTexts) {
      const result = testPattern(pattern, css);
      if (result) {
        results.push(result);
        break;
      }
    }
  }

  return results;
}

/**
 * Match cookie patterns.
 * techCookies: { "_ga": ParsedPattern }
 * signalCookies: { "_ga": "GA1.2.123.456" }
 */
export function matchCookies(
  techCookies: Record<string, ParsedPattern>,
  signalCookies: Record<string, string>,
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const [name, pattern] of Object.entries(techCookies)) {
    // Cookie names may use regex patterns — some use (?i) inline flags
    // that JS doesn't support, so strip them and handle errors gracefully
    let nameRegex: RegExp;
    try {
      nameRegex = new RegExp(name.replace(/\(\?i\)/g, ''), 'i');
    } catch {
      // If the cookie name is an invalid regex, try literal match
      nameRegex = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    for (const [cookieName, cookieValue] of Object.entries(signalCookies)) {
      if (!nameRegex.test(cookieName)) continue;

      if (pattern.rawValue === '') {
        results.push({ confidence: pattern.confidence, version: '' });
      } else {
        const result = testPattern(pattern, cookieValue);
        if (result) results.push(result);
      }
      break;
    }
  }

  return results;
}

/**
 * Match page URL patterns.
 */
export function matchUrl(
  patterns: ParsedPattern[],
  url: string,
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const pattern of patterns) {
    const result = testPattern(pattern, url);
    if (result) results.push(result);
  }

  return results;
}

/**
 * Match XHR/fetch destination URL patterns.
 */
export function matchXhr(
  patterns: ParsedPattern[],
  xhrUrls: string[],
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const pattern of patterns) {
    for (const url of xhrUrls) {
      const result = testPattern(pattern, url);
      if (result) {
        results.push(result);
        break;
      }
    }
  }

  return results;
}

/**
 * Match visible page text patterns.
 */
export function matchText(
  patterns: ParsedPattern[],
  text: string,
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const pattern of patterns) {
    const result = testPattern(pattern, text);
    if (result) results.push(result);
  }

  return results;
}
