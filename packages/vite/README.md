# @runtimescope/vite

Vite plugin that auto-injects the RuntimeScope SDK into your app. No source-code changes, reads the DSN from your `.env` file.

Works with any Vite project — React, Vue, Svelte, Solid, vanilla — and with any framework built on Vite (Remix v2, SvelteKit, Qwik, etc.) alongside their own framework integrations.

```bash
npm install @runtimescope/vite
```

## Setup

### 1. Add the plugin

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { runtimescope } from '@runtimescope/vite';

export default defineConfig({
  plugins: [
    runtimescope(),
  ],
});
```

### 2. Set the DSN

```bash
# .env.local
VITE_RUNTIMESCOPE_DSN=runtimescope://proj_xxx@localhost:9091/my-app
```

That's it. The plugin injects a `<script type="module">` that initializes the SDK on page load — before any other scripts run, so network/console events are captured from the first tick.

## Options

```typescript
runtimescope({
  // Custom env var name (default: VITE_RUNTIMESCOPE_DSN)
  dsnEnvVar: 'MY_CUSTOM_DSN',

  // Or pass an explicit DSN (overrides the env var lookup)
  dsn: 'runtimescope://proj_xxx@runtimescope.example.com',

  // Only inject during `vite dev`, skip in `vite build` (default: false)
  devOnly: true,

  // Pass additional SDK config
  sdkConfig: {
    captureRenders: true,
    capturePerformance: true,
    captureClicks: true,
  },
});
```

## Production Safety

If the DSN env var is unset at build time, no script is injected. Your production bundle is unchanged, zero overhead.

If you want the SDK to only run during local development, set `devOnly: true`.

## License

MIT
