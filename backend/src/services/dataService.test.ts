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
