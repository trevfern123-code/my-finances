import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountBase, RemovedTransaction, Transaction as PlaidTransaction } from 'plaid';
import { createQueryBuilder } from '../testUtils/supabaseMock';
import {
  upsertAccountsForItem,
  applyTransactionChanges,
  linkTransactionToLoan,
  updateLinkedPaymentPrincipal,
  unlinkPaymentFromLoan,
  getLifetimeTotalsByLoanId,
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
  upsertReportingRange,
  insertPlaidItem,
  getPlaidItemsForUser,
  getPlaidItemByPlaidItemId,
  getPlaidItemForUser,
} from './dataService';
import {
  decryptAccessToken,
  encryptAccessToken,
  GcmAuthenticationError,
  loadKeyRing,
  MissingEncryptedRepresentationError,
  PartialEncryptedRepresentationError,
  UnknownKeyIdError,
  type KeyRing,
} from './tokenEncryption';

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: mockFrom } }));

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

  it('inserts added transactions that map to a known account, and returns the inserted rows', async () => {
    const existingQuery = createQueryBuilder({ data: [], error: null });
    const mappingsQuery = createQueryBuilder({ data: [], error: null });
    const insertedRow = { id: 'txn-row-new', name: 'Coffee Shop', merchant_name: 'Coffee Shop', amount: 12.5 };
    const insertQuery = createQueryBuilder({ data: [insertedRow], error: null });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(mappingsQuery).mockReturnValueOnce(insertQuery);

    const result = await applyTransactionChanges({
      userId: 'user-1',
      added: [fakeTransaction()],
      modified: [],
      removed: [],
      accountIdByPlaidId,
    });

    const inserted = insertQuery.insert.mock.calls[0][0] as Record<string, unknown>[];
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      account_id: 'account-row-1',
      plaid_transaction_id: 'txn-1',
      category: 'FOOD_AND_DRINK',
      plaid_category: 'Food and Drink > Coffee',
    });
    expect(result).toEqual([insertedRow]);
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
    const insertedRow = { id: 'txn-row-new', name: 'Coffee Shop', merchant_name: 'Coffee Shop', amount: 12.5 };
    const insertQuery = createQueryBuilder({ data: [insertedRow], error: null });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(mappingsQuery).mockReturnValueOnce(insertQuery);

    await applyTransactionChanges({
      userId: 'user-1',
      added: [fakeTransaction()],
      modified: [],
      removed: [],
      accountIdByPlaidId,
    });

    const inserted = insertQuery.insert.mock.calls[0][0] as Record<string, unknown>[];
    expect(inserted[0]).toMatchObject({ category: 'FOOD_AND_DRINK', budget_category_id: 'cat-dining' });
  });

  it("leaves budget_category_id null when no mapping matches the transaction's category", async () => {
    const existingQuery = createQueryBuilder({ data: [], error: null });
    const mappingsQuery = createQueryBuilder({ data: [], error: null });
    const insertedRow = { id: 'txn-row-new', name: 'Coffee Shop', merchant_name: 'Coffee Shop', amount: 12.5 };
    const insertQuery = createQueryBuilder({ data: [insertedRow], error: null });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(mappingsQuery).mockReturnValueOnce(insertQuery);

    await applyTransactionChanges({
      userId: 'user-1',
      added: [fakeTransaction()],
      modified: [],
      removed: [],
      accountIdByPlaidId,
    });

    const inserted = insertQuery.insert.mock.calls[0][0] as Record<string, unknown>[];
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
    expect(result).toEqual([]);
  });

  it('updates (not inserts) a transaction whose plaid_transaction_id already exists', async () => {
    const existingQuery = createQueryBuilder({
      data: [{ id: 'txn-row-1', plaid_transaction_id: 'txn-1' }],
      error: null,
    });
    const updateQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(updateQuery);

    await applyTransactionChanges({
      userId: 'user-1',
      added: [],
      modified: [fakeTransaction({ pending: true })],
      removed: [],
      accountIdByPlaidId,
    });

    expect(updateQuery.update.mock.calls[0][0]).toMatchObject({ pending: true });
    expect(updateQuery.eq).toHaveBeenCalledWith('id', 'txn-row-1');
    // Only the existence-check select happened on the table — no separate insert call, and no
    // category-mapping lookup either (that only runs when there's something to insert).
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('deletes removed transactions by their plaid_transaction_id', async () => {
    const deleteQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(deleteQuery);

    await applyTransactionChanges({
      userId: 'user-1',
      added: [],
      modified: [],
      removed: [fakeRemoved],
      accountIdByPlaidId,
    });

    expect(deleteQuery.delete).toHaveBeenCalled();
    expect(deleteQuery.in).toHaveBeenCalledWith('plaid_transaction_id', ['txn-removed']);
  });

  it('does nothing when there are no changes at all', async () => {
    await applyTransactionChanges({ userId: 'user-1', added: [], modified: [], removed: [], accountIdByPlaidId });
    expect(mockFrom).not.toHaveBeenCalled();
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

describe('linkTransactionToLoan', () => {
  it('links the transaction and decrements the loan balance by the principal portion', async () => {
    const linkQuery = createQueryBuilder({ data: null, error: null });
    const balanceQuery = createQueryBuilder({ data: { current_balance: 1000 }, error: null });
    const updateBalanceQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(linkQuery).mockReturnValueOnce(balanceQuery).mockReturnValueOnce(updateBalanceQuery);

    await linkTransactionToLoan('txn-1', 'loan-1', 200);

    expect(linkQuery.update).toHaveBeenCalledWith({ manual_loan_id: 'loan-1', principal_portion: 200 });
    expect(linkQuery.eq).toHaveBeenCalledWith('id', 'txn-1');
    expect(updateBalanceQuery.update.mock.calls[0][0]).toMatchObject({ current_balance: 800 });
    expect(updateBalanceQuery.eq).toHaveBeenCalledWith('id', 'loan-1');
  });

  it('clamps the new balance at 0 rather than going negative', async () => {
    const linkQuery = createQueryBuilder({ data: null, error: null });
    const balanceQuery = createQueryBuilder({ data: { current_balance: 150 }, error: null });
    const updateBalanceQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(linkQuery).mockReturnValueOnce(balanceQuery).mockReturnValueOnce(updateBalanceQuery);

    await linkTransactionToLoan('txn-1', 'loan-1', 200);

    expect(updateBalanceQuery.update.mock.calls[0][0]).toMatchObject({ current_balance: 0 });
  });
});

describe('updateLinkedPaymentPrincipal', () => {
  it('updates the principal portion and adjusts the loan balance by the difference', async () => {
    const fetchQuery = createQueryBuilder({
      data: { principal_portion: 100, manual_loan_id: 'loan-1' },
      error: null,
    });
    const updateTxnQuery = createQueryBuilder({ data: null, error: null });
    const balanceQuery = createQueryBuilder({ data: { current_balance: 900 }, error: null });
    const updateBalanceQuery = createQueryBuilder({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce(fetchQuery)
      .mockReturnValueOnce(updateTxnQuery)
      .mockReturnValueOnce(balanceQuery)
      .mockReturnValueOnce(updateBalanceQuery);

    await updateLinkedPaymentPrincipal('txn-1', 'loan-1', 150);

    expect(updateTxnQuery.update).toHaveBeenCalledWith({ principal_portion: 150 });
    // Old portion (100) applied 100 to balance; new portion (150) should apply 50 more.
    expect(updateBalanceQuery.update.mock.calls[0][0]).toMatchObject({ current_balance: 850 });
  });

  it('throws when the transaction is not linked to the given loan', async () => {
    const fetchQuery = createQueryBuilder({
      data: { principal_portion: 100, manual_loan_id: 'some-other-loan' },
      error: null,
    });
    mockFrom.mockReturnValueOnce(fetchQuery);

    await expect(updateLinkedPaymentPrincipal('txn-1', 'loan-1', 150)).rejects.toThrow(
      'Payment is not linked to this loan'
    );
  });
});

describe('unlinkPaymentFromLoan', () => {
  it('clears the link and restores the loan balance by the payment principal portion', async () => {
    const fetchQuery = createQueryBuilder({
      data: { principal_portion: 200, manual_loan_id: 'loan-1' },
      error: null,
    });
    const updateTxnQuery = createQueryBuilder({ data: null, error: null });
    const balanceQuery = createQueryBuilder({ data: { current_balance: 800 }, error: null });
    const updateBalanceQuery = createQueryBuilder({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce(fetchQuery)
      .mockReturnValueOnce(updateTxnQuery)
      .mockReturnValueOnce(balanceQuery)
      .mockReturnValueOnce(updateBalanceQuery);

    await unlinkPaymentFromLoan('txn-1', 'loan-1');

    expect(updateTxnQuery.update).toHaveBeenCalledWith({ manual_loan_id: null, principal_portion: null });
    expect(updateBalanceQuery.update.mock.calls[0][0]).toMatchObject({ current_balance: 1000 });
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

describe('createManualLoanPayment', () => {
  it('inserts the payment and decrements the loan balance by its principal portion', async () => {
    const insertQuery = createQueryBuilder({
      data: { id: 'payment-1', principal_portion: 300, interest_portion: 50 },
      error: null,
    });
    const balanceQuery = createQueryBuilder({ data: { current_balance: 1000 }, error: null });
    const updateBalanceQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(insertQuery).mockReturnValueOnce(balanceQuery).mockReturnValueOnce(updateBalanceQuery);

    await createManualLoanPayment('user-1', 'loan-1', {
      date: '2026-08-01',
      principalPortion: 300,
      interestPortion: 50,
      notes: 'Cash payment',
    });

    expect(insertQuery.insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      loan_id: 'loan-1',
      date: '2026-08-01',
      principal_portion: 300,
      interest_portion: 50,
      notes: 'Cash payment',
    });
    expect(updateBalanceQuery.update.mock.calls[0][0]).toMatchObject({ current_balance: 700 });
  });
});

describe('updateManualLoanPayment', () => {
  it('updates the payment and adjusts the balance by the principal difference', async () => {
    const fetchQuery = createQueryBuilder({ data: { principal_portion: 300 }, error: null });
    const updateQuery = createQueryBuilder({ data: { id: 'payment-1', principal_portion: 250 }, error: null });
    const balanceQuery = createQueryBuilder({ data: { current_balance: 700 }, error: null });
    const updateBalanceQuery = createQueryBuilder({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce(fetchQuery)
      .mockReturnValueOnce(updateQuery)
      .mockReturnValueOnce(balanceQuery)
      .mockReturnValueOnce(updateBalanceQuery);

    await updateManualLoanPayment('payment-1', 'loan-1', { principal_portion: 250, interest_portion: 100 });

    expect(updateQuery.update).toHaveBeenCalledWith({ principal_portion: 250, interest_portion: 100 });
    // Old portion (300) applied 300 to balance; new portion (250) should give 50 back.
    expect(updateBalanceQuery.update.mock.calls[0][0]).toMatchObject({ current_balance: 750 });
  });

  it('returns null without adjusting balance when the payment does not exist', async () => {
    const fetchQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(fetchQuery);

    const result = await updateManualLoanPayment('payment-1', 'loan-1', { principal_portion: 250 });

    expect(result).toBeNull();
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('does not touch the balance when principal_portion is not part of the update', async () => {
    const fetchQuery = createQueryBuilder({ data: { principal_portion: 300 }, error: null });
    const updateQuery = createQueryBuilder({ data: { id: 'payment-1', notes: 'Updated note' }, error: null });
    mockFrom.mockReturnValueOnce(fetchQuery).mockReturnValueOnce(updateQuery);

    await updateManualLoanPayment('payment-1', 'loan-1', { notes: 'Updated note' });

    expect(mockFrom).toHaveBeenCalledTimes(2);
  });
});

describe('deleteManualLoanPayment', () => {
  it('deletes the payment and restores the loan balance by its principal portion', async () => {
    const fetchQuery = createQueryBuilder({ data: { principal_portion: 300 }, error: null });
    const deleteQuery = createQueryBuilder({ data: null, error: null });
    const balanceQuery = createQueryBuilder({ data: { current_balance: 700 }, error: null });
    const updateBalanceQuery = createQueryBuilder({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce(fetchQuery)
      .mockReturnValueOnce(deleteQuery)
      .mockReturnValueOnce(balanceQuery)
      .mockReturnValueOnce(updateBalanceQuery);

    await deleteManualLoanPayment('payment-1', 'loan-1');

    expect(deleteQuery.delete).toHaveBeenCalled();
    expect(updateBalanceQuery.update.mock.calls[0][0]).toMatchObject({ current_balance: 1000 });
  });

  it('does nothing when the payment does not exist', async () => {
    const fetchQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(fetchQuery);

    await deleteManualLoanPayment('payment-1', 'loan-1');

    expect(mockFrom).toHaveBeenCalledTimes(1);
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
