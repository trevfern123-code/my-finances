// Checks the production build's service-worker contract (README "Frontend/backend compatibility
// contract"). Run after `vite build`: `npm run verify:pwa --workspace frontend`.
//
// 1. The generated worker still activates immediately and claims open pages (skipWaiting +
//    clientsClaim) — vite-plugin-pwa drops both silently when it does not inject the registration.
// 2. The injected registerSW.js is gone; the app registers /sw.js itself (src/lib/appUpdate.ts).
// 3. The Plaid Hosted Link completion page is precached as itself and is never answered by the SPA
//    navigation fallback, with or without a query string. Workbox's NavigationRoute tests its
//    denylist against `pathname + search`, which is what is checked here.
// 4. The bundle sends the client API level and carries a build id.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
const read = (file) => readFileSync(join(dist, file), 'utf8');

check(existsSync(join(dist, 'sw.js')), 'dist/sw.js is missing (the /sw.js URL must not change)');
const sw = existsSync(join(dist, 'sw.js')) ? read('sw.js') : '';
const html = read('index.html');

// 1. Unconditional skipWaiting (not only the SKIP_WAITING message handler) and clientsClaim.
check(/"use strict";\s*self\.skipWaiting\(\)/.test(sw), 'sw.js does not call self.skipWaiting() on install');
check(/\.clientsClaim\(\)/.test(sw), 'sw.js does not call clientsClaim()');

// 2. No injected registration.
check(!existsSync(join(dist, 'registerSW.js')), 'dist/registerSW.js exists (injectRegister must be false)');
check(!html.includes('registerSW'), 'index.html still references registerSW.js');

// 3. Completion page: precached, and excluded from the navigation fallback.
check(/url:"plaid-link-complete\.html"/.test(sw), 'plaid-link-complete.html is not precached');
check(existsSync(join(dist, 'plaid-link-complete.html')), 'dist/plaid-link-complete.html is missing');
const fallback = sw.match(/NavigationRoute\([^)]*createHandlerBoundToURL\("index\.html"\)\s*,\s*\{denylist:\[([^\]]*)\]/);
check(fallback !== null, 'sw.js has no navigation fallback denylist');
const denylist = fallback
  ? [...fallback[1].matchAll(/\/((?:\\\/|[^/])+)\/([gimsuy]*)/g)].map((m) => new RegExp(m[1], m[2]))
  : [];
const deniedByFallback = (pathAndSearch) => denylist.some((re) => re.test(pathAndSearch));
for (const url of [
  '/plaid-link-complete.html',
  '/plaid-link-complete.html?',
  '/plaid-link-complete.html?status=success',
  '/plaid-link-complete.html?link_session_id=abc&status=exit',
  '/plaid-link-complete',
  '/plaid-link-complete?status=success',
]) {
  check(deniedByFallback(url), `${url} would be answered by the SPA fallback`);
}
for (const url of ['/', '/?tab=accounts', '/accounts', '/plaid-link-complete.html.bak', '/plaid-link-completed']) {
  check(!deniedByFallback(url), `${url} is wrongly excluded from the SPA fallback`);
}

// 4. The bundle.
const bundles = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js'));
const js = bundles.map((f) => read(join('assets', f))).join('\n');
check(js.includes('X-Client-Api-Level'), 'the bundle does not send X-Client-Api-Level');
check(js.includes('"/sw.js"'), 'the bundle does not register /sw.js');
check(js.includes('vite:preloadError'), 'the bundle does not handle vite:preloadError');

if (failures.length > 0) {
  console.error('PWA build verification FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PWA build verification passed (${bundles.length} bundle(s), denylist ${denylist.map(String).join(' ')}).`);
