import { describe, it, expect } from 'vitest';
import { resolveRelationships } from '../detect/resolver.js';
import { TechnologyDatabase } from '../detect/database.js';
import type { RawTechnologyEntry } from '../detect/types.js';
import type { RawCategories } from '../detect/categories.js';

// Minimal test categories
const testCategories: RawCategories = {
  '1': { name: 'CMS', groups: [1], priority: 1 },
  '12': { name: 'JavaScript frameworks', groups: [9], priority: 8 },
  '18': { name: 'Web frameworks', groups: [9], priority: 8 },
  '27': { name: 'Programming languages', groups: [2], priority: 5 },
  '66': { name: 'UI frameworks', groups: [9], priority: 7 },
};

function makeDb(techs: Record<string, Partial<RawTechnologyEntry>>): TechnologyDatabase {
  const full: Record<string, RawTechnologyEntry> = {};
  for (const [name, partial] of Object.entries(techs)) {
    full[name] = {
      cats: [12],
      website: `https://${name.toLowerCase()}.com`,
      ...partial,
    } as RawTechnologyEntry;
  }
  return new TechnologyDatabase(full, testCategories);
}

describe('resolveRelationships', () => {
  it('adds implied technologies', () => {
    const db = makeDb({
      'WordPress': { cats: [1], implies: ['PHP', 'MySQL'] },
      'PHP': { cats: [27] },
      'MySQL': { cats: [27] },
    });

    const detections = new Map([
      ['WordPress', { confidence: 100, version: '6.4' }],
    ]);

    const resolved = resolveRelationships(detections, db);

    expect(resolved.has('WordPress')).toBe(true);
    expect(resolved.has('PHP')).toBe(true);
    expect(resolved.has('MySQL')).toBe(true);
    expect(resolved.get('PHP')!.confidence).toBe(100);
  });

  it('applies confidence to implied technologies', () => {
    const db = makeDb({
      'Shopify': { cats: [1], implies: ['React\\;confidence:50'] },
      'React': { cats: [12] },
    });

    const detections = new Map([
      ['Shopify', { confidence: 80, version: '' }],
    ]);

    const resolved = resolveRelationships(detections, db);

    expect(resolved.has('React')).toBe(true);
    // 80 * (50/100) = 40
    expect(resolved.get('React')!.confidence).toBe(40);
  });

  it('removes technologies with unmet requires', () => {
    const db = makeDb({
      'WooCommerce': { cats: [1], requires: 'WordPress' },
      'WordPress': { cats: [1] },
    });

    // WooCommerce detected but WordPress NOT detected
    const detections = new Map([
      ['WooCommerce', { confidence: 100, version: '' }],
    ]);

    const resolved = resolveRelationships(detections, db);

    expect(resolved.has('WooCommerce')).toBe(false);
  });

  it('keeps technologies when requires are met', () => {
    const db = makeDb({
      'WooCommerce': { cats: [1], requires: 'WordPress' },
      'WordPress': { cats: [1] },
    });

    const detections = new Map([
      ['WooCommerce', { confidence: 100, version: '' }],
      ['WordPress', { confidence: 100, version: '6.4' }],
    ]);

    const resolved = resolveRelationships(detections, db);

    expect(resolved.has('WooCommerce')).toBe(true);
    expect(resolved.has('WordPress')).toBe(true);
  });

  it('removes technologies with unmet requiresCategory', () => {
    const db = makeDb({
      'WP Plugin X': { cats: [12], requiresCategory: 1 }, // requires a CMS
    });

    // No CMS detected
    const detections = new Map([
      ['WP Plugin X', { confidence: 100, version: '' }],
    ]);

    const resolved = resolveRelationships(detections, db);

    expect(resolved.has('WP Plugin X')).toBe(false);
  });

  it('applies excludes — removes the excluded technology', () => {
    const db = makeDb({
      'Angular': { cats: [12], excludes: 'AngularJS' },
      'AngularJS': { cats: [12] },
    });

    const detections = new Map([
      ['Angular', { confidence: 100, version: '17.0' }],
      ['AngularJS', { confidence: 80, version: '1.8' }],
    ]);

    const resolved = resolveRelationships(detections, db);

    expect(resolved.has('Angular')).toBe(true);
    expect(resolved.has('AngularJS')).toBe(false);
  });

  it('handles transitive implies', () => {
    const db = makeDb({
      'Next.js': { cats: [18], implies: 'React' },
      'React': { cats: [12], implies: 'JavaScript' },
      'JavaScript': { cats: [27] },
    });

    const detections = new Map([
      ['Next.js', { confidence: 100, version: '14.1' }],
    ]);

    const resolved = resolveRelationships(detections, db);

    expect(resolved.has('Next.js')).toBe(true);
    expect(resolved.has('React')).toBe(true);
    expect(resolved.has('JavaScript')).toBe(true);
  });
});
