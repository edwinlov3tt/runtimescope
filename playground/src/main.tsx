import React from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeScope } from '@runtimescope/sdk';
import { App } from './App';

RuntimeScope.init({
  dsn: 'runtimescope://proj_playground_demo@localhost:6768/playground-web',
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
