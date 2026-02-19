import type { Page } from 'playwright';

// ============================================================
// Raw data types returned from page.evaluate
// ============================================================

export interface RawDesignTokens {
  customProperties: Array<{ name: string; value: string; source: string }>;
  colors: Array<{ value: string; hex: string; usageCount: number; properties: string[]; sampleSelectors: string[] }>;
  typography: Array<{ fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; usageCount: number; sampleSelectors: string[] }>;
  spacing: Array<{ value: string; pixels: number; usageCount: number; properties: string[] }>;
  borderRadii: Array<{ value: string; usageCount: number }>;
  boxShadows: Array<{ value: string; usageCount: number }>;
  cssArchitecture: string;
  classNamingPatterns: string[];
  sampleClassNames: string[];
}

export interface RawLayoutNode {
  tag: string;
  id?: string;
  classList: string[];
  dataAttributes: Record<string, string>;
  role?: string;
  ariaLabel?: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  display: string;
  position: string;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  gridTemplateColumns?: string;
  gridTemplateRows?: string;
  gap?: string;
  children: RawLayoutNode[];
  childCount: number;
  textContent?: string;
}

export interface RawLayoutTree {
  viewport: { width: number; height: number };
  scrollHeight: number;
  tree: RawLayoutNode;
  totalElements: number;
  maxDepth: number;
}

export interface RawAccessibility {
  headings: Array<{ level: number; text: string; selector: string }>;
  landmarks: Array<{ role: string; label?: string; selector: string }>;
  formFields: Array<{ tag: string; type?: string; name?: string; label?: string; required: boolean; selector: string }>;
  links: Array<{ tag: string; text: string; href: string; selector: string }>;
  buttons: Array<{ tag: string; text: string; role?: string; selector: string }>;
  images: Array<{ src: string; alt: string; hasAlt: boolean; selector: string }>;
  issues: string[];
}

export interface RawFonts {
  fontFaces: Array<{ family: string; weight: string; style: string; src: string; display?: string }>;
  fontsUsed: Array<{ family: string; weight: string; style: string; usageCount: number; sampleSelectors: string[] }>;
  iconFonts: Array<{ fontFamily: string; fontFaceUrl?: string; glyphs: Array<{ codepoint: string; pseudoElement: string; selector: string; renderedSize: number }> }>;
  loadingStrategy: string;
}

export interface RawAssets {
  images: Array<{ src: string; alt: string; width: number; height: number; naturalWidth: number; naturalHeight: number; format: string; selector: string }>;
  inlineSVGs: Array<{ selector: string; viewBox: string; width: number; height: number; source: string }>;
  svgSprites: Array<{ id: string; viewBox: string; paths: string; referencedBy: string[] }>;
  backgroundSprites: Array<{ sheetUrl: string; sheetWidth: number; sheetHeight: number; frames: Array<{ selector: string; cropX: number; cropY: number; cropWidth: number; cropHeight: number }> }>;
  maskSprites: never[];
  iconFonts: Array<{ fontFamily: string; fontFaceUrl?: string; glyphs: Array<{ codepoint: string; pseudoElement: string; selector: string; renderedSize: number }> }>;
  totalAssets: number;
}

// ============================================================
// Collectors
// ============================================================

export async function collectDesignTokens(page: Page): Promise<RawDesignTokens> {
  return page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);

    // CSS custom properties from :root
    const customProperties: Array<{ name: string; value: string; source: string }> = [];
    for (let i = 0; i < rootStyle.length; i++) {
      const prop = rootStyle[i];
      if (prop.startsWith('--')) {
        customProperties.push({ name: prop, value: rootStyle.getPropertyValue(prop).trim(), source: ':root' });
      }
    }

    // Sample elements for colors, typography, spacing
    const colorMap = new Map<string, { count: number; properties: Set<string>; selectors: Set<string> }>();
    const typoMap = new Map<string, { count: number; selectors: Set<string>; parsed: { fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string } }>();
    const spacingMap = new Map<string, { count: number; properties: Set<string> }>();
    const radiusMap = new Map<string, number>();
    const shadowMap = new Map<string, number>();

    // Sample up to 200 visible elements
    const allElements = document.querySelectorAll('body *');
    const sampleLimit = Math.min(allElements.length, 200);
    for (let i = 0; i < sampleLimit; i++) {
      const el = allElements[i];
      const elRect = el.getBoundingClientRect();
      if (elRect.width === 0 && elRect.height === 0) continue;

      const cs = getComputedStyle(el);
      const cls = el.getAttribute('class') || '';
      const selector = el.tagName.toLowerCase() + (cls ? '.' + cls.split(' ')[0] : '');

      // Colors
      for (const prop of ['color', 'background-color', 'border-color'] as const) {
        const val = cs.getPropertyValue(prop);
        if (val && val !== 'rgba(0, 0, 0, 0)' && val !== 'transparent') {
          const entry = colorMap.get(val) || { count: 0, properties: new Set(), selectors: new Set() };
          entry.count++;
          entry.properties.add(prop);
          if (entry.selectors.size < 3) entry.selectors.add(selector);
          colorMap.set(val, entry);
        }
      }

      // Typography
      const typoKey = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.lineHeight}|${cs.letterSpacing}`;
      const typoEntry = typoMap.get(typoKey) || {
        count: 0, selectors: new Set(),
        parsed: { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing },
      };
      typoEntry.count++;
      if (typoEntry.selectors.size < 3) typoEntry.selectors.add(selector);
      typoMap.set(typoKey, typoEntry);

      // Spacing (padding, margin, gap)
      for (const prop of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap'] as const) {
        const val = cs.getPropertyValue(prop);
        if (val && val !== '0px' && val !== 'normal' && val !== 'auto') {
          const entry = spacingMap.get(val) || { count: 0, properties: new Set() };
          entry.count++;
          entry.properties.add(prop.replace(/-(?:top|right|bottom|left)/, ''));
          spacingMap.set(val, entry);
        }
      }

      // Border radii
      const radius = cs.borderRadius;
      if (radius && radius !== '0px') {
        radiusMap.set(radius, (radiusMap.get(radius) || 0) + 1);
      }

      // Box shadows
      const shadow = cs.boxShadow;
      if (shadow && shadow !== 'none') {
        shadowMap.set(shadow, (shadowMap.get(shadow) || 0) + 1);
      }
    }

    // Convert to hex helper
    function rgbToHex(rgb: string): string {
      const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!match) return rgb;
      return '#' + [match[1], match[2], match[3]]
        .map((n) => parseInt(n).toString(16).padStart(2, '0'))
        .join('');
    }

    const colors = Array.from(colorMap.entries())
      .map(([value, data]) => ({
        value, hex: rgbToHex(value), usageCount: data.count,
        properties: Array.from(data.properties), sampleSelectors: Array.from(data.selectors),
      }))
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 50);

    const typography = Array.from(typoMap.values())
      .map((data) => ({
        ...data.parsed, usageCount: data.count, sampleSelectors: Array.from(data.selectors),
      }))
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 30);

    const spacing = Array.from(spacingMap.entries())
      .map(([value, data]) => ({
        value, pixels: parseFloat(value) || 0, usageCount: data.count,
        properties: Array.from(data.properties),
      }))
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 30);

    const borderRadii = Array.from(radiusMap.entries())
      .map(([value, count]) => ({ value, usageCount: count }))
      .sort((a, b) => b.usageCount - a.usageCount);

    const boxShadows = Array.from(shadowMap.entries())
      .map(([value, count]) => ({ value, usageCount: count }))
      .sort((a, b) => b.usageCount - a.usageCount);

    // CSS architecture detection
    const sampleClassNames: string[] = [];
    const classCounts = { tailwind: 0, bem: 0, modules: 0, atomic: 0, vanilla: 0 };
    document.querySelectorAll('[class]').forEach((el) => {
      if (sampleClassNames.length < 20) {
        for (const c of el.classList) sampleClassNames.push(c);
      }
      for (const c of el.classList) {
        if (/^(flex|grid|text-|bg-|p-|m-|w-|h-|gap-|items-|justify-)/.test(c)) classCounts.tailwind++;
        else if (/^[a-z]+--.+/.test(c) || /__/.test(c)) classCounts.bem++;
        else if (/^[a-zA-Z]+_[a-zA-Z0-9_]{5,}$/.test(c)) classCounts.modules++;
      }
    });

    let cssArchitecture = 'vanilla';
    const classNamingPatterns: string[] = [];
    if (classCounts.tailwind > 10) { cssArchitecture = 'tailwind'; classNamingPatterns.push('tailwind utilities'); }
    else if (classCounts.bem > 5) { cssArchitecture = 'bem'; classNamingPatterns.push('BEM naming'); }
    else if (classCounts.modules > 5) { cssArchitecture = 'css-modules'; classNamingPatterns.push('CSS Modules'); }

    return {
      customProperties, colors, typography, spacing, borderRadii, boxShadows,
      cssArchitecture, classNamingPatterns, sampleClassNames: sampleClassNames.slice(0, 20),
    };
  });
}

export async function collectLayoutTree(page: Page, maxDepth = 6): Promise<RawLayoutTree> {
  return page.evaluate((maxD: number) => {
    function walkNode(el: Element, depth: number): RawLayoutNode | null {
      if (depth > maxD) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return null;

      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();

      const dataAttributes: Record<string, string> = {};
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-')) dataAttributes[attr.name] = attr.value;
      }

      const children: RawLayoutNode[] = [];
      let childCount = 0;
      for (const child of el.children) {
        childCount++;
        if (children.length < 20) { // Limit children per level
          const childNode = walkNode(child, depth + 1);
          if (childNode) children.push(childNode);
        }
      }

      const node: RawLayoutNode = {
        tag,
        classList: Array.from(el.classList),
        dataAttributes,
        boundingRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        display: cs.display,
        position: cs.position,
        children,
        childCount,
      };

      if (el.id) node.id = el.id;
      if (el.getAttribute('role')) node.role = el.getAttribute('role')!;
      if (el.getAttribute('aria-label')) node.ariaLabel = el.getAttribute('aria-label')!;

      // Flex props
      if (cs.display.includes('flex')) {
        node.flexDirection = cs.flexDirection;
        node.justifyContent = cs.justifyContent;
        node.alignItems = cs.alignItems;
      }
      // Grid props
      if (cs.display.includes('grid')) {
        node.gridTemplateColumns = cs.gridTemplateColumns;
        node.gridTemplateRows = cs.gridTemplateRows;
        node.gap = cs.gap;
      }
      // Text content for leaf-ish nodes
      if (el.children.length === 0 && el.textContent) {
        node.textContent = el.textContent.trim().slice(0, 100);
      }

      return node;
    }

    const body = document.body;
    const tree = walkNode(body, 0) || {
      tag: 'body', classList: [], dataAttributes: {},
      boundingRect: { x: 0, y: 0, width: 0, height: 0 },
      display: 'block', position: 'static', children: [], childCount: 0,
    };

    let totalElements = 0;
    function countDepth(node: RawLayoutNode, d: number): number {
      totalElements++;
      let max = d;
      for (const child of node.children) {
        max = Math.max(max, countDepth(child, d + 1));
      }
      return max;
    }
    const maxDepth = countDepth(tree, 0);

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollHeight: document.documentElement.scrollHeight,
      tree,
      totalElements,
      maxDepth,
    };

    // Type assertion for the recursive type used inside evaluate
    type RawLayoutNode = {
      tag: string; id?: string; classList: string[]; dataAttributes: Record<string, string>;
      role?: string; ariaLabel?: string;
      boundingRect: { x: number; y: number; width: number; height: number };
      display: string; position: string;
      flexDirection?: string; justifyContent?: string; alignItems?: string;
      gridTemplateColumns?: string; gridTemplateRows?: string; gap?: string;
      children: RawLayoutNode[]; childCount: number; textContent?: string;
    };
  }, maxDepth);
}

export async function collectAccessibility(page: Page): Promise<RawAccessibility> {
  return page.evaluate(() => {
    function getSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      const tag = el.tagName.toLowerCase();
      const cls = el.classList[0];
      return cls ? `${tag}.${cls}` : tag;
    }

    // Headings
    const headings: Array<{ level: number; text: string; selector: string }> = [];
    document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el) => {
      headings.push({
        level: parseInt(el.tagName[1]),
        text: (el.textContent || '').trim().slice(0, 100),
        selector: getSelector(el),
      });
    });

    // Landmarks
    const landmarks: Array<{ role: string; label?: string; selector: string }> = [];
    const landmarkEls = document.querySelectorAll('nav,main,aside,header,footer,section[aria-label],form[aria-label],[role="navigation"],[role="main"],[role="complementary"],[role="banner"],[role="contentinfo"],[role="search"]');
    landmarkEls.forEach((el) => {
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || undefined;
      landmarks.push({ role, label, selector: getSelector(el) });
    });

    // Form fields
    const formFields: Array<{ tag: string; type?: string; name?: string; label?: string; required: boolean; selector: string }> = [];
    document.querySelectorAll('input,select,textarea').forEach((el) => {
      const input = el as HTMLInputElement;
      const id = input.id;
      const label = id ? document.querySelector(`label[for="${id}"]`)?.textContent?.trim() : undefined;
      formFields.push({
        tag: el.tagName.toLowerCase(),
        type: input.type || undefined,
        name: input.name || undefined,
        label: label || input.getAttribute('aria-label') || input.placeholder || undefined,
        required: input.required,
        selector: getSelector(el),
      });
    });

    // Links (sample first 50)
    const links: Array<{ tag: string; text: string; href: string; selector: string }> = [];
    document.querySelectorAll('a[href]').forEach((el) => {
      if (links.length >= 50) return;
      const a = el as HTMLAnchorElement;
      links.push({
        tag: 'a',
        text: (a.textContent || '').trim().slice(0, 80),
        href: a.getAttribute('href') || '',
        selector: getSelector(el),
      });
    });

    // Buttons
    const buttons: Array<{ tag: string; text: string; role?: string; selector: string }> = [];
    document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]').forEach((el) => {
      buttons.push({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || (el as HTMLInputElement).value || '').trim().slice(0, 80),
        role: el.getAttribute('role') || undefined,
        selector: getSelector(el),
      });
    });

    // Images
    const images: Array<{ src: string; alt: string; hasAlt: boolean; selector: string }> = [];
    document.querySelectorAll('img').forEach((el) => {
      const img = el as HTMLImageElement;
      images.push({
        src: img.src,
        alt: img.alt,
        hasAlt: img.hasAttribute('alt') && img.alt.length > 0,
        selector: getSelector(el),
      });
    });

    // Issue detection
    const issues: string[] = [];
    // Check heading hierarchy
    let prevLevel = 0;
    for (const h of headings) {
      if (h.level > prevLevel + 1 && prevLevel > 0) {
        issues.push(`Heading level skip: h${prevLevel} → h${h.level}`);
      }
      prevLevel = h.level;
    }
    if (!landmarks.some((l) => l.role === 'main')) {
      issues.push('No <main> landmark found');
    }
    const missingAlt = images.filter((i) => !i.hasAlt);
    if (missingAlt.length > 0) {
      issues.push(`${missingAlt.length} image(s) missing alt text`);
    }

    return { headings, landmarks, formFields, links, buttons, images, issues };
  });
}

export async function collectFonts(page: Page): Promise<RawFonts> {
  return page.evaluate(() => {
    // Font faces from document.fonts API
    const fontFaces: Array<{ family: string; weight: string; style: string; src: string; display?: string }> = [];
    try {
      for (const face of document.fonts) {
        fontFaces.push({
          family: face.family.replace(/"/g, ''),
          weight: face.weight,
          style: face.style,
          src: '', // Not accessible from API
          display: face.display || undefined,
        });
      }
    } catch {
      // document.fonts may not be available
    }

    // Also check @font-face rules in stylesheets
    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSFontFaceRule) {
              const style = rule.style;
              const family = style.getPropertyValue('font-family').replace(/["']/g, '');
              if (family && !fontFaces.some((f) => f.family === family && f.weight === style.getPropertyValue('font-weight'))) {
                fontFaces.push({
                  family,
                  weight: style.getPropertyValue('font-weight') || '400',
                  style: style.getPropertyValue('font-style') || 'normal',
                  src: style.getPropertyValue('src') || '',
                  display: style.getPropertyValue('font-display') || undefined,
                });
              }
            }
          }
        } catch {
          // Cross-origin stylesheets block cssRules access
        }
      }
    } catch {
      // stylesheet access error
    }

    // Font usage across elements
    const fontUsageMap = new Map<string, { count: number; selectors: Set<string> }>();
    const elements = document.querySelectorAll('body *');
    const limit = Math.min(elements.length, 200);
    for (let i = 0; i < limit; i++) {
      const el = elements[i];
      const elRect = el.getBoundingClientRect();
      if (elRect.width === 0 && elRect.height === 0) continue;
      const cs = getComputedStyle(el);
      const key = `${cs.fontFamily}|${cs.fontWeight}|${cs.fontStyle}`;
      const entry = fontUsageMap.get(key) || { count: 0, selectors: new Set() };
      entry.count++;
      const cls = el.getAttribute('class') || '';
      const selector = el.tagName.toLowerCase() + (cls ? '.' + cls.split(' ')[0] : '');
      if (entry.selectors.size < 3) entry.selectors.add(selector);
      fontUsageMap.set(key, entry);
    }

    const fontsUsed = Array.from(fontUsageMap.entries())
      .map(([key, data]) => {
        const [family, weight, style] = key.split('|');
        return {
          family: family.split(',')[0].trim().replace(/["']/g, ''),
          weight, style,
          usageCount: data.count,
          sampleSelectors: Array.from(data.selectors),
        };
      })
      .sort((a, b) => b.usageCount - a.usageCount);

    // Loading strategy
    const strategies: string[] = [];
    const hasPreload = document.querySelector('link[rel="preload"][as="font"]');
    if (hasPreload) strategies.push('preloaded');
    if (fontFaces.some((f) => f.display === 'swap')) strategies.push('font-display: swap');
    if (fontFaces.some((f) => f.src.includes('woff2'))) strategies.push('woff2');
    const loadingStrategy = strategies.length > 0 ? strategies.join(' + ') : 'default';

    return { fontFaces, fontsUsed, iconFonts: [], loadingStrategy };
  });
}

export async function collectAssets(page: Page): Promise<RawAssets> {
  return page.evaluate(() => {
    function getSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      const tag = el.tagName.toLowerCase();
      const cls = el.classList[0];
      return cls ? `${tag}.${cls}` : tag;
    }

    // Images
    const images: Array<{
      src: string; alt: string; width: number; height: number;
      naturalWidth: number; naturalHeight: number; format: string; selector: string;
    }> = [];
    document.querySelectorAll('img').forEach((el) => {
      const img = el as HTMLImageElement;
      const src = img.src;
      const ext = src.split('.').pop()?.split('?')[0]?.toLowerCase() || '';
      const format = { webp: 'webp', png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', svg: 'svg', avif: 'avif' }[ext] || ext;
      images.push({
        src, alt: img.alt,
        width: img.width, height: img.height,
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        format, selector: getSelector(el),
      });
    });

    // Inline SVGs
    const inlineSVGs: Array<{ selector: string; viewBox: string; width: number; height: number; source: string }> = [];
    document.querySelectorAll('svg').forEach((el) => {
      const svg = el as SVGSVGElement;
      // Skip SVGs inside sprite sheets
      if (svg.closest('symbol') || svg.closest('[style*="display: none"]')) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      inlineSVGs.push({
        selector: getSelector(el),
        viewBox: svg.getAttribute('viewBox') || '',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        source: svg.outerHTML.slice(0, 500),
      });
    });

    // SVG sprites (symbol/use pattern)
    const svgSprites: Array<{ id: string; viewBox: string; paths: string; referencedBy: string[] }> = [];
    document.querySelectorAll('svg symbol[id]').forEach((el) => {
      const symbol = el as SVGSymbolElement;
      const id = symbol.id;
      const refs: string[] = [];
      document.querySelectorAll(`use[href="#${id}"],use[xlink\\:href="#${id}"]`).forEach((use) => {
        refs.push(getSelector(use.closest('svg') || use));
      });
      svgSprites.push({
        id,
        viewBox: symbol.getAttribute('viewBox') || '',
        paths: symbol.innerHTML.slice(0, 200),
        referencedBy: refs,
      });
    });

    // Background sprites
    const backgroundSprites: Array<{
      sheetUrl: string; sheetWidth: number; sheetHeight: number;
      frames: Array<{ selector: string; cropX: number; cropY: number; cropWidth: number; cropHeight: number }>;
    }> = [];
    const bgSpriteMap = new Map<string, Array<{ selector: string; cropX: number; cropY: number; cropWidth: number; cropHeight: number }>>();

    document.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      const bgImage = cs.backgroundImage;
      if (!bgImage || bgImage === 'none' || !bgImage.startsWith('url(')) return;
      const bgPos = cs.backgroundPosition;
      const bgSize = cs.backgroundSize;
      if (bgSize === 'cover' || bgSize === 'contain' || bgSize === 'auto') return;

      const urlMatch = bgImage.match(/url\(["']?(.+?)["']?\)/);
      if (!urlMatch) return;
      const url = urlMatch[1];

      const rect = el.getBoundingClientRect();
      const posMatch = bgPos.match(/([-\d.]+)px\s+([-\d.]+)px/);
      if (!posMatch) return;

      const frames = bgSpriteMap.get(url) || [];
      frames.push({
        selector: getSelector(el),
        cropX: Math.abs(parseFloat(posMatch[1])),
        cropY: Math.abs(parseFloat(posMatch[2])),
        cropWidth: Math.round(rect.width),
        cropHeight: Math.round(rect.height),
      });
      bgSpriteMap.set(url, frames);
    });

    for (const [url, frames] of bgSpriteMap.entries()) {
      if (frames.length >= 2) { // Only count as sprite if multiple frames
        backgroundSprites.push({ sheetUrl: url, sheetWidth: 0, sheetHeight: 0, frames });
      }
    }

    const totalAssets = images.length + inlineSVGs.length + svgSprites.length +
      backgroundSprites.reduce((s, b) => s + b.frames.length, 0);

    return {
      images, inlineSVGs, svgSprites, backgroundSprites,
      maskSprites: [] as never[], iconFonts: [], totalAssets,
    };
  });
}

// ============================================================
// On-demand Collectors (used by tools, not the main scan pipeline)
// ============================================================

export interface RawComputedStyles {
  selector: string;
  propertyFilter?: string[];
  entries: Array<{
    selector: string;
    matchCount: number;
    styles: Record<string, string>;
    variations: Array<{
      property: string;
      values: Array<{ value: string; count: number }>;
    }>;
  }>;
}

export interface RawElementSnapshot {
  selector: string;
  depth: number;
  totalNodes: number;
  root: RawSnapshotNode;
}

export interface RawSnapshotNode {
  tag: string;
  id?: string;
  classList: string[];
  attributes: Record<string, string>;
  textContent?: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>;
  children: RawSnapshotNode[];
}

/**
 * Collect computed styles for elements matching a CSS selector.
 * Runs inside Playwright's page context.
 */
export async function collectComputedStyles(
  page: Page,
  selector: string,
  propertyFilter?: string[],
): Promise<RawComputedStyles> {
  return page.evaluate(
    ({ sel, propFilter }) => {
      const elements = document.querySelectorAll(sel);
      if (elements.length === 0) {
        return { selector: sel, propertyFilter: propFilter, entries: [] };
      }

      // Key visual/layout properties when no filter specified
      const DEFAULT_PROPS = [
        'color', 'background-color', 'border-color',
        'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
        'letter-spacing', 'text-align', 'text-transform', 'text-decoration',
        'display', 'position', 'top', 'right', 'bottom', 'left',
        'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'gap', 'flex-direction', 'justify-content', 'align-items', 'flex-wrap',
        'grid-template-columns', 'grid-template-rows',
        'border-width', 'border-style', 'border-radius',
        'box-shadow', 'text-shadow', 'opacity', 'overflow', 'z-index',
        'transform', 'transition', 'background-image', 'background-size',
        'cursor', 'pointer-events',
      ];

      const propsToCapture = propFilter && propFilter.length > 0 ? propFilter : DEFAULT_PROPS;

      // Collect styles from all matching elements
      const allStyles: Record<string, string>[] = [];
      const limit = Math.min(elements.length, 50);
      for (let i = 0; i < limit; i++) {
        const cs = getComputedStyle(elements[i]);
        const styles: Record<string, string> = {};
        for (const prop of propsToCapture) {
          const val = cs.getPropertyValue(prop);
          if (val) styles[prop] = val;
        }
        allStyles.push(styles);
      }

      // Compute the "first element" styles and detect variations
      const baseStyles = allStyles[0] || {};
      const variations: Array<{
        property: string;
        values: Array<{ value: string; count: number }>;
      }> = [];

      if (allStyles.length > 1) {
        for (const prop of propsToCapture) {
          const valueCounts = new Map<string, number>();
          for (const s of allStyles) {
            const val = s[prop] || '';
            valueCounts.set(val, (valueCounts.get(val) || 0) + 1);
          }
          if (valueCounts.size > 1) {
            variations.push({
              property: prop,
              values: Array.from(valueCounts.entries())
                .map(([value, count]) => ({ value, count }))
                .sort((a, b) => b.count - a.count),
            });
          }
        }
      }

      return {
        selector: sel,
        propertyFilter: propFilter,
        entries: [{
          selector: sel,
          matchCount: elements.length,
          styles: baseStyles,
          variations,
        }],
      };
    },
    { sel: selector, propFilter: propertyFilter },
  );
}

/**
 * Collect a deep element snapshot for a CSS selector.
 * Captures structure, attributes, bounding rects, and key computed styles.
 */
export async function collectElementSnapshot(
  page: Page,
  selector: string,
  maxDepth = 5,
): Promise<RawElementSnapshot | null> {
  return page.evaluate(
    ({ sel, maxD }) => {
      const rootEl = document.querySelector(sel);
      if (!rootEl) return null;

      const KEY_STYLES = [
        'display', 'position', 'color', 'background-color',
        'font-family', 'font-size', 'font-weight', 'line-height',
        'width', 'height', 'margin', 'padding', 'border',
        'flex-direction', 'justify-content', 'align-items', 'gap',
        'grid-template-columns', 'grid-template-rows',
        'border-radius', 'box-shadow', 'opacity', 'overflow', 'z-index',
      ];

      type SnapNode = {
        tag: string; id?: string; classList: string[];
        attributes: Record<string, string>; textContent?: string;
        boundingRect: { x: number; y: number; width: number; height: number };
        computedStyles: Record<string, string>;
        children: SnapNode[];
      };

      let totalNodes = 0;

      function walk(el: Element, depth: number): SnapNode {
        totalNodes++;
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);

        const attributes: Record<string, string> = {};
        for (const attr of el.attributes) {
          if (!['class', 'id', 'style'].includes(attr.name)) {
            attributes[attr.name] = attr.value.slice(0, 200);
          }
        }

        const computedStyles: Record<string, string> = {};
        for (const prop of KEY_STYLES) {
          const val = cs.getPropertyValue(prop);
          if (val) computedStyles[prop] = val;
        }

        const children: SnapNode[] = [];
        if (depth < maxD) {
          const childLimit = Math.min(el.children.length, 30);
          for (let i = 0; i < childLimit; i++) {
            children.push(walk(el.children[i], depth + 1));
          }
        }

        const node: SnapNode = {
          tag: el.tagName.toLowerCase(),
          classList: Array.from(el.classList),
          attributes,
          boundingRect: {
            x: Math.round(rect.x), y: Math.round(rect.y),
            width: Math.round(rect.width), height: Math.round(rect.height),
          },
          computedStyles,
          children,
        };

        if (el.id) node.id = el.id;
        if (el.children.length === 0 && el.textContent) {
          node.textContent = el.textContent.trim().slice(0, 200);
        }

        return node;
      }

      const root = walk(rootEl, 0);

      return {
        selector: sel,
        depth: maxD,
        totalNodes,
        root,
      };
    },
    { sel: selector, maxD: maxDepth },
  );
}
