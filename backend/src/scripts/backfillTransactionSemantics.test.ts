import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUnclassifiedTransactionsBatch = vi.hoisted(() => vi.fn());
const mockUpdateTransactionRoleFields = vi.hoisted(() => vi.fn());
vi.mock('../services/dataService', () => ({
  getUnclassifiedTransactionsBatch: mockGetUnclassifiedTransactionsBatch,
  updateTransactionRoleFields: mockUpdateTransactionRoleFields,
}));

const mockReconcileRelationalRoles = vi.hoisted(() => vi.fn());
vi.mock('../services/roleReconciliation', () => ({
  reconcileRelationalRoles: mockReconcileRelationalRoles,
}));

import {
  parseArgs,
  ArgError,
  processBatch,
  main,
  __setInterruptedForTests,
} from './backfillTransactionSemantics';

function fakeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'txn-1',
    user_id: 'user-1',
    amount: 25,
    date: '2026-01-01',
    category: null,
    personal_finance_category_detailed: null,
    personal_finance_category_confidence: null,
    manual_loan_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __setInterruptedForTests(false);
  mockUpdateTransactionRoleFields.mockResolvedValue(undefined);
  mockReconcileRelationalRoles.mockResolvedValue(undefined);
});

describe('parseArgs', () => {
  it('defaults to dry run with the default batch size', () => {
    expect(parseArgs([])).toEqual({ batchSize: 500, apply: false });
  });

  it('accepts --apply and --batch-size', () => {
    expect(parseArgs(['--apply', '--batch-size', '250'])).toEqual({ batchSize: 250, apply: true });
  });

  it('rejects a non-positive-integer --batch-size', () => {
    expect(() => parseArgs(['--batch-size', '0'])).toThrow(ArgError);
    expect(() => parseArgs(['--batch-size', 'abc'])).toThrow(ArgError);
    expect(() => parseArgs(['--batch-size'])).toThrow(ArgError);
  });

  it('rejects an unrecognized argument', () => {
    expect(() => parseArgs(['--wat'])).toThrow(ArgError);
  });
});

describe('processBatch', () => {
  it('dry run: classifies but writes nothing and never calls reconciliation', async () => {
    mockGetUnclassifiedTransactionsBatch.mockResolvedValue([fakeRow({ amount: 25 })]);

    const result = await processBatch(500, false);

    expect(result).toEqual({ processed: 1, byRole: { expense: 1 } });
    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
    expect(mockReconcileRelationalRoles).not.toHaveBeenCalled();
  });

  it('apply mode: writes role fields for every row and runs reconciliation once per user, scoped to that user\'s touched ids', async () => {
    mockGetUnclassifiedTransactionsBatch.mockResolvedValue([
      fakeRow({ id: 'txn-1', user_id: 'user-a', amount: 25 }),
      fakeRow({ id: 'txn-2', user_id: 'user-a', amount: -10 }),
      fakeRow({ id: 'txn-3', user_id: 'user-b', amount: 50 }),
    ]);

    await processBatch(500, true);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledTimes(3);
    expect(mockReconcileRelationalRoles).toHaveBeenCalledWith('user-a', ['txn-1', 'txn-2']);
    expect(mockReconcileRelationalRoles).toHaveBeenCalledWith('user-b', ['txn-3']);
  });

  it('a historical row already linked to a manual loan classifies as debt_payment via manual_loan_link, exactly as it would have at ingestion time', async () => {
    mockGetUnclassifiedTransactionsBatch.mockResolvedValue([
      fakeRow({ amount: 500, manual_loan_id: 'loan-1', category: 'GENERAL_MERCHANDISE' }),
    ]);

    const result = await processBatch(500, true);

    expect(result.byRole).toEqual({ debt_payment: 1 });
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('txn-1', {
      auto_role: 'debt_payment',
      role_source: 'manual_loan_link',
      role_confidence: 'high',
      classifier_version: 1,
    });
  });

  it('never touches category_mappings/transaction_splits/manual_loans/principal_portion/user_role_override — only ever writes the four role fields', async () => {
    mockGetUnclassifiedTransactionsBatch.mockResolvedValue([fakeRow()]);
    await processBatch(500, true);
    const written = mockUpdateTransactionRoleFields.mock.calls[0][1];
    expect(Object.keys(written).sort()).toEqual(['auto_role', 'classifier_version', 'role_confidence', 'role_source'].sort());
  });

  it('a per-user reconciliation failure is logged and does not throw out of processBatch (non-fatal, matches sync\'s best-effort pattern)', async () => {
    mockGetUnclassifiedTransactionsBatch.mockResolvedValue([fakeRow()]);
    mockReconcileRelationalRoles.mockRejectedValue(new Error('boom'));

    await expect(processBatch(500, true)).resolves.toEqual({ processed: 1, byRole: { expense: 1 } });
  });
});

describe('main', () => {
  it('dry run: loops until an empty batch, aggregates counts across batches, never writes', async () => {
    mockGetUnclassifiedTransactionsBatch
      .mockResolvedValueOnce([fakeRow({ id: 'a' }), fakeRow({ id: 'b' })])
      .mockResolvedValueOnce([]);

    const code = await main(['--batch-size', '2']);

    expect(code).toBe(0);
    expect(mockGetUnclassifiedTransactionsBatch).toHaveBeenCalledTimes(2);
    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
  });

  it('stops after a partial (final) page without querying again', async () => {
    mockGetUnclassifiedTransactionsBatch.mockResolvedValueOnce([fakeRow({ id: 'a' })]);

    const code = await main(['--batch-size', '5']);

    expect(code).toBe(0);
    expect(mockGetUnclassifiedTransactionsBatch).toHaveBeenCalledTimes(1);
  });

  it('stops immediately, before fetching any batch at all, when already interrupted', async () => {
    __setInterruptedForTests(true);

    const code = await main(['--batch-size', '5']);

    expect(code).toBe(1);
    expect(mockGetUnclassifiedTransactionsBatch).not.toHaveBeenCalled();
  });

  it('checks interruption again before starting a would-be second batch, not just once at startup', async () => {
    mockGetUnclassifiedTransactionsBatch.mockImplementationOnce(async () => {
      // Simulates a signal arriving while the first batch was in flight — by the time it
      // resolves and the loop is about to fetch a second (non-partial first page), it must stop.
      __setInterruptedForTests(true);
      return Array.from({ length: 5 }, (_, i) => fakeRow({ id: `t${i}` }));
    });

    const code = await main(['--batch-size', '5']);

    expect(code).toBe(1);
    expect(mockGetUnclassifiedTransactionsBatch).toHaveBeenCalledTimes(1);
  });

  it('surfaces invalid arguments as a non-zero exit without calling the batch loop at all', async () => {
    const code = await main(['--batch-size', 'nope']);
    expect(code).toBe(1);
    expect(mockGetUnclassifiedTransactionsBatch).not.toHaveBeenCalled();
  });
});
