/**
 * @runtimescope/vite — Vite plugin.
 *
 * Auto-injects the RuntimeScope SDK into your app without touching source
 * files. Reads the DSN from an env var and decides based on the build mode
 * whether to emit the init call or skip it entirely (production builds
 * without a DSN get zero overhead).
 *
 * @example
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import { runtimescope } from '@runtimescope/vite';
 *
 * export default defineConfig({
 *   plugins: [runtimescope({ dsnEnvVar: 'VITE_RUNTIMESCOPE_DSN' })],
 * });
 */

// Minimal Vite plugin types — we don't import `vite` to keep this a zero-dep
// plugin module (Vite is a peer dep).
interface VitePlugin {
  name: string;
  apply?: 'build' | 'serve';
  enforce?: 'pre' | 'post';
  config?: (config: unknown, env: { mode: string; command: string }) => unknown;
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
}

export function runtimescope(options: RuntimeScopePluginOptions = {}): VitePlugin {
  const envVar = options.dsnEnvVar ?? 'VITE_RUNTIMESCOPE_DSN';
  let resolvedDsn: string | undefined;
  let activeMode = 'development';

  return {
    name: 'runtimescope',
    enforce: 'pre',

    config(_userConfig, { mode }) {
      activeMode = mode;
      resolvedDsn = options.dsn ?? process.env[envVar];
      // Return undefined so Vite keeps the existing config unchanged.
      return undefined;
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html: string) {
        // Skip in production builds when devOnly is true
        if (options.devOnly && activeMode === 'production') return html;
        // Skip if no DSN — SDK would no-op anyway, but we save the bytes
        if (!resolvedDsn) return html;

        const extraConfig = options.sdkConfig
          ? Object.entries(options.sdkConfig)
              .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
              .join(', ')
          : '';
        const configFields = [
          `dsn: ${JSON.stringify(resolvedDsn)}`,
          ...(extraConfig ? [extraConfig] : []),
        ].join(', ');

        const snippet = `<script type="module">
import { RuntimeScope } from '@runtimescope/sdk';
RuntimeScope.init({ ${configFields} });
</script>`;

        // Inject as early as possible so network requests are captured from
        // the first tick
        return html.replace('</head>', `${snippet}\n</head>`);
      },
    },
  };
}

export default runtimescope;
