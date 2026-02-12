import {
  CollectorServer,
  EventStore,
  ApiDiscoveryEngine,
} from '@runtimescope/collector';
import { createMcpStub } from '../__tests__/tool-harness.js';

// Tool registrations
import { registerNetworkTools } from '../tools/network.js';
import { registerConsoleTools } from '../tools/console.js';
import { registerSessionTools } from '../tools/session.js';
import { registerIssueTools } from '../tools/issues.js';
import { registerTimelineTools } from '../tools/timeline.js';
import { registerStateTools } from '../tools/state.js';
import { registerRenderTools } from '../tools/renders.js';
import { registerPerformanceTools } from '../tools/performance.js';
import { registerDomSnapshotTools } from '../tools/dom-snapshot.js';
import { registerHarTools } from '../tools/har.js';
import { registerErrorTools } from '../tools/errors.js';
import { registerApiDiscoveryTools } from '../tools/api-discovery.js';
import { registerDatabaseTools } from '../tools/database.js';

export interface TestServer {
  collector: CollectorServer;
  store: EventStore;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;
  port: number;
  cleanup: () => Promise<void>;
}

/**
 * Creates a real CollectorServer on a random port with all MCP tools registered.
 * No SQLite, no ProjectManager — pure in-memory pipeline.
 */
export async function createTestServer(): Promise<TestServer> {
  const collector = new CollectorServer({ bufferSize: 10_000 });
  await collector.start({ port: 0, maxRetries: 0 });

  const port = collector.getPort()!;
  const store = collector.getStore();

  // Create MCP stub and register all tools that don't need external resources
  const { server, callTool } = createMcpStub();

  // Core tools (use real store)
  registerNetworkTools(server, store);
  registerConsoleTools(server, store);
  registerSessionTools(server, store);
  registerIssueTools(server, store);
  registerTimelineTools(server, store);
  registerStateTools(server, store);
  registerRenderTools(server, store);
  registerPerformanceTools(server, store);
  registerDomSnapshotTools(server, store, collector);
  registerHarTools(server, store);
  registerErrorTools(server, store);

  // API Discovery (real engine, works off EventStore data)
  const apiDiscovery = new ApiDiscoveryEngine(store);
  registerApiDiscoveryTools(server, store, apiDiscovery);

  // Database tools (stub connection manager — no real DB in integration tests)
  const stubConnectionManager = { listConnections: () => [], getConnection: () => null, closeAll: async () => {} } as any;
  const stubSchemaIntrospector = { introspect: async () => ({ connectionId: 'test', tables: [], fetchedAt: Date.now() }) } as any;
  const stubDataBrowser = { read: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }), write: async () => ({ success: true, affectedRows: 0 }) } as any;
  registerDatabaseTools(server, store, stubConnectionManager, stubSchemaIntrospector, stubDataBrowser);

  async function cleanup(): Promise<void> {
    collector.stop();
    // Small delay to let the server fully close
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return { collector, store, callTool, port, cleanup };
}
