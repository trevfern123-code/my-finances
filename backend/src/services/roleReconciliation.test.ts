import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reconcileRelationalRoles,
  repairExistingRelationalRoles,
  reconcileAfterRelationalStateChange,
  RelationalRepairNotStableError,
} from './roleReconciliation';
import type { ReconciliationRow } from './dataService';

const mockGetTransactionsForReconciliation = vi.hoisted(() => vi.fn());
const mockFindTransferCounterpartCandidates = vi.hoisted(() => vi.fn());
const mockFindRefundOriginalCandidates = vi.hoisted(() => vi.fn());
const mockFindNegativeCandidatesReferencingOriginal = vi.hoisted(() => vi.fn());
const mockApplyTransactionSemanticRoles = vi.hoisted(() => vi.fn());
const mockGetRelationallyClassifiedTransactionsPage = vi.hoisted(() => vi.fn());

vi.mock('./dataService', () => ({
  getTransactionsForReconciliation: mockGetTransactionsForReconciliation,
  findTransferCounterpartCandidates: mockFindTransferCounterpartCandidates,
  findRefundOriginalCandidates: mockFindRefundOriginalCandidates,
  findNegativeCandidatesReferencingOriginal: mockFindNegativeCandidatesReferencingOriginal,
  applyTransactionSemanticRoles: mockApplyTransactionSemanticRoles,
  getRelationallyClassifiedTransactionsPage: mockGetRelationallyClassifiedTransactionsPage,
}));

/** Builds a `findTransferCounterpartCandidates` mock implementation keyed by the QUERYING row's
 *  own id — necessary because the real reciprocal check (Round 4 remediation §3) calls this
 *  twice per resolution attempt (once for the anchor, once to verify the winner's own best match
 *  points back), and a naive `mockResolvedValue` returning the same list regardless of which row
 *  is asking cannot model two DIFFERENT rows each genuinely seeing the OTHER as their candidate —
 *  it would instead make every row see ITSELF, which the reciprocal check correctly rejects. */
function transferCandidatesByRowId(byId: Record<string, ReconciliationRow[]>) {
  return async (_userId: string, queryingRow: { id: string }) => byId[queryingRow.id] ?? [];
}

/**
 * Like `fakeAccountPairMatchStore`, but pagination-aware (Round 4 remediation §12): serves pages
 * in (sorted) id order honoring `afterId`/`limit`, and removes a row once
 * `applyTransactionSemanticRoles` is called for it — so a test can verify that resets happening
 * WITHIN page 1 never disrupt the keyset cursor used to fetch page 2 (never OFFSET-style
 * skipping), and that page 2's own rows still get visited.
 */
function fakeAccountPairMatchStorePaginated(rows: ReconciliationRow[]) {
  let remaining = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  mockGetRelationallyClassifiedTransactionsPage.mockImplementation(
    async (_userId: string, roleSource: string, limit: number, afterId: string | null) => {
      if (roleSource !== 'account_pair_match') return [];
      const pool = afterId === null ? remaining : remaining.filter((r) => r.id > afterId);
      return pool.slice(0, limit);
    }
  );
  mockApplyTransactionSemanticRoles.mockImplementation(async (_userId: string, ids: string[]) => {
    remaining = remaining.filter((r) => !ids.includes(r.id));
  });
}

/**
 * A minimal stateful fake for the `account_pair_match` repair sweep's own two mocked
 * dependencies (`getRelationallyClassifiedTransactionsPage` and `applyTransactionSemanticRoles`)
 * — needed because `repairAccountPairMatches` repeats its page-traversal in bounded passes until
 * a pass resets nothing (Round 4 remediation §5). A naive `mockResolvedValue`/`mockImplementation`
 * that always returns the SAME page regardless of what was just "written" would make every reset
 * row get reset again on every subsequent pass, up to MAX_REPAIR_PASSES — this fake instead
 * actually removes a row from the simulated `account_pair_match` set once
 * `applyTransactionSemanticRoles` is called for it (simulating the real DB no longer tagging that
 * row `account_pair_match` after the write), so tests can assert exact call counts. Wires both
 * mocks; call `install()` once per test after configuring `rows`.
 */
function fakeAccountPairMatchStore(rows: ReconciliationRow[]) {
  const remaining = new Map(rows.map((r) => [r.id, r]));
  function install() {
    mockGetRelationallyClassifiedTransactionsPage.mockImplementation(async (_userId: string, roleSource: string) => {
      if (roleSource !== 'account_pair_match') return [];
      return Array.from(remaining.values());
    });
    mockApplyTransactionSemanticRoles.mockImplementation(async (_userId: string, ids: string[]) => {
      for (const id of ids) remaining.delete(id);
    });
  }
  return { install, remaining };
}

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
    user_role_override: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindTransferCounterpartCandidates.mockResolvedValue([]);
  mockFindRefundOriginalCandidates.mockResolvedValue([]);
  mockFindNegativeCandidatesReferencingOriginal.mockResolvedValue([]);
  mockApplyTransactionSemanticRoles.mockResolvedValue(true);
  mockGetRelationallyClassifiedTransactionsPage.mockResolvedValue([]);
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
    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
  });
});

describe('reconcileRelationalRoles — transfers: deterministic, conservative ranking (Round 2 remediation §4)', () => {
  it('exactly one candidate -> resolves as a pair, atomically (one RPC call for both ids), same-day match is high confidence', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-1': [row({ id: 'txn-2', amount: -100, date: '2026-09-10' })],
        'txn-2': [row({ id: 'txn-1', amount: 100, date: '2026-09-10' })],
      })
    );

    const result = await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      ['txn-1', 'txn-2'],
      expect.anything(),
      expect.objectContaining({ auto_role: 'internal_transfer', role_confidence: 'high' })
    );
    expect(result.resolved).toHaveLength(2);
    expect(result.resolved.map((r) => r.id).sort()).toEqual(['txn-1', 'txn-2']);
  });

  it('a candidate on a different day (within window) is medium confidence, not high', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-05' })]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-1': [row({ id: 'txn-2', amount: -100, date: '2026-09-06' })],
        'txn-2': [row({ id: 'txn-1', amount: 100, date: '2026-09-05' })],
      })
    );

    await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ role_confidence: 'medium' })
    );
  });

  it('exact-date candidate beats a further, merely-compatible-amount candidate deterministically', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-1': [row({ id: 'txn-far', amount: -100, date: '2026-09-08' }), row({ id: 'txn-near', amount: -100, date: '2026-09-10' })],
        // The winner (txn-near) must reciprocally see txn-1 as ITS own best match too.
        'txn-near': [row({ id: 'txn-1', amount: 100, date: '2026-09-10' })],
      })
    );

    await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      ['txn-1', 'txn-near'],
      expect.anything(),
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

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
    expect(result.unresolved).toEqual([{ id: 'txn-1', reason: 'ambiguous_transfer_candidates' }]);
  });

  it('no credible pair match ever found -> stays at the sign-based fallback, no update', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row()]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);

    const result = await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
    expect(result.unresolved).toEqual([{ id: 'txn-1', reason: 'no_transfer_evidence' }]);
  });

  it("searches within the fixed ±3-day window computed from the candidate row's own date, tagged transfer_like_unconfirmed", async () => {
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

  it('an RPC integrity failure during a transfer-pair write propagates as a HARD failure — never silently converted into an ordinary "unresolved" outcome (Round 4 remediation §6)', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-1': [row({ id: 'txn-2', amount: -100, date: '2026-09-10' })],
        'txn-2': [row({ id: 'txn-1', amount: 100, date: '2026-09-10' })],
      })
    );
    // applyTransactionSemanticRoles now THROWS on any RPC-reported failure (ownership mismatch,
    // count mismatch, duplicate ids) rather than returning `false` — see dataService.ts's
    // SemanticRoleMutationError for why this must be a hard failure, not a candidate-ranking
    // outcome a caller could mistake for ordinary ambiguity.
    mockApplyTransactionSemanticRoles.mockRejectedValue(new Error('apply_transaction_semantic_roles: ownership check failed'));

    await expect(reconcileRelationalRoles('user-1', ['txn-1'])).rejects.toThrow('ownership check failed');
  });

  it('candidate ambiguity is a normal returned outcome, NOT an RPC call at all — confirms the two are genuinely distinct code paths (Round 4 remediation §6)', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([
      row({ id: 'txn-a', amount: -100, date: '2026-09-11' }),
      row({ id: 'txn-b', amount: -100, date: '2026-09-09' }),
    ]);

    const result = await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
    expect(result.unresolved).toEqual([{ id: 'txn-1', reason: 'ambiguous_transfer_candidates' }]);
  });
});

describe('reconcileRelationalRoles — reciprocal one-to-one transfer matching (Round 4 remediation §3/§4)', () => {
  it('A/B mutual unique pair: each independently, and reciprocally, picks the other — confirmed', async () => {
    const A = row({ id: 'txn-a', account_id: 'acc-1', amount: 500, date: '2026-09-10' });
    const B = row({ id: 'txn-b', account_id: 'acc-2', amount: -500, date: '2026-09-10' });
    mockGetTransactionsForReconciliation.mockResolvedValue([A, B]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-a': [B],
        'txn-b': [A],
      })
    );

    const result = await reconcileRelationalRoles('user-1', ['txn-a', 'txn-b']);

    expect(result.resolved.map((r) => r.id).sort()).toEqual(['txn-a', 'txn-b']);
    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledTimes(1); // deduped — B's own turn is skipped
  });

  it('one mutually-unique pair plus a third unmatched candidate: A(+500)/B(-500)/C(+500) — B is genuinely closer to A, so only A/B confirm; C stays unresolved', async () => {
    const A = row({ id: 'txn-a', account_id: 'acc-1', amount: 500, date: '2026-09-10' });
    const B = row({ id: 'txn-b', account_id: 'acc-2', amount: -500, date: '2026-09-10' });
    const C = row({ id: 'txn-c', account_id: 'acc-3', amount: 500, date: '2026-09-11' });
    mockGetTransactionsForReconciliation.mockResolvedValue([A, B, C]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-a': [B], // A's only opposite-sign candidate is B
        'txn-b': [A, C], // B sees both A (same day) and C (one day away)
        'txn-c': [B], // C's only opposite-sign candidate is B
      })
    );

    const result = await reconcileRelationalRoles('user-1', ['txn-a', 'txn-b', 'txn-c']);

    expect(result.resolved.map((r) => r.id).sort()).toEqual(['txn-a', 'txn-b']);
    expect(result.unresolved).toEqual([{ id: 'txn-c', reason: 'no_transfer_evidence' }]);
    // B is never mutated twice, and never reused for a second pair.
    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledTimes(1);
    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith('user-1', ['txn-a', 'txn-b'], expect.anything(), expect.anything());
  });

  it('A/B/C tied ambiguity: B is EQUIDISTANT from A and C — none of the three relationships are confirmed', async () => {
    const A = row({ id: 'txn-a', account_id: 'acc-1', amount: 500, date: '2026-09-09' });
    const B = row({ id: 'txn-b', account_id: 'acc-2', amount: -500, date: '2026-09-10' });
    const C = row({ id: 'txn-c', account_id: 'acc-3', amount: 500, date: '2026-09-11' });
    mockGetTransactionsForReconciliation.mockResolvedValue([A, B, C]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-a': [B],
        'txn-b': [A, C], // both exactly 1 day from B — genuinely tied
        'txn-c': [B],
      })
    );

    const result = await reconcileRelationalRoles('user-1', ['txn-a', 'txn-b', 'txn-c']);

    expect(result.resolved).toEqual([]);
    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
  });

  it('unequal-distance one-to-many: three candidates for one anchor, only the closest reciprocates', async () => {
    const anchor = row({ id: 'txn-1', account_id: 'acc-1', amount: 100, date: '2026-09-10' });
    const near = row({ id: 'txn-near', account_id: 'acc-2', amount: -100, date: '2026-09-10' });
    const mid = row({ id: 'txn-mid', account_id: 'acc-3', amount: -100, date: '2026-09-11' });
    const far = row({ id: 'txn-far', account_id: 'acc-4', amount: -100, date: '2026-09-12' });
    mockGetTransactionsForReconciliation.mockResolvedValue([anchor]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-1': [near, mid, far],
        'txn-near': [anchor], // the closest candidate reciprocally agrees
      })
    );

    const result = await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(result.resolved.map((r) => r.id).sort()).toEqual(['txn-1', 'txn-near']);
  });

  it('a user override on the CANDIDATE side makes it ineligible — the anchor is left with no eligible candidate at all', async () => {
    const anchor = row({ id: 'txn-a', amount: 100, date: '2026-09-10' });
    const overriddenCandidate = row({ id: 'txn-b', amount: -100, date: '2026-09-10', user_role_override: 'expense' });
    mockGetTransactionsForReconciliation.mockResolvedValue([anchor]);
    mockFindTransferCounterpartCandidates.mockImplementation(transferCandidatesByRowId({ 'txn-a': [overriddenCandidate] }));

    const result = await reconcileRelationalRoles('user-1', ['txn-a']);

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
    expect(result.unresolved).toEqual([{ id: 'txn-a', reason: 'no_transfer_evidence' }]);
  });

  it('a user override on the ANCHOR itself disqualifies it immediately, without even querying candidates', async () => {
    const overriddenAnchor = row({ id: 'txn-a', amount: 100, date: '2026-09-10', user_role_override: 'expense' });
    mockGetTransactionsForReconciliation.mockResolvedValue([overriddenAnchor]);

    const result = await reconcileRelationalRoles('user-1', ['txn-a']);

    expect(mockFindTransferCounterpartCandidates).not.toHaveBeenCalled();
    expect(result.unresolved).toEqual([{ id: 'txn-a', reason: 'no_transfer_evidence' }]);
  });

  it('an override that already AGREES (internal_transfer) does not disqualify the row', async () => {
    const anchor = row({ id: 'txn-a', amount: 100, date: '2026-09-10', user_role_override: 'internal_transfer' });
    const candidate = row({ id: 'txn-b', amount: -100, date: '2026-09-10' });
    mockGetTransactionsForReconciliation.mockResolvedValue([anchor]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({ 'txn-a': [candidate], 'txn-b': [anchor] })
    );

    const result = await reconcileRelationalRoles('user-1', ['txn-a']);

    expect(result.resolved.map((r) => r.id).sort()).toEqual(['txn-a', 'txn-b']);
  });

  it('a candidate resolved as part of one pair is never re-processed (or re-mutated) when its own turn comes up later in the same pass', async () => {
    const A = row({ id: 'txn-a', amount: 100, date: '2026-09-10' });
    const B = row({ id: 'txn-b', amount: -100, date: '2026-09-10' });
    mockGetTransactionsForReconciliation.mockResolvedValue([A, B]);
    mockFindTransferCounterpartCandidates.mockImplementation(transferCandidatesByRowId({ 'txn-a': [B], 'txn-b': [A] }));

    await reconcileRelationalRoles('user-1', ['txn-a', 'txn-b']);

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileRelationalRoles — traversal-order independence (Round 5 remediation, blocker 1)', () => {
  // P1(+100, day0), P2(+100, day1), N1(-100, day0), N2(-100, day2). In isolation:
  //  - P1's only opposite-amount candidates are N1(dist0)/N2(dist2) -> N1 uniquely closer.
  //  - N1's candidates are P1(dist0)/P2(dist1) -> P1 uniquely closer -> P1/N1 RECIPROCALLY confirm.
  //  - P2's candidates are N1(dist1)/N2(dist1) -> TIED -> ambiguous.
  //  - N2's candidates are P1(dist2)/P2(dist1) -> P2 uniquely closer, but P2 itself is ambiguous,
  //    so N2 has no confirmed reciprocal partner either.
  // A version that persists each confirmed pair before evaluating the next anchor would see N1
  // "consumed" once P1/N1 writes, changing what a LATER-processed P2/N2 pair could resolve to
  // depending on visitation order. The correct, order-independent answer is always: P1/N1
  // confirmed, P2 and N2 both left unresolved.
  const P1 = row({ id: 'p1', account_id: 'acc-p1', amount: 100, date: '2026-09-10' });
  const P2 = row({ id: 'p2', account_id: 'acc-p2', amount: 100, date: '2026-09-11' });
  const N1 = row({ id: 'n1', account_id: 'acc-n1', amount: -100, date: '2026-09-10' });
  const N2 = row({ id: 'n2', account_id: 'acc-n2', amount: -100, date: '2026-09-12' });

  function installAdversarialCandidates() {
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        p1: [N1, N2],
        n1: [P1, P2],
        p2: [N1, N2],
        n2: [P1, P2],
      })
    );
  }

  it('order P1,N1,P2,N2 confirms exactly P1/N1', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([P1, N1, P2, N2]);
    installAdversarialCandidates();

    const result = await reconcileRelationalRoles('user-1', ['p1', 'n1', 'p2', 'n2']);

    expect(result.resolved.map((r) => r.id).sort()).toEqual(['n1', 'p1']);
  });

  it('the REVERSE order P2,N2,P1,N1 confirms the exact same pair — P1/N1, never P2/N2', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([P2, N2, P1, N1]);
    installAdversarialCandidates();

    const result = await reconcileRelationalRoles('user-1', ['p2', 'n2', 'p1', 'n1']);

    expect(result.resolved.map((r) => r.id).sort()).toEqual(['n1', 'p1']);
  });

  it('an interleaved order N2,P1,N1,P2 also confirms the same pair', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([N2, P1, N1, P2]);
    installAdversarialCandidates();

    const result = await reconcileRelationalRoles('user-1', ['n2', 'p1', 'n1', 'p2']);

    expect(result.resolved.map((r) => r.id).sort()).toEqual(['n1', 'p1']);
  });

  it('no candidate query is repeated for the same row within one resolution pass (memoized, not just consistent)', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([P1, N1, P2, N2]);
    installAdversarialCandidates();

    await reconcileRelationalRoles('user-1', ['p1', 'n1', 'p2', 'n2']);

    const callsPerRow = new Map<string, number>();
    for (const call of mockFindTransferCounterpartCandidates.mock.calls) {
      const id = (call[1] as { id: string }).id;
      callsPerRow.set(id, (callsPerRow.get(id) ?? 0) + 1);
    }
    for (const count of callsPerRow.values()) {
      expect(count).toBe(1);
    }
  });
});

describe('repairAccountPairMatches — page-level snapshot order independence (Round 5 remediation, blocker 1)', () => {
  it('the sweep resolves the SAME A/B/C outcome regardless of the order rows come back in the page', async () => {
    // A/B are truly the closest mutual pair; C only one-sidedly sees B — same shape as the
    // forward-pass adversarial fixture above, applied to the account_pair_match sweep.
    const A = row({ id: 'a', amount: 500, date: '2026-09-10', role_source: 'account_pair_match' });
    const B = row({ id: 'b', amount: -500, date: '2026-09-10', role_source: 'account_pair_match' });
    const C = row({ id: 'c', amount: 500, date: '2026-09-15', role_source: 'account_pair_match' });
    const candidatesById = transferCandidatesByRowId({ a: [B], b: [A], c: [B] });
    mockFindTransferCounterpartCandidates.mockImplementation(candidatesById);

    mockGetRelationallyClassifiedTransactionsPage.mockImplementation(async (_userId: string, roleSource: string) =>
      roleSource === 'account_pair_match' ? [C, A, B] : []
    );
    const firstOrderResult = await repairExistingRelationalRoles('user-1', false);

    mockApplyTransactionSemanticRoles.mockClear();
    mockGetRelationallyClassifiedTransactionsPage.mockImplementation(async (_userId: string, roleSource: string) =>
      roleSource === 'account_pair_match' ? [B, C, A] : []
    );
    const secondOrderResult = await repairExistingRelationalRoles('user-1', false);

    expect(firstOrderResult.resolved.map((r) => r.id)).toEqual(['c']);
    expect(secondOrderResult.resolved.map((r) => r.id)).toEqual(['c']);
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

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith('user-1', ['txn-refund'], ['sign_default'], {
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

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      ['txn-refund'],
      expect.anything(),
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

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      ['txn-refund'],
      expect.anything(),
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

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
  });

  it('two equally-plausible name-matched candidates at the same date distance -> ambiguous, not guessed', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -50, date: '2026-09-10', name: 'Store', merchant_name: 'Store', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([
      row({ id: 'txn-a', amount: 50, name: 'Store', merchant_name: 'Store', date: '2026-09-05' }),
      row({ id: 'txn-b', amount: 50, name: 'Store', merchant_name: 'Store', date: '2026-09-15' }),
    ]);

    const result = await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
    expect(result.unresolved).toEqual([{ id: 'txn-refund', reason: 'no_refund_evidence' }]);
  });

  it('no prior matching expense at all -> stays at income fallback, no update', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-refund', amount: -20, role_source: 'sign_default' })]);
    mockFindRefundOriginalCandidates.mockResolvedValue([]);

    await reconcileRelationalRoles('user-1', ['txn-refund']);

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
  });

  it('purchase and refund arrive in the same batch (purchase touched, resolves the refund via forward search)', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -50, name: 'Store', merchant_name: 'Store', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store' })]);

    await reconcileRelationalRoles('user-1', ['txn-orig', 'txn-refund']);

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      ['txn-refund'],
      expect.anything(),
      expect.objectContaining({ auto_role: 'refund' })
    );
  });

  it('the purchase syncs AFTER its own refund — a freshly-touched positive expense resolves a dangling older sign_default refund candidate', async () => {
    const purchase = row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store', auto_role: 'expense', role_source: 'sign_default', effective_role: 'expense' });
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
    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith('user-1', ['txn-refund'], ['sign_default'], {
      auto_role: 'refund',
      role_source: 'refund_match',
      role_confidence: 'high',
      classifier_version: 1,
    });
    // The purchase row's own fields are never touched by this direction.
    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalledWith('user-1', ['txn-orig'], expect.anything(), expect.anything());
  });

  it('a positive expense with no dangling refund candidate causes no update at all', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([
      row({ id: 'txn-orig', amount: 50, auto_role: 'expense', role_source: 'sign_default', effective_role: 'expense' }),
    ]);
    mockFindNegativeCandidatesReferencingOriginal.mockResolvedValue([]);

    await reconcileRelationalRoles('user-1', ['txn-orig']);

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
  });

  it('Round 3 remediation §5: a user-overridden non-expense is NEVER treated as a refund original for the dangling-refund forward trigger, even though its auto_role still says expense', async () => {
    // auto_role is still 'expense' (never rewritten by an override), but the user explicitly
    // overrode this row to internal_transfer — effective_role reflects that override.
    const overridden = row({
      id: 'txn-orig',
      amount: 50,
      auto_role: 'expense',
      role_source: 'category_detailed',
      effective_role: 'internal_transfer',
    });
    mockGetTransactionsForReconciliation.mockResolvedValue([overridden]);

    await reconcileRelationalRoles('user-1', ['txn-orig']);

    // The old (Round 2) bug checked `row.auto_role === 'expense'` here, which would have fired
    // the dangling-refund search anyway. The fix checks effective_role via isEligibleRefundOriginal.
    expect(mockFindNegativeCandidatesReferencingOriginal).not.toHaveBeenCalled();
    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
  });

  it('a manual-loan-linked row is never treated as a refund original for the dangling-refund forward trigger even if auto_role says expense', async () => {
    const loanLinked = row({
      id: 'txn-orig',
      amount: 50,
      auto_role: 'expense',
      role_source: 'sign_default',
      effective_role: 'expense',
      manual_loan_id: 'loan-1',
    });
    mockGetTransactionsForReconciliation.mockResolvedValue([loanLinked]);

    await reconcileRelationalRoles('user-1', ['txn-orig']);

    expect(mockFindNegativeCandidatesReferencingOriginal).not.toHaveBeenCalled();
  });
});

describe('reconcileRelationalRoles — dry-run preview mode (apply = false)', () => {
  it('previews a transfer pair resolution with zero writes', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-1': [row({ id: 'txn-2', amount: -100, date: '2026-09-10' })],
        'txn-2': [row({ id: 'txn-1', amount: 100, date: '2026-09-10' })],
      })
    );

    const result = await reconcileRelationalRoles('user-1', ['txn-1'], false);

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
    expect(result.resolved.map((r) => r.id).sort()).toEqual(['txn-1', 'txn-2']);
  });

  it('previews a refund resolution with zero writes', async () => {
    const refundRow = row({ id: 'txn-refund', amount: -50, name: 'Store', merchant_name: 'Store', role_source: 'sign_default' });
    mockGetTransactionsForReconciliation.mockResolvedValue([refundRow]);
    mockFindRefundOriginalCandidates.mockResolvedValue([row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store' })]);

    const result = await reconcileRelationalRoles('user-1', ['txn-refund'], false);

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
    expect(result.resolved).toEqual([{ id: 'txn-refund', fields: { auto_role: 'refund', role_source: 'refund_match', role_confidence: 'high', classifier_version: 1 } }]);
  });
});

describe('reconcileRelationalRoles — dry-run hypothetical-state pool (Round 3 remediation §7)', () => {
  it('a same-batch transfer pair previews as resolved even though neither row has been persisted yet', async () => {
    // Neither row exists in the DB fetch at all yet (backfill dry-run over never-before-classified
    // rows) — the DB queries return nothing, but the pool carries both rows' hypothetical
    // (freshly-computed, unwritten) classifications.
    mockGetTransactionsForReconciliation.mockResolvedValue([]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);

    const legA = row({ id: 'txn-a', account_id: 'acc-1', amount: 100, date: '2026-09-10', role_source: 'transfer_like_unconfirmed' });
    const legB = row({ id: 'txn-b', account_id: 'acc-2', amount: -100, date: '2026-09-10', role_source: 'transfer_like_unconfirmed' });

    const result = await reconcileRelationalRoles('user-1', ['txn-a', 'txn-b'], false, [legA, legB]);

    expect(result.resolved.map((r) => r.id).sort()).toEqual(['txn-a', 'txn-b']);
    expect(result.resolved[0].fields.auto_role).toBe('internal_transfer');
  });

  it('a same-batch purchase + refund pair previews as resolved via the pool', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([]);
    mockFindRefundOriginalCandidates.mockResolvedValue([]);

    const purchase = row({ id: 'txn-orig', account_id: 'acc-1', amount: 50, date: '2026-08-01', name: 'Store', merchant_name: 'Store', role_source: 'sign_default', effective_role: 'expense', auto_role: 'expense' });
    const refund = row({ id: 'txn-refund', account_id: 'acc-1', amount: -50, date: '2026-09-10', name: 'Store', merchant_name: 'Store', role_source: 'sign_default' });

    const result = await reconcileRelationalRoles('user-1', ['txn-orig', 'txn-refund'], false, [purchase, refund]);

    const refundOutcome = result.resolved.find((r) => r.id === 'txn-refund');
    expect(refundOutcome?.fields.auto_role).toBe('refund');
  });

  it('a same-batch overridden expense (effective_role no longer expense) is NOT used as a refund original even when supplied via the pool', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([]);
    mockFindRefundOriginalCandidates.mockResolvedValue([]);

    // This same-batch row's hypothetical auto_role is 'expense' but it carries a user override
    // reflected in effective_role — the pool filter for refund-original candidates requires
    // effective_role === 'expense', so this must NOT qualify.
    const overriddenPurchase = row({
      id: 'txn-orig',
      account_id: 'acc-1',
      amount: 50,
      date: '2026-08-01',
      name: 'Store',
      merchant_name: 'Store',
      auto_role: 'expense',
      effective_role: 'internal_transfer',
    });
    const refund = row({ id: 'txn-refund', account_id: 'acc-1', amount: -50, date: '2026-09-10', name: 'Store', merchant_name: 'Store', role_source: 'sign_default' });

    const result = await reconcileRelationalRoles('user-1', ['txn-refund'], false, [overriddenPurchase, refund]);

    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([{ id: 'txn-refund', reason: 'no_refund_evidence' }]);
  });

  it('an ambiguous same-batch transfer (two candidates, same distance) remains unresolved even via the pool', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);

    const anchor = row({ id: 'txn-1', account_id: 'acc-1', amount: 100, date: '2026-09-10', role_source: 'transfer_like_unconfirmed' });
    const candidateA = row({ id: 'txn-a', account_id: 'acc-2', amount: -100, date: '2026-09-11', role_source: 'transfer_like_unconfirmed' });
    const candidateB = row({ id: 'txn-b', account_id: 'acc-3', amount: -100, date: '2026-09-09', role_source: 'transfer_like_unconfirmed' });

    const result = await reconcileRelationalRoles('user-1', ['txn-1'], false, [anchor, candidateA, candidateB]);

    expect(result.unresolved).toEqual([{ id: 'txn-1', reason: 'ambiguous_transfer_candidates' }]);
  });

  it("a pool-tracked id's STALE, never-written DB row is never reused as a candidate — even when the pool's CURRENT hypothetical role no longer matches the search filter (Round 5 remediation, blocker 2)", async () => {
    // A and B hypothetically paired on an earlier page — their pool entries now say
    // account_pair_match. Dry run never WRITES anything, so the live DB query (mocked here) still
    // returns A/B in their OLD transfer_like_unconfirmed state — exactly what a real, unwritten
    // database would still show. C must NOT be able to reuse either of them.
    const A = row({ id: 'txn-a', account_id: 'acc-1', amount: 100, date: '2026-09-10', role_source: 'account_pair_match' });
    const B = row({ id: 'txn-b', account_id: 'acc-2', amount: -100, date: '2026-09-10', role_source: 'account_pair_match' });
    const C = row({ id: 'txn-c', account_id: 'acc-3', amount: 100, date: '2026-09-10', role_source: 'transfer_like_unconfirmed' });

    mockGetTransactionsForReconciliation.mockResolvedValue([C]);
    // The STALE DB view: A and B still show as transfer_like_unconfirmed candidates for C.
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-c': [
          row({ id: 'txn-a', account_id: 'acc-1', amount: -100, date: '2026-09-10', role_source: 'transfer_like_unconfirmed' }),
          row({ id: 'txn-b', account_id: 'acc-2', amount: -100, date: '2026-09-10', role_source: 'transfer_like_unconfirmed' }),
        ],
      })
    );

    const result = await reconcileRelationalRoles('user-1', ['txn-c'], false, [A, B]);

    // C must find NO eligible candidate — both A and B are excluded because the pool tracks them,
    // even though neither pool entry itself satisfies the transfer_like_unconfirmed filter.
    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([{ id: 'txn-c', reason: 'no_transfer_evidence' }]);
  });

  it('a DB candidate whose id the pool has NO opinion about still contributes normally (the exclusion is per-id, not a blanket suppression)', async () => {
    const anchor = row({ id: 'txn-1', account_id: 'acc-1', amount: 100, date: '2026-09-10', role_source: 'transfer_like_unconfirmed' });
    const dbOnlyCandidate = row({ id: 'txn-db-only', account_id: 'acc-2', amount: -100, date: '2026-09-10', role_source: 'transfer_like_unconfirmed' });
    const unrelatedPoolRow = row({ id: 'txn-unrelated', account_id: 'acc-9', amount: 999, date: '2026-01-01', role_source: 'account_pair_match' });

    mockGetTransactionsForReconciliation.mockResolvedValue([anchor]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-1': [dbOnlyCandidate],
        'txn-db-only': [anchor],
      })
    );

    const result = await reconcileRelationalRoles('user-1', ['txn-1'], false, [unrelatedPoolRow]);

    expect(result.resolved.map((r) => r.id).sort()).toEqual(['txn-1', 'txn-db-only']);
  });

  it('apply=true (ordinary sync) is unaffected by an empty default pool — behavior identical to calling without a pool argument', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-1': [row({ id: 'txn-2', amount: -100, date: '2026-09-10' })],
        'txn-2': [row({ id: 'txn-1', amount: 100, date: '2026-09-10' })],
      })
    );

    await reconcileRelationalRoles('user-1', ['txn-1'], true);

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      ['txn-1', 'txn-2'],
      expect.anything(),
      expect.objectContaining({ auto_role: 'internal_transfer' })
    );
  });
});

describe('user_role_override is never WRITTEN by this module (it IS read, for transfer eligibility — Round 4 remediation §3)', () => {
  it('only auto_role/source/confidence/version fields ever appear in a write', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([row({ id: 'txn-1', amount: 100, date: '2026-09-10' })]);
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-1': [row({ id: 'txn-2', amount: -100, date: '2026-09-10' })],
        'txn-2': [row({ id: 'txn-1', amount: 100, date: '2026-09-10' })],
      })
    );

    await reconcileRelationalRoles('user-1', ['txn-1']);

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledTimes(1); // sanity: the loop below isn't vacuous
    for (const call of mockApplyTransactionSemanticRoles.mock.calls) {
      const fields = call[3] as object;
      expect(Object.keys(fields).sort()).toEqual(['auto_role', 'classifier_version', 'role_confidence', 'role_source'].sort());
    }
  });
});

describe('repairExistingRelationalRoles — sweep-based retry-safe repair (Round 3 remediation §2/§3/§4/§6)', () => {
  it('re-validates every account_pair_match row against current data and resets one whose unique counterpart no longer exists', async () => {
    const staleRow = row({ id: 'txn-stale', amount: 100, date: '2026-09-10', category: 'TRANSFER_OUT', role_source: 'account_pair_match' });
    fakeAccountPairMatchStore([staleRow]).install();
    // The counterpart the row was originally paired against no longer exists (deleted, or its
    // amount/date/account changed) — the re-run candidate query finds nothing.
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);

    const result = await repairExistingRelationalRoles('user-1');

    expect(mockFindTransferCounterpartCandidates).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ id: 'txn-stale' }),
      '2026-09-07',
      '2026-09-13',
      'account_pair_match'
    );
    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledTimes(1);
    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      ['txn-stale'],
      ['account_pair_match'],
      expect.objectContaining({ role_source: 'transfer_like_unconfirmed' }) // fresh row-level classification
    );
    expect(result.resolved.map((r) => r.id)).toEqual(['txn-stale']);
  });

  it('leaves an account_pair_match row untouched when its unique, RECIPROCALLY-confirmed counterpart still validates', async () => {
    const stillPaired = row({ id: 'txn-a', amount: 100, date: '2026-09-10', role_source: 'account_pair_match' });
    fakeAccountPairMatchStore([stillPaired]).install();
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-a': [row({ id: 'txn-b', amount: -100, date: '2026-09-10' })],
        'txn-b': [row({ id: 'txn-a', amount: 100, date: '2026-09-10' })],
      })
    );

    const result = await repairExistingRelationalRoles('user-1');

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
    expect(result.resolved).toEqual([]);
  });

  it('one row LOOKS valid on its own (unique candidate) but is reset anyway because that candidate does not reciprocate (Round 4 remediation §3 applied to the sweep)', async () => {
    // txn-a's own search finds txn-c as its sole opposite-amount candidate, but txn-c's own true
    // best match is txn-b (closer) — txn-a must NOT be left as a falsely-confirmed pair.
    const A = row({ id: 'txn-a', amount: 500, date: '2026-09-11', role_source: 'account_pair_match' });
    fakeAccountPairMatchStore([A]).install();
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-a': [row({ id: 'txn-c', amount: -500, date: '2026-09-10' })],
        'txn-c': [row({ id: 'txn-b', amount: 500, date: '2026-09-10' })], // txn-c's real best is txn-b, not txn-a
      })
    );

    const result = await repairExistingRelationalRoles('user-1');

    expect(result.resolved.map((r) => r.id)).toEqual(['txn-a']);
  });

  it('BOTH legs of a broken pair are independently caught on their own turn through the sweep — no need to locate "the former partner"', async () => {
    const legA = row({ id: 'txn-a', amount: 300, date: '2026-09-10', role_source: 'account_pair_match' }); // amount just changed from 500
    const legB = row({ id: 'txn-b', amount: -500, date: '2026-09-01', role_source: 'account_pair_match' }); // unchanged, now orphaned
    fakeAccountPairMatchStore([legA, legB]).install();
    // Neither leg's own re-run query finds the other any more (amount mismatch on both sides).
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);

    const result = await repairExistingRelationalRoles('user-1');

    const resetIds = result.resolved.map((r) => r.id).sort();
    expect(resetIds).toEqual(['txn-a', 'txn-b']);
    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledTimes(2); // exactly once per leg, no repeated resets
  });

  it('A/B/C sweep regression: A/B are a genuine mutual pair, C only one-sidedly sees A — after the sweep, C is reset and NO stale A remains (Round 4 remediation §5)', async () => {
    const A = row({ id: 'txn-a', amount: 500, date: '2026-09-10', role_source: 'account_pair_match' });
    const B = row({ id: 'txn-b', amount: -500, date: '2026-09-10', role_source: 'account_pair_match' });
    const C = row({ id: 'txn-c', amount: 500, date: '2026-09-15', role_source: 'account_pair_match' });
    fakeAccountPairMatchStore([A, B, C]).install();
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-a': [B],
        'txn-b': [A], // B's true best is A (same day) — C is 5 days away, never even offered here
        'txn-c': [B],
      })
    );

    const result = await repairExistingRelationalRoles('user-1');

    expect(result.resolved.map((r) => r.id)).toEqual(['txn-c']);
    // A and B were never touched — they remain correctly paired, not stale.
    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalledWith('user-1', expect.arrayContaining(['txn-a']), expect.anything(), expect.anything());
    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalledWith('user-1', expect.arrayContaining(['txn-b']), expect.anything(), expect.anything());
  });

  it('an override moving one leg away from internal_transfer invalidates the pair cleanly — the overridden leg is reset without even being queried', async () => {
    const overridden = row({ id: 'txn-a', amount: 500, date: '2026-09-10', role_source: 'account_pair_match', user_role_override: 'expense' });
    fakeAccountPairMatchStore([overridden]).install();

    const result = await repairExistingRelationalRoles('user-1');

    expect(mockFindTransferCounterpartCandidates).not.toHaveBeenCalled();
    expect(result.resolved.map((r) => r.id)).toEqual(['txn-a']);
  });

  it('re-validates every refund_match row and resets one whose eligible original no longer exists (e.g. the original was deleted, or overridden away from expense)', async () => {
    const staleRefund = row({ id: 'txn-refund', amount: -50, date: '2026-09-10', name: 'Store', merchant_name: 'Store', role_source: 'refund_match' });
    mockGetRelationallyClassifiedTransactionsPage.mockImplementation(async (_userId: string, roleSource: string) => {
      if (roleSource === 'refund_match') return [staleRefund];
      return [];
    });
    mockFindRefundOriginalCandidates.mockResolvedValue([]); // original no longer eligible/exists

    const result = await repairExistingRelationalRoles('user-1');

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      ['txn-refund'],
      ['refund_match'],
      expect.objectContaining({ role_source: expect.not.stringMatching('refund_match') })
    );
    expect(result.resolved.map((r) => r.id)).toContain('txn-refund');
  });

  it('is retry-safe: re-triggering the sweep when the DB already reflects the new values (the exact Round 3 remediation §6 scenario) still completes the repair', async () => {
    // Attempt 1 already persisted the new amount for one leg of a pair and then (hypothetically)
    // failed before the sweep completed. Attempt 2 sees the SAME already-updated DB state — there
    // is no "old vs new" to compare, only "this batch had a modification" — and the sweep must
    // still find and repair the now-orphaned counterpart.
    const orphanedCounterpart = row({ id: 'txn-b', amount: -500, date: '2026-09-01', role_source: 'account_pair_match' });
    fakeAccountPairMatchStore([orphanedCounterpart]).install();
    mockFindTransferCounterpartCandidates.mockResolvedValue([]); // its old $500 partner is gone (now $300)

    const result = await repairExistingRelationalRoles('user-1');

    expect(result.resolved.map((r) => r.id)).toEqual(['txn-b']);
  });

  it('a page shorter than the page size stops pagination after one request (no unbounded/extra page fetch)', async () => {
    const pageOne = [row({ id: 'txn-1', amount: 100, date: '2026-09-10', role_source: 'account_pair_match' })];
    fakeAccountPairMatchStore(pageOne).install();
    // A reciprocally-valid pair (txn-1 <-> txn-2) — nothing gets reset, so the multi-pass loop
    // correctly stops after its first (and only) stable pass, isolating pagination behavior.
    mockFindTransferCounterpartCandidates.mockImplementation(
      transferCandidatesByRowId({
        'txn-1': [row({ id: 'txn-2', amount: -100, date: '2026-09-10' })],
        'txn-2': [row({ id: 'txn-1', amount: 100, date: '2026-09-10' })],
      })
    );

    await repairExistingRelationalRoles('user-1');

    const accountPairCalls = mockGetRelationallyClassifiedTransactionsPage.mock.calls.filter((c) => c[1] === 'account_pair_match');
    expect(accountPairCalls).toHaveLength(1); // one short page is the last page — no further fetch
    expect(accountPairCalls[0][3]).toBeNull(); // first page has no cursor
  });

  it('a full page advances the cursor to the last row\'s id for the next page request', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) =>
      row({ id: `txn-${String(i).padStart(3, '0')}`, amount: 100, date: '2026-09-10', role_source: 'account_pair_match' })
    );
    mockGetRelationallyClassifiedTransactionsPage.mockImplementation(
      async (_userId: string, roleSource: string, _limit: number, afterId: string | null) => {
        if (roleSource !== 'account_pair_match') return [];
        return afterId === null ? fullPage : [];
      }
    );
    // Every row in the page gets its own reciprocally-valid synthetic counterpart, so NOTHING in
    // this page gets reset — isolating pagination-cursor behavior from the multi-pass
    // reset-until-stable loop (Round 4 remediation §5), which would otherwise re-fetch and
    // re-process the page repeatedly.
    const candidatesById: Record<string, ReconciliationRow[]> = {};
    for (const r of fullPage) {
      const counterpart = row({ id: `counterpart-${r.id}`, amount: -100, date: '2026-09-10' });
      candidatesById[r.id] = [counterpart];
      candidatesById[counterpart.id] = [r];
    }
    mockFindTransferCounterpartCandidates.mockImplementation(transferCandidatesByRowId(candidatesById));

    await repairExistingRelationalRoles('user-1');

    const accountPairCalls = mockGetRelationallyClassifiedTransactionsPage.mock.calls.filter((c) => c[1] === 'account_pair_match');
    expect(accountPairCalls).toHaveLength(2);
    expect(accountPairCalls[1][3]).toBe('txn-199'); // resumes strictly after the previous page's last id
  });

  it('a SHRINKING predicate (every row in page 1 gets reset mid-page) never causes OFFSET-style skipping — page 2 is still fetched with the correct keyset cursor and its own row is still visited (Round 4 remediation §12)', async () => {
    const page1Rows = Array.from({ length: 200 }, (_, i) =>
      row({ id: `txn-${String(i).padStart(3, '0')}`, amount: 100, date: '2026-09-10', role_source: 'account_pair_match' })
    );
    const page2Row = row({ id: 'txn-200', amount: 500, date: '2026-09-10', role_source: 'account_pair_match' });
    fakeAccountPairMatchStorePaginated([...page1Rows, page2Row]);
    // Every row (both pages) has no candidates at all — everything gets reset, maximally
    // shrinking the underlying `account_pair_match` set as the sweep proceeds.
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);

    const result = await repairExistingRelationalRoles('user-1');

    const accountPairCalls = mockGetRelationallyClassifiedTransactionsPage.mock.calls.filter((c) => c[1] === 'account_pair_match');
    expect(accountPairCalls[0][3]).toBeNull(); // page 1: no cursor
    expect(accountPairCalls[1][3]).toBe('txn-199'); // page 2: resumes after page 1's ORIGINAL last id, unaffected by mid-page resets
    // Both page 1's 200 rows AND page 2's row were actually visited and reset.
    expect(result.resolved.map((r) => r.id)).toContain('txn-000');
    expect(result.resolved.map((r) => r.id)).toContain('txn-199');
    expect(result.resolved.map((r) => r.id)).toContain('txn-200');
  });

  it('never scans beyond this user — every page request is scoped to the given userId', async () => {
    mockGetRelationallyClassifiedTransactionsPage.mockResolvedValue([]);
    await repairExistingRelationalRoles('user-42');
    for (const call of mockGetRelationallyClassifiedTransactionsPage.mock.calls) {
      expect(call[0]).toBe('user-42');
    }
  });

  it('dry-run (apply=false) makes zero writes but still reports what it would reset', async () => {
    const staleRow = row({ id: 'txn-stale', amount: 100, date: '2026-09-10', role_source: 'account_pair_match' });
    mockGetRelationallyClassifiedTransactionsPage.mockImplementation(async (_userId: string, roleSource: string) => {
      if (roleSource === 'account_pair_match') return [staleRow];
      return [];
    });
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);

    const result = await repairExistingRelationalRoles('user-1', false);

    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
    expect(result.resolved.map((r) => r.id)).toContain('txn-stale');
  });

  it('is idempotent: calling the sweep again after it already reset a row makes no further change', async () => {
    const staleRow = row({ id: 'txn-stale', amount: 100, date: '2026-09-10', role_source: 'account_pair_match' });
    const store = fakeAccountPairMatchStore([staleRow]);
    store.install();
    mockFindTransferCounterpartCandidates.mockResolvedValue([]);

    const first = await repairExistingRelationalRoles('user-1');
    expect(first.resolved.map((r) => r.id)).toEqual(['txn-stale']);

    mockApplyTransactionSemanticRoles.mockClear();
    const second = await repairExistingRelationalRoles('user-1');

    expect(second.resolved).toEqual([]);
    expect(mockApplyTransactionSemanticRoles).not.toHaveBeenCalled();
  });

  it('fails CLOSED (throws RelationalRepairNotStableError) rather than silently succeeding when the sweep never reaches a stable state within the pass cap (Round 5 remediation, HIGH — "repair cap fails open")', async () => {
    // A page that never stops changing — e.g. a concurrent writer keeps re-tagging the same row
    // account_pair_match after every reset, so every pass finds it invalid and resets it again.
    // Never wire mockApplyTransactionSemanticRoles to remove it from the page (unlike
    // fakeAccountPairMatchStore), so the page is never actually empty/stable.
    const everInvalidRow = row({ id: 'txn-churning', amount: 100, date: '2026-09-10', role_source: 'account_pair_match' });
    mockGetRelationallyClassifiedTransactionsPage.mockImplementation(async (_userId: string, roleSource: string) =>
      roleSource === 'account_pair_match' ? [everInvalidRow] : []
    );
    mockFindTransferCounterpartCandidates.mockResolvedValue([]); // never valid

    await expect(repairExistingRelationalRoles('user-1')).rejects.toThrow(RelationalRepairNotStableError);
  });

  it('a genuinely quiescent dataset reaches stability well within the pass cap — the cap is a safety net, not a normal outcome', async () => {
    const A = row({ id: 'a', amount: 500, date: '2026-09-10', role_source: 'account_pair_match' });
    const B = row({ id: 'b', amount: -500, date: '2026-09-10', role_source: 'account_pair_match' });
    fakeAccountPairMatchStore([A, B]).install();
    mockFindTransferCounterpartCandidates.mockImplementation(transferCandidatesByRowId({ a: [B], b: [A] }));

    await expect(repairExistingRelationalRoles('user-1')).resolves.toEqual({ resolved: [], unresolved: [] });
  });
});

describe('reconcileAfterRelationalStateChange — replaces Round 2\'s reconcileAroundTransactionChange at loan link/unlink call sites', () => {
  it('runs both the forward pass for the changed row and the full repair sweep', async () => {
    const changed = row({ id: 'txn-x', amount: 100, date: '2026-09-10', role_source: 'transfer_like_unconfirmed' });
    mockGetTransactionsForReconciliation.mockResolvedValue([changed]);
    mockFindTransferCounterpartCandidates.mockResolvedValue([]); // no forward match
    mockGetRelationallyClassifiedTransactionsPage.mockResolvedValue([]); // nothing stale to repair

    await reconcileAfterRelationalStateChange('user-1', 'txn-x');

    expect(mockGetTransactionsForReconciliation).toHaveBeenCalledWith('user-1', ['txn-x']);
    expect(mockGetRelationallyClassifiedTransactionsPage).toHaveBeenCalledWith('user-1', 'account_pair_match', expect.any(Number), null);
    expect(mockGetRelationallyClassifiedTransactionsPage).toHaveBeenCalledWith('user-1', 'refund_match', expect.any(Number), null);
  });

  it('a transaction newly linked to a manual loan invalidates a prior transfer pairing — the sweep resets the counterpart', async () => {
    // The just-linked row is no longer transfer_like_unconfirmed/sign_default (linkTransactionToLoan
    // already set it to manual_loan_link directly), so the forward pass does nothing for it.
    const linked = row({ id: 'txn-linked', amount: 100, date: '2026-09-10', manual_loan_id: 'loan-1', auto_role: 'debt_payment', role_source: 'manual_loan_link', effective_role: 'debt_payment' });
    mockGetTransactionsForReconciliation.mockResolvedValue([linked]);

    const orphanedCounterpart = row({ id: 'txn-counterpart', amount: -100, date: '2026-09-10', role_source: 'account_pair_match' });
    fakeAccountPairMatchStore([orphanedCounterpart]).install();
    mockFindTransferCounterpartCandidates.mockResolvedValue([]); // the linked row no longer qualifies as its partner

    await reconcileAfterRelationalStateChange('user-1', 'txn-linked');

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      ['txn-counterpart'],
      ['account_pair_match'],
      expect.not.objectContaining({ role_source: 'account_pair_match' })
    );
  });

  it('unlink with existing refund evidence resolves the refund role immediately via the forward pass', async () => {
    const unlinked = row({ id: 'txn-unlinked', amount: -50, name: 'Store', merchant_name: 'Store', manual_loan_id: null, auto_role: 'income', role_source: 'sign_default', effective_role: 'income' });
    mockGetTransactionsForReconciliation.mockResolvedValue([unlinked]);
    mockFindRefundOriginalCandidates.mockResolvedValueOnce([
      row({ id: 'txn-orig', amount: 50, name: 'Store', merchant_name: 'Store', effective_role: 'expense' }),
    ]);
    mockGetRelationallyClassifiedTransactionsPage.mockResolvedValue([]);

    const result = await reconcileAfterRelationalStateChange('user-1', 'txn-unlinked');

    expect(mockApplyTransactionSemanticRoles).toHaveBeenCalledWith(
      'user-1',
      ['txn-unlinked'],
      expect.anything(),
      expect.objectContaining({ auto_role: 'refund' })
    );
    expect(result.resolved.some((r) => r.id === 'txn-unlinked' && r.fields.auto_role === 'refund')).toBe(true);
  });

  it('does nothing (but does not throw) when the changed transaction no longer exists for this user', async () => {
    mockGetTransactionsForReconciliation.mockResolvedValue([]);
    mockGetRelationallyClassifiedTransactionsPage.mockResolvedValue([]);

    const result = await reconcileAfterRelationalStateChange('user-1', 'txn-gone');

    expect(result).toEqual({ resolved: [], unresolved: [] });
  });
});
