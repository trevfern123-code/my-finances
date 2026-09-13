import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileRelationalRoles, reconcileAroundTransactionChange } from './roleReconciliation';
import type { ReconciliationRow } from './dataService';

const mockGetTransactionsForReconciliation = vi.hoisted(() => vi.fn());
const mockFindTransferCounterpartCandidates = vi.hoisted(() => vi.fn());
const mockFindRefundOriginalCandidates = vi.hoisted(() => vi.fn());
const mockFindNegativeCandidatesReferencingOriginal = vi.hoisted(() => vi.fn());
const mockUpdateTransactionRoleFields = vi.hoisted(() => vi.fn());
const mockUpdateTransferPairRoleFields = vi.hoisted(() => vi.fn());

vi.mock('./dataService', () => ({
  getTransactionsForReconciliation: mockGetTransactionsForReconciliation,
  findTransferCounterpartCandidates: mockFindTransferCounterpartCandidates,
  findRefundOriginalCandidates: mockFindRefundOriginalCandidates,
  findNegativeCandidatesReferencingOriginal: mockFindNegativeCandidatesReferencingOriginal,
  updateTransactionRoleFields: mockUpdateTransactionRoleFields,
  updateTransferPairRoleFields: mockUpdateTransferPairRoleFields,
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
    personal_finance_category_detailed: null,
    personal_finance_category_confidence: null,
    manual_loan_id: null,
    auto_role: 'expense',
    role_source: 'transfer_like_unconfirmed',
    role_confidence: 'low',
    effective_role: 'expense',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindTransferCounterpartCandidates.mockResolvedValue([]);
  mockFindRefundOriginalCandidates.mockResolvedValue([]);
  mockFindNegativeCandidatesReferencingOriginal.mockResolvedValue([]);
  mockUpdateTransactionRoleFields.mockResolvedValue(true);
  mockUpdateTransferPairRoleFields.mockImplementation(async (_userId: string, ids: string[]) => ids);
});

describe('reconcileRelationalRoles — bounded scope', () => {
  it('is a no-op for an empty touched list — no query at all', async () => {
    await reconcileRelationalRoles('user-1', []);
    expect(mockGetTransactionsForReconciliation).not.toHaveBeenCalled();
  });

  it('only fetches exactly the touched ids for the given user, never a broader scan', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([]);
    await reconcileRelationalRoles('user-1', ['txn-1', 'txn-2']);
    expect(mockGetTransactionsForReconciliation).toHaveBeenCalledWith('user-1', ['txn-1', 'txn-2']);
  });

  it('an already-confidently-classified row (e.g. category_detailed) is never queried for a relational match and never updated', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([
      row({ role_source: 'category_detailed', auto_role: 'credit_card_payment', effective_role: 'credit_card_payment' }),
    ]);
    await reconcileRelationalRoles('user-1', ['txn-1']);
    expect(mockFindTransferCounterpartCandidates).not.toHaveBeenCalled();
    expect(mockFindRefundOriginalCandidates).not.toHaveBeenCalled();
    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
    expect(mockUpdateTransferPairRoleFields).not.toHaveBeenCalled();
  });
});

describe('reconcileRelationalRoles — transfers: deterministic, conservative ranking (Round 2 remediation §4)', () => {
  it('exactly one candidate -> resolves as a pair, atomically, same-day match is high confidence', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([row({ id: 'txn-2', amount: -100, date: '2026-09-10' })]);

    const result = await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockUpdateTransferPairRoleFields).toHaveBeenCalledWith(
      'user-1',
      ['txn-1', 'txn-2'],
      expect.objectContaining({ auto_role: 'internal_transfer', role_confidence: 'high' })
    );
    expect(result.resolved).toHaveLength(2);
    expect(result.resolved.map((r) => r.id).sort()).toEqual(['txn-1', 'txn-2']);
  });

  it('a candidate on a different day (within window) is medium confidence, not high', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-05' })]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([row({ id: 'txn-2', amount: -100, date: '2026-09-06' })]);

    await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockUpdateTransferPairRoleFields).toHaveBeenCalledWith(
      'user-1',
      expect.anything(),
      expect.objectContaining({ role_confidence: 'medium' })
    );
  });

  it('exact-date candidate beats a further, merely-compatible-amount candidate deterministically', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([
      row({ id: 'txn-far', amount: -100, date: '2026-09-08' }),
      row({ id: 'txn-near', amount: -100, date: '2026-09-10' }),
    ]);

    await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockUpdateTransferPairRoleFields).toHaveBeenCalledWith(
      'user-1',
      ['txn-1', 'txn-near'],
      expect.objectContaining({ role_confidence: 'high' })
    );
  });

  it('two equally plausible candidates (same date distance) -> ambiguous, NEVER guessed, no update at all', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([
      row({ id: 'txn-a', amount: -100, date: '2026-09-11' }),
      row({ id: 'txn-b', amount: -100, date: '2026-09-09' }),
    ]);

    const result = await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockUpdateTransferPairRoleFields).not.toHaveBeenCalled();
    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
    expect(result.unresolved).toEqual([{ id: 'txn-1', reason: 'ambiguous_transfer_candidates' }]);
  });

  it('no credible pair match ever found -> stays at the sign-based fallback, no update', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row()]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);

    const result = await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockUpdateTransferPairRoleFields).not.toHaveBeenCalled();
    expect(result.unresolved).toEqual([{ id: 'txn-1', reason: 'no_transfer_evidence' }]);
  });

  it('searches within the fixed ±3-day window computed from the candidate row\'s own date, tagged transfer_like_unconfirmed', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ date: '2026-09-10' })]);
    await reconcileRelationalRoles('user-1', ['txn-1']);
    expect(mockFindTransferCounterpartCandidates).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ id: 'txn-1' }),
      '2026-09-07',
      '2026-09-13',
      'transfer_like_unconfirmed'
    );
  });

  it('an atomic pair update that fails to affect both rows (e.g. ownership mismatch) is treated as unresolved, not a half-resolved pair', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100 })]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([row({ id: 'txn-2', amount: -100, date: '2026-09-10' })]);
    mockUpdateTransferPairRoleFields.mockResolvedValue(['txn-1']); // only one of the two affected

    const result = await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([{ id: 'txn-1', reason: 'ambiguous_transfer_candidates' }]);
  });
});

describe('reconcileRelationalRoles — refunds', () => {
  it('exact-amount match against an earlier eligible expense -> refund, high confidence', async () => {
    const refundRow = row({
      id: 'txn-refund',
      amount: -50,
      date: '2026-09-10',
      name: 'Store',
      merchant_name: 'Store',
      role_source: 'sign_default',
      auto_role: 'income',
    });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([
      row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store', date: '2026-08-15', effective_role: 'expense' }),
    ]);

    await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('user-1', 'txn-refund', {
      auto_role: 'refund',
      role_source: 'refund_match',
      role_confidence: 'high',
      classifier_version: 1,
    });
  });

  it('partial refund (smaller than original) -> refund, medium confidence', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -20, name: 'Store', merchant_name: 'Store', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store' })]);

    await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith(
      'user-1',
      'txn-refund',
      expect.objectContaining({ auto_role: 'refund', role_confidence: 'medium' })
    );
  });

  it('exact amount preferred over a partial-amount candidate when both share the merchant name', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -50, name: 'Store', merchant_name: 'Store', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([
      row({ id: 'txn-partial', amount: 80, name: 'Store', merchant_name: 'Store', date: '2026-08-01' }),
      row({ id: 'txn-exact', amount: 50, name: 'Store', merchant_name: 'Store', date: '2026-07-01' }),
    ]);

    await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith(
      'user-1',
      'txn-refund',
      expect.objectContaining({ role_confidence: 'high' })
    );
  });

  it('merchant name does not match any candidate -> no refund classification', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -20, name: 'Store A', merchant_name: 'Store A', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([
      row({ id: 'txn-orig', amount: 50, name: 'Completely Different Store', merchant_name: 'Completely Different Store' }),
    ]);

    await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
  });

  it('two equally-plausible name-matched candidates at the same date distance -> ambiguous, not guessed', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -50, date: '2026-09-10', name: 'Store', merchant_name: 'Store', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([
      row({ id: 'txn-a', amount: 50, name: 'Store', merchant_name: 'Store', date: '2026-09-05' }),
      row({ id: 'txn-b', amount: 50, name: 'Store', merchant_name: 'Store', date: '2026-09-15' }),
    ]);

    const result = await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
    expect(result.unresolved).toEqual([{ id: 'txn-refund', reason: 'no_refund_evidence' }]);
  });

  it('no prior matching expense at all -> stays at income fallback, no update', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-refund', amount: -20, role_source: 'sign_default' })]);
    mockFindRefundOriginalCandidates.mockResolvedValue([]);

    await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
  });

  it('purchase and refund arrive in the same batch (purchase touched, resolves the refund via forward search)', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -50, name: 'Store', merchant_name: 'Store', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store' })]);

    await reconcileRelationalRoles('user-1', ['txn-orig', 'txn-refund']);

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('user-1', 'txn-refund', expect.objectContaining({ auto_role: 'refund' }));
  });

  it('the purchase syncs AFTER its own refund — a freshly-touched positive expense resolves a dangling older sign_default refund candidate', async () => {
    const purchase = row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store', auto_role: 'expense', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([purchase]);
    mockFindNegativeCandidatesReferencingOriginal.mockResolvedValue([
      row({ id: 'txn-refund', amount: -50, name: 'Store', merchant_name: 'Store', role_source: 'sign_default' }),
    ]);

    await reconcileRelationalRoles('user-1', ['txn-orig']);

    expect(mockFindNegativeCandidatesReferencingOriginal).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ id: 'txn-orig' }),
      expect.any(String),
      'sign_default'
    );
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith('user-1', 'txn-refund', {
      auto_role: 'refund',
      role_source: 'refund_match',
      role_confidence: 'high',
      classifier_version: 1,
    });
    // The purchase row's own fields are never touched by this direction.
    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalledWith('user-1', 'txn-orig', expect.anything());
  });

  it('a positive expense with no dangling refund candidate causes no update at all', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-orig', amount: 50, auto_role: 'expense', role_source: 'sign_default' })]);
    mockFindNegativeCandidatesReferencingOriginal.mockResolvedValue([]);

    await reconcileRelationalRoles('user-1', ['txn-orig']);

    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
  });
});

describe('reconcileRelationalRoles — dry-run preview mode (apply = false)', () => {
  it('previews a transfer pair resolution with zero writes', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([row({ id: 'txn-2', amount: -100, date: '2026-09-10' })]);

    const result = await reconcileRelationalRoles('user-1', ['txn-1'], false);

    expect(mockUpdateTransferPairRoleFields).not.toHaveBeenCalled();
    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
    expect(result.resolved.map((r) => r.id).sort()).toEqual(['txn-1', 'txn-2']);
  });

  it('previews a refund resolution with zero writes', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -50, name: 'Store', merchant_name: 'Store', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store' })]);

    const result = await reconcileRelationalRoles('user-1', ['txn-refund'], false);

    expect(mockUpdateTransactionRoleFields).not.toHaveBeenCalled();
    expect(result.resolved).toEqual([{ id: 'txn-refund', fields: { auto_role: 'refund', role_source: 'refund_match', role_confidence: 'high', classifier_version: 1 } }]);
  });
});

describe('reconcileAroundTransactionChange — Round 2 remediation §1', () => {
  it('re-evaluates the changed transaction itself and, finding a stale account_pair_match counterpart, resets it to a fresh classification and re-resolves everything together', async () => {
    // The changed row (e.g. just unlinked from a manual loan) is now an ordinary ambiguous transfer.
    const changed = row({ id: 'txn-x', amount: 100, date: '2026-09-10', category: 'TRANSFER_OUT', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation
      .mockResolvedValueOnce([changed]) // initial fetch of the changed row
      .mockResolvedValueOnce([ // the forward pass's own fetch, after the stale partner was reset
        row({ id: 'txn-x', amount: 100, date: '2026-09-10', category: 'TRANSFER_OUT', role_source: 'transfer_like_unconfirmed' }),
        row({ id: 'txn-stale', amount: -100, date: '2026-09-10', category: 'TRANSFER_OUT', role_source: 'transfer_like_unconfirmed' }),
      ]);
    // A stale confirmed partner exists — was matched against this row's OLD state.
    mockFindTransferCounterpartCandidates
      .mockResolvedValueOnce([row({ id: 'txn-stale', amount: -100, date: '2026-09-10', category: 'TRANSFER_OUT', role_source: 'account_pair_match' })]) // stale-partner search
      .mockResolvedValueOnce([row({ id: 'txn-stale', amount: -100, date: '2026-09-10', role_source: 'transfer_like_unconfirmed' })]); // forward pass re-resolving

    await reconcileAroundTransactionChange('user-1', 'txn-x');

    // The stale partner was reset to a fresh classification (its own category still says
    // TRANSFER_OUT with no confidence -> transfer_like_unconfirmed) before being re-resolved.
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith(
      'user-1',
      'txn-stale',
      expect.objectContaining({ role_source: 'transfer_like_unconfirmed' })
    );
    // Both rows end up correctly re-paired as internal_transfer by the final forward pass.
    expect(mockUpdateTransferPairRoleFields).toHaveBeenCalledWith(
      'user-1',
      expect.arrayContaining(['txn-x', 'txn-stale']),
      expect.objectContaining({ auto_role: 'internal_transfer' })
    );
  });

  it('a transaction newly linked to a manual loan invalidates a prior transfer pairing — the counterpart no longer stays falsely internal_transfer', async () => {
    const linked = row({ id: 'txn-linked', amount: 100, date: '2026-09-10', manual_loan_id: 'loan-1', auto_role: 'debt_payment', role_source: 'manual_loan_link', effective_role: 'debt_payment' });
    mockGetTransactionsForReconciliation
      .mockResolvedValueOnce([linked])
      .mockResolvedValueOnce([linked]); // forward pass finds nothing new to do for the now-debt_payment row itself
    mockFindTransferCounterpartCandidates
      .mockResolvedValueOnce([row({ id: 'txn-counterpart', amount: -100, date: '2026-09-10', role_source: 'account_pair_match' })])
      .mockResolvedValueOnce([]); // forward pass: counterpart's own re-search finds nothing (correctly no longer paired)

    await reconcileAroundTransactionChange('user-1', 'txn-linked');

    // The counterpart is reset off account_pair_match — it no longer "remains falsely internal_transfer".
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith(
      'user-1',
      'txn-counterpart',
      expect.not.objectContaining({ role_source: 'account_pair_match' })
    );
  });

  it('unlink with existing refund evidence resolves the refund role immediately', async () => {
    // The unlinked transaction is a negative amount that, on its own stored fields, is an
    // ordinary sign_default candidate with real refund evidence sitting nearby.
    const unlinked = row({ id: 'txn-unlinked', amount: -50, name: 'Store', merchant_name: 'Store', manual_loan_id: null, auto_role: 'income', role_source: 'sign_default', effective_role: 'income' });
    mockGetTransactionsForReconciliation
      .mockResolvedValueOnce([unlinked])
      .mockResolvedValueOnce([unlinked]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);
    mockFindRefundOriginalCandidates.mockResolvedValueOnce([
      row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store', effective_role: 'expense' }),
    ]);

    const result = await reconcileAroundTransactionChange('user-1', 'txn-unlinked');

    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith(
      'user-1',
      'txn-unlinked',
      expect.objectContaining({ auto_role: 'refund' })
    );
    expect(result.resolved.some((r) => r.id === 'txn-unlinked' && r.fields.auto_role === 'refund')).toBe(true);
  });

  it('a row that is no longer an eligible refund original (now a transfer) invalidates a stale refund_match that had used it', async () => {
    const changed = row({ id: 'txn-x', amount: 100, date: '2026-09-01', name: 'Store', merchant_name: 'Store', category: 'TRANSFER_OUT', auto_role: 'internal_transfer', role_source: 'account_pair_match', effective_role: 'internal_transfer' });
    mockGetTransactionsForReconciliation
      .mockResolvedValueOnce([changed])
      .mockResolvedValueOnce([changed]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);
    mockFindNegativeCandidatesReferencingOriginal.mockResolvedValueOnce([
      row({ id: 'txn-stale-refund', amount: -50, name: 'Store', merchant_name: 'Store', role_source: 'refund_match' }),
    ]);

    await reconcileAroundTransactionChange('user-1', 'txn-x');

    expect(mockFindNegativeCandidatesReferencingOriginal).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ id: 'txn-x' }),
      expect.any(String),
      'refund_match'
    );
    expect(mockUpdateTransactionRoleFields).toHaveBeenCalledWith(
      'user-1',
      'txn-stale-refund',
      expect.not.objectContaining({ role_source: 'refund_match' })
    );
  });

  it('does not look for a STALE refund match (role_source refund_match) when the row is still an eligible ordinary expense original — it may still take part in the ordinary forward dangling-refund search', async () => {
    const stillEligible = row({ id: 'txn-x', amount: 50, effective_role: 'expense', manual_loan_id: null, auto_role: 'expense', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValueOnce([stillEligible]).mockResolvedValueOnce([stillEligible]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);

    await reconcileAroundTransactionChange('user-1', 'txn-x');

    expect(mockFindNegativeCandidatesReferencingOriginal).not.toHaveBeenCalledWith(
      'user-1',
      expect.anything(),
      expect.anything(),
      'refund_match'
    );
  });

  it('user_role_override is never read or written by this module — only auto_role/source/confidence/version fields ever appear in a write', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row()]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([row({ id: 'txn-2', amount: -100 })]);

    await reconcileRelationalRoles('user-1', ['txn-1']);

    for (const call of mockUpdateTransferPairRoleFields.mock.calls) {
      const fields = call[2] as object;
      expect(Object.keys(fields).sort()).toEqual(['auto_role', 'classifier_version', 'role_confidence', 'role_source'].sort());
    }
  });

  it('returns immediately, doing nothing, if the transaction no longer exists for this user', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValueOnce([]);
    const result = await reconcileAroundTransactionChange('user-1', 'txn-gone');
    expect(result).toEqual({ resolved: [], unresolved: [] });
    expect(mockFindTransferCounterpartCandidates).not.toHaveBeenCalled();
  });
});
