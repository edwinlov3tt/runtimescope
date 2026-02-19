import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { detect, TechnologyDatabase } from '../detect/index.js';
import type { DetectionSignals, TechDetectionResult } from '../detect/types.js';

let db: TechnologyDatabase;

beforeAll(() => {
  const techPath = resolve(__dirname, '../data/technologies.json');
  const catPath = resolve(__dirname, '../data/categories.json');
  const rawTech = JSON.parse(readFileSync(techPath, 'utf-8'));
  const rawCat = JSON.parse(readFileSync(catPath, 'utf-8'));
  db = new TechnologyDatabase(rawTech, rawCat);
});

function findTech(results: TechDetectionResult[], name: string): TechDetectionResult | undefined {
  return results.find((r) => r.name === name);
}

describe('TechnologyDatabase', () => {
  it('loads all 7000+ technologies', () => {
    expect(db.size).toBeGreaterThan(7000);
  });

  it('can look up React', () => {
    const react = db.getByName('React');
    expect(react).toBeDefined();
    expect(react!.cats).toContain(12); // JavaScript frameworks
  });

  it('can look up WordPress', () => {
    const wp = db.getByName('WordPress');
    expect(wp).toBeDefined();
    expect(wp!.implies).toBeDefined();
  });

  it('resolves category names', () => {
    expect(db.getCategoryName(1)).toBe('CMS');
    expect(db.getCategoryName(12)).toBe('JavaScript frameworks');
    expect(db.getCategoryName(66)).toBe('UI frameworks');
  });
});

describe('detect() — Next.js + Tailwind + Vercel site', () => {
  let results: TechDetectionResult[];

  beforeAll(() => {
    const signals: DetectionSignals = {
      url: 'https://myapp.vercel.app',
      headers: {
        'x-vercel-id': 'iad1::abc123-def456',
        'x-powered-by': 'Next.js',
        'server': 'Vercel',
      },
      meta: {
        'generator': '',
      },
      js: {
        'React.version': '18.2.0',
        '__NEXT_DATA__': '',
        'next.version': '14.1.0',
      },
      scriptSrc: [
        'https://myapp.vercel.app/_next/static/chunks/main-abc123.js',
        'https://myapp.vercel.app/_next/static/chunks/framework-def456.js',
      ],
      html: '<div id="__next" data-reactroot=""><main class="flex min-h-screen"></main></div>',
      css: [
        ':root { --tw-ring-offset-width: 0px; --tw-shadow: 0 0 #0000; --tw-translate-x: 0; }',
      ],
      dom: {
        'div#__next': [{ exists: true, attributes: {}, properties: {}, text: '' }],
        'body > div': [{
          exists: true,
          attributes: { 'data-reactroot': '' },
          properties: { '_reactRootContainer': '[object Object]' },
          text: '',
        }],
      },
    };

    results = detect(signals, db);
  });

  it('detects React with version', () => {
    const react = findTech(results, 'React');
    expect(react).toBeDefined();
    expect(react!.confidence).toBeGreaterThanOrEqual(50);
    expect(react!.version).toBe('18.2.0');
  });

  it('detects Next.js', () => {
    const next = findTech(results, 'Next.js');
    expect(next).toBeDefined();
    expect(next!.confidence).toBeGreaterThanOrEqual(50);
  });

  it('detects Tailwind CSS', () => {
    const tailwind = findTech(results, 'Tailwind CSS');
    expect(tailwind).toBeDefined();
    expect(tailwind!.confidence).toBeGreaterThanOrEqual(50);
  });

  it('detects Vercel', () => {
    const vercel = findTech(results, 'Vercel');
    expect(vercel).toBeDefined();
    expect(vercel!.confidence).toBeGreaterThanOrEqual(50);
  });

  it('does NOT detect WordPress', () => {
    const wp = findTech(results, 'WordPress');
    expect(wp).toBeUndefined();
  });

  it('results are sorted by confidence descending', () => {
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence);
    }
  });

  it('each result has categories with names', () => {
    for (const r of results) {
      expect(r.categories.length).toBeGreaterThan(0);
      for (const cat of r.categories) {
        expect(cat.name).toBeTruthy();
        expect(typeof cat.id).toBe('number');
      }
    }
  });
});

describe('detect() — WordPress site', () => {
  let results: TechDetectionResult[];

  beforeAll(() => {
    const signals: DetectionSignals = {
      url: 'https://example-blog.com',
      headers: {
        'x-pingback': 'https://example-blog.com/xmlrpc.php',
        'link': 'rel="https://api.w.org/"',
      },
      meta: {
        'generator': 'WordPress 6.4.2',
      },
      scriptSrc: [
        'https://example-blog.com/wp-content/themes/mytheme/js/app.js',
        'https://example-blog.com/wp-includes/js/wp-embed.min.js',
      ],
      html: '<link rel="stylesheet" href="/wp-content/themes/mytheme/style.css">',
      cookies: {
        'wordpress_logged_in_abc': 'user%7C123',
      },
    };

    results = detect(signals, db);
  });

  it('detects WordPress with version', () => {
    const wp = findTech(results, 'WordPress');
    expect(wp).toBeDefined();
    expect(wp!.version).toBe('6.4.2');
    expect(wp!.confidence).toBeGreaterThanOrEqual(50);
  });

  it('implies PHP', () => {
    const php = findTech(results, 'PHP');
    expect(php).toBeDefined();
  });

  it('implies MySQL', () => {
    const mysql = findTech(results, 'MySQL');
    expect(mysql).toBeDefined();
  });

  it('does NOT detect React', () => {
    const react = findTech(results, 'React');
    expect(react).toBeUndefined();
  });
});

describe('detect() — Shopify storefront', () => {
  let results: TechDetectionResult[];

  beforeAll(() => {
    const signals: DetectionSignals = {
      url: 'https://cool-store.myshopify.com/products',
      headers: {
        'x-shopid': '12345678',
        'x-shopify-stage': 'production',
      },
      cookies: {
        '_shopify_s': 'abc123',
        '_shopify_y': 'def456',
      },
      js: {
        'Shopify': '',
        'ShopifyAnalytics': '',
      },
      scriptSrc: [
        'https://cdn.shopify.com/s/files/1/0123/theme.js',
      ],
    };

    results = detect(signals, db);
  });

  it('detects Shopify', () => {
    const shopify = findTech(results, 'Shopify');
    expect(shopify).toBeDefined();
    expect(shopify!.confidence).toBeGreaterThanOrEqual(50);
  });
});

describe('detect() — Wix site', () => {
  let results: TechDetectionResult[];

  beforeAll(() => {
    const signals: DetectionSignals = {
      url: 'https://www.example-wix-site.com',
      headers: {
        'x-wix-request-id': 'abc-123-def',
      },
      meta: {
        'generator': 'Wix.com Website Builder',
      },
      js: {
        'wixBiSession': '',
      },
      scriptSrc: [
        'https://static.parastorage.com/services/wix-thunderbolt/dist/main.js',
      ],
    };

    results = detect(signals, db);
  });

  it('detects Wix', () => {
    const wix = findTech(results, 'Wix');
    expect(wix).toBeDefined();
    expect(wix!.confidence).toBeGreaterThanOrEqual(50);
  });
});

describe('detect() — empty signals', () => {
  it('returns empty array for no signals', () => {
    const results = detect({ url: 'https://blank.example.com' }, db);
    expect(results).toEqual([]);
  });
});

describe('detect() — performance', () => {
  it('completes detection in under 500ms', () => {
    const signals: DetectionSignals = {
      url: 'https://example.com',
      js: { 'React.version': '18.2.0', '__NEXT_DATA__': '' },
      headers: { 'x-vercel-id': 'abc' },
      css: [':root { --tw-shadow: 0 0 #0000; }'],
    };

    const start = performance.now();
    detect(signals, db);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(500);
  });
});
