import type {
  TechnologyEntry,
  RawTechnologyEntry,
  ParsedPattern,
  DomSpec,
  DomCheck,
  ImpliesEntry,
} from './types.js';
import { parsePattern, parseImplies, toArray } from './pattern-parser.js';
import { CategoryMap, type RawCategories } from './categories.js';

/**
 * Parses all patterns in an object map (e.g. headers, meta, cookies, js).
 */
function parsePatternMap(raw: Record<string, string> | undefined): Record<string, ParsedPattern> | undefined {
  if (!raw) return undefined;
  const result: Record<string, ParsedPattern> = {};
  for (const [key, value] of Object.entries(raw)) {
    result[key] = parsePattern(value);
  }
  return result;
}

/**
 * Parses an array of pattern strings.
 */
function parsePatternArray(raw: string | string[] | undefined): ParsedPattern[] | undefined {
  const arr = toArray(raw);
  if (arr.length === 0) return undefined;
  return arr.map(parsePattern);
}

/**
 * Normalize the wappalyzer `dom` field from its 3 possible formats
 * into a consistent DomSpec object.
 */
function normalizeDom(raw: string | string[] | Record<string, unknown> | undefined): DomSpec | undefined {
  if (!raw) return undefined;

  const spec: DomSpec = {};

  if (typeof raw === 'string') {
    // Simple selector string: existence check
    spec[raw] = { exists: '' };
  } else if (Array.isArray(raw)) {
    // Array of selector strings: existence checks
    for (const selector of raw) {
      spec[selector] = { exists: '' };
    }
  } else {
    // Object form: selectors as keys with check objects
    for (const [selector, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        // Simple string value = existence check
        spec[selector] = { exists: '' };
      } else if (value && typeof value === 'object') {
        const check: DomCheck = {};
        const obj = value as Record<string, unknown>;

        if ('exists' in obj) {
          check.exists = '';
        }

        if (obj.attributes && typeof obj.attributes === 'object') {
          check.attributes = {};
          for (const [attr, pattern] of Object.entries(obj.attributes as Record<string, string>)) {
            check.attributes[attr] = parsePattern(pattern);
          }
        }

        if (obj.properties && typeof obj.properties === 'object') {
          check.properties = {};
          for (const [prop, pattern] of Object.entries(obj.properties as Record<string, string>)) {
            check.properties[prop] = parsePattern(pattern);
          }
        }

        if (typeof obj.text === 'string') {
          check.text = parsePattern(obj.text);
        }

        // If no specific checks defined, treat as existence check
        if (!check.exists && !check.attributes && !check.properties && !check.text) {
          check.exists = '';
        }

        spec[selector] = check;
      }
    }
  }

  return Object.keys(spec).length > 0 ? spec : undefined;
}

/**
 * Parse implies entries from raw string or string[].
 * Each entry may have confidence tags: "PHP\\;confidence:50"
 */
function parseImpliesArray(raw: string | string[] | undefined): ImpliesEntry[] | undefined {
  const arr = toArray(raw);
  if (arr.length === 0) return undefined;
  return arr.map(parseImplies);
}

/**
 * Normalize requiresCategory from number | number[] to number[].
 */
function normalizeRequiresCategory(raw: number | number[] | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Technology database: loads, parses, and indexes the full webappanalyzer dataset.
 * All patterns are compiled to RegExp at construction time.
 */
export class TechnologyDatabase {
  private technologies: Map<string, TechnologyEntry> = new Map();
  private categoryMap: CategoryMap;

  constructor(rawTechnologies: Record<string, RawTechnologyEntry>, rawCategories: RawCategories) {
    this.categoryMap = new CategoryMap(rawCategories);

    for (const [name, raw] of Object.entries(rawTechnologies)) {
      const entry: TechnologyEntry = {
        name,
        cats: raw.cats,
        website: raw.website,
        icon: raw.icon,
        description: raw.description,
        oss: raw.oss,
        saas: raw.saas,
        pricing: raw.pricing,
        // Parse detection fields
        js: parsePatternMap(raw.js),
        dom: normalizeDom(raw.dom),
        headers: parsePatternMap(raw.headers),
        meta: parsePatternMap(raw.meta),
        scriptSrc: parsePatternArray(raw.scriptSrc),
        scripts: parsePatternArray(raw.scripts),
        html: parsePatternArray(raw.html),
        css: parsePatternArray(raw.css),
        cookies: parsePatternMap(raw.cookies),
        url: parsePatternArray(raw.url),
        xhr: parsePatternArray(raw.xhr),
        text: parsePatternArray(raw.text),
        // Parse relationships
        implies: parseImpliesArray(raw.implies),
        requires: toArray(raw.requires).length > 0 ? toArray(raw.requires) : undefined,
        excludes: toArray(raw.excludes).length > 0 ? toArray(raw.excludes) : undefined,
        requiresCategory: normalizeRequiresCategory(raw.requiresCategory),
      };

      this.technologies.set(name, entry);
    }
  }

  getAll(): TechnologyEntry[] {
    return Array.from(this.technologies.values());
  }

  getByName(name: string): TechnologyEntry | undefined {
    return this.technologies.get(name);
  }

  getCategoryName(id: number): string {
    return this.categoryMap.getName(id);
  }

  getCategoryMap(): CategoryMap {
    return this.categoryMap;
  }

  get size(): number {
    return this.technologies.size;
  }
}
