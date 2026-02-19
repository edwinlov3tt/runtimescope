// ============================================================
// Canonical type definitions for RuntimeScope
// Used by both the collector and MCP server packages
// ============================================================

// --- Base Event ---

export type EventType =
  | 'network'
  | 'console'
  | 'session'
  | 'state'
  | 'render'
  | 'dom_snapshot'
  | 'performance'
  | 'database'
  | 'recon_metadata'
  | 'recon_design_tokens'
  | 'recon_fonts'
  | 'recon_layout_tree'
  | 'recon_accessibility'
  | 'recon_computed_styles'
  | 'recon_element_snapshot'
  | 'recon_asset_inventory';

export interface BaseEvent {
  eventId: string;
  sessionId: string;
  timestamp: number;
  eventType: EventType;
}

// --- Network Events ---

export interface GraphQLOperation {
  type: 'query' | 'mutation' | 'subscription';
  name: string;
}

export interface NetworkEvent extends BaseEvent {
  eventType: 'network';
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodySize: number;
  responseBodySize: number;
  duration: number;
  ttfb: number;
  graphqlOperation?: GraphQLOperation;
  // M2 additions
  requestBody?: string;
  responseBody?: string;
  errorPhase?: 'error' | 'abort' | 'timeout';
  errorMessage?: string;
  source?: 'fetch' | 'xhr' | 'node-http' | 'node-https';
}

// --- Console Events ---

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug' | 'trace';

export interface ConsoleEvent extends BaseEvent {
  eventType: 'console';
  level: ConsoleLevel;
  message: string;
  args: unknown[];
  stackTrace?: string;
  sourceFile?: string;
}

// --- Build Metadata ---

export interface BuildMeta {
  gitCommit?: string;
  gitBranch?: string;
  buildTime?: string;
  deployId?: string;
}

// --- Session Events ---

export interface SessionEvent extends BaseEvent {
  eventType: 'session';
  appName: string;
  connectedAt: number;
  sdkVersion: string;
  buildMeta?: BuildMeta;
}

// --- State Events ---

export interface StateEvent extends BaseEvent {
  eventType: 'state';
  storeId: string;
  library: 'zustand' | 'redux' | 'unknown';
  phase: 'init' | 'update';
  state: unknown;
  previousState?: unknown;
  diff?: Record<string, { from: unknown; to: unknown }>;
  action?: { type: string; payload?: unknown };
  stackTrace?: string;
}

// --- Render Events ---

export interface RenderComponentProfile {
  componentName: string;
  renderCount: number;
  totalDuration: number;
  avgDuration: number;
  lastRenderPhase: 'mount' | 'update' | 'unmount';
  lastRenderCause?: 'props' | 'state' | 'context' | 'parent' | 'unknown';
  renderVelocity: number;
  suspicious: boolean;
}

export interface RenderEvent extends BaseEvent {
  eventType: 'render';
  profiles: RenderComponentProfile[];
  snapshotWindowMs: number;
  totalRenders: number;
  suspiciousComponents: string[];
}

// --- DOM Snapshot Events ---

export interface DomSnapshotEvent extends BaseEvent {
  eventType: 'dom_snapshot';
  html: string;
  url: string;
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  elementCount: number;
  truncated: boolean;
}

// --- Performance Events ---

export type WebVitalRating = 'good' | 'needs-improvement' | 'poor';

export type ServerMetricName =
  | 'memory.rss'
  | 'memory.heapUsed'
  | 'memory.heapTotal'
  | 'memory.external'
  | 'eventloop.lag.mean'
  | 'eventloop.lag.p99'
  | 'eventloop.lag.max'
  | 'gc.pause.major'
  | 'gc.pause.minor'
  | 'cpu.user'
  | 'cpu.system'
  | 'handles.active'
  | 'requests.active';

export type PerformanceMetricName =
  | 'LCP' | 'FCP' | 'CLS' | 'TTFB' | 'FID' | 'INP'
  | ServerMetricName;

export interface PerformanceEvent extends BaseEvent {
  eventType: 'performance';
  metricName: PerformanceMetricName;
  value: number;
  rating?: WebVitalRating;
  unit?: 'bytes' | 'ms' | 'percent' | 'count' | 'score';
  element?: string;
  entries?: unknown[];
}

// --- Database Events ---

export type DatabaseOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';

export type DatabaseSource =
  | 'prisma'
  | 'drizzle'
  | 'knex'
  | 'pg'
  | 'mysql2'
  | 'better-sqlite3'
  | 'generic';

export interface DatabaseEvent extends BaseEvent {
  eventType: 'database';
  query: string;
  normalizedQuery: string;
  duration: number;
  rowsReturned?: number;
  rowsAffected?: number;
  tablesAccessed: string[];
  operation: DatabaseOperation;
  source: DatabaseSource;
  stackTrace?: string;
  label?: string;
  error?: string;
  params?: string;
}

// ============================================================
// Recon Event Types — Captured by Chrome extension for UI analysis
// ============================================================

// --- Recon: Page Metadata ---

export type DetectedFramework =
  | 'react' | 'vue' | 'angular' | 'svelte' | 'solid' | 'preact' | 'htmx' | 'unknown';

export type DetectedMetaFramework =
  | 'nextjs' | 'nuxt' | 'sveltekit' | 'remix' | 'astro' | 'gatsby' | 'unknown';

export type DetectedUILibrary =
  | 'tailwind' | 'mui' | 'chakra' | 'shadcn' | 'bootstrap' | 'antd' | 'radix' | 'unknown';

export type DetectedBuildTool =
  | 'webpack' | 'vite' | 'turbopack' | 'esbuild' | 'parcel' | 'rollup' | 'unknown';

export type DetectedHosting =
  | 'vercel' | 'netlify' | 'cloudflare' | 'aws' | 'firebase' | 'railway' | 'unknown';

export interface TechStackDetection {
  name: string;
  confidence: 'high' | 'medium' | 'low';
  version?: string;
  evidence: string[];   // e.g., ["__NEXT_DATA__ global found", "/_next/ script paths"]
}

export interface ReconMetadataEvent extends BaseEvent {
  eventType: 'recon_metadata';
  url: string;
  title: string;
  viewport: { width: number; height: number };
  documentLang?: string;
  metaTags: Record<string, string>;             // name → content
  techStack: {
    framework: TechStackDetection;
    metaFramework?: TechStackDetection;
    uiLibrary?: TechStackDetection;
    buildTool?: TechStackDetection;
    hosting?: TechStackDetection;
    stateManagement?: TechStackDetection;
    additional: TechStackDetection[];
  };
  externalStylesheets: { href: string; crossOrigin: boolean }[];
  externalScripts: { src: string; async: boolean; defer: boolean; type?: string }[];
  preloads: { href: string; as: string }[];
}

// --- Recon: Design Tokens ---

export interface CSSCustomProperty {
  name: string;             // e.g., "--color-primary"
  value: string;            // e.g., "#3b82f6"
  source: string;           // e.g., ":root", ".dark", "body"
}

export interface ColorToken {
  value: string;            // hex, rgb, hsl as found
  hex: string;              // normalized to hex
  usageCount: number;       // how many elements use this color
  properties: string[];     // which CSS properties (color, background-color, border-color)
  sampleSelectors: string[];// up to 3 example selectors that use it
}

export interface TypographyToken {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  usageCount: number;
  sampleSelectors: string[];
}

export interface SpacingValue {
  value: string;            // e.g., "16px", "1rem"
  pixels: number;           // normalized to px
  usageCount: number;
  properties: string[];     // padding, margin, gap
}

export type CSSArchitecture =
  | 'tailwind' | 'css-modules' | 'styled-components' | 'css-in-js'
  | 'bem' | 'atomic' | 'vanilla' | 'unknown';

export interface ReconDesignTokensEvent extends BaseEvent {
  eventType: 'recon_design_tokens';
  url: string;
  customProperties: CSSCustomProperty[];
  colors: ColorToken[];
  typography: TypographyToken[];
  spacing: SpacingValue[];
  borderRadii: { value: string; usageCount: number }[];
  boxShadows: { value: string; usageCount: number }[];
  cssArchitecture: CSSArchitecture;
  classNamingPatterns: string[];     // e.g., ["tailwind utilities", "BEM blocks"]
  sampleClassNames: string[];       // first 50 unique class names found
}

// --- Recon: Fonts ---

export interface FontFaceInfo {
  family: string;
  weight: string;
  style: string;
  src: string;
  display?: string;
  unicodeRange?: string;
}

export interface FontUsage {
  family: string;
  weight: string;
  style: string;
  usageCount: number;       // elements using this combo
  sampleSelectors: string[];
}

export interface ReconFontsEvent extends BaseEvent {
  eventType: 'recon_fonts';
  url: string;
  fontFaces: FontFaceInfo[];
  fontsUsed: FontUsage[];
  iconFonts: {
    family: string;
    glyphsUsed: { codepoint: string; selector: string }[];
  }[];
  loadingStrategy: string;   // e.g., "Google Fonts via <link>", "self-hosted woff2"
}

// --- Recon: Layout Tree ---

export interface LayoutNode {
  tag: string;
  id?: string;
  classList: string[];
  role?: string;
  ariaLabel?: string;
  dataAttributes: Record<string, string>;
  boundingRect: { x: number; y: number; width: number; height: number };
  display: string;           // computed display value
  position: string;          // static, relative, absolute, fixed, sticky
  // Flex/grid props (only present when display is flex/grid)
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  flexWrap?: string;
  gap?: string;
  gridTemplateColumns?: string;
  gridTemplateRows?: string;
  // Key visual props
  overflow?: string;
  zIndex?: string;
  opacity?: string;
  children: LayoutNode[];
  childCount: number;        // total descendants (not just direct children)
  textContent?: string;      // trimmed, max 200 chars, only for leaf text nodes
}

export interface ReconLayoutTreeEvent extends BaseEvent {
  eventType: 'recon_layout_tree';
  url: string;
  viewport: { width: number; height: number };
  scrollHeight: number;
  rootSelector?: string;     // if scoped to a subtree
  tree: LayoutNode;
  totalElements: number;
  maxDepth: number;
}

// --- Recon: Accessibility ---

export interface HeadingInfo {
  level: number;             // 1-6
  text: string;
  selector: string;
}

export interface LandmarkInfo {
  role: string;              // banner, navigation, main, contentinfo, etc.
  label?: string;
  selector: string;
}

export interface FormFieldInfo {
  tag: string;               // input, select, textarea
  type?: string;             // text, email, password, etc.
  name?: string;
  label?: string;
  required: boolean;
  ariaDescribedBy?: string;
  selector: string;
}

export interface InteractiveElementInfo {
  tag: string;
  role?: string;
  text: string;
  ariaLabel?: string;
  href?: string;
  tabIndex?: number;
  selector: string;
}

export interface ReconAccessibilityEvent extends BaseEvent {
  eventType: 'recon_accessibility';
  url: string;
  headings: HeadingInfo[];
  landmarks: LandmarkInfo[];
  formFields: FormFieldInfo[];
  links: InteractiveElementInfo[];
  buttons: InteractiveElementInfo[];
  images: { src: string; alt: string; hasAlt: boolean; selector: string }[];
  issues: string[];          // accessibility warnings
}

// --- Recon: Computed Styles ---

export interface ComputedStyleEntry {
  selector: string;
  matchCount: number;        // how many elements matched
  styles: Record<string, string>;  // property → computed value
  // When multiple elements match, flags differences
  variations?: {
    property: string;
    values: { value: string; count: number }[];
  }[];
}

export interface ReconComputedStylesEvent extends BaseEvent {
  eventType: 'recon_computed_styles';
  url: string;
  selector: string;          // the query selector used
  propertyFilter?: string[];  // if only specific props were requested
  entries: ComputedStyleEntry[];
}

// --- Recon: Element Snapshot ---

export interface ElementSnapshotNode {
  tag: string;
  id?: string;
  classList: string[];
  attributes: Record<string, string>;
  textContent?: string;        // trimmed, max 200 chars
  boundingRect: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>;   // key visual/layout properties
  children: ElementSnapshotNode[];
}

export interface ReconElementSnapshotEvent extends BaseEvent {
  eventType: 'recon_element_snapshot';
  url: string;
  selector: string;
  depth: number;               // how deep into children we captured
  root: ElementSnapshotNode;
  totalNodes: number;
}

// --- Recon: Asset Inventory ---

export interface ImageAsset {
  src: string;
  alt?: string;
  width: number;
  height: number;
  naturalWidth?: number;
  naturalHeight?: number;
  format?: string;           // jpg, png, svg, webp, avif
  loading?: string;          // lazy, eager
  selector: string;
}

export interface SpriteFrame {
  selector: string;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  extractedDataUrl?: string;  // cropped frame as data URL
}

export interface BackgroundSpriteSheet {
  sheetUrl: string;
  sheetWidth?: number;
  sheetHeight?: number;
  frames: SpriteFrame[];
}

export interface SVGSpriteSymbol {
  id: string;
  viewBox?: string;
  paths: string;             // the SVG path data
  referencedBy: string[];    // selectors using <use href="#id">
}

export interface IconFontInfo {
  fontFamily: string;
  fontFaceUrl?: string;
  glyphs: {
    codepoint: string;
    pseudoElement: string;    // ::before or ::after
    selector: string;
    renderedSize: number;
  }[];
}

export interface InlineSVGAsset {
  selector: string;
  viewBox?: string;
  width?: number;
  height?: number;
  source: string;             // full SVG markup
}

export interface MaskSpriteSheet {
  sheetUrl: string;
  sheetWidth?: number;
  sheetHeight?: number;
  frames: SpriteFrame[];
}

export interface ReconAssetInventoryEvent extends BaseEvent {
  eventType: 'recon_asset_inventory';
  url: string;
  images: ImageAsset[];
  inlineSVGs: InlineSVGAsset[];
  svgSprites: SVGSpriteSymbol[];
  backgroundSprites: BackgroundSpriteSheet[];
  maskSprites: MaskSpriteSheet[];
  iconFonts: IconFontInfo[];
  totalAssets: number;
}

// --- Recon Filter ---

export interface ReconFilter {
  reconType?: ReconEventType;
  sinceSeconds?: number;
  sessionId?: string;
  url?: string;
}

export type ReconEventType =
  | 'recon_metadata'
  | 'recon_design_tokens'
  | 'recon_fonts'
  | 'recon_layout_tree'
  | 'recon_accessibility'
  | 'recon_computed_styles'
  | 'recon_element_snapshot'
  | 'recon_asset_inventory';

// --- Union ---

export type RuntimeEvent =
  | NetworkEvent
  | ConsoleEvent
  | SessionEvent
  | StateEvent
  | RenderEvent
  | DomSnapshotEvent
  | PerformanceEvent
  | DatabaseEvent
  | ReconMetadataEvent
  | ReconDesignTokensEvent
  | ReconFontsEvent
  | ReconLayoutTreeEvent
  | ReconAccessibilityEvent
  | ReconComputedStylesEvent
  | ReconElementSnapshotEvent
  | ReconAssetInventoryEvent;

// --- Query Filters ---

export interface NetworkFilter {
  sinceSeconds?: number;
  urlPattern?: string;
  status?: number;
  method?: string;
  sessionId?: string;
}

export interface ConsoleFilter {
  level?: string;
  sinceSeconds?: number;
  search?: string;
  sessionId?: string;
}

export interface StateFilter {
  storeId?: string;
  sinceSeconds?: number;
  sessionId?: string;
}

export interface RenderFilter {
  componentName?: string;
  sinceSeconds?: number;
  sessionId?: string;
}

export interface PerformanceFilter {
  metricName?: string;
  sinceSeconds?: number;
  sessionId?: string;
}

export interface DatabaseFilter {
  sinceSeconds?: number;
  table?: string;
  minDurationMs?: number;
  search?: string;
  operation?: DatabaseOperation;
  source?: DatabaseSource;
  sessionId?: string;
}

// --- Historical Filter (SQLite queries) ---

export interface HistoricalFilter {
  project?: string;
  sessionId?: string;
  eventTypes?: EventType[];
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  endpoint?: string;
  component?: string;
  storeId?: string;
}

// --- Tool Response Envelope ---

export interface ToolResponse<T = unknown> {
  summary: string;
  data: T;
  issues: string[];
  metadata: {
    timeRange: { from: number; to: number };
    eventCount: number;
    sessionId: string | null;
  };
}

// --- Session Info ---

export interface SessionInfo {
  sessionId: string;
  appName: string;
  connectedAt: number;
  sdkVersion: string;
  eventCount: number;
  isConnected: boolean;
}

export interface SessionInfoExtended extends SessionInfo {
  project: string;
  disconnectedAt?: number;
  buildMeta?: BuildMeta;
}

// --- Session Metrics & Diffing ---

export interface SessionMetrics {
  sessionId: string;
  project: string;
  connectedAt: number;
  disconnectedAt: number;
  totalEvents: number;
  errorCount: number;
  endpoints: Record<string, { avgLatency: number; errorRate: number; callCount: number }>;
  components: Record<string, { renderCount: number; avgDuration: number }>;
  stores: Record<string, { updateCount: number }>;
  webVitals: Record<string, { value: number; rating: WebVitalRating }>;
  queries: Record<string, { avgDuration: number; callCount: number }>;
}

export interface MetricDelta {
  key: string;
  before: number;
  after: number;
  delta: number;
  percentChange: number;
  classification: 'regression' | 'improvement' | 'unchanged';
}

export interface SessionDiffResult {
  sessionA: string;
  sessionB: string;
  endpointDeltas: MetricDelta[];
  componentDeltas: MetricDelta[];
  storeDeltas: MetricDelta[];
  webVitalDeltas: MetricDelta[];
  queryDeltas: MetricDelta[];
  overallDelta: {
    errorCountDelta: number;
    totalEventsDelta: number;
  };
}

export interface SessionSnapshot {
  sessionId: string;
  project: string;
  snapshotPath?: string;
  metrics: SessionMetrics;
  buildMeta?: BuildMeta;
  createdAt: number;
}

// --- WebSocket Protocol ---

export interface WSMessage {
  type: 'event' | 'handshake' | 'heartbeat' | 'command' | 'command_response';
  payload: unknown;
  timestamp: number;
  sessionId: string;
}

export interface HandshakePayload {
  appName: string;
  sdkVersion: string;
  sessionId: string;
}

export interface EventBatchPayload {
  events: RuntimeEvent[];
}

// --- Server→SDK Commands ---

export type ServerCommand =
  | { command: 'capture_dom_snapshot'; requestId: string; params?: { maxSize?: number } }
  | { command: 'capture_performance_metrics'; requestId: string }
  | { command: 'clear_renders'; requestId: string }
  // Recon commands — sent to extension for on-demand capture
  | { command: 'recon_scan'; requestId: string; params?: { categories?: ReconEventType[] } }
  | { command: 'recon_computed_styles'; requestId: string; params: { selector: string; properties?: string[] } }
  | { command: 'recon_element_snapshot'; requestId: string; params: { selector: string; depth?: number } }
  | { command: 'recon_layout_tree'; requestId: string; params?: { selector?: string; maxDepth?: number } };

export interface CommandResponse {
  type: 'command_response';
  requestId: string;
  command: string;
  payload: unknown;
  timestamp: number;
  sessionId: string;
}

// --- Timeline ---

export interface TimelineFilter {
  sinceSeconds?: number;
  eventTypes?: EventType[];
  sessionId?: string;
}

// --- Issue Detection ---

export type IssueSeverity = 'high' | 'medium' | 'low';

export interface DetectedIssue {
  id: string;
  pattern: string;
  severity: IssueSeverity;
  title: string;
  description: string;
  evidence: string[];
  suggestion?: string;
}

// --- API Discovery ---

export interface AuthInfo {
  type: 'bearer' | 'basic' | 'api_key' | 'cookie' | 'none';
  headerName?: string;
}

export interface ApiContractField {
  path: string;
  type: string;
  nullable: boolean;
  example?: unknown;
}

export interface ApiContract {
  requestFields?: ApiContractField[];
  responseFields: ApiContractField[];
  sampleCount: number;
}

export interface ApiEndpoint {
  normalizedPath: string;
  method: string;
  baseUrl: string;
  service: string;
  callCount: number;
  firstSeen: number;
  lastSeen: number;
  auth: AuthInfo;
  contract?: ApiContract;
  graphqlOperation?: GraphQLOperation;
}

export interface ApiEndpointHealth {
  normalizedPath: string;
  method: string;
  service: string;
  callCount: number;
  successRate: number;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  errorRate: number;
  errorCodes: Record<number, number>;
}

export interface ServiceInfo {
  name: string;
  baseUrl: string;
  endpointCount: number;
  totalCalls: number;
  avgLatency: number;
  errorRate: number;
  auth: AuthInfo;
  detectedPlatform?: string;
}

export interface ApiChangeRecord {
  normalizedPath: string;
  method: string;
  changeType: 'added' | 'removed' | 'modified';
  fieldChanges?: {
    path: string;
    change: 'added' | 'removed' | 'type_changed';
    oldType?: string;
    newType?: string;
  }[];
}

// --- Query Monitor ---

export interface NormalizedQueryStats {
  normalizedQuery: string;
  tables: string[];
  operation: DatabaseOperation;
  callCount: number;
  avgDuration: number;
  maxDuration: number;
  p95Duration: number;
  totalDuration: number;
  avgRowsReturned: number;
}

export interface IndexSuggestion {
  table: string;
  columns: string[];
  reason: string;
  estimatedImpact: 'high' | 'medium' | 'low';
  queryPattern: string;
}

// --- Schema Introspection ---

export interface DatabaseConnectionConfig {
  id: string;
  type: 'postgres' | 'mysql' | 'sqlite';
  connectionString?: string;
  label?: string;
  projectRef?: string;
  serviceKey?: string;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
}

export interface SchemaForeignKey {
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface SchemaIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  foreignKeys: SchemaForeignKey[];
  indexes: SchemaIndex[];
  rowCount?: number;
}

export interface DatabaseSchema {
  connectionId: string;
  tables: SchemaTable[];
  fetchedAt: number;
}

// --- Process Monitor ---

export type DevProcessType =
  | 'next'
  | 'vite'
  | 'webpack'
  | 'wrangler'
  | 'prisma'
  | 'docker'
  | 'postgres'
  | 'mysql'
  | 'redis'
  | 'node'
  | 'bun'
  | 'deno'
  | 'python'
  | 'unknown';

export interface DevProcess {
  pid: number;
  command: string;
  type: DevProcessType;
  cpuPercent: number;
  memoryMB: number;
  ports: number[];
  cwd?: string;
  project?: string;
  uptime?: number;
  isOrphaned: boolean;
}

export interface PortUsage {
  port: number;
  pid: number;
  process: string;
  type: DevProcessType;
  project?: string;
}

// --- Infrastructure Connector ---

export interface DeployLog {
  id: string;
  platform: string;
  project: string;
  status: 'building' | 'ready' | 'error' | 'canceled';
  url?: string;
  branch?: string;
  commit?: string;
  createdAt: number;
  readyAt?: number;
  errorMessage?: string;
}

export interface RuntimeLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
  platform: string;
}

export interface BuildStatus {
  platform: string;
  project: string;
  latestDeployId: string;
  status: 'building' | 'ready' | 'error' | 'canceled';
  url?: string;
  lastDeployed: number;
}

export interface InfraOverview {
  project: string;
  platforms: {
    name: string;
    configured: boolean;
    deployCount: number;
    lastDeploy?: number;
    status?: string;
  }[];
  detectedFromTraffic: string[];
}
