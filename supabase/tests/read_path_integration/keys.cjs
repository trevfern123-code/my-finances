// Prints the two API keys of the THROWAWAY LOCAL stack, for run.sh to capture (never to a log):
//   SERVICE_ROLE_KEY=<jwt>
//   ANON_KEY=<jwt>
//
// `supabase status` omits the keys when the auth service is not started (this check starts only
// PostgreSQL, PostgREST and Kong), so they are derived the way the stack itself would: an HS256 token
// signed with the local stack's own JWT secret, read from the local PostgREST container. That secret
// is generated for the local development stack; nothing here touches a hosted project or any real
// credential.
'use strict';

const { createHmac } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const container = process.argv[2];
if (!container) {
  console.error('usage: keys.cjs <postgrest container name>');
  process.exit(2);
}
const inspect = spawnSync('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', container], { encoding: 'utf8' });
if (inspect.status !== 0) {
  console.error('could not inspect the PostgREST container');
  process.exit(1);
}
const line = inspect.stdout.split('\n').find((l) => l.startsWith('PGRST_JWT_SECRET='));
if (!line) {
  console.error('the PostgREST container has no PGRST_JWT_SECRET');
  process.exit(1);
}
const raw = line.slice('PGRST_JWT_SECRET='.length).trim();

/** The symmetric signing key: the secret itself, or the `oct` member of a JWKS. */
function symmetricKey(secret) {
  if (!secret.startsWith('{')) return Buffer.from(secret, 'utf8');
  const jwks = JSON.parse(secret);
  const oct = (jwks.keys || []).find((k) => k.kty === 'oct' && typeof k.k === 'string');
  if (!oct) throw new Error('the JWKS has no symmetric (oct) key');
  return Buffer.from(oct.k, 'base64url');
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(role, key) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: 'supabase-local-i1-check', role, iat: now, exp: now + 3600 });
  const signature = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

try {
  const key = symmetricKey(raw);
  process.stdout.write(`SERVICE_ROLE_KEY=${sign('service_role', key)}\nANON_KEY=${sign('anon', key)}\n`);
} catch (err) {
  console.error(`could not derive the local keys: ${err.message}`);
  process.exit(1);
}
