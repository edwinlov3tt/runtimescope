import { useState, useCallback } from 'react';
import { RuntimeScope } from '@runtimescope/sdk';

const PANEL: React.CSSProperties = {
  background: '#13131a',
  border: '1px solid #25252e',
  borderRadius: 8,
  padding: 20,
  marginBottom: 12,
};

const BTN: React.CSSProperties = {
  background: '#3b82f6',
  color: 'white',
  border: 0,
  padding: '8px 14px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  marginRight: 8,
  marginBottom: 8,
};

const BTN_RED: React.CSSProperties = { ...BTN, background: '#ef4444' };
const BTN_AMBER: React.CSSProperties = { ...BTN, background: '#f59e0b' };
const BTN_GRAY: React.CSSProperties = { ...BTN, background: '#374151' };
const INPUT: React.CSSProperties = {
  background: '#0a0a0f',
  color: '#e5e5e5',
  border: '1px solid #374151',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 13,
  boxSizing: 'border-box',
};

type SurveyDef = {
  id: string;
  name: string;
  questions: Array<{ id: string; type: string; label?: string; options?: string[]; required?: boolean }>;
};

// Headless survey renderer — the app builds its OWN UI from the question defs the
// collector returns (RuntimeScope renders nothing). Demonstrates ADR-0014.
function SurveyCard({
  survey,
  onSubmit,
  onDismiss,
}: {
  survey: SurveyDef;
  onSubmit: (answers: Record<string, unknown>) => void;
  onDismiss: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const set = (qid: string, v: unknown) => setAnswers((a) => ({ ...a, [qid]: v }));
  return (
    <div style={{ ...PANEL, background: '#161622', borderColor: '#3b82f6' }}>
      <h3 style={{ fontSize: 15, marginTop: 0 }}>{survey.name}</h3>
      {survey.questions.map((q) => (
        <div key={q.id} style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 4 }}>
            {q.label || q.id}
            {q.required ? ' *' : ''}
          </label>
          {q.type === 'rating' &&
            [1, 2, 3, 4, 5].map((n) => (
              <button key={n} style={{ ...BTN, background: answers[q.id] === n ? '#3b82f6' : '#374151' }} onClick={() => set(q.id, n)}>
                {n}
              </button>
            ))}
          {q.type === 'number' && <input type="number" style={{ ...INPUT, width: 160 }} onChange={(e) => set(q.id, Number(e.target.value))} />}
          {q.type === 'text' && <input style={{ ...INPUT, width: 320 }} onChange={(e) => set(q.id, e.target.value)} />}
          {q.type === 'textarea' && <textarea style={{ ...INPUT, width: '100%', height: 60 }} onChange={(e) => set(q.id, e.target.value)} />}
          {q.type === 'single' &&
            (q.options || []).map((o) => (
              <label key={o} style={{ display: 'block', fontSize: 13 }}>
                <input type="radio" name={q.id} onChange={() => set(q.id, o)} /> {o}
              </label>
            ))}
          {q.type === 'multi' &&
            (q.options || []).map((o) => (
              <label key={o} style={{ display: 'block', fontSize: 13 }}>
                <input
                  type="checkbox"
                  onChange={(e) =>
                    set(
                      q.id,
                      e.target.checked
                        ? [...((answers[q.id] as string[]) || []), o]
                        : ((answers[q.id] as string[]) || []).filter((x) => x !== o),
                    )
                  }
                />{' '}
                {o}
              </label>
            ))}
        </div>
      ))}
      <button style={BTN} onClick={() => onSubmit(answers)}>Submit</button>
      <button style={BTN_GRAY} onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

export function App() {
  const [log, setLog] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  // -- Analytics state --
  const [email, setEmail] = useState('dev@playground.test');
  const [role, setRole] = useState('Specialist');
  const [anonId, setAnonId] = useState<string | null>(null);
  const [surveys, setSurveys] = useState<SurveyDef[]>([]);

  const append = useCallback((msg: string) => {
    setLog((prev) => [new Date().toISOString().slice(11, 19) + '  ' + msg, ...prev].slice(0, 20));
  }, []);

  // -- Network --

  const fetchOk = async () => {
    append('GET /api/ok');
    const r = await fetch('/api/ok');
    await r.json();
  };

  const fetchSlow = async () => {
    append('GET /api/slow (simulated 2s)');
    const r = await fetch('/api/slow');
    await r.json();
  };

  const fetch500 = async () => {
    append('GET /api/error (500)');
    try {
      const r = await fetch('/api/error');
      await r.json();
    } catch { /* fetch throws on some platforms */ }
  };

  const fetch404 = async () => {
    append('GET /api/nope (404)');
    await fetch('/api/nope');
  };

  // -- Console --

  const consoleLog = () => {
    console.log('[playground] console.log with object', { foo: 'bar', n: 42 });
    append('console.log');
  };

  const consoleWarn = () => {
    console.warn('[playground] this is a warning');
    append('console.warn');
  };

  const consoleError = () => {
    console.error('[playground] this is an error with stack', new Error('oops'));
    append('console.error');
  };

  // -- Errors --

  const throwError = () => {
    append('throwing an uncaught TypeError…');
    setTimeout(() => {
      throw new TypeError('Cannot read properties of undefined (reading \'foo\')');
    }, 0);
  };

  const rejectPromise = () => {
    append('rejecting a promise');
    Promise.reject(new Error('Unhandled rejection demo'));
  };

  // -- Custom events --

  const trackEvent = () => {
    RuntimeScope.track('button_clicked', { button: 'demo', at: Date.now() });
    append('RuntimeScope.track(button_clicked)');
  };

  const addBreadcrumb = () => {
    RuntimeScope.addBreadcrumb('navigated to features section', { section: 'features' });
    append('RuntimeScope.addBreadcrumb(…)');
  };

  // -- Analytics: identity + ROI features + headless surveys --

  const doIdentify = async () => {
    const id = await RuntimeScope.identify({ email, role, consent: true, externalId: 'app-user-' + role.toLowerCase().replace(/\s+/g, '-') });
    setAnonId(id);
    append(`identify(${email}, ${role}) → ${id ?? 'failed'}`);
  };

  // `geocode`/`export` are ROI "features": seed baselines for them (see README)
  // and these track() calls drive value/hours on the analytics pages.
  const useFeature = (name: string, count?: number) => {
    RuntimeScope.track(name, count ? { count } : undefined);
    append(`track(${name}${count ? `, count=${count}` : ''})`);
  };

  const loadSurveys = async () => {
    const s = await RuntimeScope.getActiveSurveys();
    setSurveys(s as SurveyDef[]);
    append(`getActiveSurveys() → ${s.length} survey(s)`);
  };

  const submitSurvey = async (id: string, answers: Record<string, unknown>) => {
    const ok = await RuntimeScope.submitSurveyResponse(id, answers);
    append(`submitSurveyResponse(${id}) → ${ok ? 'ok' : 'failed'}`);
    setSurveys((prev) => prev.filter((s) => s.id !== id));
  };

  const dismissSurvey = async (id: string) => {
    await RuntimeScope.dismissSurvey(id);
    append(`dismissSurvey(${id})`);
    setSurveys((prev) => prev.filter((s) => s.id !== id));
  };

  // -- Renders --

  const triggerRerender = () => {
    setCount((c) => c + 1);
    append(`re-render: count=${count + 1}`);
  };

  const spamRerenders = () => {
    append('triggering 20 re-renders in a tight loop…');
    let i = 0;
    const tick = () => {
      if (i++ < 20) {
        setCount((c) => c + 1);
        setTimeout(tick, 50);
      }
    };
    tick();
  };

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>RuntimeScope Playground</h1>
        <p style={{ color: '#9ca3af', marginTop: 4 }}>
          Click buttons to trigger events, then check the dashboard at{' '}
          <a href="http://localhost:3200" target="_blank" rel="noreferrer" style={{ color: '#3b82f6' }}>
            localhost:3200
          </a>{' '}
          or query via MCP tools.
        </p>
        <p style={{ color: '#9ca3af', marginTop: 4, fontSize: 13 }}>
          Current re-render count: <strong style={{ color: '#e5e5e5' }}>{count}</strong>
        </p>
      </header>

      <section style={PANEL}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Network</h2>
        <button style={BTN} onClick={fetchOk}>Success (200)</button>
        <button style={BTN_AMBER} onClick={fetchSlow}>Slow (2s)</button>
        <button style={BTN_RED} onClick={fetch500}>Server error (500)</button>
        <button style={BTN_RED} onClick={fetch404}>Not found (404)</button>
      </section>

      <section style={PANEL}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Console</h2>
        <button style={BTN} onClick={consoleLog}>console.log</button>
        <button style={BTN_AMBER} onClick={consoleWarn}>console.warn</button>
        <button style={BTN_RED} onClick={consoleError}>console.error</button>
      </section>

      <section style={PANEL}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Errors</h2>
        <button style={BTN_RED} onClick={throwError}>Throw TypeError</button>
        <button style={BTN_RED} onClick={rejectPromise}>Unhandled promise rejection</button>
      </section>

      <section style={PANEL}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Custom events + breadcrumbs</h2>
        <button style={BTN} onClick={trackEvent}>track(button_clicked)</button>
        <button style={BTN} onClick={addBreadcrumb}>addBreadcrumb(navigated)</button>
      </section>

      <section style={PANEL}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Renders</h2>
        <button style={BTN} onClick={triggerRerender}>Re-render once</button>
        <button style={BTN_AMBER} onClick={spamRerenders}>Spam 20 re-renders</button>
      </section>

      <section style={PANEL}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Analytics — identity + ROI features</h2>
        <div style={{ marginBottom: 8 }}>
          <input style={{ ...INPUT, width: 240, marginRight: 8 }} value={email} onChange={(e) => setEmail(e.target.value)} />
          <select style={{ ...INPUT, width: 150, marginRight: 8 }} value={role} onChange={(e) => setRole(e.target.value)}>
            {['Coordinator', 'Specialist', 'DCM', 'Account Exec', 'Director'].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <button style={BTN} onClick={doIdentify}>identify()</button>
        </div>
        {anonId && (
          <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 10px' }}>
            anonId: <code style={{ color: '#9ca3af' }}>{anonId}</code> · externalId: <code style={{ color: '#9ca3af' }}>app-user-…</code>
          </p>
        )}
        <button style={BTN_GRAY} onClick={() => useFeature('geocode', 10)}>use geocode ×10</button>
        <button style={BTN_GRAY} onClick={() => useFeature('export')}>use export</button>
      </section>

      <section style={PANEL}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Surveys (headless — your UI, our targeting)</h2>
        <button style={BTN} onClick={loadSurveys}>getActiveSurveys()</button>
        {surveys.length === 0 ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>
            No active surveys. identify() first, then seed one: <code>node scripts/seed-playground-analytics.mjs</code> (see README).
          </p>
        ) : (
          surveys.map((sv) => <SurveyCard key={sv.id} survey={sv} onSubmit={(a) => submitSurvey(sv.id, a)} onDismiss={() => dismissSurvey(sv.id)} />)
        )}
      </section>

      <section style={{ ...PANEL, background: '#0a0a0f' }}>
        <h2 style={{ fontSize: 13, marginTop: 0, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>Recent</h2>
        {log.length === 0 ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>Click a button above…</p>
        ) : (
          <pre style={{ fontSize: 12, color: '#9ca3af', margin: 0, whiteSpace: 'pre-wrap' }}>
            {log.join('\n')}
          </pre>
        )}
      </section>
    </div>
  );
}
