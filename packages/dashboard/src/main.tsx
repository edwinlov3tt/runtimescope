import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeScope } from '@runtimescope/sdk';
import './index.css';
import { App } from './App';
import { ErrorBoundary } from './components/error-boundary';

// The dashboard is the monitoring UI, not a monitored app — it must NOT capture
// its OWN activity, or the collector fills with the dashboard's /api/* polling and
// its own Web Vitals (CLS) / renders (a self-monitoring feedback loop). Connect
// with every auto-interceptor OFF; the connection stays only so deliberate
// `RuntimeScope.track(...)` dogfood events (task_created, export_csv, …) still flow.
RuntimeScope.connect({
  dsn: 'runtimescope://proj_k34w06y5z8qp@localhost:6768/runtimescope-dashboard',
  captureNetwork: false,
  captureXhr: false,
  captureConsole: false,
  captureErrors: false,
  capturePerformance: false,
  captureRenders: false,
  captureNavigation: false,
  captureClicks: false,
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
