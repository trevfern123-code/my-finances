import { defineConfig } from 'vitest/config';

// Deliberately minimal and separate from vite.config.ts (which carries the PWA plugin — no
// reason to load that for tests). No jsdom/testing-library environment configured yet since the
// first tests target framework-agnostic lib/ logic (money, dates, drill-down math), not
// components — add a DOM environment when component tests are actually needed.
export default defineConfig({
  test: {
    environment: 'node',
  },
});
