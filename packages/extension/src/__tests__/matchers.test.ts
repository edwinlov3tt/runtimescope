import { describe, it, expect } from 'vitest';
import { parsePattern } from '../detect/pattern-parser.js';
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
} from '../detect/matchers.js';
import type { DomSpec, DomSignals, ParsedPattern } from '../detect/types.js';

// Helper: create a parsed pattern map from raw strings
function pp(raw: Record<string, string>): Record<string, ParsedPattern> {
  const result: Record<string, ParsedPattern> = {};
  for (const [k, v] of Object.entries(raw)) result[k] = parsePattern(v);
  return result;
}

function ppArr(raw: string[]): ParsedPattern[] {
  return raw.map(parsePattern);
}

describe('matchJs', () => {
  it('detects React.version with version extraction', () => {
    const techJs = pp({ 'React.version': '^([\\d.]+)$\\;version:\\1' });
    const results = matchJs(techJs, { 'React.version': '18.2.0' });
    expect(results).toHaveLength(1);
    expect(results[0].version).toBe('18.2.0');
    expect(results[0].confidence).toBe(100);
  });

  it('detects existence-only checks (empty pattern)', () => {
    const techJs = pp({ '__NEXT_DATA__': '' });
    const results = matchJs(techJs, { '__NEXT_DATA__': '' });
    expect(results).toHaveLength(1);
    expect(results[0].confidence).toBe(100);
  });

  it('returns empty when global not present', () => {
    const techJs = pp({ 'React.version': '' });
    const results = matchJs(techJs, { 'Vue': '' });
    expect(results).toHaveLength(0);
  });

  it('respects confidence tags', () => {
    const techJs = pp({ 'Shopify': '\\;confidence:25' });
    const results = matchJs(techJs, { 'Shopify': '' });
    expect(results).toHaveLength(1);
    expect(results[0].confidence).toBe(25);
  });
});

describe('matchDom', () => {
  it('detects element existence', () => {
    const techDom: DomSpec = { 'div#react-root': { exists: '' } };
    const signalDom: DomSignals = {
      'div#react-root': [{ exists: true, attributes: {}, properties: {}, text: '' }],
    };
    const results = matchDom(techDom, signalDom);
    expect(results).toHaveLength(1);
  });

  it('detects property existence (React _reactRootContainer)', () => {
    const techDom: DomSpec = {
      'body > div': { properties: { '_reactRootContainer': parsePattern('') } },
    };
    const signalDom: DomSignals = {
      'body > div': [{ exists: true, attributes: {}, properties: { '_reactRootContainer': '[object Object]' }, text: '' }],
    };
    const results = matchDom(techDom, signalDom);
    expect(results).toHaveLength(1);
  });

  it('extracts version from attribute', () => {
    const techDom: DomSpec = {
      '[ng-version]': {
        attributes: {
          'ng-version': parsePattern('^([\\d.]+)$\\;version:\\1'),
        },
      },
    };
    const signalDom: DomSignals = {
      '[ng-version]': [{ exists: true, attributes: { 'ng-version': '17.1.2' }, properties: {}, text: '' }],
    };
    const results = matchDom(techDom, signalDom);
    expect(results).toHaveLength(1);
    expect(results[0].version).toBe('17.1.2');
  });

  it('returns empty when selector not found', () => {
    const techDom: DomSpec = { 'div#nonexistent': { exists: '' } };
    const results = matchDom(techDom, {});
    expect(results).toHaveLength(0);
  });
});

describe('matchHeaders', () => {
  it('detects x-powered-by header', () => {
    const techHeaders = pp({ 'x-powered-by': 'Express' });
    const results = matchHeaders(techHeaders, { 'x-powered-by': 'Express 4.18.2' });
    expect(results).toHaveLength(1);
  });

  it('detects Vercel x-vercel-id header (existence check)', () => {
    const techHeaders = pp({ 'x-vercel-id': '' });
    const results = matchHeaders(techHeaders, { 'x-vercel-id': 'iad1::abc123' });
    expect(results).toHaveLength(1);
  });

  it('is case-insensitive for header names', () => {
    const techHeaders = pp({ 'X-Powered-By': 'Next' });
    const results = matchHeaders(techHeaders, { 'x-powered-by': 'Next.js 14.1.0' });
    expect(results).toHaveLength(1);
  });
});

describe('matchMeta', () => {
  it('detects WordPress generator meta tag with version', () => {
    const techMeta = pp({ 'generator': '^WordPress(?: ([\\d.]+))?\\;version:\\1' });
    const results = matchMeta(techMeta, { 'generator': 'WordPress 6.4.2' });
    expect(results).toHaveLength(1);
    expect(results[0].version).toBe('6.4.2');
  });

  it('detects meta tag without version', () => {
    const techMeta = pp({ 'generator': '^Wix\\.com' });
    const results = matchMeta(techMeta, { 'generator': 'Wix.com Website Builder' });
    expect(results).toHaveLength(1);
  });
});

describe('matchScriptSrc', () => {
  it('detects jQuery from CDN script src', () => {
    const patterns = ppArr(['jquery[.-]([\\d.]+).*\\.js\\;version:\\1']);
    const results = matchScriptSrc(patterns, [
      'https://cdnjs.cloudflare.com/ajax/libs/jquery-3.7.1/jquery.min.js',
    ]);
    expect(results).toHaveLength(1);
    // Note: version extraction depends on the regex matching
  });

  it('detects wp-content scripts', () => {
    const patterns = ppArr(['/wp-(?:content|includes)/']);
    const results = matchScriptSrc(patterns, [
      'https://example.com/wp-content/themes/theme/js/main.js',
    ]);
    expect(results).toHaveLength(1);
  });
});

describe('matchHtml', () => {
  it('detects data-react attribute in HTML', () => {
    const patterns = ppArr(['<[^>]+data-react']);
    const results = matchHtml(patterns, '<div data-reactroot="">Hello</div>');
    expect(results).toHaveLength(1);
  });

  it('detects wp-content link in HTML', () => {
    const patterns = ppArr(['<link[^>]+/wp-content/']);
    const results = matchHtml(patterns, '<link rel="stylesheet" href="/wp-content/themes/test/style.css">');
    expect(results).toHaveLength(1);
  });
});

describe('matchCss', () => {
  it('detects Tailwind CSS custom properties', () => {
    const patterns = ppArr(['--tw-(?:rotate|translate|ring|shadow|blur)']);
    const results = matchCss(patterns, [
      ':root { --tw-ring-offset-width: 0px; --tw-shadow: 0 0 #0000; }',
    ]);
    expect(results).toHaveLength(1);
  });
});

describe('matchCookies', () => {
  it('detects Google Analytics _ga cookie', () => {
    const techCookies = pp({ '_ga': '' });
    const results = matchCookies(techCookies, { '_ga': 'GA1.2.123456.789012' });
    expect(results).toHaveLength(1);
  });

  it('detects Shopify cookies', () => {
    const techCookies = pp({ '_shopify_s': '' });
    const results = matchCookies(techCookies, { '_shopify_s': 'abc123' });
    expect(results).toHaveLength(1);
  });
});

describe('matchUrl', () => {
  it('detects myshopify.com URL', () => {
    const patterns = ppArr(['^https?://.+\\.myshopify\\.com']);
    const results = matchUrl(patterns, 'https://test-store.myshopify.com/products');
    expect(results).toHaveLength(1);
  });
});

describe('matchXhr', () => {
  it('detects Firebase XHR', () => {
    const patterns = ppArr(['firestore\\.googleapis\\.com']);
    const results = matchXhr(patterns, [
      'https://firestore.googleapis.com/v1/projects/myapp/databases',
    ]);
    expect(results).toHaveLength(1);
  });
});
