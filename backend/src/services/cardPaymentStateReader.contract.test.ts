import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabaseAdmin: { rpc: vi.fn(), from: vi.fn() } }));

import { parseCardPaymentStates, SUPPORTED_EVALUATOR_CONTRACT } from './cardPaymentStateReader';
import { parseFinancialSnapshot } from './financialSnapshot';
import { aggregateCashFlow } from './semanticAggregation';

// The evaluator contract and the review states of the card-payment state payload (I3A-R packet 2-A; migration
// 20261009120000). The database is what refuses a result an older evaluator published (it returns no states for
// it). This reader's part: accept only a contract it knows, carry the review states, and never turn a payload
// it does not understand into figures.

const K = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const W = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHECKING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CARD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OBLIGATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const guardedCashLeg = {
  transactionId: K,
  accountId: CHECKING,
  date: '2026-09-10',
  amountCents: 37000,
  pending: false,
  side: 'cash',
  direction: 'payment',
  accountIncluded: true,
  state: 'unresolved',
  reason: 'relink_review_required',
  detail: null,
  partnerTransactionId: null,
  decisionId: null,
  candidates: [],
  effectCents: null,
  lowCents: -37000,
  highCents: 0,
  cashExcessCents: 0,
  cardExcessCents: 0,
  recent: false,
};
const guardedCardLeg = { ...guardedCashLeg, transactionId: W, accountId: CARD, date: '2026-09-11', amountCents: -37000, side: 'credit', effectCents: 0, lowCents: 0, highCents: 0 };
const review = (transactionId: string, partner: string | null) => ({
  transactionId,
  guardWithheld: partner !== null,
  withheldPartnerTransactionId: partner,
  obligationIds: [OBLIGATION],
  coverageGap: false,
});
const payload = (over: Record<string, unknown> = {}) => ({
  fresh: true,
  inputVersion: 9,
  evaluatedVersion: 9,
  asOf: '2026-10-09T00:00:00+00:00',
  legs: [guardedCashLeg, guardedCardLeg],
  decisions: [],
  supersededTransactionIds: [],
  evaluatorContract: SUPPORTED_EVALUATOR_CONTRACT,
  reviews: [review(K, W), review(W, K)],
  ...over,
});

describe('the evaluator contract', () => {
  it('this backend supports contract 2 — the evaluator with the relink-review guard', () => {
    expect(SUPPORTED_EVALUATOR_CONTRACT).toBe(2);
  });

  it('a fresh payload of the supported contract is read, with its review states', () => {
    const parsed = parseCardPaymentStates(payload());
    expect(parsed).toMatchObject({ kind: 'fresh', inputVersion: 9 });
    if (parsed?.kind !== 'fresh') throw new Error('expected fresh');
    expect(parsed.states.legs.map((l) => `${l.state}/${l.reason}/${l.effectCents}/${l.lowCents}..${l.highCents}`)).toEqual([
      'unresolved/relink_review_required/null/-37000..0',
      'unresolved/relink_review_required/0/0..0',
    ]);
    expect(parsed.states.reviews).toEqual([review(K, W), review(W, K)]);
  });

  it.each([
    ['a contract this backend does not know (a newer evaluator)', payload({ evaluatorContract: 3 })],
    ['an older contract number', payload({ evaluatorContract: 1 })],
    ['a contract that is not a number', payload({ evaluatorContract: '2' })],
    ['a null contract on a fresh payload', payload({ evaluatorContract: null })],
    ['the contract without its review states', payload({ reviews: undefined })],
    ['review states that are not a list', payload({ reviews: {} })],
    ['a review of a leg that is not in the payload', payload({ reviews: [review('ffffffff-ffff-4fff-8fff-ffffffffffff', null)] })],
    ['the same leg reviewed twice', payload({ reviews: [review(K, W), review(K, W)] })],
    ['a withheld leg that does not name what it was withheld from', payload({ reviews: [{ ...review(K, W), withheldPartnerTransactionId: null }] })],
    ['a review with no obligation', payload({ reviews: [{ ...review(K, W), obligationIds: [] }] })],
  ])('refuses %s: the figures are unavailable, never computed', (_name, value) => {
    expect(parseCardPaymentStates(value)).toBeNull();
  });

  it('a fresh payload with NO contract comes from a database without the migration and is read as before', () => {
    const { evaluatorContract: _contract, reviews: _reviews, ...legacy } = payload({ legs: [] });
    const parsed = parseCardPaymentStates(legacy);
    expect(parsed).toMatchObject({ kind: 'fresh' });
    if (parsed?.kind !== 'fresh') throw new Error('expected fresh');
    expect(parsed.states.reviews).toBeUndefined();
    // …but review states without a contract are not a shape either database produces.
    expect(parseCardPaymentStates({ ...legacy, reviews: [] })).toBeNull();
  });

  it('a result the database withholds — stale by version, or published by another evaluator — is stale: no states', () => {
    // What get_card_payment_states returns for a user whose stored versions are equal but who carries no stamp.
    const unstamped = parseCardPaymentStates({ fresh: false, inputVersion: 9, evaluatedVersion: 9, lastErrorCode: null, evaluatorContract: null });
    expect(unstamped).toEqual({ kind: 'stale', inputVersion: 9, evaluatedVersion: 9, lastErrorCode: null });
    expect(parseCardPaymentStates({ fresh: false, inputVersion: 9, evaluatedVersion: 8, lastErrorCode: '55P03', evaluatorContract: 2 })).toEqual({
      kind: 'stale',
      inputVersion: 9,
      evaluatedVersion: 8,
      lastErrorCode: '55P03',
    });
  });
});

describe('through the financial snapshot and the aggregation', () => {
  const transaction = (id: string, accountId: string, type: string, date: string, amount: number) => ({
    id,
    account_id: accountId,
    date,
    amount,
    category: null,
    budget_category_id: null,
    effective_role: 'credit_card_payment',
    user_role_override: null,
    manual_loan_id: null,
    principal_portion: null,
    name: 'Card payment',
    merchant_name: null,
    pending: false,
    needs_review: false,
    plaid_transaction_id: `p-${id}`,
    pending_transaction_id: null,
    accounts: { name: 'Account', nickname: null, type, exclude_from_cash_flow: false },
  });
  const request = { rows: { start: '2026-09-01', end: '2026-10-01' }, cardStates: { from: '2026-09-01', to: '2026-10-01' } };
  const snapshot = (cardPayments: unknown) => ({
    tooLarge: false,
    transactionCount: 2,
    splitCount: 0,
    maxTransactions: 10000,
    maxSplits: 25000,
    transactions: [transaction(K, CHECKING, 'depository', '2026-09-10', 370), transaction(W, CARD, 'credit', '2026-09-11', -370)],
    splits: null,
    budgetCategories: null,
    cardPayments,
  });

  it('a guarded payment is a RANGE in the cash-flow aggregate — not 0 and not −370', () => {
    const parsed = parseFinancialSnapshot(snapshot(payload()), request);
    if (parsed?.kind !== 'snapshot' || parsed.snapshot.cardPayments?.kind !== 'fresh') throw new Error('expected a fresh snapshot');
    const rows = parsed.snapshot.transactions;
    const totals = aggregateCashFlow({
      accounts: [
        { id: CHECKING, type: 'depository', excludeFromCashFlow: false },
        { id: CARD, type: 'credit', excludeFromCashFlow: false },
      ],
      transactions: rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        date: r.date,
        amount: r.amount,
        plaidCategory: r.category,
        budgetCategoryId: r.budget_category_id,
        effectiveRole: r.effective_role,
        userRoleOverride: r.user_role_override,
        manualLoanId: r.manual_loan_id,
        principalPortion: r.principal_portion,
      })),
      cardPayments: parsed.snapshot.cardPayments.states,
      period: { start: '2026-09-01', end: '2026-10-01' },
    });
    expect(totals.cardPaymentsUnresolved).toEqual({ count: 1, paymentsAmount: 370, returnsAmount: 0, byReason: { relink_review_required: 1 } });
    expect(totals.creditCardPaymentsTracked).toBe(0);
    expect(totals.creditCardPaymentsUntracked).toBe(0);
    expect(totals.cardPaymentsUnresolvedCredit).toBe(370);
  });

  it('a snapshot whose card states name an unknown contract is not a snapshot at all', () => {
    expect(parseFinancialSnapshot(snapshot(payload({ evaluatorContract: 3 })), request)).toBeNull();
  });
});
