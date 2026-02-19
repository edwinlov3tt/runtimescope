// ============================================================
// Detection Signals — collected by Chrome extension or test harness
// ============================================================

/** All signals collected from a page for technology detection */
export interface DetectionSignals {
  /** Page URL */
  url: string;
  /** HTTP response headers (lowercase keys) */
  headers?: Record<string, string>;
  /** Cookies: name → value */
  cookies?: Record<string, string>;
  /** <meta name="X" content="Y"> → { X: Y } */
  meta?: Record<string, string>;
  /** <script src="..."> URLs */
  scriptSrc?: string[];
  /** Inline <script> text content */
  scripts?: string[];
  /** Raw HTML source (or relevant subset) */
  html?: string;
  /** CSS text content (stylesheet contents, <style> tags, CSS custom property names) */
  css?: string[];
  /** JS global variable dot-paths → stringified values. e.g. "React.version" → "18.2.0", "jQuery" → "" (exists) */
  js?: Record<string, string>;
  /** Pre-queried DOM results, keyed by CSS selector */
  dom?: DomSignals;
  /** Observed XHR/fetch destination URLs */
  xhr?: string[];
  /** Visible page text content */
  text?: string;
}

/** DOM query results grouped by CSS selector */
export interface DomSignals {
  [selector: string]: DomElementResult[];
}

/** Result of querying a single DOM element */
export interface DomElementResult {
  exists: boolean;
  /** getAttribute() results */
  attributes: Record<string, string>;
  /** JS DOM property values (e.g. _reactRootContainer) */
  properties: Record<string, string>;
  /** textContent of the element */
  text: string;
}

// ============================================================
// Parsed pattern types (internal)
// ============================================================

export interface ParsedPattern {
  /** Compiled regex (case-insensitive) */
  regex: RegExp;
  /** Confidence weight for this pattern (default 100) */
  confidence: number;
  /** Version extraction template (e.g. "\\1" or "\\1?a:b") */
  version: string;
  /** Original pattern string */
  rawValue: string;
}

/** DOM detection spec after normalization */
export interface DomSpec {
  [selector: string]: DomCheck;
}

export interface DomCheck {
  exists?: string;
  attributes?: Record<string, ParsedPattern>;
  properties?: Record<string, ParsedPattern>;
  text?: ParsedPattern;
}

/** Implies entry with optional confidence */
export interface ImpliesEntry {
  name: string;
  confidence: number;
}

// ============================================================
// Technology database types
// ============================================================

export interface TechnologyEntry {
  name: string;
  cats: number[];
  website: string;
  icon?: string;
  description?: string;
  oss?: boolean;
  saas?: boolean;
  pricing?: string[];
  // Detection fields (parsed)
  js?: Record<string, ParsedPattern>;
  dom?: DomSpec;
  headers?: Record<string, ParsedPattern>;
  meta?: Record<string, ParsedPattern>;
  scriptSrc?: ParsedPattern[];
  scripts?: ParsedPattern[];
  html?: ParsedPattern[];
  css?: ParsedPattern[];
  cookies?: Record<string, ParsedPattern>;
  url?: ParsedPattern[];
  xhr?: ParsedPattern[];
  text?: ParsedPattern[];
  // Relationships
  implies?: ImpliesEntry[];
  requires?: string[];
  excludes?: string[];
  requiresCategory?: number[];
}

/** Raw technology entry as it appears in the JSON files */
export interface RawTechnologyEntry {
  cats: number[];
  website: string;
  icon?: string;
  description?: string;
  oss?: boolean;
  saas?: boolean;
  pricing?: string[];
  js?: Record<string, string>;
  dom?: string | string[] | Record<string, unknown>;
  headers?: Record<string, string>;
  meta?: Record<string, string>;
  scriptSrc?: string | string[];
  scripts?: string | string[];
  html?: string | string[];
  css?: string | string[];
  cookies?: Record<string, string>;
  url?: string | string[];
  xhr?: string | string[];
  text?: string | string[];
  implies?: string | string[];
  requires?: string | string[];
  excludes?: string | string[];
  requiresCategory?: number | number[];
  // Fields we don't use yet
  dns?: Record<string, unknown>;
  probe?: Record<string, unknown>;
  robots?: string | string[];
  certIssuer?: string | string[];
  cpe?: string;
}

// ============================================================
// Detection result types (output)
// ============================================================

export interface MatchResult {
  confidence: number;
  version: string;
}

export interface TechDetectionResult {
  name: string;
  categories: { id: number; name: string }[];
  confidence: number;
  version: string;
  website: string;
  icon?: string;
  description?: string;
}
