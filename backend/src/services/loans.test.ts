import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreditCardLiability, MortgageLiability, StudentLoan } from 'plaid';

// loans.ts also imports plaidService/dataService for refreshLoansForItem, which transitively
// pull in env-dependent config (Plaid client, Supabase client) — mock both so this file (which
// mostly tests pure functions) doesn't depend on real env vars being present, matching how
// netWorth.test.ts and syncService.test.ts handle the same situation.
const mockGetLiabilities = vi.hoisted(() => vi.fn());
vi.mock('./plaidService', () => ({ getLiabilities: mockGetLiabilities }));

const mockUpsertLoans = vi.hoisted(() => vi.fn());
const mockListManualLoans = vi.hoisted(() => vi.fn());
const mockLinkTransactionToLoan = vi.hoisted(() => vi.fn());
const mockGetUnlinkedOutflowTransactionsForUser = vi.hoisted(() => vi.fn());
const mockGetUnlinkedTransactionsByPlaidIds = vi.hoisted(() => vi.fn());
vi.mock('./dataService', () => ({
  upsertLoans: mockUpsertLoans,
  listManualLoans: mockListManualLoans,
  linkTransactionToLoan: mockLinkTransactionToLoan,
  getUnlinkedOutflowTransactionsForUser: mockGetUnlinkedOutflowTransactionsForUser,
  getUnlinkedTransactionsByPlaidIds: mockGetUnlinkedTransactionsByPlaidIds,
}));

const mockRepairExistingRelationalRoles = vi.hoisted(() => vi.fn());
vi.mock('./roleReconciliation', () => ({
  repairExistingRelationalRoles: mockRepairExistingRelationalRoles,
}));

import {
  backfillMatchesForLoan,
  computePayoffProgressPct,
  linkNewTransactionsToManualLoans,
  matchTransactionToLoan,
  normalizeLiabilities,
  refreshLoansForItem,
} from './loans';

// These fixtures intentionally only fill in the fields normalizeLiabilities actually reads —
// Plaid's real interfaces have many more optional/required fields we don't touch, so casting
// through `unknown` avoids test fixtures ballooning to satisfy fields irrelevant to this logic.
function baseStudentLoan(overrides: Record<string, unknown> = {}): StudentLoan {
  return {
    account_id: 'acc-student',
    interest_rate_percentage: 5.5,
    is_overdue: false,
    last_payment_amount: 200,
    last_payment_date: '2026-07-01',
    loan_name: 'Consolidation Loan',
    minimum_payment_amount: 200,
    next_payment_due_date: '2026-09-01',
    origination_date: '2020-01-01',
    origination_principal_amount: 20000,
    ...overrides,
  } as unknown as StudentLoan;
}

function baseMortgage(overrides: Record<string, unknown> = {}): MortgageLiability {
  return {
    account_id: 'acc-mortgage',
    interest_rate: { percentage: 6.25, type: 'fixed' },
    last_payment_amount: 1800,
    last_payment_date: '2026-07-01',
    loan_type_description: 'conventional',
    next_monthly_payment: 1800,
    next_payment_due_date: '2026-09-01',
    origination_date: '2020-01-01',
    origination_principal_amount: 300000,
    ...overrides,
  } as unknown as MortgageLiability;
}

function baseCreditCard(overrides: Record<string, unknown> = {}): CreditCardLiability {
  return {
    account_id: 'acc-credit',
    aprs: [
      { apr_percentage: 24.99, apr_type: 'balance_transfer_apr' },
      { apr_percentage: 19.99, apr_type: 'purchase_apr' },
    ],
    is_overdue: false,
    last_payment_amount: 100,
    last_payment_date: '2026-07-01',
    last_statement_balance: 500,
    minimum_payment_amount: 35,
    next_payment_due_date: '2026-08-01',
    ...overrides,
  } as unknown as CreditCardLiability;
}

describe('normalizeLiabilities', () => {
  it('normalizes a student loan into the common shape', () => {
    const [loan] = normalizeLiabilities({ student: [baseStudentLoan()], mortgage: null, credit: null });
    expect(loan).toMatchObject({
      plaid_account_id: 'acc-student',
      loan_type: 'student',
      name: 'Consolidation Loan',
      interest_rate_percentage: 5.5,
      origination_principal_amount: 20000,
    });
  });

  it('normalizes a mortgage, pulling the rate out of the nested interest_rate object', () => {
    const [loan] = normalizeLiabilities({ student: null, mortgage: [baseMortgage()], credit: null });
    expect(loan).toMatchObject({
      plaid_account_id: 'acc-mortgage',
      loan_type: 'mortgage',
      interest_rate_percentage: 6.25,
      origination_principal_amount: 300000,
      minimum_payment_amount: 1800,
    });
  });

  it('normalizes a credit card, preferring the purchase_apr over other APR types', () => {
    const [loan] = normalizeLiabilities({ student: null, mortgage: null, credit: [baseCreditCard()] });
    expect(loan).toMatchObject({
      plaid_account_id: 'acc-credit',
      loan_type: 'credit',
      interest_rate_percentage: 19.99,
      origination_principal_amount: null,
    });
  });

  it('falls back to the first APR when no purchase_apr is present', () => {
    const [loan] = normalizeLiabilities({
      student: null,
      mortgage: null,
      credit: [baseCreditCard({ aprs: [{ apr_percentage: 22, apr_type: 'cash_apr' }] })],
    });
    expect(loan.interest_rate_percentage).toBe(22);
  });

  it('drops a student/credit liability with a null account_id rather than crashing', () => {
    const loans = normalizeLiabilities({
      student: [baseStudentLoan({ account_id: null })],
      mortgage: null,
      credit: [baseCreditCard({ account_id: null })],
    });
    expect(loans).toEqual([]);
  });

  it('combines all three categories and handles nulls for missing ones', () => {
    const loans = normalizeLiabilities({
      student: [baseStudentLoan()],
      mortgage: [baseMortgage()],
      credit: [baseCreditCard()],
    });
    expect(loans).toHaveLength(3);
    expect(loans.map((l) => l.loan_type)).toEqual(['student', 'mortgage', 'credit']);
  });

  it('returns an empty array when every category is null', () => {
    expect(normalizeLiabilities({ student: null, mortgage: null, credit: null })).toEqual([]);
  });
});

describe('computePayoffProgressPct', () => {
  it('computes the percentage paid off', () => {
    expect(computePayoffProgressPct(20000, 15000)).toBe(25);
  });

  it('returns null when there is no known original amount (e.g. a credit card)', () => {
    expect(computePayoffProgressPct(null, 500)).toBeNull();
  });

  it('returns null when the current balance is unknown', () => {
    expect(computePayoffProgressPct(20000, null)).toBeNull();
  });

  it('clamps at 0% for a balance that grew past the original amount', () => {
    expect(computePayoffProgressPct(20000, 21000)).toBe(0);
  });

  it('clamps at 100% for a fully paid off (or negative) balance', () => {
    expect(computePayoffProgressPct(20000, -50)).toBe(100);
  });

  it('treats a zero or negative original amount as unknown rather than dividing by zero', () => {
    expect(computePayoffProgressPct(0, 100)).toBeNull();
  });
});

describe('refreshLoansForItem', () => {
  beforeEach(() => {
    mockGetLiabilities.mockReset();
    mockUpsertLoans.mockReset();
  });

  it('fetches liabilities, normalizes them, and upserts against the given account map', async () => {
    mockGetLiabilities.mockResolvedValue({
      student: [baseStudentLoan()],
      mortgage: null,
      credit: null,
    });
    const accountMap = new Map([['acc-student', 'account-row-1']]);

    await refreshLoansForItem('item-row-1', 'access-token-1', accountMap);

    expect(mockGetLiabilities).toHaveBeenCalledWith('access-token-1');
    expect(mockUpsertLoans).toHaveBeenCalledWith(
      'item-row-1',
      [expect.objectContaining({ plaid_account_id: 'acc-student', loan_type: 'student' })],
      accountMap
    );
  });

  it('swallows a failure (e.g. liabilities product not enabled) rather than throwing', async () => {
    mockGetLiabilities.mockRejectedValue(new Error('liabilities not enabled for this item'));

    await expect(refreshLoansForItem('item-row-1', 'access-token-1', new Map())).resolves.toBeUndefined();
    expect(mockUpsertLoans).not.toHaveBeenCalled();
  });
});

describe('matchTransactionToLoan', () => {
  const sofiLoan = { id: 'loan-1', match_text: 'SoFi' };

  it('matches a transaction whose name contains the match text, case-insensitively', () => {
    const txn = { name: 'SOFI PAYMENT', merchant_name: null, amount: 250 };
    expect(matchTransactionToLoan(txn, [sofiLoan])).toBe('loan-1');
  });

  it('matches against merchant_name too', () => {
    const txn = { name: 'Online Payment', merchant_name: 'SoFi', amount: 250 };
    expect(matchTransactionToLoan(txn, [sofiLoan])).toBe('loan-1');
  });

  it('returns null when nothing matches', () => {
    const txn = { name: 'Coffee Shop', merchant_name: null, amount: 5 };
    expect(matchTransactionToLoan(txn, [sofiLoan])).toBeNull();
  });

  it('ignores inflow (non-positive amount) transactions even if the name matches', () => {
    const txn = { name: 'SoFi Refund', merchant_name: null, amount: -250 };
    expect(matchTransactionToLoan(txn, [sofiLoan])).toBeNull();
  });

  it('ignores loans with an empty match_text', () => {
    const txn = { name: 'SoFi Payment', merchant_name: null, amount: 250 };
    expect(matchTransactionToLoan(txn, [{ id: 'loan-1', match_text: '  ' }])).toBeNull();
  });

  it('returns the first matching loan when more than one matches', () => {
    const txn = { name: 'SoFi Payment', merchant_name: null, amount: 250 };
    const loans = [sofiLoan, { id: 'loan-2', match_text: 'Payment' }];
    expect(matchTransactionToLoan(txn, loans)).toBe('loan-1');
  });
});

describe('linkNewTransactionsToManualLoans', () => {
  beforeEach(() => {
    mockListManualLoans.mockReset();
    mockLinkTransactionToLoan.mockReset();
    mockLinkTransactionToLoan.mockResolvedValue('linked');
    mockGetUnlinkedTransactionsByPlaidIds.mockReset();
    mockGetUnlinkedTransactionsByPlaidIds.mockResolvedValue([]);
    mockRepairExistingRelationalRoles.mockReset();
    mockRepairExistingRelationalRoles.mockResolvedValue(undefined);
  });

  it("re-derives candidates from Plaid's own transaction ids (Round 6 remediation, blocker 5) rather than a caller-supplied insertedTransactions list, then links matches", async () => {
    mockListManualLoans.mockResolvedValue([
      { id: 'loan-1', match_text: 'SoFi' },
      { id: 'loan-2', match_text: null },
    ]);
    mockGetUnlinkedTransactionsByPlaidIds.mockResolvedValue([
      { id: 'txn-1', name: 'SoFi Payment', merchant_name: null, amount: 250 },
      { id: 'txn-2', name: 'Coffee Shop', merchant_name: null, amount: 5 },
    ]);

    await linkNewTransactionsToManualLoans('user-1', ['plaid-txn-1', 'plaid-txn-2']);

    expect(mockGetUnlinkedTransactionsByPlaidIds).toHaveBeenCalledWith('user-1', ['plaid-txn-1', 'plaid-txn-2']);
    expect(mockLinkTransactionToLoan).toHaveBeenCalledTimes(1);
    expect(mockLinkTransactionToLoan).toHaveBeenCalledWith('user-1', 'txn-1', 'loan-1', 250);
  });

  it('does NOT run its own repair sweep (Round 4 remediation §7 — syncService.ts owns the sweep centrally, gated on Plaid\'s own added/modified/removed counts rather than on whether this call linked anything, which is what makes it retry-safe)', async () => {
    mockListManualLoans.mockResolvedValue([{ id: 'loan-1', match_text: 'SoFi' }]);
    mockGetUnlinkedTransactionsByPlaidIds.mockResolvedValue([
      { id: 'txn-1', name: 'SoFi Payment', merchant_name: null, amount: 250 },
    ]);

    await linkNewTransactionsToManualLoans('user-1', ['plaid-txn-1']);

    expect(mockRepairExistingRelationalRoles).not.toHaveBeenCalled();
  });

  it('does nothing when there are no plaid transaction ids to consider', async () => {
    await linkNewTransactionsToManualLoans('user-1', []);
    expect(mockListManualLoans).not.toHaveBeenCalled();
    expect(mockGetUnlinkedTransactionsByPlaidIds).not.toHaveBeenCalled();
  });

  it('does nothing when no loans have a match_text set (never even queries candidates)', async () => {
    mockListManualLoans.mockResolvedValue([{ id: 'loan-1', match_text: null }]);

    await linkNewTransactionsToManualLoans('user-1', ['plaid-txn-1']);

    expect(mockGetUnlinkedTransactionsByPlaidIds).not.toHaveBeenCalled();
    expect(mockLinkTransactionToLoan).not.toHaveBeenCalled();
  });

  it('swallows a failure rather than throwing (best-effort, piggybacking on a sync)', async () => {
    mockListManualLoans.mockRejectedValue(new Error('db down'));

    await expect(linkNewTransactionsToManualLoans('user-1', ['plaid-txn-1'])).resolves.toBeUndefined();
  });

  it('a retry re-derives candidates fresh, so a transaction still unlinked from a failed attempt is retried, and one already linked is naturally excluded by the query filter', async () => {
    mockListManualLoans.mockResolvedValue([{ id: 'loan-1', match_text: 'SoFi' }]);
    // Simulates attempt 2: the row that failed to link in attempt 1 is still unlinked and still
    // returned by getUnlinkedTransactionsByPlaidIds (a row that DID succeed in attempt 1 would no
    // longer come back, since the real query filters manual_loan_id IS NULL).
    mockGetUnlinkedTransactionsByPlaidIds.mockResolvedValue([
      { id: 'txn-1', name: 'SoFi Payment', merchant_name: null, amount: 250 },
    ]);

    await linkNewTransactionsToManualLoans('user-1', ['plaid-txn-1']);

    expect(mockLinkTransactionToLoan).toHaveBeenCalledWith('user-1', 'txn-1', 'loan-1', 250);
  });

  it.each(['already_linked', 'already_linked_different_principal', 'linked_to_other_loan'])(
    'a candidate an overlapping caller already linked (%s) is logged and skipped, and the remaining candidates still link (post-audit blocker 1)',
    async (outcome) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockListManualLoans.mockResolvedValue([{ id: 'loan-1', match_text: 'SoFi' }]);
      mockGetUnlinkedTransactionsByPlaidIds.mockResolvedValue([
        { id: 'txn-1', name: 'SoFi Payment', merchant_name: null, amount: 250 },
        { id: 'txn-2', name: 'SoFi Payment', merchant_name: null, amount: 300 },
      ]);
      mockLinkTransactionToLoan.mockResolvedValueOnce(outcome);

      await linkNewTransactionsToManualLoans('user-1', ['plaid-txn-1', 'plaid-txn-2']);

      expect(mockLinkTransactionToLoan).toHaveBeenCalledTimes(2);
      expect(mockLinkTransactionToLoan).toHaveBeenLastCalledWith('user-1', 'txn-2', 'loan-1', 300);
      expect(info).toHaveBeenCalledWith(`Skipped linking transaction txn-1 to manual loan loan-1: ${outcome}`);
      expect(error).not.toHaveBeenCalled();
      info.mockRestore();
      error.mockRestore();
    }
  );
});

describe('backfillMatchesForLoan', () => {
  beforeEach(() => {
    mockGetUnlinkedOutflowTransactionsForUser.mockReset();
    mockLinkTransactionToLoan.mockReset();
    mockLinkTransactionToLoan.mockResolvedValue('linked');
    mockRepairExistingRelationalRoles.mockReset();
    mockRepairExistingRelationalRoles.mockResolvedValue(undefined);
    mockGetUnlinkedOutflowTransactionsForUser.mockResolvedValue([]);
  });

  it('links unlinked transactions matching the loan match_text', async () => {
    mockGetUnlinkedOutflowTransactionsForUser.mockResolvedValue([
      { id: 'txn-1', name: 'SoFi Payment', merchant_name: null, amount: 250 },
      { id: 'txn-2', name: 'Coffee Shop', merchant_name: null, amount: 5 },
    ]);

    await backfillMatchesForLoan('user-1', { id: 'loan-1', match_text: 'SoFi' });

    expect(mockLinkTransactionToLoan).toHaveBeenCalledTimes(1);
    expect(mockLinkTransactionToLoan).toHaveBeenCalledWith('user-1', 'txn-1', 'loan-1', 250);
  });

  it('runs the repair sweep once matching completes (Round 3 remediation §2/§3 — a payment that was previously relational, e.g. an ordinary expense some refund had matched against, can be invalidated by this link)', async () => {
    mockGetUnlinkedOutflowTransactionsForUser.mockResolvedValue([
      { id: 'txn-1', name: 'SoFi Payment', merchant_name: null, amount: 250 },
    ]);

    await backfillMatchesForLoan('user-1', { id: 'loan-1', match_text: 'SoFi' });

    expect(mockRepairExistingRelationalRoles).toHaveBeenCalledWith('user-1');
  });

  it('runs the repair sweep UNCONDITIONALLY, even when nothing new was linked this call (Round 4 remediation §7 — a retry after a prior successful link whose repair failed must still repair the already-linked row, which by then is no longer an "unlinked" candidate)', async () => {
    mockGetUnlinkedOutflowTransactionsForUser.mockResolvedValue([]); // nothing to link this time

    await backfillMatchesForLoan('user-1', { id: 'loan-1', match_text: 'SoFi' });

    expect(mockLinkTransactionToLoan).not.toHaveBeenCalled();
    expect(mockRepairExistingRelationalRoles).toHaveBeenCalledWith('user-1');
  });

  it('propagates (does NOT swallow) a single failed link — this is a direct, synchronous user action, and the whole operation must be reported incomplete rather than silently missing a payment (Round 5 remediation, blocker 5)', async () => {
    mockGetUnlinkedOutflowTransactionsForUser.mockResolvedValue([
      { id: 'txn-1', name: 'SoFi Payment', merchant_name: null, amount: 250 },
      { id: 'txn-2', name: 'SoFi Payment', merchant_name: null, amount: 300 },
    ]);
    mockLinkTransactionToLoan.mockRejectedValueOnce(new Error('link failed'));

    await expect(backfillMatchesForLoan('user-1', { id: 'loan-1', match_text: 'SoFi' })).rejects.toThrow('link failed');

    // The second candidate is never attempted, and the sweep never runs — the caller sees a
    // clean failure and can retry the whole operation.
    expect(mockLinkTransactionToLoan).toHaveBeenCalledTimes(1);
    expect(mockRepairExistingRelationalRoles).not.toHaveBeenCalled();
  });

  it.each(['already_linked', 'already_linked_different_principal', 'linked_to_other_loan'])(
    'a stale candidate (%s) is not a failure: the backfill skips it, links the rest and still runs the sweep (post-audit blocker 1)',
    async (outcome) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      mockGetUnlinkedOutflowTransactionsForUser.mockResolvedValue([
        { id: 'txn-1', name: 'SoFi Payment', merchant_name: null, amount: 250 },
        { id: 'txn-2', name: 'SoFi Payment', merchant_name: null, amount: 300 },
      ]);
      mockLinkTransactionToLoan.mockResolvedValueOnce(outcome);

      await expect(backfillMatchesForLoan('user-1', { id: 'loan-1', match_text: 'SoFi' })).resolves.toBeUndefined();

      expect(mockLinkTransactionToLoan).toHaveBeenCalledTimes(2);
      expect(info).toHaveBeenCalledWith(`Skipped linking transaction txn-1 to manual loan loan-1: ${outcome}`);
      expect(mockRepairExistingRelationalRoles).toHaveBeenCalledWith('user-1');
      info.mockRestore();
    }
  );

  it('does nothing when the loan has no match_text', async () => {
    await backfillMatchesForLoan('user-1', { id: 'loan-1', match_text: null });
    expect(mockGetUnlinkedOutflowTransactionsForUser).not.toHaveBeenCalled();
    expect(mockRepairExistingRelationalRoles).not.toHaveBeenCalled();
  });

  it('propagates (does NOT swallow) a repair-sweep failure — Round 4 remediation §7: the caller must see this as an incomplete operation, not a silent success', async () => {
    mockGetUnlinkedOutflowTransactionsForUser.mockResolvedValue([]);
    mockRepairExistingRelationalRoles.mockRejectedValue(new Error('sweep failed'));

    await expect(backfillMatchesForLoan('user-1', { id: 'loan-1', match_text: 'SoFi' })).rejects.toThrow('sweep failed');
  });
});
