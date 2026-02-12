import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import type { RenderComponentProfile } from '@runtimescope/collector';

export function registerRenderTools(server: McpServer, store: EventStore): void {
  server.tool(
    'get_render_profile',
    'Get React component render profiles showing render counts, velocity, average duration, and render causes. Flags suspicious components that are re-rendering excessively. Requires captureRenders: true in the SDK config and React dev mode for accurate timing data.',
    {
      component_name: z
        .string()
        .optional()
        .describe('Filter by component name (substring match)'),
      since_seconds: z
        .number()
        .optional()
        .describe('Only return events from the last N seconds'),
    },
    async ({ component_name, since_seconds }) => {
      const events = store.getRenderEvents({
        componentName: component_name,
        sinceSeconds: since_seconds,
      });

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;
      const issues: string[] = [];

      // Merge profiles across snapshots
      const merged = new Map<string, RenderComponentProfile>();
      const allSuspicious = new Set<string>();

      for (const event of events) {
        for (const profile of event.profiles) {
          const existing = merged.get(profile.componentName);
          if (existing) {
            existing.renderCount += profile.renderCount;
            existing.totalDuration += profile.totalDuration;
            existing.avgDuration =
              existing.renderCount > 0
                ? existing.totalDuration / existing.renderCount
                : 0;
            existing.renderVelocity = Math.max(existing.renderVelocity, profile.renderVelocity);
            existing.lastRenderPhase = profile.lastRenderPhase;
            existing.lastRenderCause = profile.lastRenderCause;
            if (profile.suspicious) existing.suspicious = true;
          } else {
            merged.set(profile.componentName, { ...profile });
          }

          if (profile.suspicious) {
            allSuspicious.add(profile.componentName);
          }
        }
      }

      if (allSuspicious.size > 0) {
        issues.push(`${allSuspicious.size} suspicious component(s): ${Array.from(allSuspicious).join(', ')}`);
      }

      // Sort by render count descending
      const profiles = Array.from(merged.values()).sort(
        (a, b) => b.renderCount - a.renderCount
      );

      const totalRenders = profiles.reduce((s, p) => s + p.renderCount, 0);

      const response = {
        summary: `${profiles.length} component(s) tracked, ${totalRenders} total renders${since_seconds ? ` in the last ${since_seconds}s` : ''}. ${allSuspicious.size} suspicious.`,
        data: profiles.map((p) => ({
          componentName: p.componentName,
          renderCount: p.renderCount,
          totalDuration: `${p.totalDuration.toFixed(1)}ms`,
          avgDuration: `${p.avgDuration.toFixed(1)}ms`,
          renderVelocity: `${p.renderVelocity.toFixed(1)}/sec`,
          lastRenderPhase: p.lastRenderPhase,
          lastRenderCause: p.lastRenderCause,
          suspicious: p.suspicious,
        })),
        issues,
        metadata: {
          timeRange: {
            from: events.length > 0 ? events[0].timestamp : 0,
            to: events.length > 0 ? events[events.length - 1].timestamp : 0,
          },
          eventCount: events.length,
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
