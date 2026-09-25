import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * A build identity for diagnostics and reload-loop decisions (src/lib/appUpdate.ts). Vercel exposes
 * the deployed commit to the build as VERCEL_GIT_COMMIT_SHA when "Automatically expose System
 * Environment Variables" is on; the deployment id is the next best. A local build gets a timestamp,
 * so two local builds always differ. None of these is secret.
 */
function resolveBuildId(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 12);
  const deployment = process.env.VERCEL_DEPLOYMENT_ID;
  if (deployment && /^[A-Za-z0-9_-]{1,64}$/.test(deployment)) return deployment;
  return `local-${Date.now().toString(36)}`;
}

export default defineConfig({
  define: {
    __APP_BUILD_ID__: JSON.stringify(resolveBuildId()),
  },
  plugins: [
    react(),
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
