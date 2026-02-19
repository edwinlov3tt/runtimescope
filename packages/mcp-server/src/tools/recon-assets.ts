import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';

export function registerReconAssetTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_asset_inventory',
    'Sprite-aware asset inventory for the current page. Detects and extracts: standard images, inline SVGs, SVG sprite sheets (<symbol>/<use> references), CSS background sprites (with crop coordinates and extracted frames), CSS mask sprites, and icon fonts (with glyph codepoints). For CSS sprites, calculates the exact crop rectangle from background-position/size and can provide extracted individual frames as data URLs.',
    {
      category: z
        .enum(['all', 'images', 'svg', 'sprites', 'icon_fonts'])
        .optional()
        .default('all')
        .describe('Filter by asset category'),
      url: z
        .string()
        .optional()
        .describe('Filter by page URL substring'),
    },
    async ({ category, url }) => {
      const event = store.getReconAssetInventory({ url });
      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      if (!event) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: 'No asset inventory captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.',
              data: null,
              issues: ['No recon_asset_inventory events found in the event store'],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId },
            }, null, 2),
          }],
        };
      }

      const issues: string[] = [];

      // Build category-filtered response
      const data: Record<string, unknown> = {};

      if (category === 'all' || category === 'images') {
        data.images = event.images;
        // Flag missing alt text
        const missingAlt = event.images.filter((img) => !img.alt);
        if (missingAlt.length > 0) {
          issues.push(`${missingAlt.length} image(s) missing alt text.`);
        }
        // Flag oversized images
        const oversized = event.images.filter(
          (img) => img.naturalWidth && img.width && img.naturalWidth > img.width * 2,
        );
        if (oversized.length > 0) {
          issues.push(`${oversized.length} image(s) are significantly larger than their display size — consider resizing.`);
        }
      }

      if (category === 'all' || category === 'svg') {
        data.inlineSVGs = event.inlineSVGs;
        data.svgSprites = event.svgSprites;
      }

      if (category === 'all' || category === 'sprites') {
        data.backgroundSprites = event.backgroundSprites;
        data.maskSprites = event.maskSprites;
        data.svgSprites = event.svgSprites;

        // Summarize sprite sheets
        const totalBgFrames = event.backgroundSprites.reduce((sum, s) => sum + s.frames.length, 0);
        const totalMaskFrames = event.maskSprites.reduce((sum, s) => sum + s.frames.length, 0);
        const totalSvgSymbols = event.svgSprites.length;

        if (totalBgFrames > 0 || totalMaskFrames > 0 || totalSvgSymbols > 0) {
          const spriteParts: string[] = [];
          if (totalBgFrames > 0) spriteParts.push(`${totalBgFrames} background sprite frame(s) from ${event.backgroundSprites.length} sheet(s)`);
          if (totalMaskFrames > 0) spriteParts.push(`${totalMaskFrames} mask sprite frame(s) from ${event.maskSprites.length} sheet(s)`);
          if (totalSvgSymbols > 0) spriteParts.push(`${totalSvgSymbols} SVG symbol(s)`);
          issues.push(`Sprite detection: ${spriteParts.join(', ')}.`);
        }
      }

      if (category === 'all' || category === 'icon_fonts') {
        data.iconFonts = event.iconFonts;
        const totalGlyphs = event.iconFonts.reduce((sum, f) => sum + f.glyphs.length, 0);
        if (totalGlyphs > 0) {
          issues.push(`${totalGlyphs} icon font glyph(s) from ${event.iconFonts.length} font(s) detected.`);
        }
      }

      // Build summary
      const summaryParts: string[] = [];
      summaryParts.push(`${event.images.length} images`);
      summaryParts.push(`${event.inlineSVGs.length} inline SVGs`);
      const bgFrames = event.backgroundSprites.reduce((sum, s) => sum + s.frames.length, 0);
      if (bgFrames > 0) summaryParts.push(`${bgFrames} CSS sprite frames`);
      if (event.svgSprites.length > 0) summaryParts.push(`${event.svgSprites.length} SVG symbols`);
      if (event.maskSprites.length > 0) {
        const maskFrames = event.maskSprites.reduce((sum, s) => sum + s.frames.length, 0);
        summaryParts.push(`${maskFrames} mask sprite frames`);
      }
      const totalGlyphs = event.iconFonts.reduce((sum, f) => sum + f.glyphs.length, 0);
      if (totalGlyphs > 0) summaryParts.push(`${totalGlyphs} icon font glyphs`);
      summaryParts.push(`${event.totalAssets} total assets`);

      const response = {
        summary: summaryParts.join(', ') + '.',
        data,
        issues,
        metadata: {
          timeRange: { from: event.timestamp, to: event.timestamp },
          eventCount: 1,
          sessionId: event.sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
