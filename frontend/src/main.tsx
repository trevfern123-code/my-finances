import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { APP_BUILD_ID, appUpdate } from './lib/appUpdate';

// Diagnostics: which build this page is running (not secret — a commit prefix or a timestamp).
document.documentElement.dataset.appBuild = APP_BUILD_ID;

// Service-worker registration and update management (src/lib/appUpdate.ts). Production builds only:
// the dev server serves no /sw.js.
if (import.meta.env.PROD) {
  appUpdate.start();
}

// Local release verification only (README "Frontend/backend compatibility contract"): a build made
// with VITE_UPDATE_DEBUG=1 exposes the manager so guards and levels can be driven from DevTools.
// Normal builds never set it, and the bundler drops this branch.
if (import.meta.env.VITE_UPDATE_DEBUG === '1') {
  (window as unknown as { __appUpdate?: typeof appUpdate }).__appUpdate = appUpdate;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
