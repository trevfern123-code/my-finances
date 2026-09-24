import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { AccountBase, RemovedTransaction, Transaction as PlaidTransaction } from 'plaid';
import { createQueryBuilder } from '../testUtils/supabaseMock';
import { InvalidPrincipalPortionError } from './semanticEffects';
import {
  upsertAccountsForItem,
  applyTransactionChanges,
  linkTransactionToLoan,
  updateLinkedPaymentPrincipal,
  unlinkPaymentFromLoan,
  getLifetimeTotalsByLoanId,
  createManualLoan,
  updateManualLoan,
  deleteManualLoan,
  ManualLoanNotFoundError,
  markManualLoanDeletionReconciled,
  getUnlinkedTransactionsByPlaidIds,
  InvalidManualLoanFieldError,
  createManualLoanPayment,
  updateManualLoanPayment,
  deleteManualLoanPayment,
  updateAccountCreditLimit,
  updateAccountSavingsGoal,
  getCategorySpendRows,
  setTransactionSplits,
  clearTransactionSplits,
  deleteCategoryMappingsForBudgetCategory,
  getBudgetCategoryForUser,
  updateAccountCustomization,
  getRecurringStreamsForUser,
  getLoansForUser,
  getTransactionsSince,
  getRecentTransactionsForUser,
  upsertFinancialPreferences,
  upsertNavLayout,
  upsertReportingRange,
  insertPlaidItem,
  getPlaidItemsForUser,
  getPlaidItemByPlaidItemId,
  getPlaidItemForUser,
  getTransactionsForReconciliation,
  findTransferCounterpartCandidates,
  findRefundOriginalCandidates,
  findNegativeCandidatesReferencingOriginal,
  applyTransactionSemanticRoles,
  SemanticRoleMutationError,
  confirmTransferPair,
  TransferPairConfirmationError,
  ManualLoanCreationError,
  ManualLoanCreationKeyResolvedError,
  getRelationallyClassifiedTransactionsPage,
  getTransactionsBackfillPage,
  createPlaidLinkAttempt,
  readPlaidLinkAttempt,
  claimPlaidLinkAttempt,
  beginPlaidLinkExchange,
  storePlaidLinkItem,
  failPlaidLinkAttempt,
  markPlaidLinkAttemptReady,
  hashLinkToken,
  updatePlaidItemInstitution,
  getPlaidItemIdsMissingInstitution,
  TooManyPlaidLinkAttemptsError,
  PlaidLinkStoreOutcomeUnknownError,
} from './dataService';
import {
  decryptAccessToken,
  decryptLinkToken,
  encryptAccessToken,
  encryptLinkToken,
  GcmAuthenticationError,
  loadKeyRing,
  MissingEncryptedRepresentationError,
  PartialEncryptedRepresentationError,
  UnknownKeyIdError,
  type KeyRing,
} from './tokenEncryption';

const mockFrom = vi.hoisted(() => vi.fn());
const mockRpc = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: mockFrom, rpc: mockRpc } }));

// A fixed, test-only key ring — real crypto math still runs (so these tests exercise a genuine
// encrypt/decrypt round trip through dataService.ts, not a mocked stub), just decoupled from any
// real environment state. See PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md §16.
vi.mock('./tokenEncryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tokenEncryption')>();
  const testKeyRing = actual.loadKeyRing({
    PLAID_TOKEN_KEY_TEST_V1: Buffer.alloc(32, 7).toString('base64'),
    PLAID_TOKEN_CURRENT_KEY_ID: 'TEST_V1',
  });
  return { ...actual, getKeyRing: () => testKeyRing };
});

const TEST_KEY_RING: KeyRing = loadKeyRing({
  PLAID_TOKEN_KEY_TEST_V1: Buffer.alloc(32, 7).toString('base64'),
  PLAID_TOKEN_CURRENT_KEY_ID: 'TEST_V1',
});

describe('insertPlaidItem — Phase 2b encrypted-only writes (§27)', () => {
  const PLAINTEXT = 'access-sandbox-1';

  it('the insert payload has no access_token property at all — not present, not null', async () => {
    const query = createQueryBuilder({
      data: { id: 'row-1', user_id: 'user-1', plaid_item_id: 'item-1', access_token: null },
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    await insertPlaidItem({
      userId: 'user-1',
      itemId: 'item-1',
      accessToken: PLAINTEXT,
      institutionId: 'ins_1',
      institutionName: 'Sandbox Bank',
    });

    const inserted = (query.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect('access_token' in inserted).toBe(false);
  });

  it('the plaintext value never appears anywhere in the serialized insert payload', async () => {
    const query = createQueryBuilder({
      data: { id: 'row-1', user_id: 'user-1', plaid_item_id: 'item-1', access_token: null },
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    await insertPlaidItem({
      userId: 'user-1',
      itemId: 'item-1',
      accessToken: PLAINTEXT,
      institutionId: 'ins_1',
      institutionName: 'Sandbox Bank',
    });

    const inserted = (query.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(inserted)).not.toContain(PLAINTEXT);
  });

  it('exactly five encrypted fields are populated, and the returned row may have access_token: null', async () => {
    const query = createQueryBuilder({
      data: { id: 'row-1', user_id: 'user-1', plaid_item_id: 'item-1', access_token: null },
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    const result = await insertPlaidItem({
      userId: 'user-1',
      itemId: 'item-1',
      accessToken: PLAINTEXT,
      institutionId: 'ins_1',
      institutionName: 'Sandbox Bank',
    });

    const inserted = (query.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof inserted.id).toBe('string');
    expect(inserted.access_token_key_id).toBe('TEST_V1');
    expect(inserted.access_token_enc_version).toBe(1);
    expect(typeof inserted.access_token_ciphertext).toBe('string');
    expect(typeof inserted.access_token_nonce).toBe('string');
    expect(typeof inserted.access_token_auth_tag).toBe('string');
    // What the DB actually returns for the now-nullable column — distinct from what was sent.
    expect(result.access_token).toBeNull();
  });

  it('the written ciphertext genuinely round-trips using the generated row UUID as AAD', async () => {
    const query = createQueryBuilder({
      data: { id: 'row-1', user_id: 'user-1', plaid_item_id: 'item-1', access_token: null },
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    await insertPlaidItem({
      userId: 'user-1',
      itemId: 'item-1',
      accessToken: PLAINTEXT,
      institutionId: 'ins_1',
      institutionName: 'Sandbox Bank',
    });

    const inserted = (query.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Proves the round trip actually works at this layer, not only inside
    // tokenEncryption.test.ts in isolation — the ciphertext genuinely represents the plaintext,
    // bound to the generated row id, not just present-but-arbitrary.
    const decrypted = decryptAccessToken(
      {
        ciphertextBase64: inserted.access_token_ciphertext,
        nonceBase64: inserted.access_token_nonce,
        authTagBase64: inserted.access_token_auth_tag,
        keyId: inserted.access_token_key_id,
        encVersion: inserted.access_token_enc_version,
      },
      TEST_KEY_RING,
      inserted.id
    );
    expect(decrypted).toBe(PLAINTEXT);
  });
});

describe('getPlaidItemsForUser / getPlaidItemByPlaidItemId / getPlaidItemForUser (dual-read)', () => {
  const ITEM_ROW_ID = 'row-1';

  function plaintextOnlyRow(overrides: Record<string, unknown> = {}) {
    return {
      id: ITEM_ROW_ID,
      user_id: 'user-1',
      access_token: 'plaintext-access-token',
      access_token_ciphertext: null,
      access_token_nonce: null,
      access_token_auth_tag: null,
      access_token_key_id: null,
      access_token_enc_version: null,
      transactions_cursor: null,
      status: 'active',
      ...overrides,
    };
  }

  function encryptedRow(plaintext: string, overrides: Record<string, unknown> = {}) {
    const enc = encryptAccessToken(plaintext, TEST_KEY_RING, ITEM_ROW_ID);
    return {
      id: ITEM_ROW_ID,
      user_id: 'user-1',
      access_token: null,
      access_token_ciphertext: enc.ciphertextBase64,
      access_token_nonce: enc.nonceBase64,
      access_token_auth_tag: enc.authTagBase64,
      access_token_key_id: enc.keyId,
      access_token_enc_version: enc.encVersion,
      transactions_cursor: null,
      status: 'active',
      ...overrides,
    };
  }

  it('getPlaidItemsForUser resolves a plaintext-only row (pre-migration / not yet backfilled)', async () => {
    const query = createQueryBuilder({ data: [plaintextOnlyRow()], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemsForUser('user-1');

    expect(result).toEqual([
      { id: ITEM_ROW_ID, user_id: 'user-1', access_token: 'plaintext-access-token', transactions_cursor: null },
    ]);
  });

  it('getPlaidItemsForUser prefers the decrypted encrypted representation over a stale plaintext value', async () => {
    // Simulates a row mid-migration where the plaintext column hasn't been cleared yet (Phase
    // 2a/3) but is stale/different from what's actually encrypted — the encrypted representation
    // must win, never the plaintext, whenever access_token_key_id is present.
    const row = encryptedRow('the-real-current-token', { access_token: 'a-stale-different-value' });
    const query = createQueryBuilder({ data: [row], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemsForUser('user-1');

    expect(result[0].access_token).toBe('the-real-current-token');
  });

  it('getPlaidItemsForUser resolves the batch even with an undecryptable row — access_token is a lazy getter (per-item isolation), not resolved eagerly', async () => {
    // The batch call itself must not throw — only reading .access_token on the specific bad row
    // should. This is what lets refreshAccounts/syncTransactions isolate one bad item's failure
    // in their own per-item try/catch, instead of one bad row aborting every other item too.
    const row = encryptedRow('the-real-current-token', {
      access_token: 'a-stale-different-value',
      access_token_ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', // garbage, but well-formed lengths
    });
    const query = createQueryBuilder({ data: [row], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemsForUser('user-1');

    expect(() => result[0].access_token).toThrow(GcmAuthenticationError);
  });

  it('getPlaidItemsForUser: reading access_token throws UnknownKeyIdError for a key id not in the configured ring, without aborting the batch', async () => {
    const row = encryptedRow('token', { access_token_key_id: 'SOME_OTHER_KEY' });
    const query = createQueryBuilder({ data: [row], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemsForUser('user-1');

    expect(() => result[0].access_token).toThrow(UnknownKeyIdError);
  });

  it('getPlaidItemsForUser: an empty-string access_token_key_id enters the encrypted path (not truthiness) and fails closed, never falling back to plaintext', async () => {
    // Blocker 2: `if (row.access_token_key_id)` would treat '' as falsy and silently return the
    // plaintext column below — the DB check constraint permits '' (it only requires non-NULL),
    // so this must be handled at the application layer, not assumed away by the schema.
    const row = encryptedRow('irrelevant', {
      access_token_key_id: '',
      access_token: 'a-plaintext-value-that-must-never-be-returned',
    });
    const query = createQueryBuilder({ data: [row], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemsForUser('user-1');

    // Entering the encrypted path with keyId '' resolves to UnknownKeyIdError (no real key is
    // ever registered under an empty string) — a clean, fail-closed result, not a crash and
    // absolutely not the plaintext value.
    expect(() => result[0].access_token).toThrow(UnknownKeyIdError);
  });

  it('getPlaidItemsForUser: empty-string key ID with fully-populated encrypted fields still fails closed, not plaintext', async () => {
    // Same as above but explicit that every other encrypted column is genuinely present and
    // well-formed (mirrors exactly the row shape Codex described: "encrypted fields populated +
    // empty key ID") — the failure is specifically about the key id, not incidentally about some
    // other field being malformed too.
    const validEncryption = encryptAccessToken('some-token', TEST_KEY_RING, ITEM_ROW_ID);
    const row = encryptedRow('irrelevant', {
      access_token_key_id: '',
      access_token_ciphertext: validEncryption.ciphertextBase64,
      access_token_nonce: validEncryption.nonceBase64,
      access_token_auth_tag: validEncryption.authTagBase64,
      access_token_enc_version: validEncryption.encVersion,
      access_token: 'plaintext-must-never-be-returned',
    });
    const query = createQueryBuilder({ data: [row], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemsForUser('user-1');

    let thrown: unknown;
    try {
      void result[0].access_token;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownKeyIdError);
    // Explicit, not just "it threw" — proves no code path returned the plaintext instead.
    expect(thrown).not.toBe('plaintext-must-never-be-returned');
  });

  it('getPlaidItemForUser and getPlaidItemByPlaidItemId also fail closed on an empty-string key ID (shared resolveAccessToken)', async () => {
    const row = encryptedRow('irrelevant', {
      access_token_key_id: '',
      access_token: 'plaintext-must-never-be-returned',
    });

    const query1 = createQueryBuilder({ data: row, error: null });
    mockFrom.mockReturnValueOnce(query1);
    await expect(getPlaidItemForUser(ITEM_ROW_ID, 'user-1')).rejects.toThrow(UnknownKeyIdError);

    const query2 = createQueryBuilder({ data: row, error: null });
    mockFrom.mockReturnValueOnce(query2);
    await expect(getPlaidItemByPlaidItemId('plaid-item-1')).rejects.toThrow(UnknownKeyIdError);
  });

  it('getPlaidItemsForUser resolves each item independently — a bad row does not prevent reading a good row in the same batch', async () => {
    const badRow = encryptedRow('bad', { id: 'row-bad', access_token_ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' });
    const goodRow = { ...plaintextOnlyRow(), id: 'row-good', access_token: 'good-token' };
    const query = createQueryBuilder({ data: [badRow, goodRow], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemsForUser('user-1');

    expect(() => result[0].access_token).toThrow(GcmAuthenticationError);
    expect(result[1].access_token).toBe('good-token');
  });

  it('getPlaidItemsForUser memoizes access_token — decrypting the same row twice returns the identical value without re-decrypting', async () => {
    const row = encryptedRow('memo-token');
    const query = createQueryBuilder({ data: [row], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemsForUser('user-1');

    expect(result[0].access_token).toBe('memo-token');
    expect(result[0].access_token).toBe('memo-token'); // second read, same memoized value
  });

  it('getPlaidItemByPlaidItemId resolves an encrypted row correctly', async () => {
    const row = encryptedRow('webhook-path-token');
    const query = createQueryBuilder({ data: row, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemByPlaidItemId('plaid-item-1');

    expect(result?.access_token).toBe('webhook-path-token');
  });

  it('getPlaidItemByPlaidItemId returns null when no row matches, without attempting to resolve a token', async () => {
    const query = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(query);

    expect(await getPlaidItemByPlaidItemId('unknown-item')).toBeNull();
  });

  it('getPlaidItemForUser resolves a plaintext-only row correctly', async () => {
    const query = createQueryBuilder({ data: plaintextOnlyRow(), error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemForUser(ITEM_ROW_ID, 'user-1');

    expect(result).toEqual({ id: ITEM_ROW_ID, access_token: 'plaintext-access-token', status: 'active' });
  });

  it('getPlaidItemForUser resolves an encrypted-only row correctly', async () => {
    // getPlaidItemsForUser and getPlaidItemByPlaidItemId both already have this coverage
    // (encryptedRow() defaults access_token to null); this one was the actual gap.
    const query = createQueryBuilder({ data: encryptedRow('reconnect-path-token'), error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemForUser(ITEM_ROW_ID, 'user-1');

    expect(result?.access_token).toBe('reconnect-path-token');
  });
});

describe('resolveAccessToken — explicit 5-field state machine (§27, Phase 2b revision)', () => {
  const ITEM_ROW_ID = 'row-1';
  const ENCRYPTED_FIELD_NAMES = [
    'access_token_ciphertext',
    'access_token_nonce',
    'access_token_auth_tag',
    'access_token_key_id',
    'access_token_enc_version',
  ] as const;

  function fullyEncryptedFields(plaintext: string, rowId: string = ITEM_ROW_ID) {
    const enc = encryptAccessToken(plaintext, TEST_KEY_RING, rowId);
    return {
      access_token_ciphertext: enc.ciphertextBase64,
      access_token_nonce: enc.nonceBase64,
      access_token_auth_tag: enc.authTagBase64,
      access_token_key_id: enc.keyId,
      access_token_enc_version: enc.encVersion,
    };
  }

  it('zero encrypted fields + null plaintext throws MissingEncryptedRepresentationError', async () => {
    const row = {
      id: ITEM_ROW_ID,
      user_id: 'user-1',
      access_token: null,
      access_token_ciphertext: null,
      access_token_nonce: null,
      access_token_auth_tag: null,
      access_token_key_id: null,
      access_token_enc_version: null,
      status: 'active',
    };
    const query = createQueryBuilder({ data: row, error: null });
    mockFrom.mockReturnValueOnce(query);

    await expect(getPlaidItemForUser(ITEM_ROW_ID, 'user-1')).rejects.toThrow(MissingEncryptedRepresentationError);
  });

  // Every non-empty, incomplete subset of the 5 encrypted fields — 2^5 - 2 = 30 subsets (excludes
  // the empty subset, "legacy plaintext-only", and the full subset, "complete encrypted"). Every
  // one of these must fail closed via PartialEncryptedRepresentationError and must never return
  // plaintext, regardless of which specific fields happen to be present.
  const allFullFields = fullyEncryptedFields('sentinel-for-subset-generation');
  const PARTIAL_SUBSETS: (typeof ENCRYPTED_FIELD_NAMES[number])[][] = [];
  for (let mask = 1; mask < 31; mask++) {
    const subset = ENCRYPTED_FIELD_NAMES.filter((_, i) => (mask & (1 << i)) !== 0);
    PARTIAL_SUBSETS.push(subset);
  }

  it('generates exactly 30 partial subsets', () => {
    expect(PARTIAL_SUBSETS).toHaveLength(30);
  });

  for (const presentFields of PARTIAL_SUBSETS) {
    const label = presentFields.length > 0 ? presentFields.join('+') : '(none)';
    it(`partial state [${label}] fails closed with PartialEncryptedRepresentationError, never returns plaintext`, async () => {
      const plaintext = 'plaintext-must-never-be-returned';
      const enc = fullyEncryptedFields(plaintext);
      const row: Record<string, unknown> = {
        id: ITEM_ROW_ID,
        user_id: 'user-1',
        access_token: plaintext, // deliberately retained — must never be fallen back to
        status: 'active',
      };
      for (const field of ENCRYPTED_FIELD_NAMES) {
        row[field] = presentFields.includes(field) ? enc[field] : null;
      }
      const query = createQueryBuilder({ data: row, error: null });
      mockFrom.mockReturnValueOnce(query);

      let thrown: unknown;
      try {
        await getPlaidItemForUser(ITEM_ROW_ID, 'user-1');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(PartialEncryptedRepresentationError);
      expect(thrown).not.toBe(plaintext);
    });
  }

  it('a null encryption version specifically (four fields present) fails closed the same way — the named regression for the removed `?? 1` coercion', async () => {
    const plaintext = 'plaintext-must-never-be-returned';
    const enc = fullyEncryptedFields(plaintext);
    const row = {
      id: ITEM_ROW_ID,
      user_id: 'user-1',
      access_token: plaintext,
      access_token_ciphertext: enc.access_token_ciphertext,
      access_token_nonce: enc.access_token_nonce,
      access_token_auth_tag: enc.access_token_auth_tag,
      access_token_key_id: enc.access_token_key_id,
      access_token_enc_version: null, // no more `?? 1` — this must fail, not silently default
      status: 'active',
    };
    const query = createQueryBuilder({ data: row, error: null });
    mockFrom.mockReturnValueOnce(query);

    await expect(getPlaidItemForUser(ITEM_ROW_ID, 'user-1')).rejects.toThrow(PartialEncryptedRepresentationError);
  });

  it('batch isolation holds for a partial row too — one partial item fails lazily without preventing a good item in the same batch from resolving', async () => {
    const plaintext = 'good-token';
    const goodRow = {
      id: 'row-good',
      user_id: 'user-1',
      access_token: null,
      ...fullyEncryptedFields(plaintext, 'row-good'),
      transactions_cursor: null,
      status: 'active',
    };
    const badPlaintext = 'partial-row-plaintext-must-never-be-returned';
    const badEnc = fullyEncryptedFields(badPlaintext, 'row-partial');
    const badRow = {
      id: 'row-partial',
      user_id: 'user-1',
      access_token: badPlaintext,
      access_token_ciphertext: badEnc.access_token_ciphertext,
      access_token_nonce: badEnc.access_token_nonce,
      access_token_auth_tag: null, // partial
      access_token_key_id: badEnc.access_token_key_id,
      access_token_enc_version: badEnc.access_token_enc_version,
      transactions_cursor: null,
      status: 'active',
    };
    const query = createQueryBuilder({ data: [badRow, goodRow], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getPlaidItemsForUser('user-1');

    expect(() => result[0].access_token).toThrow(PartialEncryptedRepresentationError);
    expect(result[1].access_token).toBe(plaintext);
  });
});

function fakeAccount(overrides: Partial<AccountBase> = {}): AccountBase {
  return {
    account_id: 'plaid-acc-1',
    name: 'Checking',
    official_name: null,
    type: 'depository' as AccountBase['type'],
    subtype: 'checking' as AccountBase['subtype'],
    mask: '1234',
    balances: { current: 100, available: 90, iso_currency_code: 'USD', limit: null, unofficial_currency_code: null },
    ...overrides,
  } as AccountBase;
}

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
});

describe('upsertAccountsForItem', () => {
  it('inserts accounts with no matching existing row, and updates ones that do', async () => {
    const existingQuery = createQueryBuilder({
      data: [{ id: 'row-existing', plaid_account_id: 'plaid-acc-existing' }],
      error: null,
    });
    const insertQuery = createQueryBuilder({ data: null, error: null });
    const updateQuery = createQueryBuilder({ data: null, error: null });
    const finalQuery = createQueryBuilder({ data: [], error: null });

    mockFrom
      .mockReturnValueOnce(existingQuery) // select existing
      .mockReturnValueOnce(insertQuery) // insert new
      .mockReturnValueOnce(updateQuery) // update existing
      .mockReturnValueOnce(finalQuery); // reload final rows

    const newAccount = fakeAccount({ account_id: 'plaid-acc-new' });
    const existingAccount = fakeAccount({ account_id: 'plaid-acc-existing', name: 'Renamed' });

    await upsertAccountsForItem('item-row-1', [newAccount, existingAccount]);

    // The new account goes through insert(), tagged with item_id, no id field.
    const insertedRows = insertQuery.insert.mock.calls[0][0] as Record<string, unknown>[];
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({ item_id: 'item-row-1', plaid_account_id: 'plaid-acc-new' });

    // The existing account goes through update(), targeted at its known row id, not inserted.
    expect(updateQuery.update.mock.calls[0][0]).toMatchObject({ name: 'Renamed' });
    expect(updateQuery.eq).toHaveBeenCalledWith('id', 'row-existing');
  });

  it('skips the insert call entirely when every account already exists', async () => {
    const existingQuery = createQueryBuilder({
      data: [{ id: 'row-1', plaid_account_id: 'plaid-acc-1' }],
      error: null,
    });
    const updateQuery = createQueryBuilder({ data: null, error: null });
    const finalQuery = createQueryBuilder({ data: [], error: null });

    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(updateQuery).mockReturnValueOnce(finalQuery);

    await upsertAccountsForItem('item-row-1', [fakeAccount({ account_id: 'plaid-acc-1' })]);

    // Only 3 .from() calls total (select, update, reload) — no insert() call was made.
    expect(mockFrom).toHaveBeenCalledTimes(3);
  });

  it('throws with a descriptive message when Supabase reports an error', async () => {
    const existingQuery = createQueryBuilder({ data: null, error: { message: 'connection refused' } });
    mockFrom.mockReturnValueOnce(existingQuery);

    await expect(upsertAccountsForItem('item-row-1', [fakeAccount()])).rejects.toThrow(
      /Failed to load existing accounts: connection refused/
    );
  });
});

describe('applyTransactionChanges', () => {
  const accountIdByPlaidId = new Map([['plaid-acc-1', 'account-row-1']]);

  function fakeTransaction(overrides: Partial<PlaidTransaction> = {}): PlaidTransaction {
    return {
      transaction_id: 'txn-1',
      account_id: 'plaid-acc-1',
      amount: 12.5,
      iso_currency_code: 'USD',
      date: '2026-08-15',
      name: 'Coffee Shop',
      merchant_name: 'Coffee Shop',
      pending: false,
      category: ['Food and Drink', 'Coffee'],
      personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'COFFEE', confidence_level: 'HIGH' },
      ...overrides,
    } as PlaidTransaction;
  }

  const fakeRemoved: RemovedTransaction = { transaction_id: 'txn-removed' } as RemovedTransaction;

  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: [], error: null });
  });

  it('inserts added transactions that map to a known account, and returns the inserted rows', async () => {
    const existingQuery = createQueryBuilder({ data: [], error: null });
    const mappingsQuery = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(mappingsQuery);
    const insertedRow = { id: 'txn-row-new', name: 'Coffee Shop', merchant_name: 'Coffee Shop', amount: 12.5 };
    mockRpc.mockResolvedValueOnce({ data: [insertedRow], error: null });

    const result = await applyTransactionChanges({
      userId: 'user-1',
      added: [fakeTransaction()],
      modified: [],
      removed: [],
      accountIdByPlaidId,
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'apply_synced_transaction_batch',
      expect.objectContaining({
        p_user_id: 'user-1',
        p_inserts: expect.arrayContaining([
          expect.objectContaining({
            account_id: 'account-row-1',
            plaid_transaction_id: 'txn-1',
            category: 'FOOD_AND_DRINK',
            personal_finance_category_detailed: 'COFFEE',
            personal_finance_category_confidence: 'HIGH',
            plaid_category: 'Food and Drink > Coffee',
            // Row-level classification (Financial Semantics Foundation Phase A) runs at insert
            // time — an ordinary FOOD_AND_DRINK purchase falls all the way to the sign-based
            // fallback.
            auto_role: 'expense',
            role_source: 'sign_default',
            role_confidence: 'low',
            classifier_version: 1,
          }),
        ]),
        p_updates: [],
      })
    );
    expect(result).toEqual({
      insertedTransactions: [insertedRow],
      touchedTransactionIds: [insertedRow.id],
    });
  });

  it("auto-assigns budget_category_id from a matching category mapping when inserting", async () => {
    const existingQuery = createQueryBuilder({ data: [], error: null });
    const mappingsQuery = createQueryBuilder({
      data: [
        {
          id: 'map-1',
          user_id: 'user-1',
          plaid_category: 'FOOD_AND_DRINK',
          budget_category_id: 'cat-dining',
          created_at: '2026-01-01',
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(mappingsQuery);
    const insertedRow = { id: 'txn-row-new', name: 'Coffee Shop', merchant_name: 'Coffee Shop', amount: 12.5 };
    mockRpc.mockResolvedValueOnce({ data: [insertedRow], error: null });

    await applyTransactionChanges({
      userId: 'user-1',
      added: [fakeTransaction()],
      modified: [],
      removed: [],
      accountIdByPlaidId,
    });

    const [, callArgs] = mockRpc.mock.calls[0];
    const inserted = (callArgs as { p_inserts: Record<string, unknown>[] }).p_inserts;
    expect(inserted[0]).toMatchObject({ category: 'FOOD_AND_DRINK', budget_category_id: 'cat-dining' });
  });

  it("leaves budget_category_id null when no mapping matches the transaction's category", async () => {
    const existingQuery = createQueryBuilder({ data: [], error: null });
    const mappingsQuery = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(mappingsQuery);
    const insertedRow = { id: 'txn-row-new', name: 'Coffee Shop', merchant_name: 'Coffee Shop', amount: 12.5 };
    mockRpc.mockResolvedValueOnce({ data: [insertedRow], error: null });

    await applyTransactionChanges({
      userId: 'user-1',
      added: [fakeTransaction()],
      modified: [],
      removed: [],
      accountIdByPlaidId,
    });

    const [, callArgs] = mockRpc.mock.calls[0];
    const inserted = (callArgs as { p_inserts: Record<string, unknown>[] }).p_inserts;
    expect(inserted[0].budget_category_id).toBeNull();
  });

  it('silently skips a transaction whose account is not in our accountIdByPlaidId map', async () => {
    // No known local account for this transaction (e.g. account not yet synced) — should be
    // dropped rather than inserted with a broken account_id.
    const result = await applyTransactionChanges({
      userId: 'user-1',
      added: [fakeTransaction({ account_id: 'unknown-plaid-account' })],
      modified: [],
      removed: [],
      accountIdByPlaidId,
    });

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(result).toEqual({ insertedTransactions: [], touchedTransactionIds: [] });
  });

  it('updates (not inserts) a transaction whose plaid_transaction_id already exists, and reclassifies since its category changed from what was stored, via the SAME locked batch RPC (Round 8 remediation)', async () => {
    const existingQuery = createQueryBuilder({
      data: [
        {
          id: 'txn-row-1',
          plaid_transaction_id: 'txn-1',
          category: 'GENERAL_MERCHANDISE',
          personal_finance_category_detailed: null,
          personal_finance_category_confidence: null,
          manual_loan_id: null,
          auto_role: 'expense',
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery);

    const result = await applyTransactionChanges({
      userId: 'user-1',
      added: [],
      modified: [fakeTransaction({ pending: true })],
      removed: [],
      accountIdByPlaidId,
    });

    // The incoming category (FOOD_AND_DRINK, from fakeTransaction) differs from what was stored
    // (GENERAL_MERCHANDISE) — the stored category signal materially changed, so this reclassifies.
    const [, callArgs] = mockRpc.mock.calls[0];
    const updates = (callArgs as { p_updates: Record<string, unknown>[] }).p_updates;
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: 'txn-row-1',
      pending: true,
      auto_role: 'expense',
      role_source: 'sign_default',
      role_confidence: 'low',
      classifier_version: 1,
    });
    // Only the existence-check select happened on the table — no separate insert call, and no
    // category-mapping lookup either (that only runs when there's something to insert); the
    // actual write is the ONE apply_synced_transaction_batch RPC call.
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(result.touchedTransactionIds).toEqual(['txn-row-1']);
  });

  it('Round 10 remediation (blocker 3): every update row carries the exp_* snapshot of the state it was classified against, so the RPC can compare-and-swap under its lock', async () => {
    const existingQuery = createQueryBuilder({
      data: [
        {
          id: 'txn-row-1',
          plaid_transaction_id: 'txn-1',
          account_id: 'account-row-1',
          amount: 99.99,
          date: '2026-08-01',
          name: 'Old Name',
          merchant_name: 'Old Merchant',
          category: 'GENERAL_MERCHANDISE',
          personal_finance_category_detailed: 'OLD_DETAIL',
          personal_finance_category_confidence: 'LOW',
          manual_loan_id: null,
          auto_role: 'expense',
          principal_portion: null,
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery);

    await applyTransactionChanges({
      userId: 'user-1',
      added: [],
      modified: [fakeTransaction()],
      removed: [],
      accountIdByPlaidId,
    });

    const [, callArgs] = mockRpc.mock.calls[0];
    const updates = (callArgs as { p_updates: Record<string, unknown>[] }).p_updates;
    // Each exp_* value is the STORED value the classification decision read — never the incoming
    // Plaid value — because that is what the database must still find under the lock for the
    // decision to still be valid.
    expect(updates[0]).toMatchObject({
      id: 'txn-row-1',
      exp_account_id: 'account-row-1',
      exp_amount: 99.99,
      exp_date: '2026-08-01',
      exp_name: 'Old Name',
      exp_merchant_name: 'Old Merchant',
      exp_category: 'GENERAL_MERCHANDISE',
      exp_pfc_detailed: 'OLD_DETAIL',
      exp_pfc_confidence: 'LOW',
      exp_manual_loan_id: null,
      exp_auto_role: 'expense',
      exp_principal_portion: null,
    });
  });

  it('Round 10 remediation (blocker 3): a row read as loan-linked echoes back its manual_loan_id and principal_portion, so a concurrent unlink cannot go unnoticed', async () => {
    const existingQuery = createQueryBuilder({
      data: [
        {
          id: 'txn-row-1',
          plaid_transaction_id: 'txn-1',
          account_id: 'account-row-1',
          amount: 12.5,
          date: '2026-08-15',
          name: 'Coffee Shop',
          merchant_name: 'Coffee Shop',
          category: 'FOOD_AND_DRINK',
          personal_finance_category_detailed: 'COFFEE',
          personal_finance_category_confidence: 'HIGH',
          manual_loan_id: 'loan-9',
          auto_role: 'debt_payment',
          principal_portion: 10,
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery);

    await applyTransactionChanges({
      userId: 'user-1',
      added: [],
      modified: [fakeTransaction()],
      removed: [],
      accountIdByPlaidId,
    });

    const [, callArgs] = mockRpc.mock.calls[0];
    const updates = (callArgs as { p_updates: Record<string, unknown>[] }).p_updates;
    expect(updates[0]).toMatchObject({
      exp_manual_loan_id: 'loan-9',
      exp_principal_portion: 10,
      exp_auto_role: 'debt_payment',
    });
    // A loan-linked row still must not have its role fields churned by an ordinary resync.
    expect(updates[0]).toMatchObject({ auto_role: null, role_source: null });
  });

  it("an ordinary resync with EVERY semantic input unchanged (account/amount/date/name/merchant/category/detailed/confidence) does not churn the already-stored role fields (sent as JSON null, COALESCEd server-side)", async () => {
    const existingQuery = createQueryBuilder({
      data: [
        {
          id: 'txn-row-1',
          plaid_transaction_id: 'txn-1',
          account_id: 'account-row-1',
          amount: 12.5,
          date: '2026-08-15',
          name: 'Coffee Shop',
          merchant_name: 'Coffee Shop',
          category: 'FOOD_AND_DRINK',
          personal_finance_category_detailed: 'COFFEE',
          personal_finance_category_confidence: 'HIGH',
          manual_loan_id: null,
          auto_role: 'expense',
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery);

    await applyTransactionChanges({
      userId: 'user-1',
      added: [],
      // Identical to what's stored in every semantic-input field — only `pending` differs.
      modified: [fakeTransaction({ pending: true })],
      removed: [],
      accountIdByPlaidId,
    });

    const [, callArgs] = mockRpc.mock.calls[0];
    const updatedFields = (callArgs as { p_updates: Record<string, unknown>[] }).p_updates[0];
    expect(updatedFields.auto_role).toBeNull();
    expect(updatedFields.role_source).toBeNull();
    expect(updatedFields.role_confidence).toBeNull();
    expect(updatedFields.classifier_version).toBeNull();
  });

  it.each([
    ['amount', { amount: 999 }],
    ['date', { date: '2026-09-01' }],
    ['name', { name: 'Totally Different Merchant' }],
    ['merchant_name', { merchant_name: 'Totally Different Merchant' }],
    ['account (via a different plaid account_id)', { account_id: 'plaid-acc-2' }],
  ])('a resync where %s materially changed DOES reclassify', async (_label, overrides) => {
    const existingQuery = createQueryBuilder({
      data: [
        {
          id: 'txn-row-1',
          plaid_transaction_id: 'txn-1',
          account_id: 'account-row-1',
          amount: 12.5,
          date: '2026-08-15',
          name: 'Coffee Shop',
          merchant_name: 'Coffee Shop',
          category: 'FOOD_AND_DRINK',
          personal_finance_category_detailed: 'COFFEE',
          personal_finance_category_confidence: 'HIGH',
          manual_loan_id: null,
          auto_role: 'expense',
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery);
    const accountIdByPlaidIdWithSecond = new Map([...accountIdByPlaidId, ['plaid-acc-2', 'account-row-2']]);

    await applyTransactionChanges({
      userId: 'user-1',
      added: [],
      modified: [fakeTransaction(overrides)],
      removed: [],
      accountIdByPlaidId: accountIdByPlaidIdWithSecond,
    });

    const [, callArgs] = mockRpc.mock.calls[0];
    const updatedFields = (callArgs as { p_updates: Record<string, unknown>[] }).p_updates[0];
    expect(updatedFields.auto_role).not.toBeNull();
  });

  it('a row classified for the very first time (auto_role was null) is reclassified', async () => {
    const existingQuery = createQueryBuilder({
      data: [
        {
          id: 'txn-row-1',
          plaid_transaction_id: 'txn-1',
          account_id: 'account-row-1',
          amount: 12.5,
          date: '2026-08-15',
          name: 'Coffee Shop',
          merchant_name: 'Coffee Shop',
          category: 'FOOD_AND_DRINK',
          personal_finance_category_detailed: 'COFFEE',
          personal_finance_category_confidence: 'HIGH',
          manual_loan_id: null,
          auto_role: null,
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery);

    await applyTransactionChanges({
      userId: 'user-1',
      added: [],
      modified: [fakeTransaction({ pending: true })], // identical semantic inputs, just never classified before
      removed: [],
      accountIdByPlaidId,
    });

    const [, callArgs] = mockRpc.mock.calls[0];
    const updatedFields = (callArgs as { p_updates: Record<string, unknown>[] }).p_updates[0];
    expect(updatedFields.auto_role).not.toBeNull();
  });

  it('a transaction already linked to a manual loan is never reclassified by an ordinary resync, regardless of category drift', async () => {
    const existingQuery = createQueryBuilder({
      data: [
        {
          id: 'txn-row-1',
          plaid_transaction_id: 'txn-1',
          category: 'GENERAL_MERCHANDISE',
          personal_finance_category_detailed: null,
          personal_finance_category_confidence: null,
          manual_loan_id: 'loan-1',
          auto_role: 'debt_payment',
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery);

    await applyTransactionChanges({
      userId: 'user-1',
      added: [],
      modified: [fakeTransaction({ pending: true })], // incoming category differs, but the loan link governs
      removed: [],
      accountIdByPlaidId,
    });

    const [, callArgs] = mockRpc.mock.calls[0];
    const updatedFields = (callArgs as { p_updates: Record<string, unknown>[] }).p_updates[0];
    expect(updatedFields.auto_role).toBeNull();
  });

  describe('principal integrity on Plaid resync of a manual-loan-linked transaction (Round 3 remediation §8)', () => {
    it('rejects (throws, does not persist) a resynced amount that no longer covers the stored principal_portion, before any write for this row', async () => {
      const existingQuery = createQueryBuilder({
        data: [
          {
            id: 'txn-row-1',
            plaid_transaction_id: 'txn-1',
            account_id: 'account-row-1',
            amount: 100,
            date: '2026-08-15',
            name: 'Loan Servicer',
            merchant_name: 'Loan Servicer',
            category: 'LOAN_PAYMENTS',
            personal_finance_category_detailed: null,
            personal_finance_category_confidence: null,
            manual_loan_id: 'loan-1',
            auto_role: 'debt_payment',
            principal_portion: 80, // stored principal — fine against the OLD $100 amount
          },
        ],
        error: null,
      });
      mockFrom.mockReturnValueOnce(existingQuery);

      // Plaid resync drops the amount to $50 — the stored $80 principal is no longer valid.
      await expect(
        applyTransactionChanges({
          userId: 'user-1',
          added: [],
          modified: [fakeTransaction({ amount: 50 })],
          removed: [],
          accountIdByPlaidId,
        })
      ).rejects.toThrow(/incompatible/i);

      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('allows a resynced amount that still covers the stored principal_portion', async () => {
      const existingQuery = createQueryBuilder({
        data: [
          {
            id: 'txn-row-1',
            plaid_transaction_id: 'txn-1',
            account_id: 'account-row-1',
            amount: 100,
            date: '2026-08-15',
            name: 'Loan Servicer',
            merchant_name: 'Loan Servicer',
            category: 'LOAN_PAYMENTS',
            personal_finance_category_detailed: null,
            personal_finance_category_confidence: null,
            manual_loan_id: 'loan-1',
            auto_role: 'debt_payment',
            principal_portion: 80,
          },
        ],
        error: null,
      });
      mockFrom.mockReturnValueOnce(existingQuery);

      await expect(
        applyTransactionChanges({
          userId: 'user-1',
          added: [],
          modified: [fakeTransaction({ amount: 120 })], // still comfortably covers the $80 principal
          removed: [],
          accountIdByPlaidId,
        })
      ).resolves.toBeDefined();

      expect(mockRpc).toHaveBeenCalledWith('apply_synced_transaction_batch', expect.anything());
    });
  });

  it('deletes removed transactions via the atomic delete-and-restore-balances RPC (Round 6 remediation, blocker 4)', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    await applyTransactionChanges({
      userId: 'user-1',
      added: [],
      modified: [],
      removed: [fakeRemoved],
      accountIdByPlaidId,
    });

    expect(mockRpc).toHaveBeenCalledWith('delete_transactions_and_restore_loan_balances', {
      p_user_id: 'user-1',
      p_plaid_transaction_ids: ['txn-removed'],
    });
  });

  it('propagates a failure from the removal RPC', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    await expect(
      applyTransactionChanges({ userId: 'user-1', added: [], modified: [], removed: [fakeRemoved], accountIdByPlaidId })
    ).rejects.toThrow('Failed to delete removed transactions');
  });

  it('does nothing when there are no changes at all', async () => {
    await applyTransactionChanges({ userId: 'user-1', added: [], modified: [], removed: [], accountIdByPlaidId });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('getCategorySpendRows', () => {
  const range = { start: '2026-08-01', end: '2026-09-01' };

  it("uses a transaction's own budget_category_id/amount when it has no splits", async () => {
    const transactionsQuery = createQueryBuilder({
      data: [{ id: 'txn-1', budget_category_id: 'cat-a', amount: 25 }],
      error: null,
    });
    const splitsQuery = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(transactionsQuery).mockReturnValueOnce(splitsQuery);

    const result = await getCategorySpendRows('user-1', range);

    expect(result).toEqual([{ budget_category_id: 'cat-a', amount: 25 }]);
  });

  it('substitutes split rows for a split transaction, dropping its own row entirely', async () => {
    const transactionsQuery = createQueryBuilder({
      data: [
        { id: 'txn-1', budget_category_id: 'cat-a', amount: 50 },
        { id: 'txn-2', budget_category_id: 'cat-b', amount: 10 },
      ],
      error: null,
    });
    const splitsQuery = createQueryBuilder({
      data: [
        { transaction_id: 'txn-1', budget_category_id: 'cat-dining', amount: 30 },
        { transaction_id: 'txn-1', budget_category_id: 'cat-groceries', amount: 20 },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(transactionsQuery).mockReturnValueOnce(splitsQuery);

    const result = await getCategorySpendRows('user-1', range);

    // txn-1's own row (cat-a, 50) is gone — its two split rows stand in for it instead.
    // txn-2 has no splits, so it comes through unchanged.
    expect(result).toEqual(
      expect.arrayContaining([
        { budget_category_id: 'cat-dining', amount: 30 },
        { budget_category_id: 'cat-groceries', amount: 20 },
        { budget_category_id: 'cat-b', amount: 10 },
      ])
    );
    expect(result).toHaveLength(3);
  });
});

describe('setTransactionSplits', () => {
  it('replaces existing splits when the new splits sum to the transaction amount', async () => {
    const fetchQuery = createQueryBuilder({
      data: { amount: 50, accounts: { plaid_items: { user_id: 'user-1' } } },
      error: null,
    });
    const deleteQuery = createQueryBuilder({ data: null, error: null });
    const insertedSplits = [
      { id: 'split-1', transaction_id: 'txn-1', budget_category_id: 'cat-dining', amount: 30, note: null },
      { id: 'split-2', transaction_id: 'txn-1', budget_category_id: 'cat-groceries', amount: 20, note: null },
    ];
    const insertQuery = createQueryBuilder({ data: insertedSplits, error: null });
    mockFrom.mockReturnValueOnce(fetchQuery).mockReturnValueOnce(deleteQuery).mockReturnValueOnce(insertQuery);

    const result = await setTransactionSplits('txn-1', 'user-1', [
      { budgetCategoryId: 'cat-dining', amount: 30, note: null },
      { budgetCategoryId: 'cat-groceries', amount: 20, note: null },
    ]);

    expect(deleteQuery.delete).toHaveBeenCalled();
    expect(deleteQuery.eq).toHaveBeenCalledWith('transaction_id', 'txn-1');
    expect(insertQuery.insert.mock.calls[0][0]).toEqual([
      { transaction_id: 'txn-1', budget_category_id: 'cat-dining', amount: 30, note: null },
      { transaction_id: 'txn-1', budget_category_id: 'cat-groceries', amount: 20, note: null },
    ]);
    expect(result).toEqual(insertedSplits);
  });

  it("rejects splits that don't sum to the transaction's amount", async () => {
    const fetchQuery = createQueryBuilder({
      data: { amount: 50, accounts: { plaid_items: { user_id: 'user-1' } } },
      error: null,
    });
    mockFrom.mockReturnValueOnce(fetchQuery);

    await expect(
      setTransactionSplits('txn-1', 'user-1', [{ budgetCategoryId: 'cat-dining', amount: 30, note: null }])
    ).rejects.toThrow(/must add up to the transaction's amount \(50\.00\)/);

    // Rejected before ever touching the splits table.
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it("rejects when the transaction doesn't belong to the requesting user", async () => {
    const fetchQuery = createQueryBuilder({
      data: { amount: 50, accounts: { plaid_items: { user_id: 'someone-else' } } },
      error: null,
    });
    mockFrom.mockReturnValueOnce(fetchQuery);

    await expect(
      setTransactionSplits('txn-1', 'user-1', [{ budgetCategoryId: 'cat-dining', amount: 50, note: null }])
    ).rejects.toThrow('Transaction not found');
  });
});

describe('clearTransactionSplits', () => {
  it('deletes all splits for the transaction once ownership is confirmed', async () => {
    const ownerQuery = createQueryBuilder({
      data: { id: 'txn-1', accounts: { plaid_items: { user_id: 'user-1' } } },
      error: null,
    });
    const deleteQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(ownerQuery).mockReturnValueOnce(deleteQuery);

    await clearTransactionSplits('txn-1', 'user-1');

    expect(deleteQuery.delete).toHaveBeenCalled();
    expect(deleteQuery.eq).toHaveBeenCalledWith('transaction_id', 'txn-1');
  });

  it("rejects when the transaction doesn't belong to the requesting user", async () => {
    const ownerQuery = createQueryBuilder({
      data: { id: 'txn-1', accounts: { plaid_items: { user_id: 'someone-else' } } },
      error: null,
    });
    mockFrom.mockReturnValueOnce(ownerQuery);

    await expect(clearTransactionSplits('txn-1', 'user-1')).rejects.toThrow('Transaction not found');
  });
});

describe('linkTransactionToLoan — atomic link + balance decrement (Round 6 remediation, blocker 4)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: 'linked', error: null });
  });

  it('validates against the transaction amount, then calls the atomic RPC with the normalized principal', async () => {
    const txnFetchQuery = createQueryBuilder({ data: { amount: 500 }, error: null });
    mockFrom.mockReturnValueOnce(txnFetchQuery);

    await expect(linkTransactionToLoan('user-1', 'txn-1', 'loan-1', 200)).resolves.toBe('linked');

    expect(mockRpc).toHaveBeenCalledWith('link_transaction_to_manual_loan', {
      p_user_id: 'user-1',
      p_transaction_id: 'txn-1',
      p_loan_id: 'loan-1',
      p_principal_portion: 200,
      p_classifier_version: 1,
    });
  });

  it('cent-rounds the principal before calling the RPC', async () => {
    const txnFetchQuery = createQueryBuilder({ data: { amount: 500 }, error: null });
    mockFrom.mockReturnValueOnce(txnFetchQuery);

    await linkTransactionToLoan('user-1', 'txn-1', 'loan-1', 33.333);

    expect(mockRpc).toHaveBeenCalledWith(
      'link_transaction_to_manual_loan',
      expect.objectContaining({ p_principal_portion: 33.33 })
    );
  });

  it('rejects (throws, never calls the RPC) a principal_portion greater than the transaction amount (Round 2 remediation §7)', async () => {
    const txnFetchQuery = createQueryBuilder({ data: { amount: 100 }, error: null });
    mockFrom.mockReturnValueOnce(txnFetchQuery);

    await expect(linkTransactionToLoan('user-1', 'txn-1', 'loan-1', 150)).rejects.toThrow();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects a negative principal_portion', async () => {
    const txnFetchQuery = createQueryBuilder({ data: { amount: 100 }, error: null });
    mockFrom.mockReturnValueOnce(txnFetchQuery);

    await expect(linkTransactionToLoan('user-1', 'txn-1', 'loan-1', -10)).rejects.toThrow();
  });

  it('rejects a non-finite principal_portion', async () => {
    const txnFetchQuery = createQueryBuilder({ data: { amount: 100 }, error: null });
    mockFrom.mockReturnValueOnce(txnFetchQuery);

    await expect(linkTransactionToLoan('user-1', 'txn-1', 'loan-1', NaN)).rejects.toThrow();
  });

  it('propagates an RPC failure (e.g. ownership mismatch) rather than silently succeeding', async () => {
    const txnFetchQuery = createQueryBuilder({ data: { amount: 500 }, error: null });
    mockFrom.mockReturnValueOnce(txnFetchQuery);
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'not found or not owned' } });

    await expect(linkTransactionToLoan('user-1', 'txn-1', 'loan-1', 200)).rejects.toThrow('Failed to link transaction to loan');
  });

  it.each(['already_linked', 'already_linked_different_principal', 'linked_to_other_loan'])(
    "returns the RPC's no-write outcome %s as-is (post-audit blocker 1)",
    async (outcome) => {
      mockFrom.mockReturnValueOnce(createQueryBuilder({ data: { amount: 500 }, error: null }));
      mockRpc.mockResolvedValueOnce({ data: outcome, error: null });

      await expect(linkTransactionToLoan('user-1', 'txn-1', 'loan-1', 200)).resolves.toBe(outcome);
    }
  );

  it.each([
    ['null (the pre-repair function returns void)', null],
    ['an unknown string', 'relinked'],
    ['a differently-cased outcome', 'Linked'],
    ['a non-string', true],
  ])('rejects %s rather than treating it as success', async (_label, data) => {
    mockFrom.mockReturnValueOnce(createQueryBuilder({ data: { amount: 500 }, error: null }));
    mockRpc.mockResolvedValueOnce({ data, error: null });

    await expect(linkTransactionToLoan('user-1', 'txn-1', 'loan-1', 200)).rejects.toThrow(
      'Failed to link transaction to loan: unexpected outcome from link_transaction_to_manual_loan'
    );
  });
});

describe('updateLinkedPaymentPrincipal — atomic principal edit + balance sync (Round 6 remediation, blocker 4)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  it('validates ownership/linkage and the amount bound, then calls the atomic RPC', async () => {
    const fetchQuery = createQueryBuilder({ data: { manual_loan_id: 'loan-1', amount: 500 }, error: null });
    mockFrom.mockReturnValueOnce(fetchQuery);

    await updateLinkedPaymentPrincipal('user-1', 'txn-1', 'loan-1', 150);

    expect(mockRpc).toHaveBeenCalledWith('update_linked_payment_principal', {
      p_user_id: 'user-1',
      p_transaction_id: 'txn-1',
      p_loan_id: 'loan-1',
      p_new_principal_portion: 150,
    });
  });

  it('throws when the transaction is not linked to the given loan, never calling the RPC', async () => {
    const fetchQuery = createQueryBuilder({ data: { manual_loan_id: 'some-other-loan', amount: 500 }, error: null });
    mockFrom.mockReturnValueOnce(fetchQuery);

    await expect(updateLinkedPaymentPrincipal('user-1', 'txn-1', 'loan-1', 150)).rejects.toThrow(
      'Payment is not linked to this loan'
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects a new principal_portion greater than the transaction amount (Round 2 remediation §7)', async () => {
    const fetchQuery = createQueryBuilder({ data: { manual_loan_id: 'loan-1', amount: 200 }, error: null });
    mockFrom.mockReturnValueOnce(fetchQuery);

    await expect(updateLinkedPaymentPrincipal('user-1', 'txn-1', 'loan-1', 250)).rejects.toThrow();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('unlinkPaymentFromLoan — atomic unlink + balance restoration (Round 6 remediation, blocker 4)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('reclassifies via row-level precedence and calls the atomic unlink RPC', async () => {
    const fetchQuery = createQueryBuilder({
      data: {
        manual_loan_id: 'loan-1',
        amount: 200,
        category: null,
        personal_finance_category_detailed: null,
        personal_finance_category_confidence: null,
      },
      error: null,
    });
    mockFrom.mockReturnValueOnce(fetchQuery);
    mockRpc.mockResolvedValueOnce({ data: true, error: null });

    const result = await unlinkPaymentFromLoan('user-1', 'txn-1', 'loan-1');

    expect(mockRpc).toHaveBeenCalledWith('unlink_transaction_from_manual_loan', {
      p_user_id: 'user-1',
      p_transaction_id: 'txn-1',
      p_loan_id: 'loan-1',
      p_auto_role: 'expense',
      p_role_source: 'sign_default',
      p_role_confidence: 'low',
      p_classifier_version: 1,
    });
    expect(result).toBe(true);
  });

  it('is idempotent: returns false (not an error) when the transaction is ALREADY unlinked, and never calls the RPC at all (Round 4 remediation §7)', async () => {
    const fetchQuery = createQueryBuilder({
      data: { manual_loan_id: null, amount: 200, category: null, personal_finance_category_detailed: null, personal_finance_category_confidence: null },
      error: null,
    });
    mockFrom.mockReturnValueOnce(fetchQuery);

    const result = await unlinkPaymentFromLoan('user-1', 'txn-1', 'loan-1');

    expect(result).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('still throws for a genuine mismatch — linked to a DIFFERENT loan than the one named in the request', async () => {
    const fetchQuery = createQueryBuilder({
      data: { manual_loan_id: 'loan-OTHER', amount: 200, category: null, personal_finance_category_detailed: null, personal_finance_category_confidence: null },
      error: null,
    });
    mockFrom.mockReturnValueOnce(fetchQuery);

    await expect(unlinkPaymentFromLoan('user-1', 'txn-1', 'loan-1')).rejects.toThrow('Payment is not linked to this loan');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('throws when the transaction does not exist at all', async () => {
    const fetchQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(fetchQuery);

    await expect(unlinkPaymentFromLoan('user-1', 'txn-missing', 'loan-1')).rejects.toThrow('Payment not found');
  });

  it('propagates an RPC failure', async () => {
    const fetchQuery = createQueryBuilder({
      data: { manual_loan_id: 'loan-1', amount: 200, category: null, personal_finance_category_detailed: null, personal_finance_category_confidence: null },
      error: null,
    });
    mockFrom.mockReturnValueOnce(fetchQuery);
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    await expect(unlinkPaymentFromLoan('user-1', 'txn-1', 'loan-1')).rejects.toThrow('Failed to unlink payment');
  });
});

describe('getLifetimeTotalsByLoanId', () => {
  it('combines linked-transaction and manual-payment totals per loan', async () => {
    const txnQuery = createQueryBuilder({
      data: [
        { manual_loan_id: 'loan-1', amount: 500, principal_portion: 450 },
        { manual_loan_id: 'loan-1', amount: 300, principal_portion: 300 },
        { manual_loan_id: 'loan-2', amount: 100, principal_portion: 100 },
      ],
      error: null,
    });
    const manualQuery = createQueryBuilder({
      data: [{ loan_id: 'loan-1', principal_portion: 200, interest_portion: 20 }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(txnQuery).mockReturnValueOnce(manualQuery);

    const totals = await getLifetimeTotalsByLoanId(['loan-1', 'loan-2']);

    // loan-1: principal 450+300+200=950, interest (500-450)+(300-300)+20=70
    expect(totals.get('loan-1')).toEqual({ principalPaid: 950, interestPaid: 70 });
    // loan-2: principal 100, interest 0
    expect(totals.get('loan-2')).toEqual({ principalPaid: 100, interestPaid: 0 });
  });

  it('returns an empty map without querying when given no loan ids', async () => {
    const totals = await getLifetimeTotalsByLoanId([]);
    expect(totals.size).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('getUnlinkedTransactionsByPlaidIds (Round 6 remediation, blocker 5)', () => {
  it('scopes by user, filters to the given plaid ids, still-unlinked, and outflow-only', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await getUnlinkedTransactionsByPlaidIds('user-1', ['plaid-1', 'plaid-2']);

    expect(query.eq).toHaveBeenCalledWith('accounts.plaid_items.user_id', 'user-1');
    expect(query.in).toHaveBeenCalledWith('plaid_transaction_id', ['plaid-1', 'plaid-2']);
    expect(query.is).toHaveBeenCalledWith('manual_loan_id', null);
    expect(query.gt).toHaveBeenCalledWith('amount', 0);
  });

  it('returns an empty array without querying when given no plaid ids', async () => {
    const result = await getUnlinkedTransactionsByPlaidIds('user-1', []);
    expect(result).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('createManualLoan / updateManualLoan — numeric field validation (Round 5 remediation, blocker 7)', () => {
  const validParams = {
    name: 'Car Loan',
    loanType: 'personal',
    currentBalance: 15000,
    originationPrincipalAmount: 20000,
    interestRatePercentage: 6.5,
    originationDate: '2024-01-01',
    termMonths: 60,
    minimumPaymentAmount: 350,
    nextPaymentDueDate: '2026-10-01',
    notes: null,
    matchText: null,
  };

  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('accepts fully valid params', async () => {
    mockRpc.mockResolvedValueOnce({ data: 'loan-1', error: null });
    const refetchQuery = createQueryBuilder({ data: { id: 'loan-1', ...validParams }, error: null });
    mockFrom.mockReturnValueOnce(refetchQuery);

    await expect(createManualLoan('user-1', validParams, 'key-1')).resolves.toBeDefined();
  });

  it.each([
    ['negative current_balance', { currentBalance: -100 }],
    ['NaN current_balance', { currentBalance: NaN }],
    ['non-finite current_balance', { currentBalance: Infinity }],
    ['negative origination_principal_amount', { originationPrincipalAmount: -1 }],
    ['negative interest_rate_percentage', { interestRatePercentage: -0.5 }],
    ['NaN interest_rate_percentage', { interestRatePercentage: NaN }],
    ['negative minimum_payment_amount', { minimumPaymentAmount: -10 }],
    ['zero term_months', { termMonths: 0 }],
    ['negative term_months', { termMonths: -12 }],
    ['non-integer term_months', { termMonths: 36.5 }],
  ])('rejects %s and never touches the DB', async (_label, overrides) => {
    await expect(createManualLoan('user-1', { ...validParams, ...overrides }, 'key-1')).rejects.toThrow(
      InvalidManualLoanFieldError
    );
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a null nullable field (no origination data yet) is accepted, not validated as a number', async () => {
    const params = { ...validParams, originationPrincipalAmount: null, interestRatePercentage: null, termMonths: null, minimumPaymentAmount: null };
    mockRpc.mockResolvedValueOnce({ data: 'loan-1', error: null });
    const refetchQuery = createQueryBuilder({ data: { id: 'loan-1', ...params }, error: null });
    mockFrom.mockReturnValueOnce(refetchQuery);

    await expect(createManualLoan('user-1', params, 'key-1')).resolves.toBeDefined();
  });

  describe('createManualLoan idempotency-key contract (Round 8 remediation, replacing the Round 7 time-window heuristic)', () => {
    it('rejects a missing/empty idempotency key BEFORE calling the RPC', async () => {
      await expect(createManualLoan('user-1', validParams, '')).rejects.toThrow(ManualLoanCreationError);
      await expect(createManualLoan('user-1', validParams, '   ')).rejects.toThrow(ManualLoanCreationError);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('calls create_manual_loan_idempotent with every field plus the key, then re-fetches the resulting row', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'loan-1', error: null });
      const refetchQuery = createQueryBuilder({ data: { id: 'loan-1', ...validParams }, error: null });
      mockFrom.mockReturnValueOnce(refetchQuery);

      await createManualLoan('user-1', validParams, 'client-key-abc');

      expect(mockRpc).toHaveBeenCalledWith('create_manual_loan_idempotent', {
        p_user_id: 'user-1',
        p_idempotency_key: 'client-key-abc',
        p_name: validParams.name,
        p_loan_type: validParams.loanType,
        p_current_balance: validParams.currentBalance,
        p_origination_principal_amount: validParams.originationPrincipalAmount,
        p_interest_rate_percentage: validParams.interestRatePercentage,
        p_origination_date: validParams.originationDate,
        p_term_months: validParams.termMonths,
        p_minimum_payment_amount: validParams.minimumPaymentAmount,
        p_next_payment_due_date: validParams.nextPaymentDueDate,
        p_notes: validParams.notes,
        p_match_text: validParams.matchText,
      });
    });

    it('propagates an RPC failure as ManualLoanCreationError without ever re-fetching', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

      await expect(createManualLoan('user-1', validParams, 'key-1')).rejects.toThrow(ManualLoanCreationError);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('Round 12: reports a key that already created a since-deleted loan as ManualLoanCreationKeyResolvedError (a definitive outcome), not a generic failure', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'create_manual_loan_idempotent: idempotency_key key-1 was already used and the loan it created has since been deleted' },
      });

      await expect(createManualLoan('user-1', validParams, 'key-1')).rejects.toBeInstanceOf(ManualLoanCreationKeyResolvedError);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('Round 12: a key whose own TEXT merely contains the phrase is not mistaken for a resolved key', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'create_manual_loan_idempotent: idempotency_key has since been deleted was already used for a different request payload' },
      });

      const rejection = createManualLoan('user-1', validParams, 'has since been deleted');
      await expect(rejection).rejects.toBeInstanceOf(ManualLoanCreationError);
      await expect(rejection).rejects.not.toBeInstanceOf(ManualLoanCreationKeyResolvedError);
    });

    it('Round 9 remediation: propagates the RPC\'s fingerprint-conflict error (same idempotency key reused with a different payload) verbatim, not a silent replay', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'create_manual_loan_idempotent: idempotency_key key-1 was already used for a different request payload' },
      });

      await expect(createManualLoan('user-1', validParams, 'key-1')).rejects.toThrow(
        /idempotency_key key-1 was already used for a different request payload/,
      );
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('a replayed loan_id (delayed retry — the RPC itself has no time window) is simply re-fetched and returned like any other', async () => {
      // From this function's own point of view a "replay" and a "fresh create" look identical —
      // both are just "the RPC returned a loan_id, fetch and return that row" — the actual
      // dedup-vs-create decision (and the fact that it has no expiry) lives entirely inside
      // create_manual_loan_idempotent, verified separately against a real Postgres instance (see
      // this round's remediation report for the exact concurrent-request transcript).
      mockRpc.mockResolvedValueOnce({ data: 'loan-1-original', error: null });
      const refetchQuery = createQueryBuilder({ data: { id: 'loan-1-original', ...validParams }, error: null });
      mockFrom.mockReturnValueOnce(refetchQuery);

      const result = await createManualLoan('user-1', validParams, 'same-key-used-again');

      expect((result as { id: string }).id).toBe('loan-1-original');
    });
  });

  it('updateManualLoan rejects an invalid field before ever touching the DB', async () => {
    await expect(updateManualLoan('loan-1', 'user-1', { current_balance: -50 })).rejects.toThrow(InvalidManualLoanFieldError);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('updateManualLoan allows a partial patch that never touches numeric fields at all', async () => {
    const updateQuery = createQueryBuilder({ data: { id: 'loan-1', name: 'Renamed' }, error: null });
    mockFrom.mockReturnValueOnce(updateQuery);

    await expect(updateManualLoan('loan-1', 'user-1', { name: 'Renamed' })).resolves.toBeDefined();
  });

  it('updateManualLoan rejects a non-positive term_months in a partial patch', async () => {
    await expect(updateManualLoan('loan-1', 'user-1', { term_months: -1 })).rejects.toThrow(InvalidManualLoanFieldError);
  });
});

describe('deleteManualLoan — one atomic, locked, replay-safe RPC (Round 10 remediation, blocker 5)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockFrom.mockReset();
  });

  function linkedRowsQuery(rows: unknown[]) {
    return createQueryBuilder({ data: rows, error: null });
  }

  it('classifies every linked row and hands the whole deletion to delete_manual_loan_atomic in ONE call — no per-row unlink RPC, no separate delete query', async () => {
    mockFrom.mockReturnValueOnce(
      linkedRowsQuery([
        { id: 'txn-1', amount: 200, category: null, personal_finance_category_detailed: null, personal_finance_category_confidence: null },
        { id: 'txn-2', amount: -50, category: null, personal_finance_category_detailed: null, personal_finance_category_confidence: null },
      ])
    );
    mockRpc.mockResolvedValueOnce({
      data: { replayed: false, already_reconciled: false, affected_transaction_ids: ['txn-1', 'txn-2'] },
      error: null,
    });

    const result = await deleteManualLoan('loan-1', 'user-1');

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('delete_manual_loan_atomic', {
      p_user_id: 'user-1',
      p_loan_id: 'loan-1',
      // Round 11: each row also carries the classifier inputs it was classified from (exp_*), so the
      // RPC can reject the deletion if a concurrent sync changed them.
      p_reclassify: [
        {
          id: 'txn-1', auto_role: 'expense', role_source: 'sign_default', role_confidence: 'low', classifier_version: 1,
          exp_amount: 200, exp_category: null, exp_pfc_detailed: null, exp_pfc_confidence: null,
        },
        {
          id: 'txn-2', auto_role: 'income', role_source: 'sign_default', role_confidence: 'low', classifier_version: 1,
          exp_amount: -50, exp_category: null, exp_pfc_detailed: null, exp_pfc_confidence: null,
        },
      ],
    });
    // The loan delete happens inside the RPC — there must be no separate .delete() query at all,
    // which is what made the old implementation non-atomic.
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ affectedTransactionIds: ['txn-1', 'txn-2'], replayed: false, alreadyReconciled: false });
  });

  it('deletes cleanly with no linked transactions', async () => {
    mockFrom.mockReturnValueOnce(linkedRowsQuery([]));
    mockRpc.mockResolvedValueOnce({
      data: { replayed: false, already_reconciled: false, affected_transaction_ids: [] },
      error: null,
    });

    const result = await deleteManualLoan('loan-1', 'user-1');

    expect(result.affectedTransactionIds).toEqual([]);
    expect(mockRpc).toHaveBeenCalledWith('delete_manual_loan_atomic', expect.objectContaining({ p_reclassify: [] }));
  });

  it('surfaces a missing/foreign loan as ManualLoanNotFoundError so the controller can answer 404', async () => {
    mockFrom.mockReturnValueOnce(linkedRowsQuery([]));
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'delete_manual_loan_atomic: manual loan not found or not owned by user' },
    });

    await expect(deleteManualLoan('loan-1', 'user-1')).rejects.toBeInstanceOf(ManualLoanNotFoundError);
  });

  it('re-reads and retries when a concurrent link changes the linked set between classification and the lock', async () => {
    // First attempt classifies one row; a concurrent link lands; the RPC rejects the stale set.
    mockFrom.mockReturnValueOnce(
      linkedRowsQuery([{ id: 'txn-1', amount: 200, category: null, personal_finance_category_detailed: null, personal_finance_category_confidence: null }])
    );
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'delete_manual_loan_atomic: the set of transactions linked to this loan changed since they were classified (concurrent modification) — re-read and retry' },
    });
    // Second attempt sees both rows and succeeds.
    mockFrom.mockReturnValueOnce(
      linkedRowsQuery([
        { id: 'txn-1', amount: 200, category: null, personal_finance_category_detailed: null, personal_finance_category_confidence: null },
        { id: 'txn-2', amount: 300, category: null, personal_finance_category_detailed: null, personal_finance_category_confidence: null },
      ])
    );
    mockRpc.mockResolvedValueOnce({
      data: { replayed: false, already_reconciled: false, affected_transaction_ids: ['txn-1', 'txn-2'] },
      error: null,
    });

    const result = await deleteManualLoan('loan-1', 'user-1');

    expect(mockFrom).toHaveBeenCalledTimes(2); // genuinely re-read, not retried with the stale set
    expect(result.affectedTransactionIds).toEqual(['txn-1', 'txn-2']);
    expect(mockRpc.mock.calls[1][1]).toEqual(
      expect.objectContaining({ p_reclassify: [expect.objectContaining({ id: 'txn-1' }), expect.objectContaining({ id: 'txn-2' })] })
    );
  });

  it('gives up with a hard error if the linked set keeps changing, rather than retrying forever', async () => {
    for (let i = 0; i < 3; i++) {
      mockFrom.mockReturnValueOnce(linkedRowsQuery([]));
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'delete_manual_loan_atomic: the set of transactions linked to this loan changed since they were classified (concurrent modification) — re-read and retry' },
      });
    }

    await expect(deleteManualLoan('loan-1', 'user-1')).rejects.toThrow('Failed to delete manual loan');
    expect(mockRpc).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry an ordinary RPC failure — only a stale-set rejection is retryable', async () => {
    mockFrom.mockReturnValueOnce(linkedRowsQuery([]));
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });

    await expect(deleteManualLoan('loan-1', 'user-1')).rejects.toThrow('Failed to delete manual loan: connection reset');
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('replays an already-committed deletion (tombstone hit) with its recorded affected ids, so a reconciliation that failed after the commit can be retried', async () => {
    mockFrom.mockReturnValueOnce(linkedRowsQuery([]));
    mockRpc.mockResolvedValueOnce({
      data: { replayed: true, already_reconciled: false, affected_transaction_ids: ['txn-1', 'txn-2'] },
      error: null,
    });

    const result = await deleteManualLoan('loan-1', 'user-1');

    expect(result).toEqual({ affectedTransactionIds: ['txn-1', 'txn-2'], replayed: true, alreadyReconciled: false });
  });

  it('reports an already-reconciled replay so the caller can skip redundant reconciliation', async () => {
    mockFrom.mockReturnValueOnce(linkedRowsQuery([]));
    mockRpc.mockResolvedValueOnce({
      data: { replayed: true, already_reconciled: true, affected_transaction_ids: ['txn-1'] },
      error: null,
    });

    const result = await deleteManualLoan('loan-1', 'user-1');

    expect(result.alreadyReconciled).toBe(true);
  });
});

describe('markManualLoanDeletionReconciled (Round 10 remediation, blocker 5)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('marks the tombstone via the RPC', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    await markManualLoanDeletionReconciled('loan-1', 'user-1');

    expect(mockRpc).toHaveBeenCalledWith('mark_manual_loan_deletion_reconciled', {
      p_user_id: 'user-1',
      p_loan_id: 'loan-1',
    });
  });

  it('propagates a failure so the deletion stays unmarked and a retry re-runs reconciliation', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    await expect(markManualLoanDeletionReconciled('loan-1', 'user-1')).rejects.toThrow(
      'Failed to mark manual loan deletion reconciled'
    );
  });
});

describe('createManualLoanPayment — atomic insert + balance decrement (Round 6 remediation, blocker 4)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('calls the atomic create RPC with the normalized fields, then re-fetches the created row', async () => {
    mockRpc.mockResolvedValueOnce({ data: 'payment-1', error: null });
    const refetchQuery = createQueryBuilder({ data: { id: 'payment-1', principal_portion: 300, interest_portion: 50 }, error: null });
    mockFrom.mockReturnValueOnce(refetchQuery);

    const result = await createManualLoanPayment('user-1', 'loan-1', {
      date: '2026-08-01',
      principalPortion: 300,
      interestPortion: 50,
      notes: 'Cash payment',
    });

    expect(mockRpc).toHaveBeenCalledWith('create_manual_loan_payment', {
      p_user_id: 'user-1',
      p_loan_id: 'loan-1',
      p_date: '2026-08-01',
      p_principal_portion: 300,
      p_interest_portion: 50,
      p_notes: 'Cash payment',
    });
    expect(result).toMatchObject({ id: 'payment-1' });
  });

  it('propagates an RPC failure (e.g. loan not owned) without a re-fetch', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'manual loan not found or not owned by user' } });

    await expect(
      createManualLoanPayment('user-1', 'loan-1', { date: '2026-08-01', principalPortion: 50, interestPortion: 10, notes: null })
    ).rejects.toThrow('Failed to create manual payment');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  describe('write-boundary validation (Round 4 remediation §9) — a manual payment has no `amount` to bound against, so only finite/non-negative is required', () => {
    it.each([
      ['negative principal_portion', { principalPortion: -50, interestPortion: 10 }],
      ['NaN principal_portion', { principalPortion: NaN, interestPortion: 10 }],
      ['non-finite principal_portion', { principalPortion: Infinity, interestPortion: 10 }],
      ['negative interest_portion', { principalPortion: 50, interestPortion: -10 }],
      ['NaN interest_portion', { principalPortion: 50, interestPortion: NaN }],
    ])('rejects %s and never calls the RPC or touches the DB', async (_label, overrides) => {
      await expect(
        createManualLoanPayment('user-1', 'loan-1', { date: '2026-08-01', notes: null, ...overrides })
      ).rejects.toThrow(InvalidPrincipalPortionError);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('accepts a zero principal_portion (an all-interest payment)', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'payment-1', error: null });
      const refetchQuery = createQueryBuilder({ data: { id: 'payment-1', principal_portion: 0, interest_portion: 50 }, error: null });
      mockFrom.mockReturnValueOnce(refetchQuery);

      await expect(
        createManualLoanPayment('user-1', 'loan-1', { date: '2026-08-01', principalPortion: 0, interestPortion: 50, notes: null })
      ).resolves.toBeDefined();
    });
  });
});

describe('updateManualLoanPayment — atomic partial patch + balance sync (Round 6 remediation, blocker 4)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('calls the atomic update RPC with p_set_* flags reflecting exactly which fields were part of the patch', async () => {
    const existsQuery = createQueryBuilder({ data: { id: 'payment-1' }, error: null });
    const refetchQuery = createQueryBuilder({ data: { id: 'payment-1', principal_portion: 250, interest_portion: 100 }, error: null });
    mockFrom.mockReturnValueOnce(existsQuery).mockReturnValueOnce(refetchQuery);
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    await updateManualLoanPayment('user-1', 'payment-1', 'loan-1', { principal_portion: 250, interest_portion: 100 });

    expect(mockRpc).toHaveBeenCalledWith('update_manual_loan_payment', {
      p_user_id: 'user-1',
      p_payment_id: 'payment-1',
      p_loan_id: 'loan-1',
      p_set_date: false,
      p_date: null,
      p_set_principal_portion: true,
      p_principal_portion: 250,
      p_set_interest_portion: true,
      p_interest_portion: 100,
      p_set_notes: false,
      p_notes: null,
    });
  });

  it('returns null without calling the RPC at all when the payment does not exist', async () => {
    const existsQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(existsQuery);

    const result = await updateManualLoanPayment('user-1', 'payment-1', 'loan-1', { principal_portion: 250 });

    expect(result).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a patch that never touches principal_portion still correctly reports p_set_principal_portion: false', async () => {
    const existsQuery = createQueryBuilder({ data: { id: 'payment-1' }, error: null });
    const refetchQuery = createQueryBuilder({ data: { id: 'payment-1', notes: 'Updated note' }, error: null });
    mockFrom.mockReturnValueOnce(existsQuery).mockReturnValueOnce(refetchQuery);
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    await updateManualLoanPayment('user-1', 'payment-1', 'loan-1', { notes: 'Updated note' });

    expect(mockRpc).toHaveBeenCalledWith(
      'update_manual_loan_payment',
      expect.objectContaining({ p_set_principal_portion: false, p_set_notes: true, p_notes: 'Updated note' })
    );
  });

  describe('write-boundary validation (Round 4 remediation §9)', () => {
    it.each([
      ['negative principal_portion', { principal_portion: -50 }],
      ['NaN principal_portion', { principal_portion: NaN }],
      ['negative interest_portion', { interest_portion: -10 }],
      ['non-finite interest_portion', { interest_portion: Infinity }],
    ])('rejects %s BEFORE fetching/updating anything, or adjusting the balance', async (_label, fields) => {
      await expect(updateManualLoanPayment('user-1', 'payment-1', 'loan-1', fields)).rejects.toThrow(InvalidPrincipalPortionError);
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });
});

describe('deleteManualLoanPayment — atomic delete + balance restoration (Round 6 remediation, blocker 4)', () => {
  it('calls the atomic delete RPC (idempotent no-op for an already-gone payment is handled entirely inside the RPC)', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    await deleteManualLoanPayment('user-1', 'payment-1', 'loan-1');

    expect(mockRpc).toHaveBeenCalledWith('delete_manual_loan_payment', {
      p_user_id: 'user-1',
      p_payment_id: 'payment-1',
      p_loan_id: 'loan-1',
    });
  });

  it('propagates an RPC failure', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'manual loan not found or not owned by user' } });

    await expect(deleteManualLoanPayment('user-1', 'payment-1', 'loan-1')).rejects.toThrow('Failed to delete manual payment');
  });
});

describe('updateAccountCreditLimit', () => {
  it('updates the credit limit after verifying the account belongs to the user', async () => {
    const ownershipQuery = createQueryBuilder({ data: { id: 'account-1' }, error: null });
    const updateQuery = createQueryBuilder({ data: { id: 'account-1', credit_limit: 5000 }, error: null });
    mockFrom.mockReturnValueOnce(ownershipQuery).mockReturnValueOnce(updateQuery);

    const result = await updateAccountCreditLimit('account-1', 'user-1', 5000);

    expect(ownershipQuery.eq).toHaveBeenCalledWith('plaid_items.user_id', 'user-1');
    expect(updateQuery.update).toHaveBeenCalledWith({ credit_limit: 5000 });
    expect(result).toEqual({ id: 'account-1', credit_limit: 5000 });
  });

  it('returns null without updating when the account does not belong to the user', async () => {
    const ownershipQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(ownershipQuery);

    const result = await updateAccountCreditLimit('account-1', 'user-1', 5000);

    expect(result).toBeNull();
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});

describe('updateAccountSavingsGoal', () => {
  it('updates the savings goal after verifying the account belongs to the user', async () => {
    const ownershipQuery = createQueryBuilder({ data: { id: 'account-1' }, error: null });
    const updateQuery = createQueryBuilder({ data: { id: 'account-1', savings_goal: 10000 }, error: null });
    mockFrom.mockReturnValueOnce(ownershipQuery).mockReturnValueOnce(updateQuery);

    const result = await updateAccountSavingsGoal('account-1', 'user-1', 10000);

    expect(ownershipQuery.eq).toHaveBeenCalledWith('plaid_items.user_id', 'user-1');
    expect(updateQuery.update).toHaveBeenCalledWith({ savings_goal: 10000 });
    expect(result).toEqual({ id: 'account-1', savings_goal: 10000 });
  });

  it('returns null without updating when the account does not belong to the user', async () => {
    const ownershipQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(ownershipQuery);

    const result = await updateAccountSavingsGoal('account-1', 'user-1', 10000);

    expect(result).toBeNull();
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});

describe('deleteCategoryMappingsForBudgetCategory', () => {
  it('deletes mappings targeting the given category and returns their ids', async () => {
    const deleteQuery = createQueryBuilder({
      data: [{ id: 'mapping-1' }, { id: 'mapping-2' }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(deleteQuery);

    const result = await deleteCategoryMappingsForBudgetCategory('cat-1', 'user-1');

    expect(deleteQuery.delete).toHaveBeenCalled();
    expect(deleteQuery.eq).toHaveBeenCalledWith('budget_category_id', 'cat-1');
    expect(deleteQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(result).toEqual(['mapping-1', 'mapping-2']);
  });

  it('returns an empty array when no mappings target the category', async () => {
    const deleteQuery = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(deleteQuery);

    const result = await deleteCategoryMappingsForBudgetCategory('cat-1', 'user-1');

    expect(result).toEqual([]);
  });
});

describe('getBudgetCategoryForUser', () => {
  it("returns the category row when it belongs to the user", async () => {
    const query = createQueryBuilder({
      data: { id: 'cat-1', user_id: 'user-1', archived_at: null },
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    const result = await getBudgetCategoryForUser('cat-1', 'user-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'cat-1');
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(result).toEqual({ id: 'cat-1', user_id: 'user-1', archived_at: null });
  });

  it('returns null when no matching category is found', async () => {
    const query = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getBudgetCategoryForUser('cat-1', 'user-1');

    expect(result).toBeNull();
  });
});

describe('updateAccountCustomization', () => {
  it('updates only the provided fields after verifying account ownership', async () => {
    const ownershipQuery = createQueryBuilder({ data: { id: 'account-1' }, error: null });
    const updateQuery = createQueryBuilder({
      data: { id: 'account-1', nickname: 'Joint checking', hidden: true },
      error: null,
    });
    mockFrom.mockReturnValueOnce(ownershipQuery).mockReturnValueOnce(updateQuery);

    const result = await updateAccountCustomization('account-1', 'user-1', {
      nickname: 'Joint checking',
      hidden: true,
    });

    expect(ownershipQuery.eq).toHaveBeenCalledWith('plaid_items.user_id', 'user-1');
    expect(updateQuery.update).toHaveBeenCalledWith({ nickname: 'Joint checking', hidden: true });
    expect(result).toEqual({ id: 'account-1', nickname: 'Joint checking', hidden: true });
  });

  it('returns null without updating when the account does not belong to the user', async () => {
    const ownershipQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(ownershipQuery);

    const result = await updateAccountCustomization('account-1', 'user-1', { hidden: true });

    expect(result).toBeNull();
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});

describe('getRecurringStreamsForUser', () => {
  it('excludes a stream whose account is flagged exclude_from_cash_flow', async () => {
    const query = createQueryBuilder({
      data: [
        { id: 'stream-1', account_id: 'acc-1', accounts: { exclude_from_cash_flow: false } },
        { id: 'stream-2', account_id: 'acc-2', accounts: { exclude_from_cash_flow: true } },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    const result = await getRecurringStreamsForUser('user-1');

    expect(result.map((r) => r.id)).toEqual(['stream-1']);
    expect((result[0] as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it('keeps a stream with no linked account rather than dropping it', async () => {
    const query = createQueryBuilder({
      data: [{ id: 'stream-1', account_id: null, accounts: null }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    const result = await getRecurringStreamsForUser('user-1');

    expect(result.map((r) => r.id)).toEqual(['stream-1']);
  });
});

describe('getTransactionsSince', () => {
  it('queries only a lower bound when untilDate is omitted, matching the pre-existing open-ended behavior', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await getTransactionsSince('user-1', '2026-03-01');

    expect(query.gte).toHaveBeenCalledWith('date', '2026-03-01');
    expect(query.lt).not.toHaveBeenCalled();
  });

  it('also applies an exclusive upper bound when untilDate is given', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await getTransactionsSince('user-1', '2026-07-01', '2026-08-01');

    expect(query.gte).toHaveBeenCalledWith('date', '2026-07-01');
    expect(query.lt).toHaveBeenCalledWith('date', '2026-08-01');
  });
});

describe('getRecentTransactionsForUser', () => {
  it('applies no date filter when start/end are omitted, matching the pre-existing limit-only behavior', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await getRecentTransactionsForUser('user-1', 50);

    expect(query.gte).not.toHaveBeenCalled();
    expect(query.lte).not.toHaveBeenCalled();
    expect(query.limit).toHaveBeenCalledWith(50);
  });

  it('applies inclusive start/end bounds when given', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await getRecentTransactionsForUser('user-1', 50, '2026-06-01', '2026-06-30');

    expect(query.gte).toHaveBeenCalledWith('date', '2026-06-01');
    expect(query.lte).toHaveBeenCalledWith('date', '2026-06-30');
  });
});

describe('getLoansForUser', () => {
  it('excludes a loan whose account is flagged exclude_from_cash_flow', async () => {
    const query = createQueryBuilder({
      data: [
        { id: 'loan-1', account_id: 'acc-1', accounts: { name: 'Card', current_balance: -100, iso_currency_code: 'USD', exclude_from_cash_flow: false } },
        { id: 'loan-2', account_id: 'acc-2', accounts: { name: 'Card 2', current_balance: -200, iso_currency_code: 'USD', exclude_from_cash_flow: true } },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    const result = await getLoansForUser('user-1');

    expect(result.map((r) => r.id)).toEqual(['loan-1']);
    expect((result[0] as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it('keeps a loan with no linked account rather than dropping it', async () => {
    const query = createQueryBuilder({
      data: [{ id: 'loan-1', account_id: null, accounts: null }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    const result = await getLoansForUser('user-1');

    expect(result.map((r) => r.id)).toEqual(['loan-1']);
  });
});

describe('upsertFinancialPreferences', () => {
  it('upserts all six fields together, keyed by user_id', async () => {
    const query = createQueryBuilder({
      data: {
        user_id: 'user-1',
        minimum_cash_buffer: 500,
        upcoming_bills_days: 30,
        recent_avg_months: 3,
        savings_rate_target: 20,
        safe_to_spend_include_upcoming_bills: false,
        safe_to_spend_include_remaining_budget: false,
      },
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    const result = await upsertFinancialPreferences('user-1', {
      minimumCashBuffer: 500,
      upcomingBillsDays: 30,
      recentAvgMonths: 3,
      savingsRateTarget: 20,
      safeToSpendIncludeUpcomingBills: false,
      safeToSpendIncludeRemainingBudget: false,
    });

    expect(query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        minimum_cash_buffer: 500,
        upcoming_bills_days: 30,
        recent_avg_months: 3,
        savings_rate_target: 20,
        safe_to_spend_include_upcoming_bills: false,
        safe_to_spend_include_remaining_budget: false,
      }),
      { onConflict: 'user_id' }
    );
    expect(result.minimum_cash_buffer).toBe(500);
    expect(result.savings_rate_target).toBe(20);
  });
});

describe('upsertNavLayout', () => {
  it('upserts nav_layout keyed by user_id', async () => {
    const navLayout = { tabs: [{ id: 'loans', visible: false }] };
    const query = createQueryBuilder({
      data: { user_id: 'user-1', nav_layout: navLayout },
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    const result = await upsertNavLayout('user-1', navLayout);

    expect(query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', nav_layout: navLayout }),
      { onConflict: 'user_id' }
    );
    expect(result.nav_layout).toEqual(navLayout);
  });
});

describe('upsertReportingRange', () => {
  it('upserts reporting_range keyed by user_id', async () => {
    const query = createQueryBuilder({
      data: { user_id: 'user-1', reporting_range: 'last_12_months' },
      error: null,
    });
    mockFrom.mockReturnValueOnce(query);

    const result = await upsertReportingRange('user-1', 'last_12_months');

    expect(query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', reporting_range: 'last_12_months' }),
      { onConflict: 'user_id' }
    );
    expect(result.reporting_range).toBe('last_12_months');
  });
});

describe('transaction semantic-role reconciliation queries (Financial Semantics Foundation, Phase A + Round 2 remediation)', () => {
  it('getTransactionsForReconciliation returns [] without querying at all for an empty id list', async () => {
    const result = await getTransactionsForReconciliation('user-1', []);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('getTransactionsForReconciliation queries by exactly the given ids, scoped to the given user (§8 ownership)', async () => {
    const query = createQueryBuilder({ data: [{ id: 'txn-1' }], error: null });
    mockFrom.mockReturnValueOnce(query);

    await getTransactionsForReconciliation('user-1', ['txn-1', 'txn-2']);

    expect(query.eq).toHaveBeenCalledWith('accounts.plaid_items.user_id', 'user-1');
    expect(query.in).toHaveBeenCalledWith('id', ['txn-1', 'txn-2']);
  });

  it('findTransferCounterpartCandidates excludes the same account and the row itself, requires the opposite exact amount, the given roleSourceFilter, and the given date window — no limit(1), returns everything in range', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await findTransferCounterpartCandidates(
      'user-1',
      { id: 'txn-1', account_id: 'acc-1', amount: 100, date: '2026-09-10' },
      '2026-09-07',
      '2026-09-13',
      'transfer_like_unconfirmed'
    );

    expect(query.eq).toHaveBeenCalledWith('accounts.plaid_items.user_id', 'user-1');
    expect(query.neq).toHaveBeenCalledWith('account_id', 'acc-1');
    expect(query.neq).toHaveBeenCalledWith('id', 'txn-1');
    expect(query.eq).toHaveBeenCalledWith('amount', -100);
    expect(query.eq).toHaveBeenCalledWith('role_source', 'transfer_like_unconfirmed');
    expect(query.gte).toHaveBeenCalledWith('date', '2026-09-07');
    expect(query.lte).toHaveBeenCalledWith('date', '2026-09-13');
    expect(query.limit).not.toHaveBeenCalled();
  });

  it('findTransferCounterpartCandidates can be filtered to account_pair_match to find an EXISTING confirmed partner (reused for stale-partner detection)', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await findTransferCounterpartCandidates(
      'user-1',
      { id: 'txn-1', account_id: 'acc-1', amount: 100, date: '2026-09-10' },
      '2026-09-07',
      '2026-09-13',
      'account_pair_match'
    );

    expect(query.eq).toHaveBeenCalledWith('role_source', 'account_pair_match');
  });

  it('findRefundOriginalCandidates requires an eligible ordinary expense (effective_role = expense, not manual-loan-linked), the same account, a positive amount at least covering the refund, and the given lookback window through the refund\'s own date', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await findRefundOriginalCandidates(
      'user-1',
      { id: 'txn-refund', account_id: 'acc-1', amount: -50, date: '2026-09-10' },
      '2026-05-13'
    );

    expect(query.eq).toHaveBeenCalledWith('account_id', 'acc-1');
    expect(query.eq).toHaveBeenCalledWith('effective_role', 'expense');
    expect(query.is).toHaveBeenCalledWith('manual_loan_id', null);
    expect(query.gte).toHaveBeenCalledWith('amount', 50);
    expect(query.gte).toHaveBeenCalledWith('date', '2026-05-13');
    expect(query.lte).toHaveBeenCalledWith('date', '2026-09-10');
  });

  it('findNegativeCandidatesReferencingOriginal requires the same account, a negative amount not exceeding the purchase, the given roleSourceFilter, and a date on/after the purchase through the window end', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await findNegativeCandidatesReferencingOriginal(
      'user-1',
      { id: 'txn-orig', account_id: 'acc-1', amount: 50, date: '2026-09-10' },
      '2027-01-08',
      'sign_default'
    );

    expect(query.eq).toHaveBeenCalledWith('account_id', 'acc-1');
    expect(query.lt).toHaveBeenCalledWith('amount', 0);
    expect(query.gte).toHaveBeenCalledWith('amount', -50);
    expect(query.eq).toHaveBeenCalledWith('role_source', 'sign_default');
    expect(query.gte).toHaveBeenCalledWith('date', '2026-09-10');
    expect(query.lte).toHaveBeenCalledWith('date', '2027-01-08');
  });

  it('findNegativeCandidatesReferencingOriginal can be filtered to refund_match to find a STALE existing match', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await findNegativeCandidatesReferencingOriginal(
      'user-1',
      { id: 'txn-orig', account_id: 'acc-1', amount: 50, date: '2026-09-10' },
      '2027-01-08',
      'refund_match'
    );

    expect(query.eq).toHaveBeenCalledWith('role_source', 'refund_match');
  });

  describe('applyTransactionSemanticRoles — atomic, ownership-safe RPC mutation (Round 3 remediation §1, hard-failure contract in Round 4 remediation §6)', () => {
    beforeEach(() => {
      mockRpc.mockReset();
    });

    it('invokes the RPC with the exact expected parameter shape for a single-row mutation, including the expected-role-source CAS array', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      await expect(
        applyTransactionSemanticRoles('user-1', ['txn-1'], ['sign_default'], {
          auto_role: 'refund',
          role_source: 'refund_match',
          role_confidence: 'high',
          classifier_version: 1,
        })
      ).resolves.toBeUndefined();

      expect(mockRpc).toHaveBeenCalledWith('apply_transaction_semantic_roles', {
        p_user_id: 'user-1',
        p_transaction_ids: ['txn-1'],
        p_expected_role_sources: ['sign_default'],
        p_auto_role: 'refund',
        p_role_source: 'refund_match',
        p_role_confidence: 'high',
        p_classifier_version: 1,
      });
    });

    it('invokes the RPC with both ids (and both expected role sources) for a transfer-pair mutation, one call, never two', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      await applyTransactionSemanticRoles(
        'user-1',
        ['txn-1', 'txn-2'],
        ['transfer_like_unconfirmed', 'transfer_like_unconfirmed'],
        {
          auto_role: 'internal_transfer',
          role_source: 'account_pair_match',
          role_confidence: 'high',
          classifier_version: 1,
        }
      );

      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith(
        'apply_transaction_semantic_roles',
        expect.objectContaining({
          p_transaction_ids: ['txn-1', 'txn-2'],
          p_expected_role_sources: ['transfer_like_unconfirmed', 'transfer_like_unconfirmed'],
        })
      );
    });

    it('THROWS SemanticRoleMutationError (never resolves, never returns a boolean) when the RPC raises its own integrity error (SQLSTATE P0001) — an unowned id, a missing row, a count mismatch, or a stale expected-role-source CAS check inside the atomic function (Round 4 remediation §6, Round 6 remediation blocker 3)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'P0001', message: 'apply_transaction_semantic_roles: ownership check failed' },
      });

      await expect(
        applyTransactionSemanticRoles('user-A', ['txn-owned-by-user-B'], ['sign_default'], {
          auto_role: 'expense',
          role_source: 'sign_default',
          role_confidence: 'low',
          classifier_version: 1,
        })
      ).rejects.toThrow(SemanticRoleMutationError);
    });

    it('a mismatched-pair failure (only one of two intended transfer-pair ids resolves) THROWS identically to a single-row ownership failure — never a partial success', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'P0001', message: 'apply_transaction_semantic_roles: ownership check failed (expected 2 owned rows, found 1)' },
      });

      await expect(
        applyTransactionSemanticRoles(
          'user-1',
          ['txn-1', 'txn-missing'],
          ['transfer_like_unconfirmed', 'transfer_like_unconfirmed'],
          {
            auto_role: 'internal_transfer',
            role_source: 'account_pair_match',
            role_confidence: 'high',
            classifier_version: 1,
          }
        )
      ).rejects.toThrow(SemanticRoleMutationError);
    });

    it('a genuine infrastructure error is ALSO thrown as SemanticRoleMutationError — every RPC error is now a hard failure, none silently absorbed', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '08000', message: 'connection failure' } });

      await expect(
        applyTransactionSemanticRoles('user-1', ['txn-1'], ['sign_default'], {
          auto_role: 'expense',
          role_source: 'sign_default',
          role_confidence: 'low',
          classifier_version: 1,
        })
      ).rejects.toThrow('connection failure');
    });
  });

  describe('confirmTransferPair — atomic candidate re-discovery + ranking + write (Round 7 remediation, completing blocker 3)', () => {
    beforeEach(() => {
      mockRpc.mockReset();
    });

    it('invokes confirm_transfer_pair with the exact expected parameter shape', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      await expect(
        confirmTransferPair('user-1', 'txn-1', 'txn-2', 'transfer_like_unconfirmed', 3, 1)
      ).resolves.toBeUndefined();

      expect(mockRpc).toHaveBeenCalledWith('confirm_transfer_pair', {
        p_user_id: 'user-1',
        p_row_a_id: 'txn-1',
        p_row_b_id: 'txn-2',
        p_role_source_filter: 'transfer_like_unconfirmed',
        p_window_days: 3,
        p_classifier_version: 1,
      });
    });

    it('THROWS TransferPairConfirmationError (never resolves) when the RPC rejects the pair — a stale ranking, a phantom candidate re-discovered inside the locked transaction, an ownership mismatch, or any other integrity failure', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "confirm_transfer_pair: row_a's best current candidate is no longer row_b" },
      });

      await expect(
        confirmTransferPair('user-1', 'txn-1', 'txn-2', 'transfer_like_unconfirmed', 3, 1)
      ).rejects.toThrow(TransferPairConfirmationError);
    });

    it('a genuine infrastructure error is also thrown as TransferPairConfirmationError', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'connection failure' } });

      await expect(
        confirmTransferPair('user-1', 'txn-1', 'txn-2', 'transfer_like_unconfirmed', 3, 1)
      ).rejects.toThrow('connection failure');
    });
  });

  describe('getRelationallyClassifiedTransactionsPage — bounded keyset pagination for the repair sweep (Round 3 remediation §3/§4)', () => {
    it('filters by user, role_source, and pages by id ascending with no lower bound on the first page', async () => {
      const query = createQueryBuilder({ data: [], error: null });
      mockFrom.mockReturnValueOnce(query);

      await getRelationallyClassifiedTransactionsPage('user-1', 'account_pair_match', 200, null);

      expect(query.eq).toHaveBeenCalledWith('accounts.plaid_items.user_id', 'user-1');
      expect(query.eq).toHaveBeenCalledWith('role_source', 'account_pair_match');
      expect(query.gt).not.toHaveBeenCalled();
      expect(query.order).toHaveBeenCalledWith('id', { ascending: true });
      expect(query.limit).toHaveBeenCalledWith(200);
    });

    it('applies a strictly-greater-than id filter when resuming from a cursor', async () => {
      const query = createQueryBuilder({ data: [], error: null });
      mockFrom.mockReturnValueOnce(query);

      await getRelationallyClassifiedTransactionsPage('user-1', 'refund_match', 200, 'txn-last');

      expect(query.gt).toHaveBeenCalledWith('id', 'txn-last');
    });
  });
});

describe('getTransactionsBackfillPage — deterministic keyset pagination (Round 2 remediation §10)', () => {
  it('with no cursor, orders by date then id ascending and applies no lower-bound filter', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await getTransactionsBackfillPage(500, null);

    expect(query.order).toHaveBeenCalledWith('date', { ascending: true });
    expect(query.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(query.limit).toHaveBeenCalledWith(500);
    expect(query.or).not.toHaveBeenCalled();
  });

  it('with a cursor, filters strictly after (date, id) via a keyset OR expression, not OFFSET', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await getTransactionsBackfillPage(500, { date: '2026-01-01', id: 'abc' });

    expect(query.or).toHaveBeenCalledWith('date.gt.2026-01-01,and(date.eq.2026-01-01,id.gt.abc)');
  });

  it('does not filter by auto_role at all — returns rows regardless of classification state', async () => {
    const query = createQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(query);

    await getTransactionsBackfillPage(500, null);

    const isCalls = (query.is as ReturnType<typeof vi.fn>).mock.calls;
    expect(isCalls.some((call) => call[0] === 'auto_role')).toBe(false);
  });
});

describe('Plaid Hosted Link attempts (Wave 1)', () => {
  const ATTEMPT_ID = 'b1b2c3d4-0000-4000-8000-000000000001';
  const LINK_TOKEN = 'link-sandbox-placeholder-token';
  const ACCESS_TOKEN = 'access-sandbox-placeholder-token';
  const CLAIM = 'c1c2c3c4-0000-4000-8000-000000000001';

  beforeEach(() => {
    mockRpc.mockReset();
    mockFrom.mockReset();
  });

  it('createPlaidLinkAttempt stores the link token ENCRYPTED (bound to the attempt id) plus its SHA-256 — never the token itself', async () => {
    mockRpc.mockResolvedValueOnce({ data: '2026-09-22T12:30:00+00:00', error: null });
    await expect(
      createPlaidLinkAttempt({ attemptId: ATTEMPT_ID, userId: 'user-1', sessionId: 'sid-1', linkToken: LINK_TOKEN })
    ).resolves.toEqual({ expiresAt: '2026-09-22T12:30:00+00:00' });

    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('create_plaid_link_attempt');
    expect(JSON.stringify(args)).not.toContain(LINK_TOKEN);
    expect(args).toMatchObject({ p_id: ATTEMPT_ID, p_user_id: 'user-1', p_session_id: 'sid-1', p_link_token_key_id: 'TEST_V1', p_link_token_enc_version: 1 });
    expect(args.p_link_token_hash).toBe(createHash('sha256').update(LINK_TOKEN).digest('hex'));
    const enc = {
      ciphertextBase64: args.p_link_token_ciphertext,
      nonceBase64: args.p_link_token_nonce,
      authTagBase64: args.p_link_token_auth_tag,
      keyId: args.p_link_token_key_id,
      encVersion: args.p_link_token_enc_version,
    };
    expect(decryptLinkToken(enc, TEST_KEY_RING, ATTEMPT_ID)).toBe(LINK_TOKEN);
  });

  it('createPlaidLinkAttempt maps the "too many in progress" refusal, and throws on other errors', async () => {
    const params = { attemptId: ATTEMPT_ID, userId: 'u', sessionId: 's', linkToken: LINK_TOKEN };
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'too many Plaid Link attempts in progress' } });
    await expect(createPlaidLinkAttempt(params)).rejects.toBeInstanceOf(TooManyPlaidLinkAttemptsError);
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(createPlaidLinkAttempt(params)).rejects.toThrow('Failed to start Plaid Link attempt: boom');
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(createPlaidLinkAttempt(params)).rejects.toThrow('no expiry returned');
  });

  function storedRow(overrides: Record<string, unknown> = {}) {
    const enc = encryptLinkToken(LINK_TOKEN, TEST_KEY_RING, ATTEMPT_ID);
    return {
      status: 'pending',
      expired: false,
      stale: false,
      link_token_ciphertext: enc.ciphertextBase64,
      link_token_nonce: enc.nonceBase64,
      link_token_auth_tag: enc.authTagBase64,
      link_token_key_id: enc.keyId,
      link_token_enc_version: enc.encVersion,
      ...overrides,
    };
  }
  const erased = {
    link_token_ciphertext: null,
    link_token_nonce: null,
    link_token_auth_tag: null,
    link_token_key_id: null,
    link_token_enc_version: null,
  };

  it.each(['pending', 'claimed'] as const)("readPlaidLinkAttempt decrypts a %s attempt's link token for its own user and session", async (status) => {
    mockRpc.mockResolvedValueOnce({ data: [storedRow({ status, stale: status === 'claimed' })], error: null });
    await expect(readPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1')).resolves.toEqual({
      status,
      expired: false,
      stale: status === 'claimed',
      linkToken: LINK_TOKEN,
    });
    expect(mockRpc).toHaveBeenCalledWith('read_plaid_link_attempt', { p_id: ATTEMPT_ID, p_user_id: 'user-1', p_session_id: 'sid-1' });
  });

  it('readPlaidLinkAttempt: null for zero rows; no token for an exchanging or finished attempt', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(readPlaidLinkAttempt(ATTEMPT_ID, 'user-2', 'sid-2')).resolves.toBeNull();
    for (const status of ['exchanging', 'completed', 'failed', 'exchange_unknown']) {
      mockRpc.mockResolvedValueOnce({ data: [storedRow({ status, stale: true, ...erased })], error: null });
      await expect(readPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1')).resolves.toEqual({ status, expired: false, stale: true });
    }
  });

  it('readPlaidLinkAttempt fails closed on a foreign or partial ciphertext, and on unexpected shapes', async () => {
    const foreign = encryptLinkToken(LINK_TOKEN, TEST_KEY_RING, 'b1b2c3d4-0000-4000-8000-000000000009');
    mockRpc.mockResolvedValueOnce({
      data: [storedRow({ link_token_ciphertext: foreign.ciphertextBase64, link_token_nonce: foreign.nonceBase64, link_token_auth_tag: foreign.authTagBase64 })],
      error: null,
    });
    await expect(readPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1')).rejects.toThrow(GcmAuthenticationError);
    mockRpc.mockResolvedValueOnce({ data: [storedRow({ link_token_nonce: null })], error: null });
    await expect(readPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1')).rejects.toThrow(PartialEncryptedRepresentationError);
    for (const bad of [{ status: 'completing' }, { stale: null }]) {
      mockRpc.mockResolvedValueOnce({ data: [storedRow(bad)], error: null });
      await expect(readPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1')).rejects.toThrow('unexpected result');
    }
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    await expect(readPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1')).rejects.toThrow('Failed to read Plaid Link attempt: down');
  });

  it('claimPlaidLinkAttempt returns the claim token only for a won claim', async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ outcome: 'claimed', claim_token: CLAIM }], error: null });
    await expect(claimPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1')).resolves.toEqual({ outcome: 'claimed', claimToken: CLAIM });
    expect(mockRpc).toHaveBeenCalledWith('claim_plaid_link_attempt', { p_id: ATTEMPT_ID, p_user_id: 'user-1', p_session_id: 'sid-1' });
  });

  it.each(['invalid', 'expired', 'in_progress', 'completed', 'failed', 'exchange_unknown'] as const)(
    'claimPlaidLinkAttempt passes the refusal %s through, with no token',
    async (outcome) => {
      mockRpc.mockResolvedValueOnce({ data: [{ outcome, claim_token: null }], error: null });
      await expect(claimPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1')).resolves.toEqual({ outcome });
    }
  );

  it.each([
    [null],
    [[]],
    [[{ outcome: 'claimed', claim_token: null }]],
    [[{ outcome: 'in_progress', claim_token: CLAIM }]],
    [[{ outcome: 'CLAIMED', claim_token: CLAIM }]],
    [[{ outcome: 'claimed', claim_token: CLAIM }, { outcome: 'claimed', claim_token: CLAIM }]],
  ])('claimPlaidLinkAttempt treats any other result (%j) as an error, never as claimed', async (data) => {
    mockRpc.mockResolvedValueOnce({ data, error: null });
    await expect(claimPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1')).rejects.toThrow('unexpected result');
  });

  it('beginPlaidLinkExchange passes the claim token and requires a boolean back', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(beginPlaidLinkExchange(ATTEMPT_ID, 'user-1', 'sid-1', CLAIM)).resolves.toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('begin_plaid_link_exchange', { p_id: ATTEMPT_ID, p_user_id: 'user-1', p_session_id: 'sid-1', p_claim_token: CLAIM });
    mockRpc.mockResolvedValueOnce({ data: 'yes', error: null });
    await expect(beginPlaidLinkExchange(ATTEMPT_ID, 'user-1', 'sid-1', CLAIM)).rejects.toThrow('unexpected result');
  });

  const storeParams = { attemptId: ATTEMPT_ID, userId: 'user-1', sessionId: 'sid-1', claimToken: CLAIM, plaidItemId: 'plaid-item-1', accessToken: ACCESS_TOKEN };

  it('storePlaidLinkItem sends the access token only ENCRYPTED, AAD-bound to a fresh item row id, in one RPC', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null, status: 200 });
    const result = await storePlaidLinkItem(storeParams);
    expect(result.outcome).toBe('stored');
    const itemRowId = (result as { itemRowId: string }).itemRowId;

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('store_plaid_link_item');
    expect(JSON.stringify(args)).not.toContain(ACCESS_TOKEN);
    expect(args).toMatchObject({ p_id: ATTEMPT_ID, p_user_id: 'user-1', p_session_id: 'sid-1', p_claim_token: CLAIM, p_item_row_id: itemRowId, p_plaid_item_id: 'plaid-item-1' });
    const enc = {
      ciphertextBase64: args.p_access_token_ciphertext,
      nonceBase64: args.p_access_token_nonce,
      authTagBase64: args.p_access_token_auth_tag,
      keyId: args.p_access_token_key_id,
      encVersion: args.p_access_token_enc_version,
    };
    expect(decryptAccessToken(enc, TEST_KEY_RING, itemRowId)).toBe(ACCESS_TOKEN);
    expect(() => decryptLinkToken(enc, TEST_KEY_RING, itemRowId)).toThrow(GcmAuthenticationError); // access-token AAD, not link-token
    expect(mockFrom).not.toHaveBeenCalled(); // no separate, non-atomic insert
  });

  it('storePlaidLinkItem: false -> refused; a 4xx database answer -> rejected (rolled back)', async () => {
    mockRpc.mockResolvedValueOnce({ data: false, error: null, status: 200 });
    await expect(storePlaidLinkItem(storeParams)).resolves.toEqual({ outcome: 'refused' });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 });
    await expect(storePlaidLinkItem(storeParams)).resolves.toEqual({ outcome: 'rejected' });
  });

  it.each([
    ['no response (network error / timeout)', { data: null, error: { code: '', message: 'FetchError: fetch failed' }, status: 0 }],
    ['a 5xx (e.g. a gateway timeout)', { data: null, error: { code: '', message: 'upstream timeout' }, status: 504 }],
    ['an unexpected success value', { data: 'maybe', error: null, status: 200 }],
  ])('storePlaidLinkItem: %s -> outcome unknown (thrown), never "rejected"', async (_label, response) => {
    mockRpc.mockResolvedValueOnce(response);
    await expect(storePlaidLinkItem(storeParams)).rejects.toBeInstanceOf(PlaidLinkStoreOutcomeUnknownError);
  });

  it('failPlaidLinkAttempt passes the reason and claim token, and requires a boolean back', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(failPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1', CLAIM, 'store_failed_item_removed')).resolves.toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('fail_plaid_link_attempt', {
      p_id: ATTEMPT_ID,
      p_user_id: 'user-1',
      p_session_id: 'sid-1',
      p_claim_token: CLAIM,
      p_reason: 'store_failed_item_removed',
    });
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(failPlaidLinkAttempt(ATTEMPT_ID, 'user-1', 'sid-1', null, 'exited')).rejects.toThrow('unexpected result');
  });

  it("markPlaidLinkAttemptReady sends only the SHA-256 of the webhook's link token, never the token", async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(markPlaidLinkAttemptReady(LINK_TOKEN, 'SUCCESS')).resolves.toBe(true);
    expect(mockRpc.mock.calls[0]).toEqual(['mark_plaid_link_attempt_ready', { p_link_token_hash: hashLinkToken(LINK_TOKEN), p_status: 'SUCCESS' }]);
  });

  it('updatePlaidItemInstitution and getPlaidItemIdsMissingInstitution touch only the institution columns of the given item/user', async () => {
    const update = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(update);
    await updatePlaidItemInstitution('row-1', 'ins_1', 'Sandbox Bank');
    expect(mockFrom).toHaveBeenCalledWith('plaid_items');
    expect(update.update).toHaveBeenCalledWith({ institution_id: 'ins_1', institution_name: 'Sandbox Bank' });
    expect(update.eq).toHaveBeenCalledWith('id', 'row-1');

    const select = createQueryBuilder({ data: [{ id: 'row-1' }, { id: 'row-2' }], error: null });
    mockFrom.mockReturnValueOnce(select);
    await expect(getPlaidItemIdsMissingInstitution('user-1')).resolves.toEqual(new Set(['row-1', 'row-2']));
    expect(select.select).toHaveBeenCalledWith('id');
    expect(select.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(select.is).toHaveBeenCalledWith('institution_id', null);
  });
});
