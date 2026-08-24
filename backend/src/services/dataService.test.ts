import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountBase, RemovedTransaction, Transaction as PlaidTransaction } from 'plaid';
import { createQueryBuilder } from '../testUtils/supabaseMock';
import {
  upsertAccountsForItem,
  applyTransactionChanges,
  linkTransactionToLoan,
  updateLinkedPaymentPrincipal,
  unlinkPaymentFromLoan,
} from './dataService';

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: mockFrom } }));

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
    const insertedRow = { id: 'txn-row-new', name: 'Coffee Shop', merchant_name: 'Coffee Shop', amount: 12.5 };
    const insertQuery = createQueryBuilder({ data: [insertedRow], error: null });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(insertQuery);

    const result = await applyTransactionChanges({
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

  it('silently skips a transaction whose account is not in our accountIdByPlaidId map', async () => {
    // No known local account for this transaction (e.g. account not yet synced) — should be
    // dropped rather than inserted with a broken account_id.
    const result = await applyTransactionChanges({
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
      added: [],
      modified: [fakeTransaction({ pending: true })],
      removed: [],
      accountIdByPlaidId,
    });

    expect(updateQuery.update.mock.calls[0][0]).toMatchObject({ pending: true });
    expect(updateQuery.eq).toHaveBeenCalledWith('id', 'txn-row-1');
    // Only the existence-check select happened on the table — no separate insert call.
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('deletes removed transactions by their plaid_transaction_id', async () => {
    const deleteQuery = createQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(deleteQuery);

    await applyTransactionChanges({
      added: [],
      modified: [],
      removed: [fakeRemoved],
      accountIdByPlaidId,
    });

    expect(deleteQuery.delete).toHaveBeenCalled();
    expect(deleteQuery.in).toHaveBeenCalledWith('plaid_transaction_id', ['txn-removed']);
  });

  it('does nothing when there are no changes at all', async () => {
    await applyTransactionChanges({ added: [], modified: [], removed: [], accountIdByPlaidId });
    expect(mockFrom).not.toHaveBeenCalled();
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
