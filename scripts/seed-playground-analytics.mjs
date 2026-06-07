#!/usr/bin/env node
// Seed the analytics admin side for the playground e2e: ROI baselines + a headless
// survey. Run with the collector up (npm run dev -w playground auto-starts it).
//   node scripts/seed-playground-analytics.mjs
// Override the collector HTTP base with RS_HTTP (default http://localhost:6768).

const BASE = process.env.RS_HTTP || 'http://localhost:6768';

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) console.error(`  ! ${method} ${path} → ${res.status}`, json);
  return { status: res.status, json };
}

(async () => {
  console.log(`Seeding analytics at ${BASE} …`);

  // ROI baselines: geocode is per-item (count matters), export is per-use. These
  // turn the playground's track('geocode',{count})/track('export') into value/hours.
  await call('PUT', '/api/analytics/baselines', { fn: 'geocode', manualMin: 8, toolMin: 2.4, perItem: true });
  await call('PUT', '/api/analytics/baselines', { fn: 'export', manualMin: 15, toolMin: 5, perItem: false });
  console.log('✓ baselines: geocode (per-item, 8→2.4 min), export (per-use, 15→5 min)');

  // A headless survey targeting Specialists (the playground renders its own UI).
  const sv = await call('POST', '/api/analytics/surveys', {
    name: 'Playground CSAT',
    status: 'active',
    questions: [
      { id: 'rating', type: 'rating', label: 'How useful is RuntimeScope?', required: true },
      { id: 'tool', type: 'single', label: 'Your most-used feature?', options: ['geocode', 'export', 'other'] },
      { id: 'comment', type: 'textarea', label: 'Anything else?' },
    ],
    targeting: { roles: ['Specialist'], samplePct: 100 },
  });
  console.log(`✓ survey: ${sv.json?.data?.id ?? '(failed)'} — targets role "Specialist"`);

  console.log('\nNext, in the playground (http://localhost:5173):');
  console.log('  1. pick role "Specialist" → click identify()');
  console.log('  2. click "use geocode ×10" and "use export" a few times (ROI $)');
  console.log('  3. click getActiveSurveys() → the CSAT survey renders → Submit');
  console.log('  Then check the dashboard analytics pages (overview $, features, surveys).');
})();
