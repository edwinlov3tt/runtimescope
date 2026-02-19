import { describe, it, expect } from 'vitest';
import { extractJsGlobalPaths, extractDomSelectors } from '../scanner/signal-collector.js';

describe('extractJsGlobalPaths', () => {
  it('extracts unique JS paths from technologies', () => {
    const techs = [
      { js: { 'React': {}, 'React.version': {} } },
      { js: { 'jQuery': {}, 'jQuery.fn.jquery': {} } },
      { js: { 'React': {} } }, // duplicate
    ];
    const paths = extractJsGlobalPaths(techs);
    expect(paths).toContain('React');
    expect(paths).toContain('React.version');
    expect(paths).toContain('jQuery');
    expect(paths).toContain('jQuery.fn.jquery');
    // No duplicates
    expect(paths.filter((p) => p === 'React')).toHaveLength(1);
  });

  it('handles technologies without js field', () => {
    const techs = [
      { name: 'SomeTech' },
      { js: { 'window.myLib': {} } },
    ];
    const paths = extractJsGlobalPaths(techs as Array<{ js?: Record<string, unknown> }>);
    expect(paths).toEqual(['window.myLib']);
  });

  it('returns empty array for no js technologies', () => {
    const techs = [{ name: 'A' }, { name: 'B' }];
    const paths = extractJsGlobalPaths(techs as Array<{ js?: Record<string, unknown> }>);
    expect(paths).toEqual([]);
  });
});

describe('extractDomSelectors', () => {
  it('extracts unique DOM selectors from technologies', () => {
    const techs = [
      { dom: { '#react-root': {}, '[data-reactroot]': {} } },
      { dom: { '.wp-content': {} } },
      { dom: { '#react-root': {} } }, // duplicate
    ];
    const selectors = extractDomSelectors(techs);
    expect(selectors).toContain('#react-root');
    expect(selectors).toContain('[data-reactroot]');
    expect(selectors).toContain('.wp-content');
    // No duplicates
    expect(selectors.filter((s) => s === '#react-root')).toHaveLength(1);
  });

  it('handles technologies without dom field', () => {
    const techs = [
      { name: 'SomeTech' },
      { dom: { '[data-vue]': {} } },
    ];
    const selectors = extractDomSelectors(techs as Array<{ dom?: Record<string, unknown> }>);
    expect(selectors).toEqual(['[data-vue]']);
  });

  it('returns empty array for no dom technologies', () => {
    const techs = [{ name: 'A' }];
    const selectors = extractDomSelectors(techs as Array<{ dom?: Record<string, unknown> }>);
    expect(selectors).toEqual([]);
  });
});
