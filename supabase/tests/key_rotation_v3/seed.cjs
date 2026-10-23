// Fixture SQL for the V2 → V3 rotation rehearsal (rehearse.sh). LOCAL, SYNTHETIC DATA ONLY: fake
// tokens, throwaway keys generated per run by rehearse.sh (REHEARSAL_V2_KEY / REHEARSAL_V3_KEY), and
// encryption done by the backend's own compiled tokenEncryption module, so the AAD and format are
// exactly what production uses. Writes SQL to stdout; nothing here is ever a real credential.
//
//   node seed.cjs <compiled backend dist dir> initial | revert-cd-to-v2 | missed-writer-item
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

const [distDir, mode] = process.argv.slice(2);
const enc = require(path.join(distDir, 'services', 'tokenEncryption.js'));

const v2Ring = enc.loadKeyRing({ PLAID_TOKEN_KEY_RAILWAY_PROD_V2: process.env.REHEARSAL_V2_KEY, PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V2' });

const USER_1 = '0e000000-0000-4000-8000-000000000001';
const USER_2 = '0e000000-0000-4000-8000-000000000002';
// Production shape (PLAID_KEY_ROTATION_V2_TO_V3.md §1): 4 items, all V2, 3 with a plaintext copy, one
// encrypted-only; statuses 3 x login_required, 1 x credential_error.
const ITEMS = [
  { id: '0a000000-0000-4000-8000-00000000000a', user: USER_1, plaintext: true, status: 'login_required' },
  { id: '0b000000-0000-4000-8000-00000000000b', user: USER_1, plaintext: true, status: 'login_required' },
  { id: '0c000000-0000-4000-8000-00000000000c', user: USER_2, plaintext: true, status: 'credential_error' },
  { id: '0d000000-0000-4000-8000-00000000000d', user: USER_2, plaintext: false, status: 'login_required' },
];
const MISSED = { id: '0f000000-0000-4000-8000-00000000000f', user: USER_1, plaintext: false, status: 'active' };
const token = (id) => `access-sandbox-rehearsal-${id.slice(0, 2)}`;
const q = (v) => (v === null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

function encCols(id) {
  const e = enc.encryptAccessToken(token(id), v2Ring, id);
  return { ct: e.ciphertextBase64, nonce: e.nonceBase64, tag: e.authTagBase64, key: e.keyId, ver: e.encVersion };
}

function insertItem(it) {
  const e = encCols(it.id);
  return `insert into public.plaid_items (id, user_id, plaid_item_id, access_token, access_token_ciphertext, access_token_nonce, access_token_auth_tag, access_token_key_id, access_token_enc_version, institution_name, transactions_cursor, status)
  values (${q(it.id)}, ${q(it.user)}, ${q(`ext-item-${it.id.slice(0, 2)}`)}, ${it.plaintext ? q(token(it.id)) : 'null'}, ${q(e.ct)}, ${q(e.nonce)}, ${q(e.tag)}, ${q(e.key)}, ${e.ver}, 'Rehearsal Bank', ${q(`cursor-${it.id.slice(0, 2)}`)}, ${q(it.status)});`;
}

function linkAttempt(id, user, createdOffset, expiresOffset, withToken) {
  const linkToken = `link-sandbox-rehearsal-${id.slice(0, 2)}`;
  const hash = crypto.createHash('sha256').update(linkToken, 'utf8').digest('hex');
  if (!withToken) {
    return `insert into public.plaid_link_attempts (id, user_id, session_id, created_at, expires_at, status, link_token_hash, failure_reason, finished_at)
  values (${q(id)}, ${q(user)}, 'rehearsal-session', now() + interval '${createdOffset}', now() + interval '${expiresOffset}', 'failed', ${q(hash)}, 'exited', now() + interval '${expiresOffset}');`;
  }
  const e = enc.encryptLinkToken(linkToken, v2Ring, id);
  return `insert into public.plaid_link_attempts (id, user_id, session_id, created_at, expires_at, status, link_token_hash, link_token_ciphertext, link_token_nonce, link_token_auth_tag, link_token_key_id, link_token_enc_version)
  values (${q(id)}, ${q(user)}, 'rehearsal-session', now() + interval '${createdOffset}', now() + interval '${expiresOffset}', 'pending', ${q(hash)}, ${q(e.ciphertextBase64)}, ${q(e.nonceBase64)}, ${q(e.authTagBase64)}, ${q(e.keyId)}, ${e.encVersion});`;
}

const out = [];
if (mode === 'initial') {
  for (const [id, n] of [[USER_1, 1], [USER_2, 2]]) {
    out.push(`insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', ${q(id)}, 'authenticated', 'authenticated', 'rehearsal-${n}@example.test', '', now(), now());`);
  }
  for (const it of ITEMS) out.push(insertItem(it));
  // L1: V2 token, expired 2 h ago (purgeable). L2: finished attempt, no token, expired 3 h ago (history
  // that the cleanup must keep). L4: V2 token, still live (blocks the cleanup until it ages out).
  out.push(linkAttempt('1a000000-0000-4000-8000-0000000000a1', USER_1, '-150 minutes', '-120 minutes', true));
  out.push(linkAttempt('1b000000-0000-4000-8000-0000000000a2', USER_2, '-210 minutes', '-180 minutes', false));
  out.push(linkAttempt('1d000000-0000-4000-8000-0000000000a4', USER_1, '-1 minutes', '29 minutes', true));
} else if (mode === 'revert-cd-to-v2') {
  // Recreates the state an interrupted apply leaves: A, B already on V3; C, D still on V2.
  for (const it of ITEMS.slice(2)) {
    const e = encCols(it.id);
    out.push(`update public.plaid_items set access_token_ciphertext = ${q(e.ct)}, access_token_nonce = ${q(e.nonce)}, access_token_auth_tag = ${q(e.tag)}, access_token_key_id = ${q(e.key)}, access_token_enc_version = ${e.ver} where id = ${q(it.id)};`);
  }
} else if (mode === 'missed-writer-item') {
  out.push(insertItem(MISSED));
} else {
  console.error('usage: node seed.cjs <dist dir> initial|revert-cd-to-v2|missed-writer-item');
  process.exit(2);
}
process.stdout.write(out.join('\n') + '\n');
