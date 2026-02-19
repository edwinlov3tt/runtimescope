import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import type { PlaywrightScanner } from '../scanner/index.js';

const COLLECTOR_PORT = process.env.RUNTIMESCOPE_PORT ?? '9090';
const HTTP_PORT = process.env.RUNTIMESCOPE_HTTP_PORT ?? '9091';

export function registerScannerTools(
  server: McpServer,
  store: EventStore,
  scanner: PlaywrightScanner,
): void {
  // ---------- get_sdk_snippet ----------
  server.tool(
    'get_sdk_snippet',
    'Generate a ready-to-paste code snippet to connect any web application to RuntimeScope for live runtime monitoring. Works with ANY tech stack — React, Vue, Angular, Svelte, plain HTML, Flask/Django templates, Rails ERB, PHP, WordPress, etc. Returns the appropriate installation method based on the project type.',
    {
      app_name: z
        .string()
        .optional()
        .default('my-app')
        .describe('Name for the app in RuntimeScope (e.g., "echo-frontend", "dashboard")'),
      framework: z
        .enum(['html', 'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt', 'flask', 'django', 'rails', 'php', 'wordpress', 'other'])
        .optional()
        .default('html')
        .describe('The framework/tech stack of the project. Use "html" for any plain HTML or server-rendered pages.'),
    },
    async ({ app_name, framework }) => {
      const scriptTagSnippet = `<!-- RuntimeScope — paste before </body> -->
<script src="http://localhost:${HTTP_PORT}/runtimescope.js"></script>
<script>
  RuntimeScope.init({
    appName: '${app_name}',
    endpoint: 'ws://localhost:${COLLECTOR_PORT}',
  });
</script>`;

      const npmSnippet = `// Install: npm install @runtimescope/sdk
import { RuntimeScope } from '@runtimescope/sdk';

RuntimeScope.init({
  appName: '${app_name}',
  endpoint: 'ws://localhost:${COLLECTOR_PORT}',
});`;

      // Determine which snippet to use
      const usesNpm = ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt'].includes(framework);
      const primarySnippet = usesNpm ? npmSnippet : scriptTagSnippet;

      // Framework-specific placement hints
      const placementHints: Record<string, string> = {
        html: 'Paste the <script> tags before </body> in your HTML file(s).',
        react: 'Add the import to your entry file (src/index.tsx or src/main.tsx), before ReactDOM.render/createRoot.',
        vue: 'Add the import to your entry file (src/main.ts), before createApp().',
        angular: 'Add the import to your main.ts, before bootstrapApplication().',
        svelte: 'Add the import to your entry file (src/main.ts), before new App().',
        nextjs: 'Add the import to your app/layout.tsx or pages/_app.tsx. For App Router, use a client component wrapper.',
        nuxt: 'Create a plugin file (plugins/runtimescope.client.ts) with the init call.',
        flask: 'Add the <script> tags to your base template (templates/base.html) before </body>.',
        django: 'Add the <script> tags to your base template (templates/base.html) before </body>.',
        rails: 'Add the <script> tags to your application layout (app/views/layouts/application.html.erb) before </body>.',
        php: 'Add the <script> tags to your layout/footer file before </body>.',
        wordpress: 'Add the <script> tags to your theme\'s footer.php before </body>, or use a custom HTML plugin.',
        other: 'Add the <script> tags to your HTML template before </body>. Works in any HTML page.',
      };

      const response = {
        summary: `SDK snippet for ${framework} project "${app_name}". ${usesNpm ? 'Uses npm import.' : 'Uses <script> tag — no build system required.'}`,
        data: {
          snippet: primarySnippet,
          placement: placementHints[framework] || placementHints.other,
          alternativeSnippet: usesNpm ? scriptTagSnippet : npmSnippet,
          alternativeNote: usesNpm
            ? 'If you prefer, you can also use a <script> tag instead of npm:'
            : 'If the project uses npm/Node.js, you can also install via:',
          requirements: [
            'RuntimeScope MCP server must be running (it starts automatically with Claude Code)',
            `SDK bundle served at http://localhost:${HTTP_PORT}/runtimescope.js`,
            `WebSocket collector at ws://localhost:${COLLECTOR_PORT}`,
          ],
          whatItCaptures: [
            'Network requests (fetch/XHR) with timing and headers',
            'Console logs, warnings, and errors with stack traces',
            'React/Vue/Svelte component renders (if applicable)',
            'State store changes (Redux, Zustand, Pinia)',
            'Web Vitals (LCP, FCP, CLS, TTFB, INP)',
            'Unhandled errors and promise rejections',
          ],
        },
        issues: [],
        metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  // ---------- scan_website ----------
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
