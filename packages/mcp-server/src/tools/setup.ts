import { z } from 'zod';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore, ProjectManager, CollectorServer } from '@runtimescope/collector';
import {
  scaffoldProjectConfig,
  readProjectConfig,
} from '@runtimescope/collector';

// ============================================================
// setup_project — deterministic, single-call project setup
// Replaces the markdown-based /setup command with a tool that
// does framework detection, config scaffolding, snippet generation,
// and hook registration in one call.
// ============================================================

const COLLECTOR_PORT = process.env.RUNTIMESCOPE_PORT ?? '9090';
const HTTP_PORT = process.env.RUNTIMESCOPE_HTTP_PORT ?? '9091';

// --- Framework detection ---

type FrameworkId = 'nextjs' | 'react' | 'vue' | 'angular' | 'svelte' | 'nuxt' | 'workers' | 'flask' | 'django' | 'rails' | 'php' | 'wordpress' | 'html' | 'other';
type SdkType = 'browser' | 'server' | 'workers';

interface DetectedFramework {
  framework: FrameworkId;
  sdkType: SdkType;
  entryFile?: string;
  installCmd?: string;
}

function detectFrameworks(projectDir: string): DetectedFramework[] {
  const detected: DetectedFramework[] = [];

  // Read package.json
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
  } catch { /* no package.json */ }

  const allDeps = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  };

  // Check for Cloudflare Workers
  if (existsSync(join(projectDir, 'wrangler.toml')) || existsSync(join(projectDir, 'wrangler.jsonc')) || allDeps['@cloudflare/workers-types'] || allDeps['wrangler']) {
    const entryFile = existsSync(join(projectDir, 'src/index.ts')) ? 'src/index.ts' : existsSync(join(projectDir, 'src/index.js')) ? 'src/index.js' : undefined;
    detected.push({ framework: 'workers', sdkType: 'workers', entryFile, installCmd: 'npm install @runtimescope/workers-sdk' });
  }

  // Check for Node.js server frameworks (these get server SDK)
  if (allDeps['express'] || allDeps['fastify'] || allDeps['hono'] || allDeps['koa']) {
    detected.push({ framework: 'other', sdkType: 'server', installCmd: 'npm install @runtimescope/server-sdk' });
  }

  // Check for frontend frameworks (these get browser SDK)
  if (allDeps['next']) {
    const entryFile = existsSync(join(projectDir, 'app/providers.tsx')) ? 'app/providers.tsx'
      : existsSync(join(projectDir, 'src/app/providers.tsx')) ? 'src/app/providers.tsx'
      : existsSync(join(projectDir, 'app/layout.tsx')) ? 'app/layout.tsx'
      : existsSync(join(projectDir, 'pages/_app.tsx')) ? 'pages/_app.tsx'
      : undefined;
    detected.push({ framework: 'nextjs', sdkType: 'browser', entryFile, installCmd: 'npm install @runtimescope/sdk' });
    // Next.js also gets server SDK for API routes
    detected.push({ framework: 'nextjs', sdkType: 'server', installCmd: 'npm install @runtimescope/server-sdk' });
  } else if (allDeps['react'] || allDeps['react-dom']) {
    const entryFile = existsSync(join(projectDir, 'src/main.tsx')) ? 'src/main.tsx'
      : existsSync(join(projectDir, 'src/index.tsx')) ? 'src/index.tsx'
      : existsSync(join(projectDir, 'src/main.jsx')) ? 'src/main.jsx'
      : undefined;
    detected.push({ framework: 'react', sdkType: 'browser', entryFile, installCmd: 'npm install @runtimescope/sdk' });
  } else if (allDeps['vue']) {
    const entryFile = existsSync(join(projectDir, 'src/main.ts')) ? 'src/main.ts' : undefined;
    detected.push({ framework: 'vue', sdkType: 'browser', entryFile, installCmd: 'npm install @runtimescope/sdk' });
  } else if (allDeps['nuxt']) {
    detected.push({ framework: 'nuxt', sdkType: 'browser', installCmd: 'npm install @runtimescope/sdk' });
  } else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) {
    detected.push({ framework: 'svelte', sdkType: 'browser', installCmd: 'npm install @runtimescope/sdk' });
  } else if (allDeps['@angular/core']) {
    detected.push({ framework: 'angular', sdkType: 'browser', installCmd: 'npm install @runtimescope/sdk' });
  }

  // Check for non-JS frameworks
  if (existsSync(join(projectDir, 'requirements.txt')) || existsSync(join(projectDir, 'pyproject.toml'))) {
    if (existsSync(join(projectDir, 'manage.py'))) {
      detected.push({ framework: 'django', sdkType: 'browser' });
    } else {
      detected.push({ framework: 'flask', sdkType: 'browser' });
    }
  }
  if (existsSync(join(projectDir, 'Gemfile'))) {
    detected.push({ framework: 'rails', sdkType: 'browser' });
  }
  if (existsSync(join(projectDir, 'composer.json'))) {
    detected.push({ framework: 'php', sdkType: 'browser' });
  }
  if (existsSync(join(projectDir, 'wp-config.php'))) {
    detected.push({ framework: 'wordpress', sdkType: 'browser' });
  }

  // Fallback: if we found a package.json but no framework
  if (detected.length === 0 && Object.keys(pkg).length > 0) {
    detected.push({ framework: 'html', sdkType: 'browser', installCmd: 'npm install @runtimescope/sdk' });
  }

  // Fallback: no package.json at all → script tag
  if (detected.length === 0) {
    detected.push({ framework: 'html', sdkType: 'browser' });
  }

  return detected;
}

// --- Snippet generation (inline, no dependency on get_sdk_snippet tool) ---

function generateSnippet(
  framework: FrameworkId,
  sdkType: SdkType,
  appName: string,
  projectId: string,
): { snippet: string; placement: string; installCmd?: string } {
  const projectIdLine = `\n    projectId: '${projectId}',`;

  if (sdkType === 'workers') {
    return {
      snippet: `import { withRuntimeScope, scopeD1, scopeKV, scopeR2 } from '@runtimescope/workers-sdk';

export default withRuntimeScope({
  async fetch(request, env, ctx) {
    // const db = scopeD1(env.DB);
    // const kv = scopeKV(env.KV);
    return yourApp.fetch(request, env, ctx);
  },
}, {
  appName: '${appName}',${projectIdLine}
  httpEndpoint: 'http://localhost:${HTTP_PORT}/api/events',
});`,
      placement: 'Wrap your default export in the Worker entry file (src/index.ts).',
      installCmd: 'npm install @runtimescope/workers-sdk',
    };
  }

  if (sdkType === 'server') {
    return {
      snippet: `import { RuntimeScope } from '@runtimescope/server-sdk';

RuntimeScope.connect({
  appName: '${appName}',${projectIdLine}
  captureConsole: true,
  captureHttp: true,
  capturePerformance: true,
});

// Instrument your ORM:
// RuntimeScope.instrumentPrisma(prisma);
// RuntimeScope.instrumentDrizzle(db);`,
      placement: framework === 'nextjs'
        ? 'Add to instrumentation.ts (Next.js instrumentation hook).'
        : 'Add to your server entry file before starting the server.',
      installCmd: 'npm install @runtimescope/server-sdk',
    };
  }

  // Browser SDK
  const usesNpm = ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt'].includes(framework);

  if (usesNpm) {
    return {
      snippet: `import { RuntimeScope } from '@runtimescope/sdk';

RuntimeScope.init({
  appName: '${appName}',${projectIdLine}
  endpoint: 'ws://localhost:${COLLECTOR_PORT}',
  capturePerformance: true,
  captureRenders: true,
});`,
      placement: framework === 'nextjs'
        ? 'Add to app/providers.tsx (client component) or pages/_app.tsx.'
        : framework === 'react' ? 'Add to src/main.tsx before createRoot().'
        : framework === 'vue' ? 'Add to src/main.ts before createApp().'
        : 'Add to your entry file before the app initializes.',
      installCmd: 'npm install @runtimescope/sdk',
    };
  }

  // Script tag (Flask, Django, Rails, PHP, WordPress, plain HTML)
  const placements: Record<string, string> = {
    flask: 'Add to templates/base.html before </body>.',
    django: 'Add to templates/base.html before </body>.',
    rails: 'Add to app/views/layouts/application.html.erb before </body>.',
    php: 'Add to your layout/footer file before </body>.',
    wordpress: "Add to your theme's footer.php before </body>.",
    html: 'Add before </body> in your HTML files.',
  };

  return {
    snippet: `<script src="http://localhost:${HTTP_PORT}/runtimescope.js"></script>
<script>
  RuntimeScope.init({
    appName: '${appName}',${projectIdLine}
    endpoint: 'ws://localhost:${COLLECTOR_PORT}',
  });
</script>`,
    placement: placements[framework] ?? placements.html,
  };
}

// --- Hook registration ---

function checkAndRegisterHooks(): { registered: boolean; alreadyExists: boolean; message: string } {
  const settingsPath = join(homedir(), '.claude', 'settings.json');

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    // No settings file — create one
  }

  // Check if hooks already exist
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (hooks?.PostToolUse) {
    const existing = JSON.stringify(hooks.PostToolUse);
    if (existing.includes('9091') || existing.includes('runtimescope')) {
      return { registered: true, alreadyExists: true, message: 'RuntimeScope hooks already registered.' };
    }
  }

  // Merge new hook
  if (!settings.hooks) settings.hooks = {};
  const h = settings.hooks as Record<string, unknown[]>;
  if (!h.PostToolUse) h.PostToolUse = [];

  h.PostToolUse.push({
    matcher: '.*',
    hooks: [{
      type: 'command',
      command: `mkdir -p ~/.runtimescope/hooks && _RS_DIR=$(basename "$PWD") && _RS_PID=$(cat "$PWD/.runtimescope/config.json" 2>/dev/null | grep -o '"projectId":"[^"]*"' | cut -d'"' -f4) && echo '{"ts":'$(date +%s)',"tool":"'"$CLAUDE_TOOL_NAME"'","exit":"'"$CLAUDE_TOOL_EXIT_CODE"'","dir":"'"$_RS_DIR"'","projectId":"'"$_RS_PID"'"}' >> ~/.runtimescope/hooks/tool-events.jsonl && curl -s -X POST http://localhost:${HTTP_PORT}/api/events -H 'Content-Type: application/json' -d '{"sessionId":"claude-hooks","appName":"'"$_RS_DIR"'","events":[{"eventId":"hook-'$(date +%s%N)'","sessionId":"claude-hooks","timestamp":'$(date +%s000)',"eventType":"custom","name":"tool_use","properties":{"tool":"'"$CLAUDE_TOOL_NAME"'","exitCode":"'"$CLAUDE_TOOL_EXIT_CODE"'","projectId":"'"$_RS_PID"'"}}]}' >/dev/null 2>&1 &`,
    }],
  });

  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    return { registered: true, alreadyExists: false, message: 'RuntimeScope hooks registered in ~/.claude/settings.json.' };
  } catch (err) {
    return { registered: false, alreadyExists: false, message: `Failed to register hooks: ${(err as Error).message}` };
  }
}

// --- Main tool ---

export function registerSetupTools(
  server: McpServer,
  store: EventStore,
  collector: CollectorServer,
  projectManager: ProjectManager,
): void {
  server.tool(
    'setup_project',
    'Set up RuntimeScope in a project — detects framework, creates .runtimescope/config.json, generates SDK snippets, and registers Claude hooks. Returns everything needed to install the SDK in one call. Use this instead of manual setup steps.',
    {
      project_dir: z
        .string()
        .describe('Absolute path to the project root directory'),
      app_name: z
        .string()
        .optional()
        .describe('App name for RuntimeScope (defaults to directory name or package.json name)'),
      register_hooks: z
        .boolean()
        .optional()
        .default(true)
        .describe('Register Claude Code hooks for tool timing (default: true)'),
    },
    async ({ project_dir, app_name, register_hooks }) => {
      const issues: string[] = [];

      // --- 1. Validate project directory ---
      if (!existsSync(project_dir)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              summary: `Directory not found: ${project_dir}`,
              data: null,
              issues: [`Project directory does not exist: ${project_dir}`],
              metadata: { timeRange: { from: 0, to: 0 }, eventCount: 0, sessionId: null },
            }, null, 2),
          }],
        };
      }

      // --- 2. Resolve app name ---
      let resolvedAppName = app_name;
      if (!resolvedAppName) {
        try {
          const pkg = JSON.parse(readFileSync(join(project_dir, 'package.json'), 'utf-8'));
          resolvedAppName = pkg.name;
        } catch { /* no package.json */ }
      }
      if (!resolvedAppName) {
        resolvedAppName = basename(project_dir);
      }

      // --- 3. Detect frameworks ---
      const frameworks = detectFrameworks(project_dir);
      const primaryFramework = frameworks[0];

      // --- 4. Scaffold .runtimescope/config.json ---
      const config = scaffoldProjectConfig(project_dir, {
        appName: resolvedAppName,
        framework: primaryFramework.framework,
        sdkType: primaryFramework.sdkType,
      });

      // Add additional SDK types if detected (e.g., Next.js has both browser + server)
      for (const fw of frameworks.slice(1)) {
        if (!config.sdks.some((s) => s.type === fw.sdkType)) {
          config.sdks.push({ type: fw.sdkType, framework: fw.framework, entryFile: fw.entryFile });
        }
      }

      // Persist projectId to global ProjectManager too
      projectManager.ensureProjectDir(resolvedAppName);
      projectManager.setProjectIdForApp(resolvedAppName, config.projectId);

      // --- 5. Generate snippets for each SDK type ---
      const snippets = frameworks.map((fw) => ({
        sdkType: fw.sdkType,
        framework: fw.framework,
        entryFile: fw.entryFile,
        ...generateSnippet(fw.framework, fw.sdkType, resolvedAppName!, config.projectId),
      }));

      // Deduplicate by sdkType
      const uniqueSnippets = snippets.filter((s, i, arr) => arr.findIndex((x) => x.sdkType === s.sdkType) === i);

      // --- 6. Check existing connection ---
      const sessions = store.getSessionInfo();
      const projectSessions = sessions.filter((s) => s.projectId === config.projectId || s.appName === resolvedAppName);
      const isConnected = projectSessions.some((s) => s.isConnected);

      // --- 7. Register hooks ---
      let hookResult = { registered: false, alreadyExists: false, message: 'Hooks not requested.' };
      if (register_hooks) {
        hookResult = checkAndRegisterHooks();
      }

      // --- 8. Check if SDK is already installed ---
      const sdkInstalled = existsSync(join(project_dir, 'node_modules', '@runtimescope'));

      // --- 9. Build response ---
      const phase = isConnected ? 'connected'
        : sdkInstalled ? 'installed_not_connected'
        : 'awaiting_installation';

      const nextSteps: string[] = [];
      if (phase === 'awaiting_installation') {
        for (const s of uniqueSnippets) {
          if (s.installCmd) nextSteps.push(`Run: ${s.installCmd}`);
          nextSteps.push(`Add SDK init to ${s.entryFile ?? 'your entry file'}: ${s.placement}`);
        }
        nextSteps.push('Start your app and verify with get_session_info');
      } else if (phase === 'installed_not_connected') {
        nextSteps.push('Start your app to establish the WebSocket connection');
        nextSteps.push('Verify with get_session_info');
      }

      if (!hookResult.alreadyExists && hookResult.registered) {
        nextSteps.push('Hooks registered — tool timing will be tracked automatically');
      }

      const response = {
        summary: phase === 'connected'
          ? `${resolvedAppName} is set up and connected (${config.projectId}). ${projectSessions.length} active session(s).`
          : `${resolvedAppName} set up (${config.projectId}). ${uniqueSnippets.length} SDK snippet(s) generated. ${phase === 'awaiting_installation' ? 'Install the SDK to connect.' : 'Start your app to connect.'}`,
        data: {
          phase,
          project: {
            projectId: config.projectId,
            appName: resolvedAppName,
            configPath: join(project_dir, '.runtimescope', 'config.json'),
            frameworks: frameworks.map((f) => ({ framework: f.framework, sdkType: f.sdkType, entryFile: f.entryFile })),
          },
          snippets: uniqueSnippets.map((s) => ({
            sdkType: s.sdkType,
            framework: s.framework,
            snippet: s.snippet,
            placement: s.placement,
            installCmd: s.installCmd,
            entryFile: s.entryFile,
          })),
          connection: {
            connected: isConnected,
            sessionCount: projectSessions.length,
            sessions: projectSessions.map((s) => ({
              sessionId: s.sessionId,
              appName: s.appName,
              sdkVersion: s.sdkVersion,
              eventCount: s.eventCount,
            })),
          },
          hooks: hookResult,
          sdkInstalled,
          nextSteps,
        },
        issues,
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: 0,
          sessionId: projectSessions[0]?.sessionId ?? null,
          projectId: config.projectId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
