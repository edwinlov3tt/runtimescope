import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestServer, type TestServer } from './setup.js';
import { TestWsClient } from './test-ws-client.js';

let server: TestServer;
let wsUrl: string;

beforeAll(async () => {
  server = await createTestServer();
  wsUrl = `ws://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.cleanup();
});

// Helper: connect a client with handshake + session event
async function connectClient(opts: {
  appName?: string;
  sessionId?: string;
} = {}): Promise<TestWsClient> {
  const sessionId = opts.sessionId ?? `sess-${Math.random().toString(36).slice(2)}`;
  const appName = opts.appName ?? 'test-app';

  const client = new TestWsClient(wsUrl);
  await client.connect();
  client.handshake({ appName, sdkVersion: '0.1.0', sessionId });

  // Send the session event (like the real SDK does after connecting)
  client.sendEvents([{
    eventId: `evt-session-${Math.random().toString(36).slice(2)}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'session',
    appName,
    connectedAt: Date.now(),
    sdkVersion: '0.1.0',
  }]);

  await client.waitForServerProcessing();
  return client;
}

describe('Full Pipeline Integration', () => {
  // Clean store between tests so they don't leak state
  beforeEach(() => {
    server.store.clear();
  });

  describe('WebSocket connection', () => {
    it('client connects and handshake succeeds', async () => {
      const client = new TestWsClient(wsUrl);
      await client.connect();
      client.handshake({ appName: 'my-app', sdkVersion: '0.1.0', sessionId: 'sess-connect-1' });
      await client.waitForServerProcessing();

      // Server should have registered the client
      const firstSession = server.collector.getFirstSessionId();
      expect(firstSession).toBe('sess-connect-1');
      await client.close();
    });

    it('multiple clients can connect simultaneously', async () => {
      const client1 = await connectClient({ sessionId: 'sess-multi-1' });
      const client2 = await connectClient({ sessionId: 'sess-multi-2' });

      const sessions = server.store.getSessionInfo();
      expect(sessions.length).toBeGreaterThanOrEqual(2);

      await client1.close();
      await client2.close();
    });
  });

  describe('Event ingestion → EventStore', () => {
    it('network events sent via WS appear in store', async () => {
      const client = await connectClient({ sessionId: 'sess-net' });

      client.sendEvents([{
        eventId: 'evt-net-1',
        sessionId: 'sess-net',
        timestamp: Date.now(),
        eventType: 'network',
        url: 'https://api.example.com/users',
        method: 'GET',
        status: 200,
        requestHeaders: {},
        responseHeaders: {},
        requestBodySize: 0,
        responseBodySize: 100,
        duration: 150,
        ttfb: 50,
      }]);
      await client.waitForServerProcessing();

      const events = server.store.getNetworkRequests();
      expect(events.some((e) => e.eventId === 'evt-net-1')).toBe(true);
      expect(events.some((e) => e.url === 'https://api.example.com/users')).toBe(true);

      await client.close();
    });

    it('console events sent via WS appear in store', async () => {
      const client = await connectClient({ sessionId: 'sess-console' });

      client.sendEvents([{
        eventId: 'evt-con-1',
        sessionId: 'sess-console',
        timestamp: Date.now(),
        eventType: 'console',
        level: 'error',
        message: 'Something went wrong',
        args: [],
      }]);
      await client.waitForServerProcessing();

      const events = server.store.getConsoleMessages({ level: 'error' });
      expect(events.some((e) => e.message === 'Something went wrong')).toBe(true);

      await client.close();
    });

    it('database events sent via WS appear in store', async () => {
      const client = await connectClient({ sessionId: 'sess-db' });

      client.sendEvents([{
        eventId: 'evt-db-1',
        sessionId: 'sess-db',
        timestamp: Date.now(),
        eventType: 'database',
        query: 'SELECT * FROM users WHERE id = 1',
        normalizedQuery: 'SELECT * FROM users WHERE id = ?',
        duration: 25,
        tablesAccessed: ['users'],
        operation: 'SELECT',
        source: 'prisma',
      }]);
      await client.waitForServerProcessing();

      const events = server.store.getDatabaseEvents();
      expect(events.some((e) => e.eventId === 'evt-db-1')).toBe(true);

      await client.close();
    });

    it('session event registers session in store', async () => {
      const client = await connectClient({ sessionId: 'sess-info-1', appName: 'dashboard' });

      const sessions = server.store.getSessionInfo();
      expect(sessions.some((s) => s.sessionId === 'sess-info-1')).toBe(true);
      expect(sessions.some((s) => s.appName === 'dashboard')).toBe(true);

      await client.close();
    });

    it('batch of mixed events all ingested correctly', async () => {
      const client = await connectClient({ sessionId: 'sess-batch' });
      const now = Date.now();

      client.sendEvents([
        {
          eventId: 'evt-batch-net',
          sessionId: 'sess-batch',
          timestamp: now,
          eventType: 'network',
          url: 'https://api.com/batch',
          method: 'POST',
          status: 201,
          requestHeaders: {},
          responseHeaders: {},
          requestBodySize: 50,
          responseBodySize: 200,
          duration: 100,
          ttfb: 30,
        },
        {
          eventId: 'evt-batch-con',
          sessionId: 'sess-batch',
          timestamp: now + 1,
          eventType: 'console',
          level: 'log',
          message: 'batch test',
          args: [],
        },
        {
          eventId: 'evt-batch-perf',
          sessionId: 'sess-batch',
          timestamp: now + 2,
          eventType: 'performance',
          metricName: 'LCP',
          value: 2500,
          rating: 'good',
        },
      ]);
      await client.waitForServerProcessing();

      expect(server.store.getNetworkRequests().some((e) => e.eventId === 'evt-batch-net')).toBe(true);
      expect(server.store.getConsoleMessages().some((e) => e.eventId === 'evt-batch-con')).toBe(true);
      expect(server.store.getPerformanceMetrics().some((e) => e.eventId === 'evt-batch-perf')).toBe(true);

      await client.close();
    });
  });

  describe('Event ingestion → MCP tool output', () => {
    it('get_network_requests returns data matching sent events', async () => {
      const client = await connectClient({ sessionId: 'sess-mcp-net' });

      client.sendEvents([{
        eventId: 'evt-mcp-net-1',
        sessionId: 'sess-mcp-net',
        timestamp: Date.now(),
        eventType: 'network',
        url: 'https://api.example.com/orders',
        method: 'POST',
        status: 201,
        requestHeaders: {},
        responseHeaders: {},
        requestBodySize: 100,
        responseBodySize: 50,
        duration: 200,
        ttfb: 75,
      }]);
      await client.waitForServerProcessing();

      const result = await server.callTool('get_network_requests', {});
      expect(result.data.some((d: any) => d.url === 'https://api.example.com/orders')).toBe(true);
      expect(result.data.some((d: any) => d.method === 'POST')).toBe(true);
      expect(result.data.some((d: any) => d.status === 201)).toBe(true);

      await client.close();
    });

    it('get_console_messages returns data matching sent events', async () => {
      const client = await connectClient({ sessionId: 'sess-mcp-con' });

      client.sendEvents([{
        eventId: 'evt-mcp-con-1',
        sessionId: 'sess-mcp-con',
        timestamp: Date.now(),
        eventType: 'console',
        level: 'warn',
        message: 'Deprecation warning: use v2',
        args: [],
      }]);
      await client.waitForServerProcessing();

      const result = await server.callTool('get_console_messages', {});
      expect(result.data.some((d: any) => d.message === 'Deprecation warning: use v2')).toBe(true);
      expect(result.data.some((d: any) => d.level === 'warn')).toBe(true);

      await client.close();
    });

    it('get_event_timeline returns all event types in chronological order', async () => {
      const client = await connectClient({ sessionId: 'sess-timeline' });
      const now = Date.now();

      client.sendEvents([
        {
          eventId: 'evt-tl-1',
          sessionId: 'sess-timeline',
          timestamp: now,
          eventType: 'network',
          url: 'https://api.com/first',
          method: 'GET',
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          requestBodySize: 0,
          responseBodySize: 50,
          duration: 100,
          ttfb: 30,
        },
        {
          eventId: 'evt-tl-2',
          sessionId: 'sess-timeline',
          timestamp: now + 100,
          eventType: 'console',
          level: 'log',
          message: 'second',
          args: [],
        },
      ]);
      await client.waitForServerProcessing();

      const result = await server.callTool('get_event_timeline', {});
      expect(result.data.length).toBeGreaterThanOrEqual(2);
      // Should include both network and console types
      const types = result.data.map((d: any) => d.type);
      expect(types).toContain('network');
      expect(types).toContain('console');

      await client.close();
    });

    it('detect_issues flags 500-status network events sent via WS', async () => {
      const client = await connectClient({ sessionId: 'sess-issues' });

      client.sendEvents([{
        eventId: 'evt-fail-1',
        sessionId: 'sess-issues',
        timestamp: Date.now(),
        eventType: 'network',
        url: 'https://api.com/broken',
        method: 'GET',
        status: 500,
        requestHeaders: {},
        responseHeaders: {},
        requestBodySize: 0,
        responseBodySize: 0,
        duration: 50,
        ttfb: 20,
      }]);
      await client.waitForServerProcessing();

      const result = await server.callTool('detect_issues', {});
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data.some((i: any) => i.pattern === 'failed_requests')).toBe(true);

      await client.close();
    });

    it('capture_har produces valid HAR from WS-ingested events', async () => {
      const client = await connectClient({ sessionId: 'sess-har' });

      client.sendEvents([{
        eventId: 'evt-har-1',
        sessionId: 'sess-har',
        timestamp: Date.now(),
        eventType: 'network',
        url: 'https://api.com/data',
        method: 'GET',
        status: 200,
        requestHeaders: { 'accept': 'application/json' },
        responseHeaders: { 'content-type': 'application/json' },
        requestBodySize: 0,
        responseBodySize: 500,
        duration: 120,
        ttfb: 40,
      }]);
      await client.waitForServerProcessing();

      const result = await server.callTool('capture_har', {});
      expect(result.data.log.version).toBe('1.2');
      expect(result.data.log.entries).toHaveLength(1);
      expect(result.data.log.entries[0].request.url).toBe('https://api.com/data');
      expect(result.data.log.entries[0].response.status).toBe(200);

      await client.close();
    });

    it('get_session_info shows connected session', async () => {
      const client = await connectClient({ sessionId: 'sess-info-mcp', appName: 'my-dashboard' });

      const result = await server.callTool('get_session_info', {});
      expect(result.data.some((d: any) => d.sessionId === 'sess-info-mcp')).toBe(true);
      expect(result.data.some((d: any) => d.appName === 'my-dashboard')).toBe(true);
      expect(result.data.some((d: any) => d.isConnected === true)).toBe(true);

      await client.close();
    });

    it('get_api_catalog discovers endpoints from WS-ingested events', async () => {
      const client = await connectClient({ sessionId: 'sess-api' });

      // Send several requests to the same endpoint to build catalog
      for (let i = 0; i < 3; i++) {
        client.sendEvents([{
          eventId: `evt-api-${i}`,
          sessionId: 'sess-api',
          timestamp: Date.now() + i,
          eventType: 'network',
          url: 'https://api.stripe.com/v1/charges',
          method: 'POST',
          status: 200,
          requestHeaders: { Authorization: 'Bearer sk_test_123' },
          responseHeaders: {},
          requestBodySize: 50,
          responseBodySize: 200,
          duration: 100 + i * 10,
          ttfb: 40,
        }]);
      }
      await client.waitForServerProcessing();

      const result = await server.callTool('get_api_catalog', {});
      expect(result.data.endpoints.length).toBeGreaterThan(0);
      expect(result.data.services.some((s: any) => s.name === 'Stripe')).toBe(true);

      await client.close();
    });
  });

  describe('Command/Response protocol', () => {
    it('get_dom_snapshot works end-to-end', async () => {
      const client = await connectClient({ sessionId: 'sess-dom' });

      // Register a command handler on the client (simulates the SDK)
      client.onCommand((cmd) => {
        if (cmd.command === 'capture_dom_snapshot') {
          return {
            html: '<html><body><h1>Integration Test</h1></body></html>',
            url: 'http://localhost:3000/test',
            viewport: { width: 1280, height: 720 },
            scrollPosition: { x: 0, y: 0 },
            elementCount: 3,
            truncated: false,
          };
        }
        return null;
      });
      await client.waitForServerProcessing();

      const result = await server.callTool('get_dom_snapshot', {});
      expect(result.data).not.toBeNull();
      expect(result.data.html).toContain('Integration Test');
      expect(result.data.url).toBe('http://localhost:3000/test');
      expect(result.data.elementCount).toBe(3);

      await client.close();
    });

    it('sendCommand rejects on timeout when client does not respond', async () => {
      const client = await connectClient({ sessionId: 'sess-timeout' });
      // Don't register a command handler — client won't respond

      await expect(
        server.collector.sendCommand('sess-timeout', {
          command: 'capture_dom_snapshot',
          requestId: 'req-timeout-1',
        }, 200) // 200ms timeout
      ).rejects.toThrow('timed out');

      await client.close();
    });
  });

  describe('Session lifecycle', () => {
    it('session shows isConnected=false after client disconnects', async () => {
      const client = await connectClient({ sessionId: 'sess-disconnect' });

      // Verify connected
      let sessions = server.store.getSessionInfo();
      const session = sessions.find((s) => s.sessionId === 'sess-disconnect');
      expect(session?.isConnected).toBe(true);

      // Disconnect
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 100)); // Wait for close event

      // Verify disconnected
      sessions = server.store.getSessionInfo();
      const disconnected = sessions.find((s) => s.sessionId === 'sess-disconnect');
      expect(disconnected?.isConnected).toBe(false);
    });

    it('clear_events empties store after WS events ingested', async () => {
      const client = await connectClient({ sessionId: 'sess-clear' });

      client.sendEvents([{
        eventId: 'evt-clear-1',
        sessionId: 'sess-clear',
        timestamp: Date.now(),
        eventType: 'network',
        url: 'https://api.com/temp',
        method: 'GET',
        status: 200,
        requestHeaders: {},
        responseHeaders: {},
        requestBodySize: 0,
        responseBodySize: 50,
        duration: 100,
        ttfb: 30,
      }]);
      await client.waitForServerProcessing();

      // Verify events exist
      expect(server.store.getNetworkRequests().length).toBeGreaterThan(0);

      // Clear
      const result = await server.callTool('clear_events', {});
      expect(result.summary).toContain('Cleared');

      // Verify empty
      expect(server.store.getNetworkRequests()).toHaveLength(0);

      await client.close();
    });
  });

  describe('Multi-session', () => {
    it('events from different sessions tracked independently', async () => {
      const client1 = await connectClient({ sessionId: 'sess-multi-a', appName: 'app-a' });
      const client2 = await connectClient({ sessionId: 'sess-multi-b', appName: 'app-b' });

      client1.sendEvents([{
        eventId: 'evt-multi-a-1',
        sessionId: 'sess-multi-a',
        timestamp: Date.now(),
        eventType: 'console',
        level: 'log',
        message: 'from app-a',
        args: [],
      }]);

      client2.sendEvents([{
        eventId: 'evt-multi-b-1',
        sessionId: 'sess-multi-b',
        timestamp: Date.now(),
        eventType: 'console',
        level: 'error',
        message: 'from app-b',
        args: [],
      }]);

      await client1.waitForServerProcessing();

      const allMessages = server.store.getConsoleMessages();
      expect(allMessages.some((e) => e.message === 'from app-a' && e.sessionId === 'sess-multi-a')).toBe(true);
      expect(allMessages.some((e) => e.message === 'from app-b' && e.sessionId === 'sess-multi-b')).toBe(true);

      await client1.close();
      await client2.close();
    });

    it('get_session_info lists multiple sessions', async () => {
      const client1 = await connectClient({ sessionId: 'sess-list-1', appName: 'alpha' });
      const client2 = await connectClient({ sessionId: 'sess-list-2', appName: 'beta' });

      const result = await server.callTool('get_session_info', {});
      expect(result.data.length).toBeGreaterThanOrEqual(2);
      expect(result.data.some((s: any) => s.sessionId === 'sess-list-1')).toBe(true);
      expect(result.data.some((s: any) => s.sessionId === 'sess-list-2')).toBe(true);

      await client1.close();
      await client2.close();
    });
  });
});
