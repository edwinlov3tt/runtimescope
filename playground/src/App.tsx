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

export function App() {
  const [log, setLog] = useState<string[]>([]);
  const [count, setCount] = useState(0);

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
