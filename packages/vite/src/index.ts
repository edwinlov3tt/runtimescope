/**
 * @runtimescope/vite — Vite plugin.
 *
 * Auto-injects the RuntimeScope SDK into your app without touching source
 * files. On `vite dev`, also checks whether the collector is running and
 * prints a clear, Claude-Code-friendly warning if it's not (with the exact
 * command to fix it).
 *
 * @example
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import { runtimescope } from '@runtimescope/vite';
 *
 * export default defineConfig({
 *   plugins: [runtimescope()],
 * });
 */

import { spawn } from 'node:child_process';

// Minimal Vite plugin types — we don't import `vite` to keep this a zero-dep
// plugin module (Vite is a peer dep).
interface VitePlugin {
  name: string;
  apply?: 'build' | 'serve';
  enforce?: 'pre' | 'post';
  config?: (config: unknown, env: { mode: string; command: string }) => unknown;
  configureServer?: (server: unknown) => void | Promise<void>;
  transformIndexHtml?:
    | ((html: string) => string | { html: string; tags?: unknown[] })
    | {
        order?: 'pre' | 'post';
        handler: (html: string) => string | { html: string; tags?: unknown[] };
      };
}

export interface RuntimeScopePluginOptions {
  /**
   * Explicit DSN. Overrides the env-var lookup.
   * If omitted, the plugin reads `dsnEnvVar` from `process.env`.
   */
  dsn?: string;
  /**
   * Name of the env var to read the DSN from.
   * @default 'VITE_RUNTIMESCOPE_DSN'
   */
  dsnEnvVar?: string;
  /**
   * Skip injection in production builds. Useful if you only want RuntimeScope
   * active during `vite dev`.
   * @default false (injects in both)
   */
  devOnly?: boolean;
  /**
   * Extra SDK config passed to `RuntimeScope.init()`. See `RuntimeScopeConfig`
   * in `@runtimescope/sdk` for the full list.
   */
  sdkConfig?: Record<string, unknown>;
  /**
   * When `true`, the plugin attempts to start the collector in the background
   * if it isn't already running. Uses `npx runtimescope start` under the hood.
   * @default false — warns only, never spawns without explicit consent.
   */
  autostart?: boolean;
  /**
   * Port for the HTTP health check. Defaults to 6768, matching the collector's
   * default. Set this if you run the collector on a non-standard port.
   * @default 6768
   */
  httpPort?: number;
}

/** Console colours — fall back to no-colour for dumb terminals / CI. */
const isTTY = typeof process !== 'undefined' && !!process.stdout?.isTTY;
const DIM = isTTY ? '\x1b[2m' : '';
const YELLOW = isTTY ? '\x1b[33m' : '';
const CYAN = isTTY ? '\x1b[36m' : '';
const GREEN = isTTY ? '\x1b[32m' : '';
const RESET = isTTY ? '\x1b[0m' : '';

async function isCollectorReachable(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function printCollectorWarning(hasDsn: boolean, autostart: boolean): void {
  const lines = [
    '',
    `${YELLOW}⚠ RuntimeScope collector is not running.${RESET}`,
    ``,
  ];
  if (hasDsn) {
    lines.push(
      `  The SDK will not capture anything until the collector is started.`,
      `  Start it in a separate terminal:`,
      ``,
      `    ${CYAN}npx runtimescope start${RESET}`,
      ``,
      `  ${DIM}Or let Claude Code do it: "start the runtimescope collector"${RESET}`,
    );
  } else {
    lines.push(
      `  No DSN configured — the RuntimeScope plugin is idle.`,
      `  Set ${CYAN}VITE_RUNTIMESCOPE_DSN${RESET} in .env.local to enable.`,
    );
  }
  lines.push(``);
  // eslint-disable-next-line no-console
  console.warn(lines.join('\n'));
  if (autostart) {
    // eslint-disable-next-line no-console
    console.warn(`${DIM}  (autostart enabled — attempting to spawn collector…)${RESET}`);
  }
}

function spawnCollectorDetached(): boolean {
  try {
    const child = spawn('npx', ['runtimescope', 'start'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function runtimescope(options: RuntimeScopePluginOptions = {}): VitePlugin {
  const envVar = options.dsnEnvVar ?? 'VITE_RUNTIMESCOPE_DSN';
  const httpPort = options.httpPort ?? 6768;
  let resolvedDsn: string | undefined;
  let activeMode = 'development';

  return {
    name: 'runtimescope',
    enforce: 'pre',

    config(_userConfig, { mode }) {
      activeMode = mode;
      resolvedDsn = options.dsn ?? process.env[envVar];
      return undefined;
    },

    async configureServer(_server: unknown) {
      // Runs only on `vite dev`. We check the collector health and warn
      // (or try to spawn) so Claude sees a clear message at boot time.
      const reachable = await isCollectorReachable(httpPort);
      if (reachable) {
        // eslint-disable-next-line no-console
        console.log(`${GREEN}✓${RESET} RuntimeScope collector reachable on :${httpPort}`);
        return;
      }

      printCollectorWarning(!!resolvedDsn, !!options.autostart);

      if (options.autostart) {
        const spawned = spawnCollectorDetached();
        if (spawned) {
          // Poll for up to 10s — more reliable than a fixed sleep because
          // `npx` cold-start varies from ~0.5s to ~5s depending on cache state.
          let nowUp = false;
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 300));
            nowUp = await isCollectorReachable(httpPort);
            if (nowUp) break;
          }
          if (nowUp) {
            // eslint-disable-next-line no-console
            console.log(`${GREEN}✓${RESET} RuntimeScope collector started automatically`);
          } else {
            // eslint-disable-next-line no-console
            console.warn(`${YELLOW}⚠${RESET} Spawned collector didn't come up within 10s — check \`runtimescope service logs\``);
          }
        }
      }
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html: string) {
        if (options.devOnly && activeMode === 'production') return html;
        if (!resolvedDsn) return html;
        // Skip if the user already injected RuntimeScope themselves —
        // avoids double-init and the reconnect churn that causes.
        if (/RuntimeScope\.init\s*\(/i.test(html)) return html;

        const extraConfig = options.sdkConfig
          ? Object.entries(options.sdkConfig)
              .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
              .join(', ')
          : '';
        const configFields = [
          `dsn: ${JSON.stringify(resolvedDsn)}`,
          ...(extraConfig ? [extraConfig] : []),
        ].join(', ');

        // In `vite dev`, bare-specifier imports resolve via the module graph.
        // In `vite build`, emitted HTML is static — a bare specifier will 404
        // in the browser. Load the IIFE bundle from the collector instead; it
        // exposes `RuntimeScope` globally and works identically in both modes.
        const httpPort = options.httpPort ?? 6768;
        const snippet =
          activeMode === 'development'
            ? `<script type="module">
import { RuntimeScope } from '@runtimescope/sdk';
RuntimeScope.init({ ${configFields} });
</script>`
            : `<script src="http://127.0.0.1:${httpPort}/runtimescope.js"></script>
<script>
if (typeof RuntimeScope !== 'undefined') { RuntimeScope.init({ ${configFields} }); }
</script>`;

        return html.replace('</head>', `${snippet}\n</head>`);
      },
    },
  };
}

export default runtimescope;
