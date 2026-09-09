import { defineConfig } from 'vitest/config';

// Deliberately minimal and separate from vite.config.ts (which carries the PWA plugin — no
// reason to load that for tests). The global environment stays 'node': almost every test here
// targets framework-agnostic lib/ logic (money, dates, drill-down math), not components. The one
// exception — App.integration.test.tsx, which exercises real React/StrictMode lifecycle behavior
// pure functions can't — opts into jsdom per-file via a `// @vitest-environment jsdom` docblock at
// its own top, rather than switching this whole suite to a DOM environment for everything else's
// sake.
export default defineConfig({
  test: {
    environment: 'node',
  },
});
