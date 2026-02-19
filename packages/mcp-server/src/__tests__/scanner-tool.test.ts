import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventStore } from '@runtimescope/collector';
import { registerScannerTools } from '../tools/scanner.js';
import { createMcpStub } from './tool-harness.js';
import type { PlaywrightScanner, ScanResult } from '../scanner/index.js';
import type { TechDetectionResult } from '@runtimescope/extension';

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  const events = [
    { eventId: 'evt-1', sessionId: 'scan-1', timestamp: Date.now(), eventType: 'recon_metadata' as const, url: 'https://example.com', title: 'Example' },
    { eventId: 'evt-2', sessionId: 'scan-1', timestamp: Date.now(), eventType: 'recon_design_tokens' as const, url: 'https://example.com' },
    { eventId: 'evt-3', sessionId: 'scan-1', timestamp: Date.now(), eventType: 'recon_layout_tree' as const, url: 'https://example.com' },
    { eventId: 'evt-4', sessionId: 'scan-1', timestamp: Date.now(), eventType: 'recon_accessibility' as const, url: 'https://example.com' },
    { eventId: 'evt-5', sessionId: 'scan-1', timestamp: Date.now(), eventType: 'recon_fonts' as const, url: 'https://example.com' },
    { eventId: 'evt-6', sessionId: 'scan-1', timestamp: Date.now(), eventType: 'recon_asset_inventory' as const, url: 'https://example.com' },
  ];

  const techStack: TechDetectionResult[] = [
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
  ];

  return {
    url: 'https://example.com',
    title: 'Example Site',
    techStack,
    events: events as unknown as ScanResult['events'],
    summary: 'Scanned: Example Site. Tech stack: React 18.2.0 (100%), Next.js 14.0.0 (90%)',
    scanDurationMs: 3500,
    ...overrides,
  };
}

function createMockScanner(result?: ScanResult): PlaywrightScanner {
  return {
    scan: vi.fn().mockResolvedValue(result ?? makeScanResult()),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlaywrightScanner;
}

describe('scan_website tool', () => {
  let store: EventStore;
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;
  let scanner: PlaywrightScanner;

  beforeEach(() => {
    store = new EventStore(100);
    scanner = createMockScanner();
    const { server, callTool: ct } = createMcpStub();
    callTool = ct;
    registerScannerTools(server, store, scanner);
  });

  it('registers the scan_website tool', () => {
    const { server, getTools } = createMcpStub();
    registerScannerTools(server, store, createMockScanner());
    expect(getTools().has('scan_website')).toBe(true);
  });

  it('calls scanner.scan with the provided URL', async () => {
    // Note: harness doesn't apply zod defaults, so pass all params explicitly
    await callTool('scan_website', {
      url: 'https://stripe.com',
      viewport_width: 1280,
      viewport_height: 720,
      wait_for: 'networkidle',
    });
    expect(scanner.scan).toHaveBeenCalledWith('https://stripe.com', {
      viewportWidth: 1280,
      viewportHeight: 720,
      waitFor: 'networkidle',
    });
  });

  it('passes custom viewport and wait options', async () => {
    await callTool('scan_website', {
      url: 'https://example.com',
      viewport_width: 375,
      viewport_height: 812,
      wait_for: 'load',
    });
    expect(scanner.scan).toHaveBeenCalledWith('https://example.com', {
      viewportWidth: 375,
      viewportHeight: 812,
      waitFor: 'load',
    });
  });

  it('writes events to the store', async () => {
    await callTool('scan_website', { url: 'https://example.com' });
    // The mock returns 6 events; all should be written to store
    expect(store.getAllEvents().length).toBeGreaterThanOrEqual(6);
  });

  it('returns summary with tech stack info', async () => {
    const result = await callTool('scan_website', { url: 'https://example.com' });
    expect(result.summary).toContain('Scanned');
    expect(result.data.techStack).toHaveLength(2);
    expect(result.data.techStack[0].name).toBe('React');
  });

  it('returns available tool hints', async () => {
    const result = await callTool('scan_website', { url: 'https://example.com' });
    expect(result.data.availableTools).toBeDefined();
    expect(result.data.availableTools.length).toBeGreaterThan(0);
    expect(result.data.availableTools.some((t: string) => t.includes('get_design_tokens'))).toBe(true);
  });

  it('returns metadata with scan duration', async () => {
    const result = await callTool('scan_website', { url: 'https://example.com' });
    expect(result.metadata.scanDurationMs).toBe(3500);
    expect(result.metadata.eventCount).toBe(6);
  });

  it('handles scan errors gracefully', async () => {
    const failScanner = {
      scan: vi.fn().mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED')),
      shutdown: vi.fn(),
    } as unknown as PlaywrightScanner;

    const { server, callTool: ct } = createMcpStub();
    registerScannerTools(server, store, failScanner);

    // callTool already parses the JSON response
    const result = await ct('scan_website', { url: 'https://nonexistent.example' });
    expect(result.summary).toContain('Scan failed');
    expect(result.summary).toContain('net::ERR_');
    expect(result.summary).toContain('unreachable');
  });

  it('provides hint for missing Chromium', async () => {
    const failScanner = {
      scan: vi.fn().mockRejectedValue(new Error('browserType.launch: Executable doesn\'t exist')),
      shutdown: vi.fn(),
    } as unknown as PlaywrightScanner;

    const { server, callTool: ct } = createMcpStub();
    registerScannerTools(server, store, failScanner);

    const result = await ct('scan_website', { url: 'https://example.com' });
    expect(result.summary).toContain('npx playwright install chromium');
  });

  it('provides hint for timeouts', async () => {
    const failScanner = {
      scan: vi.fn().mockRejectedValue(new Error('Timeout 30000ms exceeded')),
      shutdown: vi.fn(),
    } as unknown as PlaywrightScanner;

    const { server, callTool: ct } = createMcpStub();
    registerScannerTools(server, store, failScanner);

    const result = await ct('scan_website', { url: 'https://example.com' });
    expect(result.summary).toContain('wait_for');
  });

  it('marks empty tech stack with an issue', async () => {
    const emptyTechResult = makeScanResult({ techStack: [] });
    const emptyScanner = createMockScanner(emptyTechResult);

    const { server, callTool: ct } = createMcpStub();
    registerScannerTools(server, store, emptyScanner);

    const result = await ct('scan_website', { url: 'https://example.com' });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('No technologies detected');
  });

  it('limits tech stack to 15 entries in response', async () => {
    const manyTechs: TechDetectionResult[] = Array.from({ length: 25 }, (_, i) => ({
      name: `Tech${i}`,
      version: '',
      confidence: 100 - i,
      categories: [{ id: 1, name: 'Test' }],
      website: '',
      icon: '',
    }));
    const manyTechResult = makeScanResult({ techStack: manyTechs });
    const manyScanner = createMockScanner(manyTechResult);

    const { server, callTool: ct } = createMcpStub();
    registerScannerTools(server, store, manyScanner);

    const result = await ct('scan_website', { url: 'https://example.com' });
    expect(result.data.techStack.length).toBeLessThanOrEqual(15);
    expect(result.data.totalTechnologiesDetected).toBe(25);
  });
});
