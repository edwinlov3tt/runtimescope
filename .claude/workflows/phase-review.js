export const meta = {
  name: 'phase-review',
  description: 'Parallel-lens code audit (adversarial / edge-cases / verification) → deduped, ranked findings. Find-only; fixes are a separate pass.',
  whenToUse: 'Run at the end of a phase / before a release, over a dir or the branch diff, to scrutinize work before shipping.',
  phases: [
    { title: 'Review', detail: 'three independent lenses, structured findings' },
    { title: 'Consolidate', detail: 'dedup by file:line, rank by severity' },
  ],
}

// Scope: pass `args` as a string (a dir, a file list, or a diff spec). Defaults
// to the current branch diff vs main.
const scope = (typeof args === 'string' && args.trim())
  ? args.trim()
  : (args && args.scope) || 'the changes on the current branch (run `git diff main...HEAD --stat` then read the changed files)'

// Structured findings so consolidation is mechanical, not vibes.
const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
          file: { type: 'string', description: 'path:line, e.g. src/foo.rs:42' },
          title: { type: 'string', description: 'one-line description' },
          why: { type: 'string', description: 'why it is a real defect (not style)' },
        },
        required: ['severity', 'file', 'title', 'why'],
      },
    },
    clean: { type: 'array', items: { type: 'string' }, description: 'categories checked with NO issues' },
  },
  required: ['findings', 'clean'],
}

const common = `Review scope: ${scope}.\nRead the code first (rg/grep + read files). Do NOT fix anything — only collect findings. Return severity-ranked findings, each with a path:line reference and a one-sentence "why it's a real defect." List the categories you checked and found clean. Your final output is the StructuredOutput object.`

const LENSES = [
  {
    key: 'adversarial',
    prompt: `You are an ADVERSARIAL reviewer. Assume the implementation is WRONG and prove it: logic errors, race conditions, incorrect assumptions, security holes (injection, SSRF, auth gaps, PII leaks), discarded Results / silent unwraps, and ways the happy path masks failures. ${common}`,
  },
  {
    key: 'edge-cases',
    prompt: `You are an EDGE-CASE & GAP reviewer. Enumerate inputs/states the code does NOT handle (empty/null/malformed, boundary values, concurrency, partial failures, unhandled error paths). Then do a SPEC-COVERAGE pass against any spec/ADR/handoff docs in the repo: list requirements not implemented, and flag those NOT marked with a TODO. ${common}`,
  },
  {
    key: 'verification',
    prompt: `You are a VERIFICATION reviewer. Check the code against its STATED INTENT (specs/ADRs/commit messages): does it do what was asked? Find silent no-ops, dead code, tests that pass without testing anything (tautological asserts, mocks masking the real path), and handlers/branches with no test coverage. Where something is correct, say so. ${common}`,
  },
]

phase('Review')
const reports = await parallel(
  LENSES.map((l) => () => agent(l.prompt, { label: `review:${l.key}`, phase: 'Review', schema: FINDINGS })),
)

phase('Consolidate')
const SEV = { Critical: 0, High: 1, Medium: 2, Low: 3 }
const all = reports
  .map((r, i) => ({ r, lens: LENSES[i].key }))
  .filter((x) => x.r && Array.isArray(x.r.findings))
  .flatMap((x) => x.r.findings.map((f) => ({ ...f, lens: x.lens })))

// Dedup by normalized file:line — merge titles + record which lenses flagged it
// (multi-lens agreement = higher confidence). Keep the worst severity.
const byLoc = new Map()
for (const f of all) {
  const key = (f.file || '?').toLowerCase().replace(/\s+/g, '')
  const prev = byLoc.get(key)
  if (!prev) {
    byLoc.set(key, { ...f, lenses: [f.lens] })
  } else {
    if (SEV[f.severity] < SEV[prev.severity]) prev.severity = f.severity
    if (!prev.lenses.includes(f.lens)) prev.lenses.push(f.lens)
    if (f.title && !prev.title.includes(f.title)) prev.title += ` | ${f.title}`
  }
}
const consolidated = [...byLoc.values()].sort(
  (a, b) => SEV[a.severity] - SEV[b.severity] || b.lenses.length - a.lenses.length,
)
const clean = [...new Set(reports.filter(Boolean).flatMap((r) => r.clean || []))]

log(`phase-review: ${consolidated.length} findings (${all.length} raw across 3 lenses) — ` +
    `${consolidated.filter((f) => f.severity === 'Critical').length} Critical, ` +
    `${consolidated.filter((f) => f.severity === 'High').length} High`)

// Returned to the orchestrator to review + decide fixes (a SEPARATE pass).
return {
  scope,
  counts: { raw: all.length, deduped: consolidated.length },
  multiLensConfirmed: consolidated.filter((f) => f.lenses.length >= 2).length,
  findings: consolidated,
  clean,
  note: 'Find-only. Do NOT fix in this run — review, then run a separate fix pass on the chosen findings.',
}
