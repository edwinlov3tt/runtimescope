import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeScope } from '@runtimescope/sdk';
import './index.css';
import { App } from './App';
import { ErrorBoundary } from './components/error-boundary';

RuntimeScope.connect({
  serverUrl: 'ws://localhost:9092',
  appName: 'runtimescope-dashboard',
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
