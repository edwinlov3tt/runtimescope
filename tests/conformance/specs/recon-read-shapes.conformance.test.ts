/**
 * Conformance: recon READ tool OUTPUT SHAPES (the "clone-ui / recon" family).
 *
 * Audit 0002 #2: ~57 MCP tools were ported by agents and compiled but never
 * behavior-verified. The six recon READ tools below are pure store readers —
 * they pull the LATEST recon_* event for a URL and reshape it into the standard
 * envelope, deriving issues/summary/timeRange on the way. A naive port can
 * compile while returning the raw event verbatim, dropping the derived issues,
 * ignoring the per-tool category filter, or emitting `data: null`. None of
 * those would be caught by an existence/count check, so this spec pins the REAL
 * contract of each tool as implemented by the Node mcp-server.
 *
 * Source of truth (ADR-0006): packages/mcp-server/src/tools/recon-*.ts
 *   - recon-metadata.ts        get_page_metadata
 *   - recon-design-tokens.ts   get_design_tokens
 *   - recon-fonts.ts           get_font_info
 *   - recon-layout.ts          get_layout_tree
 *   - recon-accessibility.ts   get_accessibility_tree
 *   - recon-assets.ts          get_asset_inventory
 * Event shapes: packages/collector/src/types.ts (Recon* event interfaces).
 *
 * These tools READ stored events — no browser/scan needed. We inject the recon
 * events straight into the embedded collector via the SdkDriver WS path (the
 * same path the extension uses) and call each tool WITHOUT force_refresh so it
 * reads the stored event. Each assertion pins specific reshaped/derived fields
 * — a tool that returned `data: null` (empty stub) or echoed the raw event
 * would fail.
 *
 * Drives the real mcp-server over stdio. RUNTIMESCOPE_MCP_CMD swaps the Rust bin
 * later; default is the Node mcp-server (the source of truth here).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver, SdkDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const PROJECT = 'proj_conf_recon_read';
const URL = 'https://recon.example.com/clone-me';
const TS = 1_700_000_000_000; // fixed epoch ms so timeRange is exactly assertable

let evtSeq = 0;
function baseFields(sessionId: string, eventType: string): Record<string, unknown> {
  return {
    eventId: `recon-${eventType}-${++evtSeq}`,
    sessionId,
    timestamp: TS,
    eventType,
    url: URL,
  };
}

interface ReconEnvelope {
  summary: string;
  data: Record<string, unknown> | null;
  issues: string[];
  metadata: {
    timeRange: { from: number; to: number };
    eventCount: number;
    sessionId: string;
    projectId: string | null;
  };
}

/** Common envelope-shape assertions every recon READ tool must satisfy. */
function assertEnvelopeShape(env: ReconEnvelope): void {
  expect(typeof env.summary).toBe('string');
  expect(env.data).not.toBeNull();
  expect(Array.isArray(env.issues)).toBe(true);
  // A populated stored event reshapes to eventCount 1 + a single-point timeRange.
  expect(env.metadata.eventCount).toBe(1);
  expect(env.metadata.timeRange.from).toBe(TS);
  expect(env.metadata.timeRange.to).toBe(TS);
  // The tool stamps the project_id arg back onto metadata.projectId.
  expect(env.metadata.projectId).toBe(PROJECT);
}

describe('recon READ tool output shapes (clone-ui family, vs Node mcp-server)', () => {
  it('reshapes + derives all six recon READ tools from stored events', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();

    const driver = new SdkDriver({ wsPort: mcp.wsPort, appName: 'conf-recon', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 150));
    const sid = driver.sessionId;

    // --- recon_metadata ---
    // techStack.framework is high-confidence react (no low-confidence issue),
    // but metaTags has NO viewport key -> tool must derive "No viewport meta tag".
    const metadata = {
      ...baseFields(sid, 'recon_metadata'),
      title: 'Clone Me',
      viewport: { width: 1280, height: 720 },
      documentLang: 'en',
      metaTags: { description: 'a page', 'og:title': 'Clone Me' }, // intentionally no "viewport"
      techStack: {
        framework: { name: 'react', confidence: 'high', version: '18.2.0', evidence: ['__REACT__'] },
        metaFramework: { name: 'nextjs', confidence: 'high', evidence: ['__NEXT_DATA__'] },
        uiLibrary: { name: 'tailwind', confidence: 'medium', evidence: ['utility classes'] },
        buildTool: { name: 'webpack', confidence: 'medium', evidence: ['webpackChunk'] },
        hosting: { name: 'vercel', confidence: 'high', evidence: ['x-vercel-id'] },
        stateManagement: { name: 'redux', confidence: 'low', evidence: ['__REDUX__'] },
        additional: [{ name: 'sentry', confidence: 'high', evidence: ['Sentry global'] }],
      },
      externalStylesheets: [{ href: 'https://cdn.example.com/app.css', crossOrigin: true }],
      externalScripts: [{ src: 'https://cdn.example.com/app.js', async: true, defer: false, type: 'module' }],
      preloads: [{ href: 'https://cdn.example.com/font.woff2', as: 'font' }],
    };

    // --- recon_design_tokens ---
    // 0 custom properties -> derives the "no CSS custom properties" issue.
    const designTokens = {
      ...baseFields(sid, 'recon_design_tokens'),
      customProperties: [], // -> issue
      colors: [
        { value: '#3b82f6', hex: '#3b82f6', usageCount: 12, properties: ['color'], sampleSelectors: ['.btn'] },
        { value: 'rgb(0,0,0)', hex: '#000000', usageCount: 30, properties: ['background-color'], sampleSelectors: ['body'] },
      ],
      typography: [
        { fontFamily: 'Inter', fontSize: '16px', fontWeight: '400', lineHeight: '1.5', letterSpacing: 'normal', usageCount: 40, sampleSelectors: ['p'] },
      ],
      spacing: [
        { value: '16px', pixels: 16, usageCount: 22, properties: ['padding'] },
        { value: '8px', pixels: 8, usageCount: 11, properties: ['gap'] },
      ],
      borderRadii: [{ value: '8px', usageCount: 5 }],
      boxShadows: [{ value: '0 1px 2px rgba(0,0,0,0.1)', usageCount: 3 }],
      cssArchitecture: 'tailwind',
      classNamingPatterns: ['tailwind utilities'],
      sampleClassNames: ['flex', 'p-4', 'text-blue-500'],
    };

    // --- recon_fonts ---
    // One @font-face WITHOUT a `display` field -> derives the FOIT issue.
    const fonts = {
      ...baseFields(sid, 'recon_fonts'),
      fontFaces: [
        { family: 'Inter', weight: '400', style: 'normal', src: 'inter.woff2', display: 'swap' },
        { family: 'IconFont', weight: '400', style: 'normal', src: 'icons.woff2' }, // no display -> issue
      ],
      fontsUsed: [
        { family: 'Inter', weight: '400', style: 'normal', usageCount: 50, sampleSelectors: ['body'] },
        { family: 'Mono', weight: '500', style: 'normal', usageCount: 4, sampleSelectors: ['code'] },
      ],
      iconFonts: [{ family: 'IconFont', glyphsUsed: [{ codepoint: 'e001', selector: '.icon-home' }] }],
      loadingStrategy: 'self-hosted woff2',
    };

    // --- recon_layout_tree ---
    // Root <main> is flex; one child div is grid -> tool derives flex=1, grid=1
    // counts into the summary. childCount/totalElements pinned.
    const layoutTree = {
      ...baseFields(sid, 'recon_layout_tree'),
      viewport: { width: 1280, height: 720 },
      scrollHeight: 2400,
      tree: {
        tag: 'main', classList: ['container'], dataAttributes: {},
        boundingRect: { x: 0, y: 0, width: 1280, height: 2400 },
        display: 'flex', position: 'relative', flexDirection: 'column', gap: '16px',
        children: [
          {
            tag: 'div', classList: ['grid-area'], dataAttributes: {},
            boundingRect: { x: 0, y: 0, width: 1280, height: 600 },
            display: 'grid', position: 'static', gridTemplateColumns: '1fr 1fr',
            children: [], childCount: 0,
          },
        ],
        childCount: 1,
      },
      totalElements: 2,
      maxDepth: 2,
    };

    // --- recon_accessibility ---
    // Heading order h1 -> h3 (skips h2) and one image without alt -> the tool
    // appends derived issues ON TOP of the event's own issues array. Also no
    // <main>/<nav> landmark present -> two more derived issues.
    const accessibility = {
      ...baseFields(sid, 'recon_accessibility'),
      headings: [
        { level: 1, text: 'Title', selector: 'h1' },
        { level: 3, text: 'Sub', selector: 'h3' }, // h1 -> h3 skip -> derived issue
      ],
      landmarks: [{ role: 'banner', selector: 'header' }], // no main, no navigation
      formFields: [
        { tag: 'input', type: 'email', name: 'email', label: 'Email', required: true, selector: '#email' },
      ],
      links: [{ tag: 'a', text: 'Home', href: '/', selector: 'a.home' }],
      buttons: [{ tag: 'button', text: 'Submit', selector: 'button.submit' }],
      images: [
        { src: '/logo.png', alt: 'Logo', hasAlt: true, selector: 'img.logo' },
        { src: '/banner.png', alt: '', hasAlt: false, selector: 'img.banner' }, // missing alt -> issue
      ],
      issues: ['Color contrast below WCAG AA on .muted'], // event's own pre-existing issue
    };

    // --- recon_asset_inventory ---
    // One image missing alt -> derived issue. iconFonts with 2 glyphs -> derived
    // "icon font glyph(s)" issue. totalAssets echoed into the summary.
    const assets = {
      ...baseFields(sid, 'recon_asset_inventory'),
      images: [
        { src: '/a.png', alt: 'A', width: 100, height: 100, naturalWidth: 100, naturalHeight: 100, format: 'png', loading: 'lazy', selector: 'img.a' },
        { src: '/b.png', alt: '', width: 50, height: 50, format: 'png', selector: 'img.b' }, // missing alt -> issue
      ],
      inlineSVGs: [{ selector: 'svg.icon', viewBox: '0 0 24 24', width: 24, height: 24, source: '<svg/>' }],
      svgSprites: [],
      backgroundSprites: [],
      maskSprites: [],
      iconFonts: [
        {
          fontFamily: 'IconFont',
          glyphs: [
            { codepoint: 'e001', pseudoElement: '::before', selector: '.icon-home', renderedSize: 16 },
            { codepoint: 'e002', pseudoElement: '::before', selector: '.icon-user', renderedSize: 16 },
          ],
        },
      ],
      totalAssets: 5,
    };

    driver.sendBatch([metadata, designTokens, fonts, layoutTree, accessibility, assets]);
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    // ============================================================
    // get_page_metadata
    // ============================================================
    {
      const { envelope } = await mcp.callTool('get_page_metadata', { project_id: PROJECT, url: URL });
      const env = envelope as ReconEnvelope;
      assertEnvelopeShape(env);
      const d = env.data as {
        url: string; title: string; viewport: { width: number; height: number };
        documentLang: string; metaTags: Record<string, string>;
        techStack: {
          framework: { name: string; confidence: string; version?: string };
          metaFramework: { name: string } | null;
          uiLibrary: { name: string } | null;
          buildTool: { name: string } | null;
          hosting: { name: string } | null;
          stateManagement: { name: string } | null;
          additional: Array<{ name: string }>;
        };
        externalStylesheets: Array<{ href: string; crossOrigin: boolean }>;
        externalScripts: Array<{ src: string; async: boolean; defer: boolean; type?: string }>;
        preloads: Array<{ href: string; as: string }>;
      };
      // Field fidelity round-trips the stored event.
      expect(d.url).toBe(URL);
      expect(d.title).toBe('Clone Me');
      expect(d.viewport).toEqual({ width: 1280, height: 720 });
      expect(d.documentLang).toBe('en');
      // techStack is reshaped into a fixed-key object; optional members become null when absent
      // (here all present, so assert the names + that the framework version survives).
      expect(d.techStack.framework.name).toBe('react');
      expect(d.techStack.framework.version).toBe('18.2.0');
      expect(d.techStack.metaFramework?.name).toBe('nextjs');
      expect(d.techStack.uiLibrary?.name).toBe('tailwind');
      expect(d.techStack.hosting?.name).toBe('vercel');
      expect(Array.isArray(d.techStack.additional)).toBe(true);
      expect(d.techStack.additional[0].name).toBe('sentry');
      expect(d.externalStylesheets[0].href).toBe('https://cdn.example.com/app.css');
      expect(d.externalScripts[0].src).toBe('https://cdn.example.com/app.js');
      expect(d.preloads[0].as).toBe('font');
      // DERIVED issue: metaTags has no "viewport" key.
      expect(env.issues).toContain('No viewport meta tag detected');
      // High-confidence framework => NO low-confidence issue.
      expect(env.issues.some((i) => i.includes('confidence is low'))).toBe(false);
      // Summary derives stylesheet/script counts.
      expect(env.summary).toContain('1 stylesheets');
      expect(env.summary).toContain('1 scripts');
    }

    // ============================================================
    // get_design_tokens (default category 'all')
    // ============================================================
    {
      const { envelope } = await mcp.callTool('get_design_tokens', { project_id: PROJECT, url: URL });
      const env = envelope as ReconEnvelope;
      assertEnvelopeShape(env);
      const d = env.data as {
        customProperties: unknown[];
        colors: Array<{ hex: string; usageCount: number }>;
        typography: unknown[];
        spacing: unknown[];
        borderRadii: unknown[];
        boxShadows: unknown[];
        cssArchitecture: string;
        classNamingPatterns: unknown[];
        sampleClassNames: unknown[];
      };
      // 'all' includes every category + architecture metadata.
      expect(Array.isArray(d.customProperties)).toBe(true);
      expect(d.customProperties.length).toBe(0);
      expect(d.colors.length).toBe(2);
      expect(d.colors[0].hex).toBe('#3b82f6');
      expect(d.spacing.length).toBe(2);
      expect(d.borderRadii.length).toBe(1);
      expect(d.boxShadows.length).toBe(1);
      // 'all'-only fields are present.
      expect(d.cssArchitecture).toBe('tailwind');
      expect(Array.isArray(d.classNamingPatterns)).toBe(true);
      expect(Array.isArray(d.sampleClassNames)).toBe(true);
      // DERIVED issue: 0 custom properties.
      expect(env.issues.some((i) => i.includes('No CSS custom properties'))).toBe(true);
      // 2 colors (<=30) so no "inconsistent color system" issue.
      expect(env.issues.some((i) => i.includes('inconsistent color system'))).toBe(false);
      expect(env.summary).toContain('2 colors');
    }

    // ============================================================
    // get_design_tokens with category='colors' (filter drops other categories)
    // ============================================================
    {
      const { envelope } = await mcp.callTool('get_design_tokens', { project_id: PROJECT, url: URL, category: 'colors' });
      const env = envelope as ReconEnvelope;
      const d = env.data as Record<string, unknown>;
      // Only colors present; spacing/typography/custom_properties/architecture excluded.
      expect(d.colors).toBeDefined();
      expect((d.colors as unknown[]).length).toBe(2);
      expect(d.spacing).toBeUndefined();
      expect(d.typography).toBeUndefined();
      expect(d.customProperties).toBeUndefined();
      expect(d.cssArchitecture).toBeUndefined();
    }

    // ============================================================
    // get_font_info
    // ============================================================
    {
      const { envelope } = await mcp.callTool('get_font_info', { project_id: PROJECT, url: URL });
      const env = envelope as ReconEnvelope;
      assertEnvelopeShape(env);
      const d = env.data as {
        fontFaces: Array<{ family: string; display?: string }>;
        fontsUsed: Array<{ family: string }>;
        iconFonts: Array<{ family: string }>;
        loadingStrategy: string;
      };
      expect(d.fontFaces.length).toBe(2);
      expect(d.fontsUsed.length).toBe(2);
      expect(d.iconFonts[0].family).toBe('IconFont');
      expect(d.loadingStrategy).toBe('self-hosted woff2');
      // DERIVED issue: exactly one @font-face without font-display -> FOIT warning.
      expect(env.issues).toContain('1 @font-face rule(s) without font-display — may cause FOIT (flash of invisible text).');
      // 2 unique families (<=5) so no "different font families" perf issue.
      expect(env.issues.some((i) => i.includes('different font families'))).toBe(false);
      // Summary derives the 2 distinct families used.
      expect(env.summary).toContain('2 font families in use');
    }

    // ============================================================
    // get_layout_tree
    // ============================================================
    {
      const { envelope } = await mcp.callTool('get_layout_tree', { project_id: PROJECT, url: URL });
      const env = envelope as ReconEnvelope;
      assertEnvelopeShape(env);
      const d = env.data as {
        viewport: { width: number; height: number };
        scrollHeight: number;
        rootSelector: string | null;
        tree: { tag: string; display: string; children: Array<{ tag: string; display: string }> };
        totalElements: number;
        maxDepth: number;
      };
      expect(d.viewport).toEqual({ width: 1280, height: 720 });
      expect(d.scrollHeight).toBe(2400);
      // No selector requested -> rootSelector null (event had no rootSelector).
      expect(d.rootSelector).toBeNull();
      expect(d.tree.tag).toBe('main');
      expect(d.tree.display).toBe('flex');
      expect(d.tree.children[0].tag).toBe('div');
      expect(d.tree.children[0].display).toBe('grid');
      expect(d.totalElements).toBe(2);
      expect(d.maxDepth).toBe(2);
      // DERIVED summary: 1 flex container + 1 grid container counted from the tree.
      expect(env.summary).toContain('1 flex containers');
      expect(env.summary).toContain('1 grid containers');
      expect(env.summary).toContain('Viewport: 1280x720');
    }

    // ============================================================
    // get_accessibility_tree
    // ============================================================
    {
      const { envelope } = await mcp.callTool('get_accessibility_tree', { project_id: PROJECT, url: URL });
      const env = envelope as ReconEnvelope;
      assertEnvelopeShape(env);
      const d = env.data as {
        headings: Array<{ level: number }>;
        landmarks: Array<{ role: string }>;
        formFields: unknown[];
        buttons: unknown[];
        links: unknown[];
        images: Array<{ hasAlt: boolean }>;
      };
      expect(d.headings.length).toBe(2);
      expect(d.landmarks.length).toBe(1);
      expect(d.formFields.length).toBe(1);
      expect(d.buttons.length).toBe(1);
      expect(d.links.length).toBe(1);
      expect(d.images.length).toBe(2);
      // The tool seeds issues from the event's OWN issues then appends derived ones.
      expect(env.issues).toContain('Color contrast below WCAG AA on .muted'); // event's own
      expect(env.issues).toContain('Heading level skip: h1 → h3 (missing h2).'); // derived
      expect(env.issues).toContain('1 image(s) missing alt text.'); // derived
      expect(env.issues).toContain('No <main> landmark found.'); // derived
      expect(env.issues).toContain('No <nav> landmark found.'); // derived
      // Summary echoes the derived issue count (all issues, incl. the event's own).
      expect(env.summary).toContain(`${env.issues.length} accessibility issue(s)`);
    }

    // ============================================================
    // get_asset_inventory (default category 'all')
    // ============================================================
    {
      const { envelope } = await mcp.callTool('get_asset_inventory', { project_id: PROJECT, url: URL });
      const env = envelope as ReconEnvelope;
      assertEnvelopeShape(env);
      const d = env.data as {
        images: Array<{ alt?: string }>;
        inlineSVGs: unknown[];
        svgSprites: unknown[];
        backgroundSprites: unknown[];
        maskSprites: unknown[];
        iconFonts: Array<{ fontFamily: string; glyphs: unknown[] }>;
      };
      // 'all' includes every category bucket.
      expect(d.images.length).toBe(2);
      expect(d.inlineSVGs.length).toBe(1);
      expect(Array.isArray(d.svgSprites)).toBe(true);
      expect(Array.isArray(d.backgroundSprites)).toBe(true);
      expect(Array.isArray(d.maskSprites)).toBe(true);
      expect(d.iconFonts[0].fontFamily).toBe('IconFont');
      expect(d.iconFonts[0].glyphs.length).toBe(2);
      // DERIVED issues: one image missing alt + total icon glyph count.
      expect(env.issues).toContain('1 image(s) missing alt text.');
      expect(env.issues).toContain('2 icon font glyph(s) from 1 font(s) detected.');
      // Summary echoes totalAssets from the stored event.
      expect(env.summary).toContain('5 total assets');
    }

    // ============================================================
    // category filter on get_asset_inventory: 'icon_fonts' drops images/svgs.
    // ============================================================
    {
      const { envelope } = await mcp.callTool('get_asset_inventory', { project_id: PROJECT, url: URL, category: 'icon_fonts' });
      const env = envelope as ReconEnvelope;
      const d = env.data as Record<string, unknown>;
      expect(d.iconFonts).toBeDefined();
      expect((d.iconFonts as unknown[]).length).toBe(1);
      // images/svgs excluded by the category filter.
      expect(d.images).toBeUndefined();
      expect(d.inlineSVGs).toBeUndefined();
      expect(d.backgroundSprites).toBeUndefined();
      // The "missing alt text" issue is NOT derived when images aren't in scope.
      expect(env.issues.some((i) => i.includes('missing alt text'))).toBe(false);
      // The icon-glyph issue IS still derived (icon_fonts is in scope).
      expect(env.issues).toContain('2 icon font glyph(s) from 1 font(s) detected.');
    }

    await driver.close();
  });
});
