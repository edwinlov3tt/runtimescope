/**
 * Minimal playground API server — uses the raw `node:http` module so we don't
 * pull in an HTTP framework just for test routes. The RuntimeScope server SDK
 * auto-instruments console + errors + outgoing HTTP once we call connect().
 */

import http from 'node:http';
import { RuntimeScope } from '@runtimescope/server-sdk';

RuntimeScope.connect({
  dsn: 'runtimescope://proj_playground_demo@localhost:6768/playground-api',
  captureConsole: true,
  captureErrors: true,
  capturePerformance: true,
});

const PORT = 5174;

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  res.setHeader('Content-Type', 'application/json');

  console.log(`[server] ${req.method} ${url}`);

  if (url === '/api/ok') {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, at: Date.now() }));
    return;
  }

  if (url === '/api/slow') {
    await new Promise((r) => setTimeout(r, 2000));
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, slow: true }));
    return;
  }

  if (url === '/api/error') {
    console.error('[server] intentionally returning 500');
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Intentional demo 500' }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found', path: url }));
});

server.listen(PORT, () => {
  console.log(`[playground-api] listening on http://127.0.0.1:${PORT}`);
});
