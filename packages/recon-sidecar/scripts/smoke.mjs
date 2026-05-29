#!/usr/bin/env node
// Smoke test for the recon sidecar.
//
//   node packages/recon-sidecar/dist/index.js   must exist (run `npm run build` first)
//
// Spawns the sidecar, sends a `ping` then a `scan_website` request over stdio,
// prints the responses, and exits non-zero if the scan fails.
//
// Usage: node scripts/smoke.mjs [url]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../dist/index.js');
const url = process.argv[2] ?? 'https://example.com';

const child = spawn('node', [entry], { stdio: ['pipe', 'pipe', 'inherit'] });

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

function send(method, params) {
  return new Promise((resolveReq) => {
    const id = nextId++;
    pending.set(id, resolveReq);
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const resolveReq = pending.get(msg.id);
  if (resolveReq) {
    pending.delete(msg.id);
    resolveReq(msg);
  }
});

const ping = await send('ping', {});
console.log('ping →', JSON.stringify(ping));

const scan = await send('scan_website', { url });
if (scan.error) {
  console.error('scan_website FAILED →', JSON.stringify(scan.error));
  child.kill();
  process.exit(1);
}

const { title, url: finalUrl, techStack = [], events = [], scanDurationMs } = scan.result;
console.log(
  `scan_website OK → "${title}" (${finalUrl}) — ${techStack.length} techs, ${events.length} events in ${scanDurationMs}ms`,
);

child.stdin.write(JSON.stringify({ id: nextId++, method: 'shutdown' }) + '\n');
setTimeout(() => child.kill(), 1000);
