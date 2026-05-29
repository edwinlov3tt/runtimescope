/**
 * Recon event types produced by the sidecar.
 *
 * These are copied verbatim from `@runtimescope/collector`'s `types.ts` (the
 * canonical wire source) so the events the sidecar emits are byte-shape
 * identical to what the collector stores. The sidecar must NOT import the
 * collector — it mirrors the relevant types here, exactly like the SDKs do.
 *
 * Keep in sync with `packages/collector/src/types.ts` (Recon Event Types
 * section). The wire protocol is frozen; if a shape here is wrong, fix it to
 * match the collector — do not diverge.
 */

export interface BaseEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  projectId?: string;
  appName?: string;
}

// --- Recon: Page Metadata ---

export interface TechStackDetection {
  name: string;
  confidence: 'high' | 'medium' | 'low';
  version?: string;
  evidence: string[];
}

export interface ReconMetadataEvent extends BaseEvent {
  eventType: 'recon_metadata';
  url: string;
  title: string;
  viewport: { width: number; height: number };
  documentLang: string;
  metaTags: Record<string, string>;
  techStack: {
    framework: TechStackDetection;
    metaFramework?: TechStackDetection;
    uiLibrary?: TechStackDetection;
    buildTool?: TechStackDetection;
    hosting?: TechStackDetection;
    stateManagement?: TechStackDetection;
    additional: TechStackDetection[];
  };
  externalStylesheets: Array<{ href: string; crossOrigin: boolean }>;
  externalScripts: Array<{ src: string; async: boolean; defer: boolean; type: string }>;
  preloads: Array<{ href: string; as: string }>;
  documentTitle?: string;
  charset?: string;
  favicon?: string;
  openGraph?: Record<string, string>;
  twitterCard?: Record<string, string>;
  jsonLd?: unknown[];
  htmlLang?: string;
  themeColor?: string;
  canonicalUrl?: string;
}

// --- Recon: Design Tokens ---

export interface ColorToken {
  value: string;
  hex: string;
  usageCount: number;
  properties: string[];
  sampleSelectors: string[];
}

export interface ReconDesignTokensEvent extends BaseEvent {
  eventType: 'recon_design_tokens';
  url: string;
  customProperties: Array<{ name: string; value: string; source: string }>;
  colors: ColorToken[];
  typography: Array<{ fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; usageCount: number; sampleSelectors: string[] }>;
  spacing: Array<{ value: string; pixels: number; usageCount: number; properties: string[] }>;
  borderRadii: Array<{ value: string; usageCount: number }>;
  boxShadows: Array<{ value: string; usageCount: number }>;
  cssArchitecture: string;
  classNamingPatterns: string[];
  sampleClassNames: string[];
}

// --- Recon: Fonts ---

export interface ReconFontsEvent extends BaseEvent {
  eventType: 'recon_fonts';
  url: string;
  fontFaces: Array<{ family: string; weight: string; style: string; src: string; display?: string }>;
  fontsUsed: Array<{ family: string; weight: string; style: string; usageCount: number; sampleSelectors: string[] }>;
  iconFonts: Array<{ fontFamily: string; fontFaceUrl?: string; glyphs: Array<{ codepoint: string; pseudoElement: string; selector: string; renderedSize: number }> }>;
  loadingStrategy: string;
}

// --- Recon: Layout Tree ---

export interface LayoutNode {
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
  children: LayoutNode[];
  childCount: number;
  textContent?: string;
}

export interface ReconLayoutTreeEvent extends BaseEvent {
  eventType: 'recon_layout_tree';
  url: string;
  viewport: { width: number; height: number };
  scrollHeight: number;
  tree: LayoutNode;
  totalElements: number;
  maxDepth: number;
}

// --- Recon: Accessibility ---

export interface ReconAccessibilityEvent extends BaseEvent {
  eventType: 'recon_accessibility';
  url: string;
  headings: Array<{ level: number; text: string; selector: string }>;
  landmarks: Array<{ role: string; label?: string; selector: string }>;
  formFields: Array<{ tag: string; type?: string; name?: string; label?: string; required: boolean; selector: string }>;
  links: Array<{ tag: string; text: string; href: string; selector: string }>;
  buttons: Array<{ tag: string; text: string; role?: string; selector: string }>;
  images: Array<{ src: string; alt: string; hasAlt: boolean; selector: string }>;
  issues: string[];
}

// --- Recon: Computed Styles ---

export interface ComputedStyleEntry {
  selector: string;
  matchCount: number;
  styles: Record<string, string>;
  variations: Array<{
    property: string;
    values: Array<{ value: string; count: number }>;
  }>;
}

export interface ReconComputedStylesEvent extends BaseEvent {
  eventType: 'recon_computed_styles';
  url: string;
  selector: string;
  propertyFilter?: string[];
  entries: ComputedStyleEntry[];
}

// --- Recon: Element Snapshot ---

export interface SnapshotNode {
  tag: string;
  id?: string;
  classList: string[];
  attributes: Record<string, string>;
  textContent?: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>;
  children: SnapshotNode[];
}

export interface ReconElementSnapshotEvent extends BaseEvent {
  eventType: 'recon_element_snapshot';
  url: string;
  selector: string;
  depth: number;
  totalNodes: number;
  root: SnapshotNode;
}

// --- Recon: Asset Inventory ---

export interface AssetImage {
  src: string;
  alt: string;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  format: string;
  selector: string;
}

export interface ReconAssetInventoryEvent extends BaseEvent {
  eventType: 'recon_asset_inventory';
  url: string;
  images: AssetImage[];
  inlineSVGs: Array<{ selector: string; viewBox: string; width: number; height: number; source: string }>;
  svgSprites: Array<{ id: string; viewBox: string; paths: string; referencedBy: string[] }>;
  backgroundSprites: Array<{ sheetUrl: string; sheetWidth: number; sheetHeight: number; frames: Array<{ selector: string; cropX: number; cropY: number; cropWidth: number; cropHeight: number }> }>;
  maskSprites: Array<{ sheetUrl: string; sheetWidth: number; sheetHeight: number; frames: Array<{ selector: string; cropX: number; cropY: number; cropWidth: number; cropHeight: number }> }>;
  iconFonts: Array<{ fontFamily: string; fontFaceUrl?: string; glyphs: Array<{ codepoint: string; pseudoElement: string; selector: string; renderedSize: number }> }>;
  totalAssets: number;
}

/**
 * The subset of the collector's `RuntimeEvent` union that the sidecar can
 * produce. The full scan emits the six page-level recon events; the on-demand
 * captures additionally yield computed-styles / element-snapshot events.
 */
export type RuntimeEvent =
  | ReconMetadataEvent
  | ReconDesignTokensEvent
  | ReconFontsEvent
  | ReconLayoutTreeEvent
  | ReconAccessibilityEvent
  | ReconComputedStylesEvent
  | ReconElementSnapshotEvent
  | ReconAssetInventoryEvent;
