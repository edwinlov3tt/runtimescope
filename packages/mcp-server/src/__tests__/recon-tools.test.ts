import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import type {
  ReconMetadataEvent,
  ReconDesignTokensEvent,
  ReconFontsEvent,
  ReconLayoutTreeEvent,
  ReconAccessibilityEvent,
  ReconComputedStylesEvent,
  ReconElementSnapshotEvent,
  ReconAssetInventoryEvent,
} from '@runtimescope/collector';
import { registerReconMetadataTools } from '../tools/recon-metadata.js';
import { registerReconDesignTokenTools } from '../tools/recon-design-tokens.js';
import { registerReconFontTools } from '../tools/recon-fonts.js';
import { registerReconLayoutTools } from '../tools/recon-layout.js';
import { registerReconAccessibilityTools } from '../tools/recon-accessibility.js';
import { registerReconComputedStyleTools } from '../tools/recon-computed-styles.js';
import { registerReconElementSnapshotTools } from '../tools/recon-element-snapshot.js';
import { registerReconAssetTools } from '../tools/recon-assets.js';
import { registerReconStyleDiffTools } from '../tools/recon-style-diff.js';
import { createMcpStub } from './tool-harness.js';

// --- Test data factories ---

function makeReconMetadata(overrides: Partial<ReconMetadataEvent> = {}): ReconMetadataEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'recon_metadata',
    url: 'https://example.com',
    title: 'Example Site',
    viewport: { width: 1280, height: 720 },
    documentLang: 'en',
    metaTags: { viewport: 'width=device-width, initial-scale=1' },
    techStack: {
      framework: { name: 'react', confidence: 'high', version: '18.2.0', evidence: ['__REACT_DEVTOOLS_GLOBAL_HOOK__ found'] },
      metaFramework: { name: 'nextjs', confidence: 'high', version: '14.1.0', evidence: ['__NEXT_DATA__ global found'] },
      uiLibrary: { name: 'tailwind', confidence: 'high', evidence: ['Tailwind utility classes detected'] },
      buildTool: { name: 'webpack', confidence: 'medium', evidence: ['/_next/ script paths'] },
      hosting: { name: 'vercel', confidence: 'high', evidence: ['X-Vercel-Id header'] },
      additional: [],
    },
    externalStylesheets: [{ href: 'https://example.com/styles.css', crossOrigin: false }],
    externalScripts: [{ src: 'https://example.com/main.js', async: false, defer: true, type: 'module' }],
    preloads: [{ href: 'https://fonts.googleapis.com/inter.woff2', as: 'font' }],
    ...overrides,
  };
}

function makeReconDesignTokens(overrides: Partial<ReconDesignTokensEvent> = {}): ReconDesignTokensEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'recon_design_tokens',
    url: 'https://example.com',
    customProperties: [
      { name: '--color-primary', value: '#3b82f6', source: ':root' },
      { name: '--color-secondary', value: '#6366f1', source: ':root' },
      { name: '--spacing-4', value: '16px', source: ':root' },
    ],
    colors: [
      { value: '#3b82f6', hex: '#3b82f6', usageCount: 15, properties: ['color', 'background-color'], sampleSelectors: ['.btn-primary', '.link'] },
      { value: '#1f2937', hex: '#1f2937', usageCount: 30, properties: ['color'], sampleSelectors: ['.text-body', 'p', 'h1'] },
    ],
    typography: [
      { fontFamily: 'Inter', fontSize: '16px', fontWeight: '400', lineHeight: '1.5', letterSpacing: 'normal', usageCount: 50, sampleSelectors: ['body', 'p'] },
      { fontFamily: 'Inter', fontSize: '24px', fontWeight: '700', lineHeight: '1.2', letterSpacing: '-0.025em', usageCount: 5, sampleSelectors: ['h2'] },
    ],
    spacing: [
      { value: '8px', pixels: 8, usageCount: 20, properties: ['padding', 'margin'] },
      { value: '16px', pixels: 16, usageCount: 35, properties: ['padding', 'margin', 'gap'] },
      { value: '24px', pixels: 24, usageCount: 10, properties: ['padding', 'gap'] },
    ],
    borderRadii: [{ value: '8px', usageCount: 15 }, { value: '9999px', usageCount: 5 }],
    boxShadows: [{ value: '0 1px 3px rgba(0,0,0,0.1)', usageCount: 8 }],
    cssArchitecture: 'tailwind',
    classNamingPatterns: ['tailwind utilities'],
    sampleClassNames: ['flex', 'items-center', 'gap-4', 'text-lg', 'font-bold', 'bg-blue-500'],
    ...overrides,
  };
}

function makeReconFonts(overrides: Partial<ReconFontsEvent> = {}): ReconFontsEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'recon_fonts',
    url: 'https://example.com',
    fontFaces: [
      { family: 'Inter', weight: '400', style: 'normal', src: 'url(/fonts/inter-400.woff2)', display: 'swap' },
      { family: 'Inter', weight: '700', style: 'normal', src: 'url(/fonts/inter-700.woff2)', display: 'swap' },
    ],
    fontsUsed: [
      { family: 'Inter', weight: '400', style: 'normal', usageCount: 50, sampleSelectors: ['body', 'p'] },
      { family: 'Inter', weight: '700', style: 'normal', usageCount: 10, sampleSelectors: ['h1', 'h2', '.bold'] },
    ],
    iconFonts: [],
    loadingStrategy: 'self-hosted woff2 with font-display: swap',
    ...overrides,
  };
}

function makeReconLayoutTree(overrides: Partial<ReconLayoutTreeEvent> = {}): ReconLayoutTreeEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'recon_layout_tree',
    url: 'https://example.com',
    viewport: { width: 1280, height: 720 },
    scrollHeight: 3200,
    tree: {
      tag: 'div',
      id: 'root',
      classList: ['flex', 'flex-col'],
      dataAttributes: {},
      boundingRect: { x: 0, y: 0, width: 1280, height: 3200 },
      display: 'flex',
      position: 'static',
      flexDirection: 'column',
      children: [
        {
          tag: 'nav',
          classList: ['sticky', 'top-0'],
          dataAttributes: {},
          boundingRect: { x: 0, y: 0, width: 1280, height: 64 },
          display: 'flex',
          position: 'sticky',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          children: [],
          childCount: 0,
          role: 'navigation',
        },
        {
          tag: 'main',
          classList: ['grid', 'grid-cols-3'],
          dataAttributes: {},
          boundingRect: { x: 0, y: 64, width: 1280, height: 2000 },
          display: 'grid',
          position: 'static',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '24px',
          children: [],
          childCount: 0,
          role: 'main',
        },
      ],
      childCount: 2,
    },
    totalElements: 150,
    maxDepth: 8,
    ...overrides,
  };
}

function makeReconAccessibility(overrides: Partial<ReconAccessibilityEvent> = {}): ReconAccessibilityEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'recon_accessibility',
    url: 'https://example.com',
    headings: [
      { level: 1, text: 'Welcome', selector: 'h1' },
      { level: 2, text: 'Features', selector: '.features h2' },
    ],
    landmarks: [
      { role: 'navigation', label: 'Main nav', selector: 'nav' },
      { role: 'main', selector: 'main' },
    ],
    formFields: [
      { tag: 'input', type: 'email', name: 'email', label: 'Email address', required: true, selector: '#email' },
    ],
    links: [
      { tag: 'a', text: 'Home', href: '/', selector: 'nav a:first-child' },
    ],
    buttons: [
      { tag: 'button', text: 'Sign Up', role: 'button', selector: '.cta-button' },
    ],
    images: [
      { src: '/hero.png', alt: 'Hero image', hasAlt: true, selector: '.hero img' },
      { src: '/icon.svg', alt: '', hasAlt: false, selector: '.icon' },
    ],
    issues: [],
    ...overrides,
  };
}

function makeReconComputedStyles(overrides: Partial<ReconComputedStylesEvent> = {}): ReconComputedStylesEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'recon_computed_styles',
    url: 'https://example.com',
    selector: '.btn-primary',
    entries: [
      {
        selector: '.btn-primary',
        matchCount: 3,
        styles: {
          'color': 'rgb(255, 255, 255)',
          'background-color': 'rgb(59, 130, 246)',
          'font-size': '16px',
          'font-weight': '500',
          'padding-top': '12px',
          'padding-right': '24px',
          'padding-bottom': '12px',
          'padding-left': '24px',
          'border-radius': '8px',
          'display': 'inline-flex',
          'justify-content': 'center',
          'align-items': 'center',
          'gap': '8px',
        },
        variations: [],
      },
    ],
    ...overrides,
  };
}

function makeReconElementSnapshot(overrides: Partial<ReconElementSnapshotEvent> = {}): ReconElementSnapshotEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'recon_element_snapshot',
    url: 'https://example.com',
    selector: '.card',
    depth: 3,
    root: {
      tag: 'div',
      classList: ['card'],
      attributes: { 'data-testid': 'feature-card' },
      boundingRect: { x: 100, y: 200, width: 320, height: 240 },
      computedStyles: {
        'background-color': 'rgb(255, 255, 255)',
        'border-radius': '12px',
        'padding': '24px',
        'box-shadow': '0 1px 3px rgba(0,0,0,0.1)',
      },
      children: [
        {
          tag: 'h3',
          classList: ['card-title'],
          attributes: {},
          textContent: 'Feature Title',
          boundingRect: { x: 124, y: 224, width: 272, height: 28 },
          computedStyles: {
            'font-size': '20px',
            'font-weight': '600',
            'color': 'rgb(31, 41, 55)',
          },
          children: [],
        },
      ],
    },
    totalNodes: 5,
    ...overrides,
  };
}

function makeReconAssetInventory(overrides: Partial<ReconAssetInventoryEvent> = {}): ReconAssetInventoryEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    eventType: 'recon_asset_inventory',
    url: 'https://example.com',
    images: [
      { src: '/hero.webp', alt: 'Hero', width: 640, height: 480, naturalWidth: 1920, naturalHeight: 1440, format: 'webp', selector: '.hero img' },
    ],
    inlineSVGs: [
      { selector: '.logo svg', viewBox: '0 0 120 40', width: 120, height: 40, source: '<svg viewBox="0 0 120 40"><path d="M10..."/></svg>' },
    ],
    svgSprites: [
      { id: 'icon-heart', viewBox: '0 0 24 24', paths: 'M12 21.35l-1.45-1.32...', referencedBy: ['.like-btn svg use'] },
    ],
    backgroundSprites: [
      {
        sheetUrl: 'https://example.com/sprite.png',
        sheetWidth: 400,
        sheetHeight: 200,
        frames: [
          { selector: '.icon-like', cropX: 0, cropY: 0, cropWidth: 24, cropHeight: 24 },
          { selector: '.icon-share', cropX: 24, cropY: 0, cropWidth: 24, cropHeight: 24 },
        ],
      },
    ],
    maskSprites: [],
    iconFonts: [
      {
        fontFamily: 'Material Icons',
        fontFaceUrl: 'https://fonts.gstatic.com/material-icons.woff2',
        glyphs: [
          { codepoint: '\\e87c', pseudoElement: '::before', selector: '.icon-home', renderedSize: 24 },
        ],
      },
    ],
    totalAssets: 7,
    ...overrides,
  };
}

// --- Stub collector for tools that accept it ---
const collectorStub = {
  sendCommand: vi.fn().mockResolvedValue(undefined),
} as any;

// ============================================================
// Tests
// ============================================================

describe('get_page_metadata tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerReconMetadataTools(server, store, collectorStub);
  });

  it('returns empty response when no data captured', async () => {
    const result = await callTool('get_page_metadata', {});
    expect(result.data).toBeNull();
    expect(result.issues).toContain('No recon_metadata events found in the event store');
  });

  it('returns tech stack summary', async () => {
    store.addEvent(makeReconMetadata());
    const result = await callTool('get_page_metadata', {});
    expect(result.data).not.toBeNull();
    expect(result.summary).toContain('react');
    expect(result.summary).toContain('nextjs');
    expect(result.summary).toContain('tailwind');
    expect(result.summary).toContain('vercel');
    expect(result.data.techStack.framework.name).toBe('react');
    expect(result.data.techStack.framework.version).toBe('18.2.0');
  });

  it('returns external resources', async () => {
    store.addEvent(makeReconMetadata());
    const result = await callTool('get_page_metadata', {});
    expect(result.data.externalStylesheets).toHaveLength(1);
    expect(result.data.externalScripts).toHaveLength(1);
    expect(result.data.preloads).toHaveLength(1);
  });

  it('flags missing viewport meta', async () => {
    store.addEvent(makeReconMetadata({ metaTags: {} }));
    const result = await callTool('get_page_metadata', {});
    expect(result.issues.some((i: string) => i.includes('viewport'))).toBe(true);
  });
});

describe('get_design_tokens tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerReconDesignTokenTools(server, store, collectorStub);
  });

  it('returns empty response when no data', async () => {
    const result = await callTool('get_design_tokens', {});
    expect(result.data).toBeNull();
  });

  it('returns all token categories by default', async () => {
    store.addEvent(makeReconDesignTokens());
    const result = await callTool('get_design_tokens', { category: 'all' });
    expect(result.data.customProperties).toHaveLength(3);
    expect(result.data.colors).toHaveLength(2);
    expect(result.data.typography).toHaveLength(2);
    expect(result.data.spacing).toHaveLength(3);
    expect(result.data.cssArchitecture).toBe('tailwind');
    expect(result.summary).toContain('3 CSS variables');
  });

  it('filters by category', async () => {
    store.addEvent(makeReconDesignTokens());
    const result = await callTool('get_design_tokens', { category: 'colors' });
    expect(result.data.colors).toHaveLength(2);
    expect(result.data.customProperties).toBeUndefined();
    expect(result.data.typography).toBeUndefined();
  });

  it('flags excessive colors', async () => {
    const manyColors = Array.from({ length: 35 }, (_, i) => ({
      value: `#${i.toString(16).padStart(6, '0')}`,
      hex: `#${i.toString(16).padStart(6, '0')}`,
      usageCount: 1,
      properties: ['color'],
      sampleSelectors: ['.el'],
    }));
    store.addEvent(makeReconDesignTokens({ colors: manyColors }));
    const result = await callTool('get_design_tokens', {});
    expect(result.issues.some((i: string) => i.includes('35 unique colors'))).toBe(true);
  });
});

describe('get_font_info tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerReconFontTools(server, store);
  });

  it('returns font face and usage data', async () => {
    store.addEvent(makeReconFonts());
    const result = await callTool('get_font_info', {});
    expect(result.data.fontFaces).toHaveLength(2);
    expect(result.data.fontsUsed).toHaveLength(2);
    expect(result.summary).toContain('Inter');
    expect(result.summary).toContain('2 @font-face');
  });

  it('flags missing font-display', async () => {
    store.addEvent(makeReconFonts({
      fontFaces: [
        { family: 'Inter', weight: '400', style: 'normal', src: 'url(/fonts/inter.woff2)' },
      ],
    }));
    const result = await callTool('get_font_info', {});
    expect(result.issues.some((i: string) => i.includes('font-display'))).toBe(true);
  });
});

describe('get_layout_tree tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerReconLayoutTools(server, store, collectorStub);
  });

  it('returns full layout tree', async () => {
    store.addEvent(makeReconLayoutTree());
    const result = await callTool('get_layout_tree', {});
    expect(result.data.tree.tag).toBe('div');
    expect(result.data.tree.children).toHaveLength(2);
    expect(result.data.totalElements).toBe(150);
    expect(result.summary).toContain('flex');
    expect(result.summary).toContain('grid');
  });

  it('scopes to a selector', async () => {
    store.addEvent(makeReconLayoutTree());
    const result = await callTool('get_layout_tree', { selector: 'nav' });
    expect(result.data.tree.tag).toBe('nav');
    expect(result.summary).toContain('Scoped to: nav');
  });
});

describe('get_accessibility_tree tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerReconAccessibilityTools(server, store);
  });

  it('returns accessibility structure', async () => {
    store.addEvent(makeReconAccessibility());
    const result = await callTool('get_accessibility_tree', {});
    expect(result.data.headings).toHaveLength(2);
    expect(result.data.landmarks).toHaveLength(2);
    expect(result.data.buttons).toHaveLength(1);
  });

  it('flags images without alt text', async () => {
    store.addEvent(makeReconAccessibility());
    const result = await callTool('get_accessibility_tree', {});
    expect(result.issues.some((i: string) => i.includes('1 image(s) missing alt'))).toBe(true);
  });

  it('flags missing main landmark', async () => {
    store.addEvent(makeReconAccessibility({ landmarks: [] }));
    const result = await callTool('get_accessibility_tree', {});
    expect(result.issues.some((i: string) => i.includes('No <main> landmark'))).toBe(true);
  });
});

describe('get_computed_styles tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerReconComputedStyleTools(server, store, collectorStub);
  });

  it('returns computed styles for a selector', async () => {
    store.addEvent(makeReconComputedStyles());
    const result = await callTool('get_computed_styles', { selector: '.btn-primary' });
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].styles['background-color']).toBe('rgb(59, 130, 246)');
    expect(result.data.entries[0].matchCount).toBe(3);
  });

  it('filters by property group', async () => {
    store.addEvent(makeReconComputedStyles());
    const result = await callTool('get_computed_styles', { selector: '.btn-primary', properties: 'typography' });
    const styles = result.data.entries[0].styles;
    expect(styles['font-size']).toBe('16px');
    expect(styles['font-weight']).toBe('500');
    // Should NOT include non-typography props
    expect(styles['background-color']).toBeUndefined();
  });
});

describe('get_element_snapshot tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerReconElementSnapshotTools(server, store, collectorStub);
  });

  it('returns element snapshot with children', async () => {
    store.addEvent(makeReconElementSnapshot());
    const result = await callTool('get_element_snapshot', { selector: '.card' });
    expect(result.data.root.tag).toBe('div');
    expect(result.data.root.children).toHaveLength(1);
    expect(result.data.root.children[0].textContent).toBe('Feature Title');
    expect(result.data.totalNodes).toBe(5);
  });

  it('reports zero-dimension elements', async () => {
    store.addEvent(makeReconElementSnapshot({
      root: {
        tag: 'div', classList: ['hidden'], attributes: {},
        boundingRect: { x: 0, y: 0, width: 0, height: 0 },
        computedStyles: { display: 'none' },
        children: [],
      },
    }));
    const result = await callTool('get_element_snapshot', { selector: '.card' });
    expect(result.issues.some((i: string) => i.includes('zero dimensions'))).toBe(true);
  });
});

describe('get_asset_inventory tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerReconAssetTools(server, store);
  });

  it('returns all asset categories', async () => {
    store.addEvent(makeReconAssetInventory());
    const result = await callTool('get_asset_inventory', { category: 'all' });
    expect(result.data.images).toHaveLength(1);
    expect(result.data.inlineSVGs).toHaveLength(1);
    expect(result.data.svgSprites).toHaveLength(1);
    expect(result.data.backgroundSprites).toHaveLength(1);
    expect(result.data.iconFonts).toHaveLength(1);
    expect(result.summary).toContain('2 CSS sprite frames');
    expect(result.summary).toContain('1 SVG symbols');
  });

  it('filters by sprite category', async () => {
    store.addEvent(makeReconAssetInventory());
    const result = await callTool('get_asset_inventory', { category: 'sprites' });
    expect(result.data.backgroundSprites).toHaveLength(1);
    expect(result.data.svgSprites).toHaveLength(1);
    expect(result.data.images).toBeUndefined();
  });

  it('detects oversized images', async () => {
    store.addEvent(makeReconAssetInventory());
    const result = await callTool('get_asset_inventory', { category: 'all' });
    expect(result.issues.some((i: string) => i.includes('larger than their display size'))).toBe(true);
  });
});

describe('get_style_diff tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    store = new EventStore(100);
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerReconStyleDiffTools(server, store);
  });

  it('reports 100% match for identical styles', async () => {
    const styles = {
      'color': 'rgb(255, 255, 255)',
      'background-color': 'rgb(59, 130, 246)',
      'font-size': '16px',
      'border-radius': '8px',
    };
    store.addEvent(makeReconComputedStyles({ selector: '.source', entries: [{ selector: '.source', matchCount: 1, styles }] }));
    store.addEvent(makeReconComputedStyles({ selector: '.target', entries: [{ selector: '.target', matchCount: 1, styles }] }));

    const result = await callTool('get_style_diff', {
      source_selector: '.source',
      target_selector: '.target',
    });
    expect(result.data.matchPercentage).toBe(100);
    expect(result.data.differences).toBe(0);
  });

  it('reports differences with delta', async () => {
    store.addEvent(makeReconComputedStyles({
      selector: '.source',
      entries: [{ selector: '.source', matchCount: 1, styles: { 'font-size': '16px', 'color': 'rgb(0,0,0)', 'border-radius': '8px' } }],
    }));
    store.addEvent(makeReconComputedStyles({
      selector: '.target',
      entries: [{ selector: '.target', matchCount: 1, styles: { 'font-size': '14px', 'color': 'rgb(0,0,0)', 'border-radius': '6px' } }],
    }));

    const result = await callTool('get_style_diff', {
      source_selector: '.source',
      target_selector: '.target',
      properties: 'all',
    });

    expect(result.data.matchPercentage).toBeLessThan(100);
    expect(result.data.differences).toBe(2);
    const fontDiff = result.data.diffs.find((d: any) => d.property === 'font-size');
    expect(fontDiff).toBeDefined();
    expect(fontDiff.delta).toBe('-2.0px');
  });

  it('returns error when source not found', async () => {
    const result = await callTool('get_style_diff', {
      source_selector: '.missing',
      target_selector: '.also-missing',
    });
    expect(result.data).toBeNull();
    expect(result.issues).toHaveLength(1);
  });
});
