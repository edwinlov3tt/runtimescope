#!/usr/bin/env node
/**
 * RuntimeScope stress runner.
 *
 * Usage:
 *   npm run stress                  # run all scenarios
 *   npm run stress -- flood         # only flood-events
 *   npm run stress -- --quick       # smoke set (fast — under 30s)
 *   npm run stress -- --list        # list scenarios + exit
 *
 * Exit code 0 if all scenarios pass, non-zero otherwise — wires cleanly into
 * a pre-push git hook or CI gate.
 */

import { runScenario } from './utils/assert.js';
import { floodEvents } from './scenarios/flood-events.js';
import { concurrentSessions } from './scenarios/concurrent-sessions.js';
import { crashRecovery } from './scenarios/crash-recovery.js';
import { pathologicalEvents } from './scenarios/pathological-events.js';
import { authFuzz } from './scenarios/auth-fuzz.js';
import { memoryLeak } from './scenarios/memory-leak.js';
import { frameworkSmoke } from './scenarios/framework-smoke.js';

interface ScenarioDef {
  name: string;
  body: (checks: import('./utils/assert.js').CheckCollector) => Promise<void>;
  inQuick: boolean;
}

const SCENARIOS: ScenarioDef[] = [
  { name: 'flood-events',         body: floodEvents,        inQuick: true },
  { name: 'concurrent-sessions',  body: concurrentSessions, inQuick: true },
  { name: 'pathological-events',  body: pathologicalEvents, inQuick: true },
  { name: 'auth-fuzz',            body: authFuzz,           inQuick: true },
  { name: 'crash-recovery',       body: crashRecovery,      inQuick: false },
  { name: 'memory-leak',          body: memoryLeak,         inQuick: false },
  { name: 'framework-smoke',      body: frameworkSmoke,     inQuick: false },
];

const COLOR = process.stdout.isTTY;
const GREEN = COLOR ? '\x1b[32m' : '';
const RED = COLOR ? '\x1b[31m' : '';
const YELLOW = COLOR ? '\x1b[33m' : '';
const RESET = COLOR ? '\x1b[0m' : '';
const BOLD = COLOR ? '\x1b[1m' : '';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    console.log('Available scenarios:');
    for (const s of SCENARIOS) {
      console.log(`  ${s.name}${s.inQuick ? ' (quick)' : ''}`);
    }
    return;
  }

  const quick = args.includes('--quick');
  const filter = args.find((a) => !a.startsWith('-'));
  const toRun = SCENARIOS.filter((s) => {
    if (filter && !s.name.includes(filter)) return false;
    if (quick && !s.inQuick) return false;
    return true;
  });

  if (toRun.length === 0) {
    console.error(`No scenarios match filter "${filter ?? ''}". Use --list to see available.`);
    process.exit(2);
  }

  console.log(`${BOLD}RuntimeScope stress harness${RESET}`);
  console.log(`Running ${toRun.length} scenario${toRun.length === 1 ? '' : 's'}${quick ? ' (quick mode)' : ''}\n`);

  const results: { name: string; passed: boolean; checksLine: string }[] = [];
  const start = Date.now();

  for (const def of toRun) {
    const r = await runScenario(def.name, def.body);
    results.push({
      name: def.name,
      passed: r.passed,
      checksLine: r.checks.reportLine(def.name),
    });
  }

  const totalMs = Date.now() - start;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  console.log('\n' + '─'.repeat(60));
  console.log(`${BOLD}Summary${RESET} (${(totalMs / 1000).toFixed(1)}s total)`);
  console.log('─'.repeat(60));
  for (const r of results) console.log(r.checksLine);
  console.log('─'.repeat(60));
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}✓ ${passed}/${results.length} scenarios passed${RESET}`);
  } else {
    console.log(`${RED}${BOLD}✗ ${failed}/${results.length} scenarios failed${RESET}  (${passed} passed)`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err);
  process.exit(1);
});
