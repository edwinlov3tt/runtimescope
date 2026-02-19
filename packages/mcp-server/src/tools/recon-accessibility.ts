import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';

export function registerReconAccessibilityTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_accessibility_tree',
    'Get the accessibility structure of the current page: heading hierarchy (h1-h6), ARIA landmarks (nav, main, aside), form fields with labels, buttons, links, and images with alt text status. Useful for ensuring UI recreations maintain proper semantic HTML and accessibility.',
    {
      url: z
        .string()
        .optional()
        .describe('Filter by URL substring'),
    },
    async ({ url }) => {
      const event = store.getReconAccessibility({ url });
      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      if (!event) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: 'No accessibility data captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.',
              data: null,
              issues: ['No recon_accessibility events found in the event store'],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId },
            }, null, 2),
          }],
        };
      }

      const issues = [...event.issues];

      // Analyze heading structure
      const headingLevels = event.headings.map((h) => h.level);
      if (headingLevels.length > 0 && headingLevels[0] !== 1) {
        issues.push(`First heading is h${headingLevels[0]}, not h1.`);
      }
      for (let i = 1; i < headingLevels.length; i++) {
        if (headingLevels[i] > headingLevels[i - 1] + 1) {
          issues.push(`Heading level skip: h${headingLevels[i - 1]} → h${headingLevels[i]} (missing h${headingLevels[i - 1] + 1}).`);
          break;
        }
      }

      // Check images without alt
      const missingAlt = event.images.filter((img) => !img.hasAlt);
      if (missingAlt.length > 0) {
        issues.push(`${missingAlt.length} image(s) missing alt text.`);
      }

      // Check form labels
      const unlabeled = event.formFields.filter((f) => !f.label && !f.ariaDescribedBy);
      if (unlabeled.length > 0) {
        issues.push(`${unlabeled.length} form field(s) without labels.`);
      }

      // Check landmarks
      const hasMain = event.landmarks.some((l) => l.role === 'main');
      const hasNav = event.landmarks.some((l) => l.role === 'navigation');
      if (!hasMain) issues.push('No <main> landmark found.');
      if (!hasNav) issues.push('No <nav> landmark found.');

      const response = {
        summary: `${event.headings.length} headings, ${event.landmarks.length} landmarks, ${event.formFields.length} form fields, ${event.buttons.length} buttons, ${event.links.length} links, ${event.images.length} images. ${issues.length} accessibility issue(s).`,
        data: {
          headings: event.headings,
          landmarks: event.landmarks,
          formFields: event.formFields,
          buttons: event.buttons,
          links: event.links,
          images: event.images,
        },
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
