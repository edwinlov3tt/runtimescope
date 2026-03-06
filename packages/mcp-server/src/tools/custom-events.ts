import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore } from '@runtimescope/collector';
import type {
  CustomEvent,
  NetworkEvent,
  ConsoleEvent,
  DatabaseEvent,
  StateEvent,
} from '@runtimescope/collector';

export function registerCustomEventTools(server: McpServer, store: EventStore): void {
  // ----------------------------------------------------------------
  // get_custom_events — query tracked custom events
  // ----------------------------------------------------------------
  server.tool(
    'get_custom_events',
    'Get custom business/product events tracked via RuntimeScope.track(). Shows event catalog (all unique event names with counts) and recent occurrences. Use this to see what events are being tracked and their frequency.',
    {
      name: z.string().optional().describe('Filter by event name (exact match)'),
      since_seconds: z.number().optional().describe('Only events from the last N seconds (default: 300)'),
      session_id: z.string().optional().describe('Filter by session ID'),
    },
    async ({ name, since_seconds, session_id }) => {
      const sinceSeconds = since_seconds ?? 300;

      const events = store.getCustomEvents({
        name,
        sinceSeconds,
        sessionId: session_id,
      });

      // Build event catalog (unique event names with counts)
      const catalog: Record<string, { count: number; lastSeen: number; sampleProperties: Record<string, unknown> | undefined }> = {};
      for (const e of events) {
        if (!catalog[e.name]) {
          catalog[e.name] = { count: 0, lastSeen: 0, sampleProperties: undefined };
        }
        catalog[e.name].count++;
        if (e.timestamp > catalog[e.name].lastSeen) {
          catalog[e.name].lastSeen = e.timestamp;
          catalog[e.name].sampleProperties = e.properties;
        }
      }

      const catalogList = Object.entries(catalog)
        .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
        .map(([eventName, info]) => ({
          name: eventName,
          count: info.count,
          lastSeen: new Date(info.lastSeen).toISOString(),
          sampleProperties: info.sampleProperties,
        }));

      const sessions = store.getSessionInfo();
      const sessionId = session_id ?? sessions[0]?.sessionId ?? null;

      const response = {
        summary: `${events.length} custom event(s) across ${catalogList.length} unique event name(s) in the last ${sinceSeconds}s.${name ? ` Filtered by: "${name}".` : ''}`,
        data: {
          catalog: catalogList,
          recentEvents: events.slice(0, 100).map((e) => ({
            name: e.name,
            timestamp: new Date(e.timestamp).toISOString(),
            properties: e.properties,
            sessionId: e.sessionId,
          })),
        },
        issues: [],
        metadata: {
          timeRange: {
            from: events.length > 0 ? events[events.length - 1].timestamp : 0,
            to: events.length > 0 ? events[0].timestamp : 0,
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

  // ----------------------------------------------------------------
  // get_event_flow — funnel analysis with correlated telemetry
  // ----------------------------------------------------------------
  server.tool(
    'get_event_flow',
    'Analyze a user flow as a funnel. Given an ordered list of custom event names (steps), shows how many sessions completed each step, where drop-offs happen, and what errors/failures occurred between steps. Each step includes correlated telemetry (network errors, console errors, failed DB queries) that happened between the previous step and this one — this is the key to finding WHY a step failed.',
    {
      steps: z.array(z.string()).min(2).describe('Ordered list of custom event names representing the flow (e.g. ["create_profile", "generate_campaign", "export_ad"])'),
      since_seconds: z.number().optional().describe('Only analyze events from the last N seconds (default: 3600)'),
      session_id: z.string().optional().describe('Analyze a specific session (default: all sessions)'),
    },
    async ({ steps, since_seconds, session_id }) => {
      const sinceSeconds = since_seconds ?? 3600;

      // Get all custom events in the window
      const allCustom = store.getCustomEvents({ sinceSeconds, sessionId: session_id });

      // Group custom events by session
      const bySession = new Map<string, CustomEvent[]>();
      for (const e of allCustom) {
        if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
        bySession.get(e.sessionId)!.push(e);
      }

      // Sort each session's events chronologically
      for (const events of bySession.values()) {
        events.sort((a, b) => a.timestamp - b.timestamp);
      }

      // Get all telemetry for correlation
      const networkErrors = store.getNetworkRequests({ sinceSeconds, sessionId: session_id })
        .filter((e) => e.status >= 400 || e.errorPhase);
      const consoleErrors = store.getConsoleMessages({ sinceSeconds, sessionId: session_id })
        .filter((e) => e.level === 'error');
      const dbErrors = store.getDatabaseEvents({ sinceSeconds, sessionId: session_id })
        .filter((e) => !!e.error);

      // Analyze the funnel
      interface StepResult {
        step: string;
        sessionsReached: number;
        sessionsCompleted: number;
        avgTimeFromPrevMs: number | null;
        correlatedErrors: {
          networkErrors: { url: string; status: number; method: string; timestamp: string }[];
          consoleErrors: { message: string; timestamp: string }[];
          dbErrors: { query: string; error: string; timestamp: string }[];
        };
      }

      const stepResults: StepResult[] = steps.map(() => ({
        step: '',
        sessionsReached: 0,
        sessionsCompleted: 0,
        avgTimeFromPrevMs: null,
        correlatedErrors: { networkErrors: [], consoleErrors: [], dbErrors: [] },
      }));

      const totalSessions = bySession.size;
      const completedFlows: { sessionId: string; totalDurationMs: number }[] = [];

      for (const [sessionId, sessionEvents] of bySession) {
        let prevStepTime: number | null = null;
        let completedAll = true;

        for (let i = 0; i < steps.length; i++) {
          const stepName = steps[i];
          stepResults[i].step = stepName;

          // Find the first occurrence of this step event AFTER the previous step
          const occurrence = sessionEvents.find((e) =>
            e.name === stepName && (prevStepTime === null || e.timestamp >= prevStepTime)
          );

          if (!occurrence) {
            completedAll = false;
            // Collect errors between prev step and end of session for this gap
            if (prevStepTime !== null) {
              const gapEnd = sessionEvents[sessionEvents.length - 1]?.timestamp ?? Date.now();
              collectCorrelatedErrors(stepResults[i], sessionId, prevStepTime, gapEnd, networkErrors, consoleErrors, dbErrors);
            }
            break;
          }

          stepResults[i].sessionsReached++;

          if (prevStepTime !== null) {
            const delta = occurrence.timestamp - prevStepTime;
            if (stepResults[i].avgTimeFromPrevMs === null) {
              stepResults[i].avgTimeFromPrevMs = delta;
            } else {
              // Running average
              stepResults[i].avgTimeFromPrevMs =
                (stepResults[i].avgTimeFromPrevMs! * (stepResults[i].sessionsReached - 1) + delta) /
                stepResults[i].sessionsReached;
            }

            // Collect errors between previous step and this step
            collectCorrelatedErrors(stepResults[i], sessionId, prevStepTime, occurrence.timestamp, networkErrors, consoleErrors, dbErrors);
          } else {
            stepResults[i].sessionsReached++;
          }

          stepResults[i].sessionsCompleted++;
          prevStepTime = occurrence.timestamp;
        }

        if (completedAll && prevStepTime !== null) {
          const firstStep = sessionEvents.find((e) => e.name === steps[0]);
          if (firstStep) {
            completedFlows.push({ sessionId, totalDurationMs: prevStepTime - firstStep.timestamp });
          }
        }
      }

      // Fix double-counting on first step
      for (let i = 0; i < stepResults.length; i++) {
        stepResults[i].step = steps[i];
      }

      // Deduplicate correlated errors (limit to 5 per category per step)
      for (const step of stepResults) {
        step.correlatedErrors.networkErrors = dedup(step.correlatedErrors.networkErrors, 5);
        step.correlatedErrors.consoleErrors = dedup(step.correlatedErrors.consoleErrors, 5);
        step.correlatedErrors.dbErrors = dedup(step.correlatedErrors.dbErrors, 5);
      }

      // Build funnel summary
      const funnelSteps = stepResults.map((s, i) => ({
        step: s.step,
        reached: s.sessionsCompleted,
        conversionRate: i === 0
          ? (totalSessions > 0 ? `${((s.sessionsCompleted / totalSessions) * 100).toFixed(1)}%` : '0%')
          : (stepResults[i - 1].sessionsCompleted > 0
            ? `${((s.sessionsCompleted / stepResults[i - 1].sessionsCompleted) * 100).toFixed(1)}%`
            : '0%'),
        avgTimeFromPrev: s.avgTimeFromPrevMs !== null ? `${Math.round(s.avgTimeFromPrevMs)}ms` : null,
        errorsBetweenSteps: {
          network: s.correlatedErrors.networkErrors.length,
          console: s.correlatedErrors.consoleErrors.length,
          database: s.correlatedErrors.dbErrors.length,
        },
        correlatedErrors: s.correlatedErrors,
      }));

      const avgCompletionTime = completedFlows.length > 0
        ? Math.round(completedFlows.reduce((sum, f) => sum + f.totalDurationMs, 0) / completedFlows.length)
        : null;

      const issues: string[] = [];
      for (let i = 1; i < funnelSteps.length; i++) {
        const prev = funnelSteps[i - 1].reached;
        const curr = funnelSteps[i].reached;
        if (prev > 0 && curr / prev < 0.5) {
          issues.push(`Major drop-off at "${steps[i]}": only ${((curr / prev) * 100).toFixed(0)}% conversion from "${steps[i - 1]}"`);
        }
        const totalErrors = funnelSteps[i].errorsBetweenSteps.network +
          funnelSteps[i].errorsBetweenSteps.console +
          funnelSteps[i].errorsBetweenSteps.database;
        if (totalErrors > 0) {
          issues.push(`${totalErrors} error(s) detected between "${steps[i - 1]}" and "${steps[i]}"`);
        }
      }

      const response = {
        summary: `Flow analysis: ${steps.length} steps, ${totalSessions} session(s), ${completedFlows.length} completed the full flow.${avgCompletionTime ? ` Avg completion: ${avgCompletionTime}ms.` : ''}`,
        data: {
          totalSessions,
          completedFlows: completedFlows.length,
          avgCompletionTimeMs: avgCompletionTime,
          funnel: funnelSteps,
        },
        issues,
        metadata: {
          timeRange: {
            from: allCustom.length > 0 ? allCustom[allCustom.length - 1].timestamp : 0,
            to: allCustom.length > 0 ? allCustom[0].timestamp : 0,
          },
          eventCount: allCustom.length,
          sessionId: session_id ?? null,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function collectCorrelatedErrors(
  result: { correlatedErrors: { networkErrors: any[]; consoleErrors: any[]; dbErrors: any[] } },
  sessionId: string,
  fromTs: number,
  toTs: number,
  networkErrors: NetworkEvent[],
  consoleErrors: ConsoleEvent[],
  dbErrors: DatabaseEvent[],
): void {
  for (const e of networkErrors) {
    if (e.sessionId === sessionId && e.timestamp >= fromTs && e.timestamp <= toTs) {
      result.correlatedErrors.networkErrors.push({
        url: e.url,
        status: e.status,
        method: e.method,
        timestamp: new Date(e.timestamp).toISOString(),
      });
    }
  }
  for (const e of consoleErrors) {
    if (e.sessionId === sessionId && e.timestamp >= fromTs && e.timestamp <= toTs) {
      result.correlatedErrors.consoleErrors.push({
        message: e.message.length > 200 ? e.message.slice(0, 200) + '...' : e.message,
        timestamp: new Date(e.timestamp).toISOString(),
      });
    }
  }
  for (const e of dbErrors) {
    if (e.sessionId === sessionId && e.timestamp >= fromTs && e.timestamp <= toTs) {
      result.correlatedErrors.dbErrors.push({
        query: e.query.length > 150 ? e.query.slice(0, 150) + '...' : e.query,
        error: e.error!,
        timestamp: new Date(e.timestamp).toISOString(),
      });
    }
  }
}

function dedup<T>(arr: T[], limit: number): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of arr) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
      if (result.length >= limit) break;
    }
  }
  return result;
}
