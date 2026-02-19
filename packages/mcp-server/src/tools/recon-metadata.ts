import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import type { CollectorServer } from '@runtimescope/collector';

export function registerReconMetadataTools(
  server: McpServer,
  store: EventStore,
  collector: CollectorServer,
): void {
  server.tool(
    'get_page_metadata',
    'Get page metadata and tech stack detection for the current page. Returns URL, viewport, meta tags, detected framework/UI library/build tool/hosting, external stylesheets and scripts. Requires the RuntimeScope extension to be connected.',
    {
      url: z
        .string()
        .optional()
        .describe('Filter by URL substring'),
      force_refresh: z
        .boolean()
        .optional()
        .default(false)
        .describe('Send a recon_scan command to the extension to capture fresh data'),
    },
    async ({ url, force_refresh }) => {
      if (force_refresh) {
        const sessions = store.getSessionInfo();
        const activeSession = sessions.find((s) => s.isConnected);
        if (activeSession) {
          try {
            await collector.sendCommand(activeSession.sessionId, {
              command: 'recon_scan',
              requestId: crypto.randomUUID(),
              params: { categories: ['recon_metadata'] },
            });
          } catch {
            // Extension may not support commands yet; fall through to stored data
          }
        }
      }

      const event = store.getReconMetadata({ url });
      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      if (!event) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: 'No page metadata captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.',
              data: null,
              issues: ['No recon_metadata events found in the event store'],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId },
            }, null, 2),
          }],
        };
      }

      const ts = event.techStack;
      const stackParts: string[] = [];
      if (ts.framework.name !== 'unknown') stackParts.push(`${ts.framework.name}${ts.framework.version ? ' ' + ts.framework.version : ''}`);
      if (ts.metaFramework?.name && ts.metaFramework.name !== 'unknown') stackParts.push(ts.metaFramework.name);
      if (ts.uiLibrary?.name && ts.uiLibrary.name !== 'unknown') stackParts.push(ts.uiLibrary.name);
      if (ts.hosting?.name && ts.hosting.name !== 'unknown') stackParts.push(`on ${ts.hosting.name}`);

      const issues: string[] = [];
      if (!event.metaTags['viewport']) {
        issues.push('No viewport meta tag detected');
      }
      if (ts.framework.confidence === 'low') {
        issues.push(`Framework detection confidence is low: ${ts.framework.name}`);
      }

      const response = {
        summary: `Page: ${event.title || event.url}. Tech stack: ${stackParts.join(' + ') || 'unknown'}. ${event.externalStylesheets.length} stylesheets, ${event.externalScripts.length} scripts.`,
        data: {
          url: event.url,
          title: event.title,
          viewport: event.viewport,
          documentLang: event.documentLang,
          metaTags: event.metaTags,
          techStack: {
            framework: ts.framework,
            metaFramework: ts.metaFramework ?? null,
            uiLibrary: ts.uiLibrary ?? null,
            buildTool: ts.buildTool ?? null,
            hosting: ts.hosting ?? null,
            stateManagement: ts.stateManagement ?? null,
            additional: ts.additional,
          },
          externalStylesheets: event.externalStylesheets,
          externalScripts: event.externalScripts,
          preloads: event.preloads,
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
