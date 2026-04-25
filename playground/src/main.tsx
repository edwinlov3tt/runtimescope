import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// The RuntimeScope SDK is initialized by the @runtimescope/vite plugin via an
// inline <script type="module"> in index.html (see vite.config.ts). Don't
// re-init here — a second `RuntimeScope.init()` call would override the DSN
// the plugin injected (which respects VITE_RUNTIMESCOPE_DSN) with whatever
// was hard-coded, breaking any custom collector port.

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
