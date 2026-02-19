import { describe, it, expect } from 'vitest';
import { buildReconEvents } from '../scanner/event-builder.js';
import type { TechDetectionResult } from '@runtimescope/extension';
import type {
  RawDesignTokens,
  RawLayoutTree,
  RawAccessibility,
  RawFonts,
  RawAssets,
} from '../scanner/recon-collectors.js';

// --- Minimal mock data ---

function makeTechResults(): TechDetectionResult[] {
  return [
    {
      name: 'React',
      version: '18.2.0',
      confidence: 100,
      categories: [{ id: 12, name: 'JavaScript frameworks' }],
      website: 'https://reactjs.org',
      icon: 'React.svg',
    },
    {
      name: 'Next.js',
      version: '14.0.0',
      confidence: 90,
      categories: [{ id: 18, name: 'Web frameworks' }],
      website: 'https://nextjs.org',
      icon: 'Next.js.svg',
    },
    {
      name: 'Tailwind CSS',
      version: '3.4',
      confidence: 85,
      categories: [{ id: 66, name: 'UI frameworks' }],
      website: 'https://tailwindcss.com',
      icon: 'Tailwind CSS.svg',
    },
    {
      name: 'Vercel',
      version: '',
      confidence: 75,
      categories: [{ id: 62, name: 'PaaS' }],
      website: 'https://vercel.com',
      icon: 'Vercel.svg',
    },
    {
      name: 'webpack',
      version: '',
      confidence: 60,
      categories: [{ id: 19, name: 'Build tools' }],
      website: 'https://webpack.js.org',
      icon: 'webpack.svg',
    },
    {
      name: 'Google Analytics',
      version: '',
      confidence: 50,
      categories: [{ id: 10, name: 'Analytics' }],
      website: 'https://analytics.google.com',
      icon: 'Google Analytics.svg',
    },
  ];
}

function makeDesignTokens(): RawDesignTokens {
  return {
    customProperties: [
      { name: '--primary', value: '#3b82f6', source: ':root' },
      { name: '--background', value: '#ffffff', source: ':root' },
    ],
    colors: [
      { value: 'rgb(59, 130, 246)', hex: '#3b82f6', usageCount: 12, properties: ['color', 'background-color'], sampleSelectors: ['a.link'] },
    ],
    typography: [
      { fontFamily: 'Inter', fontSize: '16px', fontWeight: '400', lineHeight: '24px', letterSpacing: 'normal', usageCount: 45, sampleSelectors: ['p'] },
    ],
    spacing: [
      { value: '16px', pixels: 16, usageCount: 30, properties: ['padding', 'margin'] },
    ],
    borderRadii: [{ value: '8px', usageCount: 15 }],
    boxShadows: [{ value: '0 1px 3px rgba(0,0,0,0.1)', usageCount: 5 }],
    cssArchitecture: 'tailwind',
    classNamingPatterns: ['tailwind utilities'],
    sampleClassNames: ['flex', 'items-center', 'bg-white'],
  };
}

function makeLayoutTree(): RawLayoutTree {
  return {
    viewport: { width: 1280, height: 720 },
    scrollHeight: 2000,
    tree: {
      tag: 'body',
      classList: [],
      dataAttributes: {},
      boundingRect: { x: 0, y: 0, width: 1280, height: 2000 },
      display: 'block',
      position: 'static',
      children: [
        {
          tag: 'div',
          id: 'app',
          classList: ['app-root'],
          dataAttributes: {},
          boundingRect: { x: 0, y: 0, width: 1280, height: 2000 },
          display: 'flex',
          position: 'relative',
          flexDirection: 'column',
          children: [],
          childCount: 3,
        },
      ],
      childCount: 1,
    },
    totalElements: 42,
    maxDepth: 5,
  };
}

function makeAccessibility(): RawAccessibility {
  return {
    headings: [
      { level: 1, text: 'Welcome', selector: 'h1' },
      { level: 2, text: 'Features', selector: 'h2.features' },
    ],
    landmarks: [
      { role: 'navigation', label: 'Main', selector: 'nav.main' },
      { role: 'main', selector: 'main' },
    ],
    formFields: [
      { tag: 'input', type: 'email', name: 'email', label: 'Email', required: true, selector: 'input.email' },
    ],
    links: [{ tag: 'a', text: 'Home', href: '/', selector: 'a.home' }],
    buttons: [{ tag: 'button', text: 'Submit', selector: 'button.submit' }],
    images: [{ src: '/logo.png', alt: 'Logo', hasAlt: true, selector: 'img.logo' }],
    issues: ['Heading level skip: h1 → h3'],
  };
}

function makeFonts(): RawFonts {
  return {
    fontFaces: [
      { family: 'Inter', weight: '400', style: 'normal', src: '/fonts/inter.woff2', display: 'swap' },
      { family: 'Inter', weight: '700', style: 'normal', src: '/fonts/inter-bold.woff2', display: 'swap' },
    ],
    fontsUsed: [
      { family: 'Inter', weight: '400', style: 'normal', usageCount: 120, sampleSelectors: ['p', 'span'] },
    ],
    iconFonts: [],
    loadingStrategy: 'font-display: swap + woff2',
  };
}

function makeAssets(): RawAssets {
  return {
    images: [
      { src: '/hero.webp', alt: 'Hero', width: 1200, height: 600, naturalWidth: 2400, naturalHeight: 1200, format: 'webp', selector: 'img.hero' },
    ],
    inlineSVGs: [
      { selector: 'svg.icon', viewBox: '0 0 24 24', width: 24, height: 24, source: '<svg>...</svg>' },
    ],
    svgSprites: [],
    backgroundSprites: [],
    maskSprites: [],
    iconFonts: [],
    totalAssets: 2,
  };
}

describe('buildReconEvents', () => {
  const url = 'https://example.com';
  const title = 'Example Site';
  const sessionId = 'scan-12345';
  const viewport = { width: 1280, height: 720 };
  const meta = { description: 'A test site', 'og:title': 'Example' };
  const scriptSrcs = ['/_next/static/chunks/main.js'];
  const stylesheetHrefs = ['/styles.css'];

  function buildEvents() {
    return buildReconEvents(
      url, title, sessionId,
      makeTechResults(),
      makeDesignTokens(),
      makeLayoutTree(),
      makeAccessibility(),
      makeFonts(),
      makeAssets(),
      viewport,
      meta,
      scriptSrcs,
      stylesheetHrefs,
    );
  }

  it('produces exactly 6 events', () => {
    const events = buildEvents();
    expect(events).toHaveLength(6);
  });

  it('all events share the same sessionId', () => {
    const events = buildEvents();
    for (const event of events) {
      expect(event.sessionId).toBe(sessionId);
    }
  });

  it('all events have unique eventIds', () => {
    const events = buildEvents();
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(6);
  });

  it('all events have timestamps', () => {
    const events = buildEvents();
    for (const event of events) {
      expect(event.timestamp).toBeGreaterThan(0);
    }
  });

  it('produces a ReconMetadataEvent first', () => {
    const events = buildEvents();
    expect(events[0].eventType).toBe('recon_metadata');
  });

  it('maps framework correctly in metadata', () => {
    const events = buildEvents();
    const metadata = events[0] as { techStack: { framework: { name: string; confidence: string; version: string } } };
    expect(metadata.techStack.framework.name).toBe('react');
    expect(metadata.techStack.framework.confidence).toBe('high');
    expect(metadata.techStack.framework.version).toBe('18.2.0');
  });

  it('maps metaFramework in metadata', () => {
    const events = buildEvents();
    const metadata = events[0] as { techStack: { metaFramework: { name: string } } };
    expect(metadata.techStack.metaFramework?.name).toBe('next.js');
  });

  it('maps uiLibrary in metadata', () => {
    const events = buildEvents();
    const metadata = events[0] as { techStack: { uiLibrary: { name: string } } };
    expect(metadata.techStack.uiLibrary?.name).toBe('tailwind css');
  });

  it('maps hosting in metadata', () => {
    const events = buildEvents();
    const metadata = events[0] as { techStack: { hosting: { name: string } } };
    expect(metadata.techStack.hosting?.name).toBe('vercel');
  });

  it('includes additional techs that dont fit main categories', () => {
    const events = buildEvents();
    const metadata = events[0] as { techStack: { additional: Array<{ name: string }> } };
    expect(metadata.techStack.additional.some((t) => t.name === 'Google Analytics')).toBe(true);
  });

  it('includes external scripts and stylesheets', () => {
    const events = buildEvents();
    const metadata = events[0] as { externalScripts: Array<{ src: string }>; externalStylesheets: Array<{ href: string }> };
    expect(metadata.externalScripts[0].src).toBe('/_next/static/chunks/main.js');
    expect(metadata.externalStylesheets[0].href).toBe('/styles.css');
  });

  it('produces a ReconDesignTokensEvent second', () => {
    const events = buildEvents();
    expect(events[1].eventType).toBe('recon_design_tokens');
    const tokens = events[1] as { customProperties: Array<{ name: string }> };
    expect(tokens.customProperties).toHaveLength(2);
    expect(tokens.customProperties[0].name).toBe('--primary');
  });

  it('produces a ReconLayoutTreeEvent third', () => {
    const events = buildEvents();
    expect(events[2].eventType).toBe('recon_layout_tree');
    const layout = events[2] as { totalElements: number; maxDepth: number };
    expect(layout.totalElements).toBe(42);
    expect(layout.maxDepth).toBe(5);
  });

  it('produces a ReconAccessibilityEvent fourth', () => {
    const events = buildEvents();
    expect(events[3].eventType).toBe('recon_accessibility');
    const a11y = events[3] as { headings: Array<unknown>; issues: string[] };
    expect(a11y.headings).toHaveLength(2);
    expect(a11y.issues).toHaveLength(1);
  });

  it('produces a ReconFontsEvent fifth', () => {
    const events = buildEvents();
    expect(events[4].eventType).toBe('recon_fonts');
    const fonts = events[4] as { fontFaces: Array<unknown>; fontsUsed: Array<unknown> };
    expect(fonts.fontFaces).toHaveLength(2);
    expect(fonts.fontsUsed).toHaveLength(1);
  });

  it('produces a ReconAssetInventoryEvent sixth', () => {
    const events = buildEvents();
    expect(events[5].eventType).toBe('recon_asset_inventory');
    const assets = events[5] as { images: Array<unknown>; totalAssets: number };
    expect(assets.images).toHaveLength(1);
    expect(assets.totalAssets).toBe(2);
  });

  it('sets confidence levels correctly based on thresholds', () => {
    const events = buildEvents();
    const metadata = events[0] as {
      techStack: {
        framework: { confidence: string };
        metaFramework: { confidence: string };
        hosting: { confidence: string };
      };
    };
    // React = 100% => high
    expect(metadata.techStack.framework.confidence).toBe('high');
    // Next.js = 90% => high
    expect(metadata.techStack.metaFramework.confidence).toBe('high');
    // Vercel = 75% => high (>= 75)
    expect(metadata.techStack.hosting.confidence).toBe('high');
  });

  it('handles empty tech results gracefully', () => {
    const events = buildReconEvents(
      url, title, sessionId,
      [],
      makeDesignTokens(),
      makeLayoutTree(),
      makeAccessibility(),
      makeFonts(),
      makeAssets(),
      viewport,
      meta,
      scriptSrcs,
      stylesheetHrefs,
    );
    expect(events).toHaveLength(6);
    const metadata = events[0] as { techStack: { framework: { name: string; confidence: string } } };
    expect(metadata.techStack.framework.name).toBe('unknown');
    expect(metadata.techStack.framework.confidence).toBe('low');
  });

  it('includes url on all events', () => {
    const events = buildEvents();
    for (const event of events) {
      expect((event as { url: string }).url).toBe(url);
    }
  });
});
