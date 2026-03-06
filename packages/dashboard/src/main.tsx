import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeScope } from '@runtimescope/sdk';
import './index.css';
import { App } from './App';

RuntimeScope.connect({
  serverUrl: 'ws://localhost:9092',
  appName: 'runtimescope-dashboard',
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
