// Checks the production build's service-worker contract (README "Frontend/backend compatibility
// contract"). Run after `vite build`: `npm run verify:pwa --workspace frontend`.
//
// 1. The generated worker still activates immediately and claims open pages (skipWaiting +
//    clientsClaim) — vite-plugin-pwa drops both silently when it does not inject the registration.
// 2. The injected registerSW.js is gone; the app registers /sw.js itself (src/lib/appUpdate.ts).
// 3. The Plaid Hosted Link completion page is precached as itself and is never answered by the SPA
//    navigation fallback, with or without a query string. Workbox's NavigationRoute tests its
//    denylist against `pathname + search`, which is what is checked here.
// 4. The bundle sends the client API level and registers /sw.js itself.
// 5. Build identity: index.html's <meta name="app-build"> and the bundle carry the same id, of a
//    valid form, and it is the id this environment should produce (scripts/build-id.mjs): the
//    Vercel commit on Vercel, or EXPECTED_APP_BUILD_ID when set. A local build's id is a timestamp
//    that can't be predicted, so there only its form and consistency are checked.
//
// The patterns tolerate quoting and whitespace differences in generated code: this checks the
// contract, not a snapshot of Workbox's or the minifier's exact output.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_ID_PATTERN, expectedBuildId } from './build-id.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
const read = (file) => readFileSync(join(dist, file), 'utf8');
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Matches `text` as a string literal in any quote style. */
const literal = (text) => new RegExp(`["'\`]${escapeRegExp(text)}["'\`]`);

check(existsSync(join(dist, 'sw.js')), 'dist/sw.js is missing (the /sw.js URL must not change)');
const sw = existsSync(join(dist, 'sw.js')) ? read('sw.js') : '';
const html = read('index.html');

// 1. Unconditional skipWaiting, and clientsClaim. Without the option Workbox emits skipWaiting()
//    only inside a SKIP_WAITING message handler, so a single call beside that handler doesn't count.
const skipWaitingCalls = (sw.match(/\.skipWaiting\s*\(\s*\)/g) ?? []).length;
check(
  skipWaitingCalls > (sw.includes('SKIP_WAITING') ? 1 : 0),
  'sw.js does not call skipWaiting() on install (at most on a SKIP_WAITING message)'
);
check(/\.clientsClaim\s*\(\s*\)/.test(sw), 'sw.js does not call clientsClaim()');

// 2. No injected registration.
check(!existsSync(join(dist, 'registerSW.js')), 'dist/registerSW.js exists (injectRegister must be false)');
check(!html.includes('registerSW'), 'index.html still references registerSW.js');

// 3. Completion page: precached, and excluded from the navigation fallback.
check(/url\s*:\s*["'`]\/?plaid-link-complete\.html["'`]/.test(sw), 'plaid-link-complete.html is not precached');
check(existsSync(join(dist, 'plaid-link-complete.html')), 'dist/plaid-link-complete.html is missing');
const denylistSource = sw.match(/denylist\s*:\s*\[([^\]]*)\]/)?.[1];
check(denylistSource !== undefined, 'sw.js has no navigation fallback denylist');
const denylist = [...(denylistSource ?? '').matchAll(/\/((?:\\.|[^/\\])+)\/([dgimsuy]*)/g)].map(
  (m) => new RegExp(m[1], m[2])
);
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
check(literal('/sw.js').test(js), 'the bundle does not register /sw.js');
check(js.includes('vite:preloadError'), 'the bundle does not handle vite:preloadError');

// 5. Build identity.
const metaTag = html.match(/<meta\b[^>]*\bname\s*=\s*["']app-build["'][^>]*>/i)?.[0];
const buildId = metaTag?.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
check(buildId !== undefined, 'index.html has no <meta name="app-build" content="…">');
if (buildId !== undefined) {
  check(BUILD_ID_PATTERN.test(buildId), `build id "${buildId}" is not a valid build id`);
  check(literal(buildId).test(js), `the bundle does not carry index.html's build id "${buildId}"`);
  const expected = process.env.EXPECTED_APP_BUILD_ID || expectedBuildId();
  if (expected) {
    check(buildId === expected, `build id is "${buildId}", expected "${expected}"`);
  } else {
    check(buildId.startsWith('local-'), `a local build's id should be local-<timestamp>, got "${buildId}"`);
  }
}
check(js.includes('appBuild'), 'the bundle does not expose the build id as <html data-app-build>');

if (failures.length > 0) {
  console.error('PWA build verification FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `PWA build verification passed (build ${buildId}, ${bundles.length} bundle(s), denylist ${denylist.map(String).join(' ')}).`
);
