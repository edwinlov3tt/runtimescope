import type { TechDetectionResult } from '@runtimescope/extension';
import type {
  RuntimeEvent,
  ReconMetadataEvent,
  ReconDesignTokensEvent,
  ReconLayoutTreeEvent,
  ReconAccessibilityEvent,
  ReconFontsEvent,
  ReconAssetInventoryEvent,
} from '@runtimescope/collector';
import type {
  RawDesignTokens,
  RawLayoutTree,
  RawAccessibility,
  RawFonts,
  RawAssets,
} from './recon-collectors.js';

function makeEventId(): string {
  return `evt-scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build all 6 recon events from collected scanner data.
 */
export function buildReconEvents(
  url: string,
  title: string,
  sessionId: string,
  techResults: TechDetectionResult[],
  tokens: RawDesignTokens,
  layout: RawLayoutTree,
  a11y: RawAccessibility,
  fonts: RawFonts,
  assets: RawAssets,
  viewport: { width: number; height: number },
  meta: Record<string, string>,
  scriptSrcs: string[],
  stylesheetHrefs: string[],
): RuntimeEvent[] {
  const timestamp = Date.now();
  const events: RuntimeEvent[] = [];

  // 1. ReconMetadataEvent — tech stack + page info
  const framework = techResults.find((t) => t.categories.some((c) => c.id === 12));
  const metaFramework = techResults.find((t) =>
    t.categories.some((c) => c.id === 18 || c.id === 57) && t.name !== framework?.name,
  );
  const uiLib = techResults.find((t) => t.categories.some((c) => c.id === 66));
  const buildTool = techResults.find((t) =>
    t.categories.some((c) => c.id === 19) || t.name.match(/webpack|vite|parcel|turbopack|esbuild|rollup/i),
  );
  const hosting = techResults.find((t) =>
    t.categories.some((c) => c.id === 62 || c.id === 31) || t.name.match(/vercel|netlify|cloudflare|aws|heroku/i),
  );

  function toDetection(result: TechDetectionResult | undefined): { name: string; confidence: 'high' | 'medium' | 'low'; version?: string; evidence: string[] } {
    if (!result) return { name: 'unknown', confidence: 'low', evidence: [] };
    return {
      name: result.name.toLowerCase(),
      confidence: result.confidence >= 75 ? 'high' : result.confidence >= 40 ? 'medium' : 'low',
      version: result.version || undefined,
      evidence: [`Detected by scanner (confidence: ${result.confidence}%)`],
    };
  }

  const metadataEvent: ReconMetadataEvent = {
    eventId: makeEventId(),
    sessionId,
    timestamp,
    eventType: 'recon_metadata',
    url,
    title,
    viewport,
    documentLang: '', // Not critical for this use case
    metaTags: meta,
    techStack: {
      framework: toDetection(framework),
      metaFramework: metaFramework ? toDetection(metaFramework) : undefined,
      uiLibrary: uiLib ? toDetection(uiLib) : undefined,
      buildTool: buildTool ? toDetection(buildTool) : undefined,
      hosting: hosting ? toDetection(hosting) : undefined,
      additional: techResults
        .filter((t) => t !== framework && t !== metaFramework && t !== uiLib && t !== buildTool && t !== hosting)
        .slice(0, 20)
        .map((t) => ({
          name: t.name,
          confidence: t.confidence >= 75 ? 'high' as const : t.confidence >= 40 ? 'medium' as const : 'low' as const,
          version: t.version || undefined,
          evidence: [`${t.categories.map((c) => c.name).join(', ')}`],
        })),
    },
    externalStylesheets: stylesheetHrefs.map((href) => ({ href, crossOrigin: !href.startsWith(url) })),
    externalScripts: scriptSrcs.map((src) => ({ src, async: false, defer: false, type: 'text/javascript' })),
    preloads: [],
  };
  events.push(metadataEvent);

  // 2. ReconDesignTokensEvent
  const designTokensEvent: ReconDesignTokensEvent = {
    eventId: makeEventId(),
    sessionId,
    timestamp,
    eventType: 'recon_design_tokens',
    url,
    ...tokens,
  };
  events.push(designTokensEvent);

  // 3. ReconLayoutTreeEvent
  const layoutEvent: ReconLayoutTreeEvent = {
    eventId: makeEventId(),
    sessionId,
    timestamp,
    eventType: 'recon_layout_tree',
    url,
    viewport: layout.viewport,
    scrollHeight: layout.scrollHeight,
    tree: layout.tree,
    totalElements: layout.totalElements,
    maxDepth: layout.maxDepth,
  };
  events.push(layoutEvent);

  // 4. ReconAccessibilityEvent
  const a11yEvent: ReconAccessibilityEvent = {
    eventId: makeEventId(),
    sessionId,
    timestamp,
    eventType: 'recon_accessibility',
    url,
    ...a11y,
  };
  events.push(a11yEvent);

  // 5. ReconFontsEvent
  const fontsEvent: ReconFontsEvent = {
    eventId: makeEventId(),
    sessionId,
    timestamp,
    eventType: 'recon_fonts',
    url,
    ...fonts,
  };
  events.push(fontsEvent);

  // 6. ReconAssetInventoryEvent
  const assetsEvent: ReconAssetInventoryEvent = {
    eventId: makeEventId(),
    sessionId,
    timestamp,
    eventType: 'recon_asset_inventory',
    url,
    ...assets,
  };
  events.push(assetsEvent);

  return events;
}
