/**
 * Tiny assertion helper tuned for stress reports — every assertion records
 * pass/fail and the scenario decides how to summarize. Output is colored
 * and copy-pastable so a failure in CI is debuggable from the log alone.
 */

const COLOR = process.stdout.isTTY;
const GREEN = COLOR ? '\x1b[32m' : '';
const RED = COLOR ? '\x1b[31m' : '';
const YELLOW = COLOR ? '\x1b[33m' : '';
const DIM = COLOR ? '\x1b[2m' : '';
const RESET = COLOR ? '\x1b[0m' : '';

export interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
}

export class CheckCollector {
  private results: CheckResult[] = [];
  private start = Date.now();

  ok(label: string, condition: boolean, detail?: string): void {
    this.results.push({ ok: condition, label, detail });
    if (condition) {
      console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}— ${detail}${RESET}` : ''}`);
    } else {
      console.log(`  ${RED}✗${RESET} ${label}${detail ? ` ${RED}— ${detail}${RESET}` : ''}`);
    }
  }

  eq(label: string, actual: unknown, expected: unknown, tolerance: number = 0): void {
    const a = typeof actual === 'number' ? actual : NaN;
    const e = typeof expected === 'number' ? expected : NaN;
    const isNum = !Number.isNaN(a) && !Number.isNaN(e);
    const pass = isNum
      ? Math.abs(a - e) <= tolerance
      : actual === expected;
    this.ok(
      label,
      pass,
      pass
        ? isNum
          ? `actual=${actual}`
          : undefined
        : `actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}${tolerance > 0 ? ` ±${tolerance}` : ''}`,
    );
  }

  geq(label: string, actual: number, threshold: number): void {
    this.ok(label, actual >= threshold, `${actual} ≥ ${threshold}`);
  }

  leq(label: string, actual: number, threshold: number, unit?: string): void {
    const u = unit ? unit : '';
    this.ok(label, actual <= threshold, `${actual.toFixed(2)}${u} ≤ ${threshold}${u}`);
  }

  /** True if every check passed. */
  passed(): boolean {
    return this.results.every((r) => r.ok);
  }

  summary(): { total: number; passed: number; failed: number; ms: number } {
    const passed = this.results.filter((r) => r.ok).length;
    return {
      total: this.results.length,
      passed,
      failed: this.results.length - passed,
      ms: Date.now() - this.start,
    };
  }

  reportLine(scenarioName: string): string {
    const s = this.summary();
    const status = s.failed === 0 ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    return `${status} ${scenarioName.padEnd(28)} ${s.passed}/${s.total} checks  ${YELLOW}${s.ms}ms${RESET}`;
  }
}

/**
 * Wrap a scenario function with timing + crash safety so one bad scenario
 * doesn't take down the whole suite.
 */
export async function runScenario(
  name: string,
  body: (checks: CheckCollector) => Promise<void>,
): Promise<{ name: string; passed: boolean; checks: CheckCollector; error?: Error }> {
  const checks = new CheckCollector();
  console.log(`\n${YELLOW}▶${RESET} ${name}`);
  try {
    await body(checks);
  } catch (err) {
    checks.ok(`uncaught error in scenario: ${(err as Error).message}`, false);
    return { name, passed: false, checks, error: err as Error };
  }
  return { name, passed: checks.passed(), checks };
}
