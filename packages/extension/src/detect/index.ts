export type {
  DetectionSignals,
  DomSignals,
  DomElementResult,
  TechDetectionResult,
  MatchResult,
} from './types.js';

export { TechnologyDatabase } from './database.js';
export { CategoryMap } from './categories.js';
export { parsePattern, extractVersion } from './pattern-parser.js';
export { resolveRelationships } from './resolver.js';

import type {
  DetectionSignals,
  TechnologyEntry,
  TechDetectionResult,
  MatchResult,
} from './types.js';
import { TechnologyDatabase } from './database.js';
import { resolveRelationships } from './resolver.js';
import {
  matchJs,
  matchDom,
  matchHeaders,
  matchMeta,
  matchScriptSrc,
  matchScripts,
  matchHtml,
  matchCss,
  matchCookies,
  matchUrl,
  matchXhr,
  matchText,
} from './matchers.js';

/**
 * Run all matchers for a single technology against the provided signals.
 * Returns aggregated confidence and best version string.
 */
function detectTechnology(
  tech: TechnologyEntry,
  signals: DetectionSignals,
): { confidence: number; version: string } {
  const allResults: MatchResult[] = [];

  // JS globals
  if (tech.js && signals.js) {
    allResults.push(...matchJs(tech.js, signals.js));
  }

  // DOM
  if (tech.dom && signals.dom) {
    allResults.push(...matchDom(tech.dom, signals.dom));
  }

  // HTTP headers
  if (tech.headers && signals.headers) {
    allResults.push(...matchHeaders(tech.headers, signals.headers));
  }

  // Meta tags
  if (tech.meta && signals.meta) {
    allResults.push(...matchMeta(tech.meta, signals.meta));
  }

  // Script src
  if (tech.scriptSrc && signals.scriptSrc) {
    allResults.push(...matchScriptSrc(tech.scriptSrc, signals.scriptSrc));
  }

  // Inline scripts
  if (tech.scripts && signals.scripts) {
    allResults.push(...matchScripts(tech.scripts, signals.scripts));
  }

  // HTML source
  if (tech.html && signals.html) {
    allResults.push(...matchHtml(tech.html, signals.html));
  }

  // CSS
  if (tech.css && signals.css) {
    allResults.push(...matchCss(tech.css, signals.css));
  }

  // Cookies
  if (tech.cookies && signals.cookies) {
    allResults.push(...matchCookies(tech.cookies, signals.cookies));
  }

  // URL
  if (tech.url) {
    allResults.push(...matchUrl(tech.url, signals.url));
  }

  // XHR
  if (tech.xhr && signals.xhr) {
    allResults.push(...matchXhr(tech.xhr, signals.xhr));
  }

  // Text
  if (tech.text && signals.text) {
    allResults.push(...matchText(tech.text, signals.text));
  }

  if (allResults.length === 0) {
    return { confidence: 0, version: '' };
  }

  // Accumulate confidence (sum, capped at 100)
  const confidence = Math.min(100, allResults.reduce((sum, r) => sum + r.confidence, 0));

  // Pick best version (longest non-empty string)
  let bestVersion = '';
  for (const r of allResults) {
    if (r.version && r.version.length > bestVersion.length) {
      bestVersion = r.version;
    }
  }

  return { confidence, version: bestVersion };
}

/**
 * Detect technologies on a page based on collected signals.
 *
 * @param signals - All signals collected from the page
 * @param db - The loaded technology database
 * @returns Detected technologies sorted by confidence (highest first)
 */
export function detect(
  signals: DetectionSignals,
  db: TechnologyDatabase,
): TechDetectionResult[] {
  // Phase 1: Run all matchers against all technologies
  const rawDetections = new Map<string, { confidence: number; version: string }>();

  for (const tech of db.getAll()) {
    const result = detectTechnology(tech, signals);
    if (result.confidence > 0) {
      rawDetections.set(tech.name, result);
    }
  }

  // Phase 2: Resolve relationships (implies, requires, excludes)
  const resolved = resolveRelationships(rawDetections, db);

  // Phase 3: Build results with category names
  const results: TechDetectionResult[] = [];

  for (const [name, state] of resolved) {
    const tech = db.getByName(name);
    if (!tech) continue;

    results.push({
      name,
      categories: tech.cats.map((id) => ({
        id,
        name: db.getCategoryName(id),
      })),
      confidence: state.confidence,
      version: state.version,
      website: tech.website,
      icon: tech.icon,
      description: tech.description,
    });
  }

  // Sort by confidence descending, then by name alphabetically
  results.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

  return results;
}
