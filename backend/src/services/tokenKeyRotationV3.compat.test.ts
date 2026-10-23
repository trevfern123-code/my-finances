import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryBuilder } from '../testUtils/supabaseMock';

// Application-side compatibility for the RAILWAY_PROD_V2 → RENDER_PROD_V3 rotation
// (PLAID_KEY_ROTATION_V2_TO_V3.md). No application code changes for the rotation — the key ring is
// purely environment-driven — so these tests pin the behaviour the runbook relies on:
//   1. with both keys configured and V3 current, every V2 row and V2 link token still reads, and
//      every new write is V3 (the whole transition window is safe in either direction);
//   2. with V2 removed too early, V2 rows fail CLOSED (UnknownKeyIdError) even when a plaintext
//      copy exists — the plaintext copy is never a fallback — which is why V2 retirement is gated
//      on `verify-retirement`, not on "the plaintext copies are still there".

const mockFrom = vi.hoisted(() => vi.fn());
const mockRpc = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: mockFrom, rpc: mockRpc } }));

const keyRingHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('./tokenEncryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tokenEncryption')>();
  return { ...actual, getKeyRing: () => keyRingHolder.current };
});

import { getPlaidItemForUser, insertPlaidItem, readPlaidLinkAttempt, storePlaidLinkItem } from './dataService';
import {
  decryptAccessToken,
  encryptAccessToken,
  encryptLinkToken,
  loadKeyRing,
  UnknownKeyIdError,
  type KeyRing,
} from './tokenEncryption';

const V2_KEY = Buffer.alloc(32, 21).toString('base64');
const V3_KEY = Buffer.alloc(32, 33).toString('base64');

const V2_ONLY: KeyRing = loadKeyRing({ PLAID_TOKEN_KEY_RAILWAY_PROD_V2: V2_KEY, PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V2' });
const V2_PLUS_V3_V2_CURRENT: KeyRing = loadKeyRing({
  PLAID_TOKEN_KEY_RAILWAY_PROD_V2: V2_KEY,
  PLAID_TOKEN_KEY_RENDER_PROD_V3: V3_KEY,
  PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V2',
});
const V2_PLUS_V3_V3_CURRENT: KeyRing = loadKeyRing({
  PLAID_TOKEN_KEY_RAILWAY_PROD_V2: V2_KEY,
  PLAID_TOKEN_KEY_RENDER_PROD_V3: V3_KEY,
  PLAID_TOKEN_CURRENT_KEY_ID: 'RENDER_PROD_V3',
});
const V3_ONLY: KeyRing = loadKeyRing({ PLAID_TOKEN_KEY_RENDER_PROD_V3: V3_KEY, PLAID_TOKEN_CURRENT_KEY_ID: 'RENDER_PROD_V3' });

const ROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCESS_TOKEN = 'access-sandbox-compat';
const LINK_TOKEN = 'link-sandbox-compat';

function storedRow(keyRing: KeyRing, plaintextCopy: boolean) {
  const enc = encryptAccessToken(ACCESS_TOKEN, keyRing, ROW_ID);
  return {
    id: ROW_ID,
    status: 'login_required',
    access_token: plaintextCopy ? ACCESS_TOKEN : null,
    access_token_ciphertext: enc.ciphertextBase64,
    access_token_nonce: enc.nonceBase64,
    access_token_auth_tag: enc.authTagBase64,
    access_token_key_id: enc.keyId,
    access_token_enc_version: enc.encVersion,
  };
}

function storedLinkAttempt(keyRing: KeyRing, expired: boolean) {
  const enc = encryptLinkToken(LINK_TOKEN, keyRing, ATTEMPT_ID);
  return {
    status: 'pending',
    expired,
    stale: false,
    link_token_ciphertext: enc.ciphertextBase64,
    link_token_nonce: enc.nonceBase64,
    link_token_auth_tag: enc.authTagBase64,
    link_token_key_id: enc.keyId,
    link_token_enc_version: enc.encVersion,
  };
}

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
});

describe('transition window: V2 and V3 both configured', () => {
  it.each([
    ['V2 current (step 1: V3 added, nothing switched yet)', V2_PLUS_V3_V2_CURRENT],
    ['V3 current (step 2: new writes go to V3)', V2_PLUS_V3_V3_CURRENT],
  ])('reads a V2 row — with and without a plaintext copy — with %s', async (_name, keyRing) => {
    for (const plaintextCopy of [true, false]) {
      keyRingHolder.current = keyRing;
      mockFrom.mockReturnValue(createQueryBuilder({ data: storedRow(V2_ONLY, plaintextCopy), error: null }));
      const item = await getPlaidItemForUser(ROW_ID, 'user-1');
      expect(item?.access_token).toBe(ACCESS_TOKEN);
    }
  });

  it('reads a row already rotated to V3 (mixed V2/V3 table after a partial or interrupted run)', async () => {
    keyRingHolder.current = V2_PLUS_V3_V3_CURRENT;
    mockFrom.mockReturnValue(createQueryBuilder({ data: storedRow(V3_ONLY, false), error: null }));
    expect((await getPlaidItemForUser(ROW_ID, 'user-1'))?.access_token).toBe(ACCESS_TOKEN);
  });

  it('still decrypts a V2 Hosted Link token created before the switch', async () => {
    keyRingHolder.current = V2_PLUS_V3_V3_CURRENT;
    mockRpc.mockResolvedValue({ data: [storedLinkAttempt(V2_ONLY, false)], error: null });
    expect(await readPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'session-1')).toMatchObject({ status: 'pending', linkToken: LINK_TOKEN });
  });

  it('writes every new access token (direct insert and Hosted Link store) under V3 once V3 is current', async () => {
    keyRingHolder.current = V2_PLUS_V3_V3_CURRENT;
    const insertBuilder = createQueryBuilder({ data: { id: 'x' }, error: null });
    mockFrom.mockReturnValue(insertBuilder);
    await insertPlaidItem({ userId: 'user-1', itemId: 'item-1', accessToken: ACCESS_TOKEN, institutionId: null, institutionName: null });
    const inserted = insertBuilder.insert.mock.calls[0][0];
    expect(inserted.access_token_key_id).toBe('RENDER_PROD_V3');
    expect(inserted).not.toHaveProperty('access_token');
    expect(
      decryptAccessToken(
        {
          ciphertextBase64: inserted.access_token_ciphertext,
          nonceBase64: inserted.access_token_nonce,
          authTagBase64: inserted.access_token_auth_tag,
          keyId: inserted.access_token_key_id,
          encVersion: inserted.access_token_enc_version,
        },
        V3_ONLY,
        inserted.id
      )
    ).toBe(ACCESS_TOKEN);

    mockRpc.mockResolvedValue({ data: true, error: null, status: 200 });
    await storePlaidLinkItem({ attemptId: ATTEMPT_ID, userId: 'user-1', sessionId: 's', claimToken: 'c', plaidItemId: 'item-2', accessToken: ACCESS_TOKEN });
    expect(mockRpc.mock.calls[0][1].p_access_token_key_id).toBe('RENDER_PROD_V3');
  });
});

describe('V2 removed before every dependent record was migrated (what the retirement gate prevents)', () => {
  it('fails closed on a V2 row even though a plaintext copy exists — no plaintext fallback', async () => {
    keyRingHolder.current = V3_ONLY;
    mockFrom.mockReturnValue(createQueryBuilder({ data: storedRow(V2_ONLY, true), error: null }));
    await expect(getPlaidItemForUser(ROW_ID, 'user-1')).rejects.toBeInstanceOf(UnknownKeyIdError);
  });

  it('fails closed on a V2 Hosted Link token, even an expired one that has not been purged yet', async () => {
    keyRingHolder.current = V3_ONLY;
    mockRpc.mockResolvedValue({ data: [storedLinkAttempt(V2_ONLY, true)], error: null });
    await expect(readPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'session-1')).rejects.toBeInstanceOf(UnknownKeyIdError);
  });
});
