import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolveBuildId } from './scripts/build-id.mjs';

// One build identity (scripts/build-id.mjs: the Vercel commit, else the deployment id, else a local
// timestamp), resolved once so the bundle and index.html always agree.
const BUILD_ID = resolveBuildId();

export default defineConfig({
  define: {
    __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    {
      // <meta name="app-build" content="…"> in index.html: which build a deployment serves, readable
      // without running it (release checks, scripts/verify-pwa-build.mjs). Not secret.
      name: 'app-build-meta',
      transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'app-build', content: BUILD_ID }, injectTo: 'head' }],
    },
    VitePWA({
      // The generated worker still activates immediately and claims open pages (skipWaiting +
      // clientsClaim); the page itself decides when it is safe to reload onto the new build.
      registerType: 'autoUpdate',
      // No injected registerSW.js: src/lib/appUpdate.ts registers /sw.js (same URL, so existing
      // installations upgrade in place) and manages updates.
      injectRegister: false,
      includeAssets: ['icons/icon.svg'],
      workbox: {
        // Explicit, not implied: vite-plugin-pwa only turns these on for 'autoUpdate' when it injects
        // the registration itself, so with injectRegister: false they would silently switch off and
        // a new worker would wait until every tab closed. scripts/verify-pwa-build.mjs checks them.
        skipWaiting: true,
        clientsClaim: true,
        // Plaid Hosted Link redirects to this page, possibly with query parameters. It must never be
        // answered by the SPA navigation fallback: the precache serves the exact URL (and the
        // extension-less form), and anything else — e.g. with a query string — goes to the network.
        navigateFallbackDenylist: [/^\/plaid-link-complete(\.html)?(\?|$)/],
      },
      manifest: {
        name: 'My Finances',
        short_name: 'Finances',
        description: 'Personal finance tracker with bank account linking',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
    }),
  ],
});
