import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore, ApiDiscoveryEngine } from '@runtimescope/collector';

export function registerApiDiscoveryTools(
  server: McpServer,
  store: EventStore,
  engine: ApiDiscoveryEngine
): void {
  // --- get_api_catalog ---
  server.tool(
    'get_api_catalog',
    'Discover all API endpoints the app is communicating with, auto-grouped by service. Shows normalized paths, call counts, auth patterns, and inferred response shapes.',
    {
      service: z.string().optional().describe('Filter by service name (e.g. "Supabase", "Your API")'),
      min_calls: z.number().optional().describe('Only show endpoints with at least N calls'),
    },
    async ({ service, min_calls }) => {
      const catalog = engine.getCatalog({ service, minCalls: min_calls });
      const services = engine.getServiceMap();

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      const response = {
        summary: `Discovered ${catalog.length} API endpoint(s) across ${services.length} service(s).`,
        data: {
          services: services.map((s) => ({
            name: s.name,
            baseUrl: s.baseUrl,
            endpointCount: s.endpointCount,
            totalCalls: s.totalCalls,
            avgLatency: `${s.avgLatency.toFixed(0)}ms`,
            errorRate: `${(s.errorRate * 100).toFixed(1)}%`,
            auth: s.auth.type,
            platform: s.detectedPlatform ?? null,
          })),
          endpoints: catalog.map((ep) => ({
            method: ep.method,
            path: ep.normalizedPath,
            service: ep.service,
            callCount: ep.callCount,
            auth: ep.auth.type,
            firstSeen: new Date(ep.firstSeen).toISOString(),
            lastSeen: new Date(ep.lastSeen).toISOString(),
            graphql: ep.graphqlOperation ?? null,
            responseFields: ep.contract?.responseFields.length ?? 0,
          })),
        },
        issues: [] as string[],
        metadata: {
          timeRange: catalog.length > 0
            ? { from: Math.min(...catalog.map((e) => e.firstSeen)), to: Math.max(...catalog.map((e) => e.lastSeen)) }
            : { from: 0, to: 0 },
          eventCount: catalog.reduce((s, e) => s + e.callCount, 0),
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_api_health ---
  server.tool(
    'get_api_health',
    'Get health metrics for discovered API endpoints: success rate, latency percentiles (p50/p95), error rates and error codes.',
    {
      endpoint: z.string().optional().describe('Filter by endpoint path substring'),
      since_seconds: z.number().optional().describe('Only consider requests from the last N seconds'),
    },
    async ({ endpoint, since_seconds }) => {
      const health = engine.getHealth({ endpoint, sinceSeconds: since_seconds });

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      const issues: string[] = [];
      for (const ep of health) {
        if (ep.errorRate > 0.5) issues.push(`${ep.method} ${ep.normalizedPath}: ${(ep.errorRate * 100).toFixed(0)}% error rate`);
        if (ep.p95Latency > 5000) issues.push(`${ep.method} ${ep.normalizedPath}: p95 latency ${(ep.p95Latency / 1000).toFixed(1)}s`);
      }

      const response = {
        summary: `Health report for ${health.length} endpoint(s).${issues.length > 0 ? ` ${issues.length} issue(s) found.` : ''}`,
        data: health.map((ep) => ({
          method: ep.method,
          path: ep.normalizedPath,
          service: ep.service,
          callCount: ep.callCount,
          successRate: `${(ep.successRate * 100).toFixed(1)}%`,
          avgLatency: `${ep.avgLatency.toFixed(0)}ms`,
          p50Latency: `${ep.p50Latency.toFixed(0)}ms`,
          p95Latency: `${ep.p95Latency.toFixed(0)}ms`,
          errorRate: `${(ep.errorRate * 100).toFixed(1)}%`,
          errorCodes: ep.errorCodes,
        })),
        issues,
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: health.reduce((s, e) => s + e.callCount, 0),
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_api_documentation ---
  server.tool(
    'get_api_documentation',
    'Generate API documentation from observed network traffic. Shows endpoints, auth, latency, and inferred response shapes in markdown format.',
    {
      service: z.string().optional().describe('Generate docs for a specific service only'),
    },
    async ({ service }) => {
      const docs = engine.getDocumentation({ service });

      return {
        content: [{ type: 'text' as const, text: docs }],
      };
    }
  );

  // --- get_service_map ---
  server.tool(
    'get_service_map',
    'Get a topology map of all external services the app communicates with, including detected platforms (Supabase, Vercel, Stripe, etc.), call counts, and latency.',
    {},
    async () => {
      const services = engine.getServiceMap();

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      const response = {
        summary: `${services.length} service(s) detected from network traffic.`,
        data: services.map((s) => ({
          name: s.name,
          baseUrl: s.baseUrl,
          endpointCount: s.endpointCount,
          totalCalls: s.totalCalls,
          avgLatency: `${s.avgLatency.toFixed(0)}ms`,
          errorRate: `${(s.errorRate * 100).toFixed(1)}%`,
          auth: s.auth,
          detectedPlatform: s.detectedPlatform ?? null,
        })),
        issues: [] as string[],
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: services.reduce((s, e) => s + e.totalCalls, 0),
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // --- get_api_changes ---
  server.tool(
    'get_api_changes',
    'Compare API endpoints between two sessions. Detects added/removed endpoints and response shape changes.',
    {
      session_a: z.string().describe('First session ID'),
      session_b: z.string().describe('Second session ID'),
    },
    async ({ session_a, session_b }) => {
      const changes = engine.getApiChanges(session_a, session_b);

      const sessions = store.getSessionInfo();
      const sessionId = sessions[0]?.sessionId ?? null;

      const added = changes.filter((c) => c.changeType === 'added').length;
      const removed = changes.filter((c) => c.changeType === 'removed').length;
      const modified = changes.filter((c) => c.changeType === 'modified').length;

      const response = {
        summary: `${changes.length} API change(s) between sessions: ${added} added, ${removed} removed, ${modified} modified.`,
        data: changes,
        issues: removed > 0 ? [`${removed} endpoint(s) no longer called — may indicate removed features or routing changes`] : [],
        metadata: {
          timeRange: { from: 0, to: Date.now() },
          eventCount: changes.length,
          sessionId,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
