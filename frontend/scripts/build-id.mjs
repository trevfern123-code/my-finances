// The application build identity: one rule, shared by vite.config.ts (which bakes it into the
// bundle and into index.html's <meta name="app-build">) and scripts/verify-pwa-build.mjs (which
// checks the built output against it). Diagnostics and reload-loop decisions use it
// (src/lib/appUpdate.ts). None of these values is secret.

/** The id a build made with this environment should carry, or null for a local build, whose id is
 *  a timestamp (`local-<base36>`) that can't be predicted — every local build differs by design. */
export function expectedBuildId(env = process.env) {
  // Vercel exposes the deployed commit to the build when "Automatically expose System Environment
  // Variables" is on; the deployment id is the next best.
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 12).toLowerCase();
  const deployment = env.VERCEL_DEPLOYMENT_ID;
  if (deployment && /^[A-Za-z0-9_-]{1,64}$/.test(deployment)) return deployment;
  return null;
}

export function resolveBuildId(env = process.env, now = Date.now()) {
  return expectedBuildId(env) ?? `local-${now.toString(36)}`;
}

/** Every id resolveBuildId can produce. */
export const BUILD_ID_PATTERN = /^(?:[0-9a-f]{7,12}|local-[0-9a-z]+|[A-Za-z0-9_-]{1,64})$/;
