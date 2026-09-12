import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileRelationalRoles } from './roleReconciliation';
import type { ReconciliationRow } from './dataService';

const mockGetTransactionsForReconciliation = vi.hoisted(() => vi.fn());
const mockFindTransferCounterpartCandidate = vi.hoisted(() => vi.fn());
const mockFindRefundOriginalCandidates = vi.hoisted(() => vi.fn());
const mockFindDanglingRefundCandidates = vi.hoisted(() => vi.fn());
const mockUpdateTransactionRoleFields = vi.hoisted(() => vi.fn());

vi.mock('./dataService', () => ({
  getTransactionsForReconciliation: mockGetTransactionsForReconciliation,
  findTransferCounterpartCandidate: mockFindTransferCounterpartCandidate,
  findRefundOriginalCandidates: mockFindRefundOriginalCandidates,
  findDanglingRefundCandidates: mockFindDanglingRefundCandidates,
  updateTransactionRoleFields: mockUpdateTransactionRoleFields,
}));

function row(overrides: Partial<ReconciliationRow> = {}): ReconciliationRow {
  return {
    id: 'txn-1',
    account_id: 'acc-1',
    amount: 100,
    date: '2026-09-10',
    name: 'Transfer',
    merchant_name: null,
    category: 'TRANSFER_OUT',
    manual_loan_id: null,
    auto_role: 'expense',
    role_source: 'transfer_like_unconfirmed',
    role_confidence: 'low',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindTransferCounterpartCandidate.mockResolvedValue(null);
  mockFindRefundOriginalCandidates.mockResolvedValue([]);
  mockFindDanglingRefundCandidates.mockResolvedValue([]);
});

describe('reconcileRelationalRoles — bounded scope', () => {
  it('is a no-op for an empty touched list — no query at all', async () => {
    await reconcileRelationalRoles('user-1', []);
    expect(mockGetTransactionsForReconciliation).not.toHaveBeenCalled();
  });

  it('only fetches exactly the touched ids, never a broader scan', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([]);
    await reconcileRelationalRoles('user-1', ['txn-1', 'txn-2']);
    expect(mockGetTransactionsForReconciliation).toHaveBeenCalledWith(['txn-1', 'txn-2']);
  });

  it('an already-confidently-classified row (e.g. category_detailed) is never queried for a relational match and never updated', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([
      row({ role_source: 'category_detailed', auto_role: 'credit_card_payment' }),
    ]);
    await reconcileRelationalRoles('user-1', ['txn-1']);
    expect(mockFindTransferCounterpartCandidate).not.toHaveBeenCalled();
    expect(mockFindRefundOriginalCandidates).not.toHaveBeenCalled();
    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
  });
});

describe('reconcileRelationalRoles — transfers', () => {
  it('leg 1 (already in DB) resolved once leg 2 is touched and a same-day match is found -> both legs updated, high confidence', async () => {
    const leg2 = row({ id: 'txn-2', amount: -100, date: '2026-09-10' });
    mockGetTransactionsForReconciliation.mockResolvedValue([leg2]);
    const leg1Match = row({ id: 'txn-1', amount: 100, date: '2026-09-10' });
    mockFindTransferCounterpartCandidate.mockResolvedValue(leg1Match);

    await reconcileRelationalRoles('user-1', ['txn-2']);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('txn-2', {
      auto_role: 'internal_transfer',
      role_source: 'account_pair_match',
      role_confidence: 'high',
      classifier_version: 1,
    });
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('txn-1', {
      auto_role: 'internal_transfer',
      role_source: 'account_pair_match',
      role_confidence: 'high',
      classifier_version: 1,
    });
  });

  it('leg 2 arrives in a LATER sync than leg 1 — leg 1, touched now, finds leg 2 (already persisted) and resolves both', async () => {
    const leg1 = row({ id: 'txn-1', amount: 100, date: '2026-09-05' });
    mockGetTransactionsForReconciliation.mockResolvedValue([leg1]);
    const leg2Existing = row({ id: 'txn-2', amount: -100, date: '2026-09-06' });
    mockFindTransferCounterpartCandidate.mockResolvedValue(leg2Existing);

    await reconcileRelationalRoles('user-1', ['txn-1']);

    // Different days within the window -> medium, not high.
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith(
      'txn-1',
      expect.objectContaining({ auto_role: 'internal_transfer', role_confidence: 'medium' })
    );
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith(
      'txn-2',
      expect.objectContaining({ auto_role: 'internal_transfer', role_confidence: 'medium' })
    );
  });

  it('both legs touched in the same batch resolve together', async () => {
    const legA = row({ id: 'txn-a', amount: 100, date: '2026-09-10' });
    const legB = row({ id: 'txn-b', amount: -100, date: '2026-09-10' });
    mockGetTransactionsForReconciliation.mockResolvedValue([legA, legB]);
    mockFindTransferCounterpartCandidate.mockResolvedValueOnce(legB).mockResolvedValueOnce(null);

    await reconcileRelationalRoles('user-1', ['txn-a', 'txn-b']);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('txn-a', expect.objectContaining({ auto_role: 'internal_transfer' }));
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('txn-b', expect.objectContaining({ auto_role: 'internal_transfer' }));
  });

  it('ambiguous transfer with no credible pair match ever found -> stays at the sign-based fallback, no update', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row()]);
    mockFindTransferCounterpartCandidate.mockResolvedValue(null);

    await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
  });

  it('searches within the fixed ±3-day window computed from the candidate row\'s own date', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ date: '2026-09-10' })]);
    await reconcileRelationalRoles('user-1', ['txn-1']);
    expect(mockFindTransferCounterpartCandidate).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ id: 'txn-1' }),
      '2026-09-07',
      '2026-09-13'
    );
  });
});

describe('reconcileRelationalRoles — refunds', () => {
  it('exact-amount match against an earlier expense -> refund, high confidence', async () => {
    const refundRow = row({
      id: 'txn-refund',
      amount: -50,
      date: '2026-09-10',
      name: 'Store',
      merchant_name: 'Store',
      role_source: 'refund_candidate_unconfirmed',
      auto_role: 'income',
    });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([
      row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store', date: '2026-08-15' }),
    ]);

    await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('txn-refund', {
      auto_role: 'refund',
      role_source: 'refund_match',
      role_confidence: 'high',
      classifier_version: 1,
    });
  });

  it('partial refund (smaller than original) -> refund, medium confidence', async () => {
    const refundRow = row({
      id: 'txn-refund',
      amount: -20,
      name: 'Store',
      merchant_name: 'Store',
      role_source: 'refund_candidate_unconfirmed',
    });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([
      row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store' }),
    ]);

    await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith(
      'txn-refund',
      expect.objectContaining({ auto_role: 'refund', role_confidence: 'medium' })
    );
  });

  it('merchant name does not match any candidate -> no refund classification, stays at fallback', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -20, name: 'Store A', merchant_name: 'Store A', role_source: 'refund_candidate_unconfirmed' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([
      row({ id: 'txn-orig', amount: 50, name: 'Completely Different Store', merchant_name: 'Completely Different Store' }),
    ]);

    await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
  });

  it('no prior matching expense at all -> stays at income fallback, no update', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([
      row({ id: 'txn-refund', amount: -20, role_source: 'refund_candidate_unconfirmed' }),
    ]);
    mockFindRefundOriginalCandidates.mockResolvedValue([]);

    await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
  });

  it('purchase and refund arrive in the same batch (purchase touched, resolves the refund via forward search)', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -50, name: 'Store', merchant_name: 'Store', role_source: 'refund_candidate_unconfirmed' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([
      row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store' }),
    ]);

    await reconcileRelationalRoles('user-1', ['txn-orig', 'txn-refund']);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('txn-refund', expect.objectContaining({ auto_role: 'refund' }));
  });

  it('the purchase syncs AFTER its own refund — a freshly-touched positive expense resolves a dangling older refund candidate', async () => {
    const purchase = row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store', auto_role: 'expense', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([purchase]);
    mockFindDanglingRefundCandidates.mockResolvedValue([
      row({ id: 'txn-refund', amount: -50, name: 'Store', merchant_name: 'Store', role_source: 'refund_candidate_unconfirmed' }),
    ]);

    await reconcileRelationalRoles('user-1', ['txn-orig']);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('txn-refund', {
      auto_role: 'refund',
      role_source: 'refund_match',
      role_confidence: 'high',
      classifier_version: 1,
    });
    // The purchase row's own fields are never touched by this direction.
    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalledWith('txn-orig', expect.anything());
  });

  it('a positive expense with no dangling refund candidate causes no update at all', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-orig', amount: 50, auto_role: 'expense', role_source: 'sign_default' })]);
    mockFindDanglingRefundCandidates.mockResolvedValue([]);

    await reconcileRelationalRoles('user-1', ['txn-orig']);

    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
  });
});

describe('reconcileRelationalRoles — user_role_override interaction', () => {
  it('a row is still eligible to have auto_role/source/confidence refreshed even if it carries a user override (the caller never reads or writes user_role_override here)', async () => {
    // ReconciliationRow deliberately has no user_role_override field at all — this module only
    // ever touches auto_role/role_source/role_confidence/classifier_version, so an override (a
    // separate column, resolved into effective_role by the DB) is structurally untouchable from
    // here regardless of what this test asserts; this documents that expectation explicitly.
    mockGetTransactionsForReconciliation.mockResolvedValue([row()]);
    mockFindTransferCounterpartCandidate.mockResolvedValue(row({ id: 'txn-2', amount: -100 }));

    await reconcileRelationalRoles('user-1', ['txn-1']);

    const calls = mockUpdateTransactionRoleFields.mock.calls;
    for (const [, fields] of calls) {
      expect(Object.keys(fields as object).sort()).toEqual(
        ['auto_role', 'classifier_version', 'role_confidence', 'role_source'].sort()
      );
    }
  });
});
