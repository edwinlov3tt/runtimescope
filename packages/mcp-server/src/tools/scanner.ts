import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import type { PlaywrightScanner } from '../scanner/index.js';

export function registerScannerTools(
  server: McpServer,
  store: EventStore,
  scanner: PlaywrightScanner,
): void {
  server.tool(
    'scan_website',
    'Visit a website with a headless browser and extract comprehensive data: tech stack (7,221 technologies), design tokens (colors, typography, spacing, CSS variables), layout tree (DOM with bounding rects, flex/grid), accessibility structure, fonts, and asset inventory (images, SVGs, sprites). After scanning, all recon tools (get_design_tokens, get_layout_tree, get_font_info, etc.) will return data from the scanned page. This is the primary way to analyze any website.',
    {
      url: z
        .string()
        .describe('The full URL to scan (e.g., "https://stripe.com")'),
      viewport_width: z
        .number()
        .optional()
        .default(1280)
        .describe('Viewport width in pixels (default: 1280)'),
      viewport_height: z
        .number()
        .optional()
        .default(720)
        .describe('Viewport height in pixels (default: 720)'),
      wait_for: z
        .enum(['load', 'networkidle', 'domcontentloaded'])
        .optional()
        .default('networkidle')
        .describe('Wait condition before scanning (default: networkidle)'),
    },
    async ({ url, viewport_width, viewport_height, wait_for }) => {
      try {
        const result = await scanner.scan(url, {
          viewportWidth: viewport_width,
          viewportHeight: viewport_height,
          waitFor: wait_for,
        });

        // Write all recon events to the store
        for (const event of result.events) {
          store.addEvent(event);
        }

        const topTech = result.techStack.slice(0, 15).map((t) => ({
          name: t.name,
          version: t.version || undefined,
          confidence: t.confidence,
          categories: t.categories.map((c) => c.name),
        }));

        const issues: string[] = [];
        if (result.techStack.length === 0) {
          issues.push('No technologies detected — the page may use server-rendered HTML with no identifiable framework.');
        }

        const response = {
          summary: result.summary,
          data: {
            url: result.url,
            title: result.title,
            techStack: topTech,
            totalTechnologiesDetected: result.techStack.length,
            eventsStored: result.events.length,
            availableTools: [
              'get_page_metadata — tech stack details',
              'get_design_tokens — colors, typography, spacing, CSS variables',
              'get_layout_tree — DOM structure with layout info',
              'get_font_info — font faces and usage',
              'get_accessibility_tree — headings, landmarks, forms',
              'get_asset_inventory — images, SVGs, sprites',
              'get_computed_styles — CSS values for specific selectors',
              'get_element_snapshot — deep snapshot of an element',
              'get_style_diff — compare styles between selectors',
            ],
          },
          issues,
          metadata: {
            timeRange: { from: Date.now() - result.scanDurationMs, to: Date.now() },
            eventCount: result.events.length,
            sessionId: result.events[0]?.sessionId ?? null,
            scanDurationMs: result.scanDurationMs,
          },
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Provide helpful error messages
        let hint = '';
        if (message.includes('browserType.launch')) {
          hint = ' Ensure Chromium is installed: npx playwright install chromium';
        } else if (message.includes('net::ERR_')) {
          hint = ' The URL may be unreachable or blocked.';
        } else if (message.includes('Timeout')) {
          hint = ' The page took too long to load. Try with wait_for: "load" instead of "networkidle".';
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: `Scan failed: ${message}${hint}`,
              data: null,
              issues: [`Scan error: ${message}${hint}`],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
            }, null, 2),
          }],
        };
      }
    },
  );
}
