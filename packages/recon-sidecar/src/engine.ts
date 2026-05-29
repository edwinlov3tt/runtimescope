import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { TechnologyDatabase, detect } from '@runtimescope/extension';
import type { TechDetectionResult } from '@runtimescope/extension';
import type { RuntimeEvent } from './types.js';
import { loadTechData } from './detection.js';
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
import type {
  RawComputedStyles,
  RawElementSnapshot,
  RawDesignTokens,
  RawLayoutTree,
  RawAccessibility,
  RawFonts,
  RawAssets,
} from './recon-collectors.js';
import { buildReconEvents } from './event-builder.js';
import { log } from './log.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Simple semaphore to limit concurrent browser contexts.
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

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
 * ReconEngine — the headless-browser engine for the sidecar.
 *
 * Lifted from `packages/mcp-server/src/scanner/index.ts` (PlaywrightScanner),
 * with all `@runtimescope/collector` imports removed. Lazily loads Playwright
 * and the technology database; reuses one Chromium instance across requests and
 * auto-closes it after an idle period.
 */
export class ReconEngine {
  private db: TechnologyDatabase | null = null;
  private jsGlobalPaths: string[] = [];
  private domSelectors: string[] = [];
  private browser: Browser | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private static IDLE_TIMEOUT = 60_000; // Close browser after 60s idle
  private lastScannedUrl: string | null = null;
  private contextSemaphore = new Semaphore(2);

  /** Lazily load the technology database. */
  private ensureDb(): TechnologyDatabase {
    if (this.db) return this.db;

    const { techData, catData } = loadTechData();
    this.db = new TechnologyDatabase(techData, catData);

    // Pre-extract signals for the detection engine.
    const allTechs = this.db.getAll();
    this.jsGlobalPaths = extractJsGlobalPaths(allTechs);
    this.domSelectors = extractDomSelectors(allTechs);

    log.error(
      `scanner loaded: ${this.db.size} technologies, ${this.jsGlobalPaths.length} JS paths, ${this.domSelectors.length} DOM selectors`,
    );

    return this.db;
  }

  /** Lazily launch or reuse a Chromium browser. */
  private async ensureBrowser(): Promise<Browser> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Dynamic import — Playwright is only loaded when a browser tool is called.
    const pw = await import('playwright');

    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await pw.chromium.launch({ headless: true });
      log.error('Chromium launched');
    }

    // Set idle auto-close.
    this.idleTimer = setTimeout(() => {
      this.shutdown().catch(() => {});
    }, ReconEngine.IDLE_TIMEOUT);

    return this.browser;
  }

  /**
   * Navigate to a URL in a fresh context, run a collector, then tear the
   * context down. Shared by the on-demand recon captures.
   */
  private async withPage<T>(
    url: string,
    fn: (page: Page) => Promise<T>,
    options: ScanOptions = {},
  ): Promise<T> {
    const browser = await this.ensureBrowser();
    await this.contextSemaphore.acquire();
    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({
        viewport: { width: options.viewportWidth ?? 1280, height: options.viewportHeight ?? 720 },
        userAgent: USER_AGENT,
      });
      const page = await context.newPage();
      await page.goto(url, {
        waitUntil: options.waitFor ?? 'networkidle',
        timeout: options.timeout ?? 60_000,
      });
      this.lastScannedUrl = page.url();
      return await fn(page);
    } finally {
      if (context) await context.close().catch(() => {});
      this.contextSemaphore.release();
    }
  }

  /** Full scan: collect all signals, detect tech stack, build recon events. */
  async scan(url: string, options: ScanOptions = {}): Promise<ScanResult> {
    const startTime = Date.now();
    const {
      viewportWidth = 1280,
      viewportHeight = 720,
      waitFor = 'networkidle',
      timeout = 60_000,
    } = options;

    const db = this.ensureDb();
    const browser = await this.ensureBrowser();

    await this.contextSemaphore.acquire();
    let context: BrowserContext | null = null;

    try {
      context = await browser.newContext({
        viewport: { width: viewportWidth, height: viewportHeight },
        userAgent: USER_AGENT,
      });

      const page = await context.newPage();

      // Capture main document response headers.
      let mainResponse: Response | null = null;
      page.on('response', (response) => {
        if (!mainResponse && response.request().resourceType() === 'document') {
          mainResponse = response;
        }
      });

      await page.goto(url, { waitUntil: waitFor, timeout });

      const title = await page.title();
      const sessionId = `scan-${Date.now()}`;

      // Collect stylesheet hrefs (needed for event builder).
      const stylesheetHrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((el) => el.getAttribute('href') || ''),
      );

      // Run collections in parallel.
      const [signals, tokens, layout, a11y, fonts, assets] = await Promise.all([
        collectDetectionSignals(page, mainResponse, this.jsGlobalPaths, this.domSelectors),
        collectDesignTokens(page),
        collectLayoutTree(page),
        collectAccessibility(page),
        collectFonts(page),
        collectAssets(page),
      ]);

      // Run tech stack detection.
      const techStack = detect(signals, db);

      // Build recon events.
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

      // Build summary.
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
      if (context) await context.close().catch(() => {});
      this.contextSemaphore.release();
    }
  }

  /** Last URL the engine navigated to (scan or on-demand capture). */
  getLastScannedUrl(): string | null {
    return this.lastScannedUrl;
  }

  // ---- On-demand captures (navigate → collect → close) ----

  async computedStyles(url: string, selector: string, propertyFilter?: string[], options: ScanOptions = {}): Promise<RawComputedStyles> {
    return this.withPage(url, (page) => collectComputedStyles(page, selector, propertyFilter), options);
  }

  async elementSnapshot(url: string, selector: string, depth = 5, options: ScanOptions = {}): Promise<RawElementSnapshot | null> {
    return this.withPage(url, (page) => collectElementSnapshot(page, selector, depth), options);
  }

  async layoutTree(url: string, maxDepth = 6, options: ScanOptions = {}): Promise<RawLayoutTree> {
    return this.withPage(url, (page) => collectLayoutTree(page, maxDepth), options);
  }

  async designTokens(url: string, options: ScanOptions = {}): Promise<RawDesignTokens> {
    return this.withPage(url, (page) => collectDesignTokens(page), options);
  }

  async accessibility(url: string, options: ScanOptions = {}): Promise<RawAccessibility> {
    return this.withPage(url, (page) => collectAccessibility(page), options);
  }

  async fonts(url: string, options: ScanOptions = {}): Promise<RawFonts> {
    return this.withPage(url, (page) => collectFonts(page), options);
  }

  async assets(url: string, options: ScanOptions = {}): Promise<RawAssets> {
    return this.withPage(url, (page) => collectAssets(page), options);
  }

  /** Shutdown: close the browser if open. */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Already closed.
      }
      this.browser = null;
      log.error('Chromium closed');
    }
  }
}
