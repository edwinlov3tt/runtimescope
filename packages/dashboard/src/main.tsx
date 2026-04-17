import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeScope } from '@runtimescope/sdk';
import './index.css';
import { App } from './App';
import { ErrorBoundary } from './components/error-boundary';

RuntimeScope.connect({
  dsn: 'runtimescope://proj_k34w06y5z8qp@localhost:6768/runtimescope-dashboard',
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
