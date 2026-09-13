import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetTransactionsBackfillPage = vi.hoisted(() => vi.fn());
const mockUpdateTransactionRoleFields = vi.hoisted(() => vi.fn());
vi.mock('../services/dataService', () => ({
  getTransactionsBackfillPage: mockGetTransactionsBackfillPage,
  updateTransactionRoleFields: mockUpdateTransactionRoleFields,
}));

const mockReconcileRelationalRoles = vi.hoisted(() => vi.fn());
vi.mock('../services/roleReconciliation', () => ({
  reconcileRelationalRoles: mockReconcileRelationalRoles,
}));

import { parseArgs, ArgError, processPage, main, __setInterruptedForTests } from './backfillTransactionSemantics';

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
    auto_role: null,
    classifier_version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __setInterruptedForTests(false);
  mockUpdateTransactionRoleFields.mockResolvedValue(true);
  mockReconcileRelationalRoles.mockResolvedValue({ resolved: [], unresolved: [] });
});

describe('parseArgs', () => {
  it('defaults to dry run, default batch size, target version = current classifier version, no cursor, not forced', () => {
    expect(parseArgs([])).toEqual({ batchSize: 500, apply: false, force: false, targetVersion: 1, after: null });
  });

  it('accepts --apply, --force, --batch-size, --target-version, --after-date/--after-id together', () => {
    expect(
      parseArgs(['--apply', '--force', '--batch-size', '250', '--target-version', '2', '--after-date', '2026-01-01', '--after-id', 'abc'])
    ).toEqual({ batchSize: 250, apply: true, force: true, targetVersion: 2, after: { date: '2026-01-01', id: 'abc' } });
  });

  it('rejects a non-positive-integer --batch-size or --target-version', () => {
    expect(() => parseArgs(['--batch-size', '0'])).toThrow(ArgError);
    expect(() => parseArgs(['--batch-size', 'abc'])).toThrow(ArgError);
    expect(() => parseArgs(['--target-version', '0'])).toThrow(ArgError);
  });

  it('rejects --after-date without --after-id and vice versa', () => {
    expect(() => parseArgs(['--after-date', '2026-01-01'])).toThrow(ArgError);
    expect(() => parseArgs(['--after-id', 'abc'])).toThrow(ArgError);
  });

  it('rejects an unrecognized argument', () => {
    expect(() => parseArgs(['--wat'])).toThrow(ArgError);
  });
});

describe('processPage — classification', () => {
  it('dry run: classifies but writes nothing and never calls reconciliation with apply=true', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([fakeRow({ amount: 25 })]);

    const result = await processPage(null, 500, false, false, 1);

    expect(result.classified).toBe(1);
    expect(result.byRole).toEqual({ expense: 1 });
    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
    expect(mockReconcileRelationalRoles).toHaveBeenCalledWith('user-1', ['txn-1'], false);
  });

  it('apply mode: writes role fields for rows needing classification and runs reconciliation once per user over the WHOLE page', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([
      fakeRow({ id: 'txn-1', user_id: 'user-a', amount: 25, auto_role: null }),
      fakeRow({ id: 'txn-2', user_id: 'user-a', amount: -10, auto_role: 'income', classifier_version: 1 }), // already classified, current version
      fakeRow({ id: 'txn-3', user_id: 'user-b', amount: 50, auto_role: null }),
    ]);

    const result = await processPage(null, 500, true, false, 1);

    // Only the two rows lacking auto_role actually get written.
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledTimes(2);
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('user-a', 'txn-1', expect.any(Object));
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('user-b', 'txn-3', expect.any(Object));
    // Reconciliation runs per user over the FULL page's ids for that user, including the
    // already-classified txn-2 — a page's evidence can still matter even for rows that didn't
    // need a fresh row-level write this run.
    expect(mockReconcileRelationalRoles).toHaveBeenCalledWith('user-a', ['txn-1', 'txn-2'], true);
    expect(mockReconcileRelationalRoles).toHaveBeenCalledWith('user-b', ['txn-3'], true);
    expect(result.classified).toBe(2);
  });

  it('skips rewriting a row that is already classified at or above the target version, without --force', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([fakeRow({ auto_role: 'expense', classifier_version: 1 })]);

    const result = await processPage(null, 500, true, false, 1);

    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
    expect(result.classified).toBe(0);
  });

  it('reclassifies a row whose classifier_version is behind the target version (future classifier-version backfill, Round 2 remediation §13)', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([fakeRow({ auto_role: 'expense', classifier_version: 1 })]);

    const result = await processPage(null, 500, true, false, 2);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledTimes(1);
    expect(result.classified).toBe(1);
  });

  it('--force reclassifies every row in the page regardless of auto_role/classifier_version', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([fakeRow({ auto_role: 'expense', classifier_version: 1 })]);

    const result = await processPage(null, 500, true, true, 1);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledTimes(1);
    expect(result.classified).toBe(1);
  });

  it('a historical row already linked to a manual loan classifies as debt_payment via manual_loan_link', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([fakeRow({ amount: 500, manual_loan_id: 'loan-1', category: 'GENERAL_MERCHANDISE' })]);

    const result = await processPage(null, 500, true, false, 1);

    expect(result.byRole).toEqual({ debt_payment: 1 });
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('user-1', 'txn-1', {
      auto_role: 'debt_payment',
      role_source: 'manual_loan_link',
      role_confidence: 'high',
      classifier_version: 1,
    });
  });

  it('never touches category_mappings/transaction_splits/manual_loans/principal_portion/user_role_override — only ever writes the four role fields', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([fakeRow()]);
    await processPage(null, 500, true, false, 1);
    const written = mockUpdateTransactionRoleFields.mock.calls[0][2];
    expect(Object.keys(written).sort()).toEqual(['auto_role', 'classifier_version', 'role_confidence', 'role_source'].sort());
  });

  it('returns a keyset cursor pointing at the last row of the page', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([
      fakeRow({ id: 'a', date: '2026-01-01' }),
      fakeRow({ id: 'b', date: '2026-01-02' }),
    ]);
    const result = await processPage(null, 500, true, false, 1);
    expect(result.nextCursor).toEqual({ date: '2026-01-02', id: 'b' });
  });

  it('passes the given cursor straight through to getTransactionsBackfillPage', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([]);
    await processPage({ date: '2026-01-01', id: 'abc' }, 500, true, false, 1);
    expect(mockGetTransactionsBackfillPage).toHaveBeenCalledWith(500, { date: '2026-01-01', id: 'abc' });
  });

  it('a reconciliation failure for one user propagates out of processPage (Round 2 remediation §12 — not treated as success)', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([fakeRow()]);
    mockReconcileRelationalRoles.mockRejectedValue(new Error('boom'));

    await expect(processPage(null, 500, true, false, 1)).rejects.toThrow('boom');
  });
});

describe('main — keyset traversal terminates correctly (Round 2 remediation §11)', () => {
  it('dry run: terminates after visiting each row once across multiple pages, never re-fetching the same first page', async () => {
    mockGetTransactionsBackfillPage
      .mockResolvedValueOnce([fakeRow({ id: 'a', date: '2026-01-01' }), fakeRow({ id: 'b', date: '2026-01-02' })])
      .mockResolvedValueOnce([fakeRow({ id: 'c', date: '2026-01-03' })]); // partial page -> stop

    const code = await main(['--batch-size', '2']);

    expect(code).toBe(0);
    expect(mockGetTransactionsBackfillPage).toHaveBeenCalledTimes(2);
    // Second call must use a DIFFERENT (advanced) cursor than the first (no repeated first page).
    expect(mockGetTransactionsBackfillPage).toHaveBeenNthCalledWith(1, 2, null);
    expect(mockGetTransactionsBackfillPage).toHaveBeenNthCalledWith(2, 2, { date: '2026-01-02', id: 'b' });
    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled(); // dry run: zero writes
  });

  it('terminates immediately on an empty first page', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValueOnce([]);
    const code = await main([]);
    expect(code).toBe(0);
    expect(mockGetTransactionsBackfillPage).toHaveBeenCalledTimes(1);
  });

  it('resumes from an explicit --after-date/--after-id cursor', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValueOnce([]);
    await main(['--after-date', '2026-05-01', '--after-id', 'resume-id']);
    expect(mockGetTransactionsBackfillPage).toHaveBeenCalledWith(500, { date: '2026-05-01', id: 'resume-id' });
  });

  it('reports the total classified count and role breakdown across pages', async () => {
    mockGetTransactionsBackfillPage
      .mockResolvedValueOnce([fakeRow({ id: 'a', date: '2026-01-01', amount: 10 }), fakeRow({ id: 'b', date: '2026-01-02', amount: -10 })])
      .mockResolvedValueOnce([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['--batch-size', '2', '--apply']);
    const doneLine = logSpy.mock.calls.map((c) => JSON.parse(c[0] as string)).find((l) => l.stage === 'done');
    logSpy.mockRestore();

    expect(code).toBe(0);
    expect(doneLine.count).toBe(2);
    expect(doneLine.byRole).toEqual({ expense: 1, income: 1 });
  });

  it('stops immediately, before fetching any page at all, when already interrupted', async () => {
    __setInterruptedForTests(true);
    const code = await main([]);
    expect(code).toBe(1);
    expect(mockGetTransactionsBackfillPage).not.toHaveBeenCalled();
  });

  it('checks interruption again before starting a would-be second page, not just once at startup', async () => {
    mockGetTransactionsBackfillPage.mockImplementationOnce(async () => {
      __setInterruptedForTests(true);
      return Array.from({ length: 5 }, (_, i) => fakeRow({ id: `t${i}`, date: `2026-01-0${i + 1}` }));
    });

    const code = await main(['--batch-size', '5']);

    expect(code).toBe(1);
    expect(mockGetTransactionsBackfillPage).toHaveBeenCalledTimes(1);
  });

  it('surfaces invalid arguments as a non-zero exit without calling the page loop at all', async () => {
    const code = await main(['--batch-size', 'nope']);
    expect(code).toBe(1);
    expect(mockGetTransactionsBackfillPage).not.toHaveBeenCalled();
  });
});

describe('main — apply-mode failure and retry (Round 2 remediation §12)', () => {
  it('a reconciliation failure during apply is reported as an incomplete run (nonzero), not success, and does not advance past the failed page', async () => {
    mockGetTransactionsBackfillPage.mockResolvedValue([fakeRow({ id: 'a', date: '2026-01-01' })]);
    mockReconcileRelationalRoles.mockRejectedValueOnce(new Error('transient failure'));

    const code = await main(['--apply']);

    expect(code).toBe(1);
  });

  it('rerunning after a reconciliation failure safely repairs the affected page — the row-level write already having happened does not cause it to be skipped', async () => {
    // First run: row-level write succeeds, reconciliation fails.
    mockGetTransactionsBackfillPage.mockResolvedValueOnce([fakeRow({ id: 'a', date: '2026-01-01', auto_role: null })]);
    mockReconcileRelationalRoles.mockRejectedValueOnce(new Error('transient failure'));
    const firstCode = await main(['--apply']);
    expect(firstCode).toBe(1);
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledTimes(1);

    // Rerun: the SAME row is fetched again (keyset traversal is independent of auto_role — see
    // getTransactionsBackfillPage's own contract) — now already classified, so no rewrite, but
    // reconciliation is retried and this time succeeds.
    mockGetTransactionsBackfillPage.mockReset();
    mockGetTransactionsBackfillPage.mockResolvedValueOnce([fakeRow({ id: 'a', date: '2026-01-01', auto_role: 'expense', classifier_version: 1 })]);
    mockReconcileRelationalRoles.mockResolvedValueOnce({ resolved: [], unresolved: [] });

    const secondCode = await main(['--apply']);

    expect(secondCode).toBe(0);
    expect(mockReconcileRelationalRoles).toHaveBeenCalledTimes(2); // once failed, once succeeded
  });
});
