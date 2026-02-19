import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TechnologyDatabase, detect } from '@runtimescope/extension';
import type { TechDetectionResult, DetectionSignals } from '@runtimescope/extension';
import type { RuntimeEvent } from '@runtimescope/collector';
import {
  collectDetectionSignals,
  extractJsGlobalPaths,
  extractDomSelectors,
} from './signal-collector.js';
import {
  collectDesignTokens,
  collectLayoutTree,
  collectAccessibility,
  collectFonts,
  collectAssets,
  collectComputedStyles,
  collectElementSnapshot,
} from './recon-collectors.js';
import type { RawComputedStyles, RawElementSnapshot } from './recon-collectors.js';
import { buildReconEvents } from './event-builder.js';

export interface ScanOptions {
  viewportWidth?: number;
  viewportHeight?: number;
  waitFor?: 'load' | 'networkidle' | 'domcontentloaded';
  timeout?: number;
}

export interface ScanResult {
  url: string;
  title: string;
  techStack: TechDetectionResult[];
  events: RuntimeEvent[];
  summary: string;
  scanDurationMs: number;
}

/**
 * PlaywrightScanner — orchestrates headless browser scans.
 * Lazily loads Playwright and the technology database.
 * Reuses the browser instance across scans for performance.
 */
export class PlaywrightScanner {
  private db: TechnologyDatabase | null = null;
  private jsGlobalPaths: string[] = [];
  private domSelectors: string[] = [];
  private browser: unknown = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private static IDLE_TIMEOUT = 60_000; // Close browser after 60s idle
  private lastScannedUrl: string | null = null;

  /**
   * Lazily load the technology database.
   */
  private ensureDb(): TechnologyDatabase {
    if (this.db) return this.db;

    // Resolve path to the data files in @runtimescope/extension
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Try multiple possible paths for the data files
    const possiblePaths = [
      resolve(__dirname, '../../../node_modules/@runtimescope/extension/src/data'),
      resolve(__dirname, '../../extension/src/data'),
    ];

    let techData: Record<string, unknown> | null = null;
    let catData: Record<string, unknown> | null = null;

    for (const basePath of possiblePaths) {
      try {
        techData = JSON.parse(readFileSync(resolve(basePath, 'technologies.json'), 'utf-8'));
        catData = JSON.parse(readFileSync(resolve(basePath, 'categories.json'), 'utf-8'));
        break;
      } catch {
        continue;
      }
    }

    if (!techData || !catData) {
      throw new Error('Could not load technology database. Ensure @runtimescope/extension is built.');
    }

    this.db = new TechnologyDatabase(techData as Record<string, never>, catData as Record<string, never>);

    // Pre-extract signals for the detection engine
    const allTechs = this.db.getAll();
    this.jsGlobalPaths = extractJsGlobalPaths(allTechs);
    this.domSelectors = extractDomSelectors(allTechs);

    console.error(`[RuntimeScope] Scanner loaded: ${this.db.size} technologies, ${this.jsGlobalPaths.length} JS paths, ${this.domSelectors.length} DOM selectors`);

    return this.db;
  }

  /**
   * Lazily launch or reuse a Chromium browser.
   */
  private async ensureBrowser(): Promise<{ chromium: unknown; browser: unknown }> {
    // Reset idle timer
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Dynamic import — Playwright is only loaded when scan_website is actually called
    const pw = await import('playwright');

    if (!this.browser || !(this.browser as { isConnected(): boolean }).isConnected()) {
      this.browser = await pw.chromium.launch({ headless: true });
      console.error('[RuntimeScope] Scanner: Chromium launched');
    }

    // Set idle auto-close
    this.idleTimer = setTimeout(() => {
      this.shutdown().catch(() => {});
    }, PlaywrightScanner.IDLE_TIMEOUT);

    return { chromium: pw.chromium, browser: this.browser };
  }

  /**
   * Scan a website: collect all signals, detect tech stack, build recon events.
   */
  async scan(url: string, options: ScanOptions = {}): Promise<ScanResult> {
    const startTime = Date.now();
    const {
      viewportWidth = 1280,
      viewportHeight = 720,
      waitFor = 'networkidle',
      timeout = 30_000,
    } = options;

    const db = this.ensureDb();
    const { browser } = await this.ensureBrowser();
    const br = browser as import('playwright').Browser;

    // Create a fresh context and page
    const context = await br.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    try {
      // Capture main document response headers
      let mainResponse: import('playwright').Response | null = null;
      page.on('response', (response) => {
        if (!mainResponse && response.request().resourceType() === 'document') {
          mainResponse = response;
        }
      });

      // Navigate
      await page.goto(url, {
        waitUntil: waitFor,
        timeout,
      });

      const title = await page.title();
      const sessionId = `scan-${Date.now()}`;

      // Collect stylesheet hrefs (needed for event builder)
      const stylesheetHrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((el) => el.getAttribute('href') || ''),
      );

      // Run collections in parallel
      const [signals, tokens, layout, a11y, fonts, assets] = await Promise.all([
        collectDetectionSignals(page, mainResponse, this.jsGlobalPaths, this.domSelectors),
        collectDesignTokens(page),
        collectLayoutTree(page),
        collectAccessibility(page),
        collectFonts(page),
        collectAssets(page),
      ]);

      // Run tech stack detection
      const techStack = detect(signals, db);

      // Build recon events
      const events = buildReconEvents(
        url,
        title,
        sessionId,
        techStack,
        tokens,
        layout,
        a11y,
        fonts,
        assets,
        { width: viewportWidth, height: viewportHeight },
        signals.meta || {},
        signals.scriptSrc || [],
        stylesheetHrefs,
      );

      // Build summary
      const topTechs = techStack.slice(0, 10).map((t) => `${t.name}${t.version ? ' ' + t.version : ''} (${t.confidence}%)`);
      const summaryParts = [
        `Scanned: ${title || url}`,
        `Tech stack: ${topTechs.join(', ') || 'none detected'}`,
        `Design: ${tokens.customProperties.length} CSS vars, ${tokens.colors.length} colors, ${tokens.typography.length} type combos`,
        `Layout: ${layout.totalElements} elements, depth ${layout.maxDepth}`,
        `Fonts: ${fonts.fontFaces.length} faces, ${fonts.fontsUsed.length} used`,
        `Assets: ${assets.images.length} images, ${assets.inlineSVGs.length} SVGs, ${assets.totalAssets} total`,
        `Accessibility: ${a11y.headings.length} headings, ${a11y.landmarks.length} landmarks, ${a11y.issues.length} issues`,
      ];

      const scanDurationMs = Date.now() - startTime;

      this.lastScannedUrl = page.url();

      return {
        url: page.url(),
        title,
        techStack,
        events,
        summary: summaryParts.join('. ') + `. Scan took ${scanDurationMs}ms.`,
        scanDurationMs,
      };
    } finally {
      await context.close();
    }
  }

  /**
   * Get the last scanned URL (so tools know a scan was performed).
   */
  getLastScannedUrl(): string | null {
    return this.lastScannedUrl;
  }

  /**
   * On-demand: query computed styles for a selector on a previously scanned URL.
   * Opens a fresh page, navigates, collects, closes.
   */
  async queryComputedStyles(
    url: string,
    selector: string,
    propertyFilter?: string[],
  ): Promise<RawComputedStyles> {
    const { browser } = await this.ensureBrowser();
    const br = browser as import('playwright').Browser;
    const context = await br.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      return await collectComputedStyles(page, selector, propertyFilter);
    } finally {
      await context.close();
    }
  }

  /**
   * On-demand: query element snapshot for a selector on a previously scanned URL.
   * Opens a fresh page, navigates, collects, closes.
   */
  async queryElementSnapshot(
    url: string,
    selector: string,
    depth = 5,
  ): Promise<RawElementSnapshot | null> {
    const { browser } = await this.ensureBrowser();
    const br = browser as import('playwright').Browser;
    const context = await br.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      return await collectElementSnapshot(page, selector, depth);
    } finally {
      await context.close();
    }
  }

  /**
   * Shutdown: close browser if open.
   */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      try {
        await (this.browser as import('playwright').Browser).close();
      } catch {
        // Already closed
      }
      this.browser = null;
      console.error('[RuntimeScope] Scanner: Chromium closed');
    }
  }
}
