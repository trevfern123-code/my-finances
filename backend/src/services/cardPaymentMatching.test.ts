import { describe, expect, it } from 'vitest';
import {
  CardPaymentMatchingIntegrityError,
  evaluateCardPayments,
  evaluateCardPaymentsForAllUsers,
  summarizeCardPaymentPeriod,
  type CardPaymentEvaluation,
  type DecisionLegRef,
  type MatchingAccount,
  type MatchingCarryover,
  type MatchingDecision,
  type MatchingTransaction,
} from './cardPaymentMatching';

// Stage 1 — the pure card-payment matching reference evaluator (CARD_PAYMENT_PAIRING_DESIGN.md rev 3).
// Every expected value below is taken from the design's own statements (section cited per test), not
// from the implementation. Amounts are integer cents; Plaid sign (+ out, − in). "C" is an included
// checking account, "X"/"Y" included cards, "E" an excluded card, "F" an excluded savings account.

const U = 'user-1';
const V = 'user-2';

const account = (id: string, type: string | null, excluded = false, userId = U): MatchingAccount => ({
  id,
  userId,
  type,
  excludeFromCashFlow: excluded,
});
const C = account('C', 'depository');
const X = account('X', 'credit');
const Y = account('Y', 'credit');
const E = account('E', 'credit', true);
const F = account('F', 'depository', true);

interface TxOptions {
  plaid?: string;
  pendingOf?: string;
  pending?: boolean;
  role?: string | null;
}
const tx = (id: string, accountId: string, date: string, cents: number, o: TxOptions = {}): MatchingTransaction => ({
  id,
  accountId,
  plaidTransactionId: o.plaid ?? `p-${id}`,
  pendingTransactionId: o.pendingOf ?? null,
  pending: o.pending ?? false,
  date,
  amountCents: cents,
  effectiveRole: o.role === undefined ? 'credit_card_payment' : o.role,
});
const ref = (accountId: string, plaid: string, cents: number): DecisionLegRef => ({ accountId, plaidTransactionId: plaid, cents });
let seq = 0;
const decision = (
  id: string,
  kind: MatchingDecision['kind'],
  a: DecisionLegRef,
  b: DecisionLegRef | null = null,
  acceptedDifferenceCents: number | null = kind === 'pair' ? 0 : null,
  extra: Partial<MatchingDecision> = {}
): MatchingDecision => ({ id, userId: U, kind, a, b, acceptedDifferenceCents, decidedSeq: ++seq, supersededBy: null, ...extra });

interface Scenario {
  accounts?: MatchingAccount[];
  transactions: MatchingTransaction[];
  decisions?: MatchingDecision[];
  carryovers?: MatchingCarryover[];
  asOf?: string;
  userId?: string;
}
const evaluate = (s: Scenario): CardPaymentEvaluation =>
  evaluateCardPayments({
    userId: s.userId ?? U,
    asOf: s.asOf ?? '2026-10-15T00:00:00Z',
    accounts: s.accounts ?? [C, X, E, F],
    transactions: s.transactions,
    carryovers: s.carryovers ?? [],
    decisions: s.decisions ?? [],
  });
const legOf = (ev: CardPaymentEvaluation, id: string) => {
  const found = ev.legs.find((l) => l.transactionId === id);
  if (!found) throw new Error(`no leg ${id}`);
  return found;
};
const SEP = { start: '2026-09-01', end: '2026-10-01' };
const OCT = { start: '2026-10-01', end: '2026-11-01' };

describe('R3 (design §1, §4.1, §4.2): unpaired tracked legs are unresolved ranges, never a guessed figure', () => {
  const late = [tx('pay', 'C', '2026-09-01', 10000), tx('card', 'X', '2026-09-07', -10000)];

  it('late card leg (6 days): both legs unresolved/possible_match, cash bounds [−100, 0] — not −100', () => {
    const ev = evaluate({ transactions: late });
    const pay = legOf(ev, 'pay');
    expect(pay).toMatchObject({ state: 'unresolved', reason: 'possible_match', effectCents: null, lowCents: -10000, highCents: 0 });
    expect(pay.candidates).toEqual([{ transactionId: 'card', kind: 'exact_amount', distanceDays: 6, differenceCents: 0, contradictsDecision: false }]);
    expect(legOf(ev, 'card')).toMatchObject({ side: 'credit', state: 'unresolved', lowCents: 0, highCents: 0 });
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: -10000, highCents: 0, resolved: false, unresolvedCount: 1 });
  });

  it('confirmed by the user → tracked/user_pair, 0 (the figure the slice-1 it.fails test states)', () => {
    const ev = evaluate({ transactions: late, decisions: [decision('d1', 'pair', ref('C', 'p-pay', 10000), ref('X', 'p-card', -10000))] });
    expect(legOf(ev, 'pay')).toMatchObject({ state: 'tracked', reason: 'user_pair', effectCents: 0, partnerTransactionId: 'card' });
    expect(legOf(ev, 'card')).toMatchObject({ state: 'paired', reason: 'user_pair', partnerTransactionId: 'pay' });
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: 0, highCents: 0, resolved: true });
  });

  it('rejected (not_this_pair) → still unresolved/no_candidate with the same bounds; never untracked (§3.3, T4)', () => {
    const ev = evaluate({ transactions: late, decisions: [decision('d1', 'not_this_pair', ref('C', 'p-pay', 10000), ref('X', 'p-card', -10000))] });
    expect(legOf(ev, 'pay')).toMatchObject({ state: 'unresolved', reason: 'no_candidate', lowCents: -10000, highCents: 0, candidates: [] });
  });

  it('user confirms "a card I haven\'t linked" → untracked/user_confirmed_unlinked, −100', () => {
    const ev = evaluate({ transactions: late, decisions: [decision('d1', 'destination_unlinked', ref('C', 'p-pay', 10000))] });
    expect(legOf(ev, 'pay')).toMatchObject({ state: 'untracked', reason: 'user_confirmed_unlinked', effectCents: -10000 });
  });

  it('card leg within 5 days (Sep 6) → tier 1 pairs automatically, 0', () => {
    const ev = evaluate({ transactions: [tx('pay', 'C', '2026-09-01', 10000), tx('card', 'X', '2026-09-06', -10000)] });
    expect(legOf(ev, 'pay')).toMatchObject({ state: 'tracked', reason: 'auto_pair', effectCents: 0 });
  });

  const codex = (returnDate: string) => [
    tx('pay', 'C', '2026-09-01', 10000),
    tx('card', 'X', '2026-09-02', -10000),
    tx('rev', 'X', '2026-09-10', 10000),
    tx('ret', 'C', returnDate, -10000),
  ];

  it("Codex's return 6 days after the reversal: a return-of-pair suggestion, bounds [0, +100] (§4.2, T3)", () => {
    const ev = evaluate({ transactions: codex('2026-09-16') });
    expect(legOf(ev, 'pay')).toMatchObject({ state: 'tracked', reason: 'auto_pair' });
    const ret = legOf(ev, 'ret');
    expect(ret).toMatchObject({ state: 'unresolved', reason: 'possible_match', direction: 'return', lowCents: 0, highCents: 10000 });
    expect(ret.candidates).toEqual([{ transactionId: 'rev', kind: 'return_of_pair', distanceDays: 6, differenceCents: 0, contradictsDecision: false }]);
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: 0, highCents: 10000 });
  });

  it("Codex's return, confirmed → 0 for the month (the figure the slice-1 it.fails test states)", () => {
    const ev = evaluate({
      transactions: codex('2026-09-16'),
      decisions: [decision('d1', 'pair', ref('C', 'p-ret', -10000), ref('X', 'p-rev', 10000))],
    });
    expect(legOf(ev, 'ret')).toMatchObject({ state: 'tracked', reason: 'user_pair', effectCents: 0 });
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: 0, highCents: 0, resolved: true });
  });

  it("Codex's return 5 days after the reversal: tier 1 pairs it automatically", () => {
    const ev = evaluate({ transactions: codex('2026-09-15') });
    expect(legOf(ev, 'ret')).toMatchObject({ state: 'tracked', reason: 'auto_pair', effectCents: 0 });
  });
});

describe('§3.4 / T4: nothing but evidence or the user makes a leg untracked', () => {
  it('no candidate, long ago, with an included card: unresolved, whatever asOf says', () => {
    for (const asOf of ['2026-09-02T00:00:00Z', '2027-09-01T00:00:00Z']) {
      const ev = evaluate({ transactions: [tx('pay', 'C', '2026-09-01', 25000)], asOf });
      expect(legOf(ev, 'pay')).toMatchObject({ state: 'unresolved', reason: 'no_candidate', lowCents: -25000, highCents: 0 });
    }
  });

  it('asOf only changes the "recent" label, never the state or bounds', () => {
    const recent = legOf(evaluate({ transactions: [tx('pay', 'C', '2026-09-01', 25000)], asOf: '2026-09-03T00:00:00Z' }), 'pay');
    const old = legOf(evaluate({ transactions: [tx('pay', 'C', '2026-09-01', 25000)], asOf: '2027-01-01T00:00:00Z' }), 'pay');
    expect(recent.recent).toBe(true);
    expect(old.recent).toBe(false);
    expect({ ...recent, recent: null }).toEqual({ ...old, recent: null });
  });

  it('no included credit account at all → untracked/no_included_card immediately (§4.5)', () => {
    const ev = evaluate({ accounts: [C, E], transactions: [tx('pay', 'C', '2026-09-01', 25000)] });
    expect(legOf(ev, 'pay')).toMatchObject({ state: 'untracked', reason: 'no_included_card', effectCents: -25000 });
  });

  it('an excluded card does not count as an included card for that proof', () => {
    const ev = evaluate({ accounts: [C, E], transactions: [tx('pay', 'C', '2026-09-01', 25000)] });
    expect(legOf(ev, 'pay').reason).toBe('no_included_card');
    const withX = evaluate({ accounts: [C, E, X], transactions: [tx('pay', 'C', '2026-09-01', 25000)] });
    expect(legOf(withX, 'pay').reason).toBe('no_candidate');
  });
});

describe('§4.6 / T5: excluded accounts are evidence; effects follow the tracked set', () => {
  it('R6 payment to an excluded card → untracked/partner_excluded −500 immediately; the excluded leg is not counted', () => {
    const ev = evaluate({ transactions: [tx('pay', 'C', '2026-09-01', 50000), tx('e', 'E', '2026-09-02', -50000)] });
    expect(legOf(ev, 'pay')).toMatchObject({ state: 'untracked', reason: 'partner_excluded', effectCents: -50000, partnerTransactionId: 'e' });
    expect(legOf(ev, 'e')).toMatchObject({ state: 'not_counted', reason: 'excluded_account', lowCents: 0, highCents: 0 });
  });

  it('T7: including that card later makes the same history tracked (0) on the next evaluation', () => {
    const rows = [tx('pay', 'C', '2026-09-01', 50000), tx('e', 'E', '2026-09-02', -50000)];
    const ev = evaluate({ accounts: [C, X, { ...E, excludeFromCashFlow: false }], transactions: rows });
    expect(legOf(ev, 'pay')).toMatchObject({ state: 'tracked', reason: 'auto_pair', effectCents: 0 });
  });

  it('R7 an excluded card closer than the included card → −100 confirmed, zero unresolved exposure', () => {
    const ev = evaluate({
      transactions: [tx('pay', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-03', -10000), tx('e', 'E', '2026-09-02', -10000)],
    });
    expect(legOf(ev, 'pay')).toMatchObject({ state: 'untracked', reason: 'partner_excluded', effectCents: -10000, partnerTransactionId: 'e' });
    expect(legOf(ev, 'x')).toMatchObject({ side: 'credit', state: 'unresolved', reason: 'ambiguous', lowCents: 0, highCents: 0 });
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: -10000, highCents: -10000, resolved: true, unresolvedCount: 0 });
  });

  it('R4 an excluded card leg tying with the included one → ambiguous, bounds [−555, 0] (§4.4)', () => {
    const ev = evaluate({
      transactions: [tx('pay', 'C', '2026-09-15', 55500), tx('x', 'X', '2026-09-16', -55500), tx('e', 'E', '2026-09-14', -55500)],
    });
    const pay = legOf(ev, 'pay');
    expect(pay).toMatchObject({ state: 'unresolved', reason: 'ambiguous', lowCents: -55500, highCents: 0 });
    expect(pay.candidates.map((c) => [c.transactionId, c.kind])).toEqual([
      ['e', 'tier1_competitor'],
      ['x', 'tier1_competitor'],
    ]);
  });

  it('R5 an excluded cash account funding an included card → card leg funded_from_excluded, nothing counted', () => {
    const ev = evaluate({ transactions: [tx('f', 'F', '2026-09-01', 65000), tx('x', 'X', '2026-09-02', -65000)] });
    expect(legOf(ev, 'x')).toMatchObject({ state: 'funded_from_excluded', reason: 'auto_pair', effectCents: 0 });
    expect(legOf(ev, 'f')).toMatchObject({ state: 'not_counted', reason: 'excluded_account' });
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: 0, highCents: 0, resolved: true });
  });

  it('R1 a NULL account type is the cash side (as semanticAggregation.ts)', () => {
    const N = account('N', null);
    const ev = evaluate({ accounts: [N, X], transactions: [tx('n', 'N', '2026-09-01', 71000), tx('x', 'X', '2026-09-02', -71000)] });
    expect(legOf(ev, 'n')).toMatchObject({ side: 'cash', direction: 'payment', state: 'tracked', reason: 'auto_pair' });
  });
});

describe('R2/R3 (audit boundary cases) on full history: suggestions honour the 60-day limit and reciprocity', () => {
  it('the only exact candidate 60 days away is itself paired (4 days from another payment) → no_candidate', () => {
    const ev = evaluate({
      transactions: [tx('c', 'C', '2026-11-01', 33300), tx('x', 'X', '2026-09-02', -33300), tx('c2', 'C', '2026-08-29', 33300)],
      asOf: '2026-11-15T00:00:00Z',
    });
    expect(legOf(ev, 'x')).toMatchObject({ state: 'paired', partnerTransactionId: 'c2' });
    expect(legOf(ev, 'c')).toMatchObject({ state: 'unresolved', reason: 'no_candidate', candidates: [] });
  });

  it('the candidate ties between two payments 4 days either side → unpaired → possible_match at exactly 60 days', () => {
    const ev = evaluate({
      transactions: [
        tx('c', 'C', '2026-11-01', 44400),
        tx('x', 'X', '2026-09-02', -44400),
        tx('c2', 'C', '2026-08-29', 44400),
        tx('c3', 'C', '2026-09-06', 44400),
      ],
      asOf: '2026-11-15T00:00:00Z',
    });
    expect(legOf(ev, 'x')).toMatchObject({ state: 'unresolved', reason: 'ambiguous' });
    expect(legOf(ev, 'c').candidates).toEqual([{ transactionId: 'x', kind: 'exact_amount', distanceDays: 60, differenceCents: 0, contradictsDecision: false }]);
  });

  it('61 days away is not suggested (T2); 60 is', () => {
    const at = (date: string) => legOf(evaluate({ transactions: [tx('c', 'C', '2026-11-01', 100), tx('x', 'X', date, -100)] }), 'c');
    expect(at('2026-09-02').reason).toBe('possible_match'); // 60 days
    expect(at('2026-09-01').reason).toBe('no_candidate'); // 61 days
  });
});

describe('§4.3 / T6: fee-difference rules, each row of the design table (explicit acceptance)', () => {
  const feePair = (cash: [string, number], card: [string, number], accepted: number, accounts?: MatchingAccount[]) =>
    evaluate({
      accounts,
      transactions: [tx('c', cash[0], '2026-09-01', cash[1]), tx('k', card[0], '2026-09-02', card[1])],
      decisions: [decision('d', 'pair', ref(cash[0], 'p-c', cash[1]), ref(card[0], 'p-k', card[1]), accepted)],
    });

  it('payment, cash larger (C +100 / X −98) → −2.00', () => {
    const ev = feePair(['C', 10000], ['X', -9800], 200);
    expect(legOf(ev, 'c')).toMatchObject({ state: 'tracked', reason: 'user_pair', effectCents: -200, cashExcessCents: 200, cardExcessCents: 0 });
  });
  it('payment, card larger (C +98 / X −100) → 0; the card excess is externally funded', () => {
    const ev = feePair(['C', 9800], ['X', -10000], -200);
    expect(legOf(ev, 'c')).toMatchObject({ state: 'tracked', effectCents: 0 });
    expect(legOf(ev, 'k')).toMatchObject({ state: 'paired', cardExcessCents: 200, effectCents: 0 });
  });
  it('return, cash larger (C −100 / X +98) → +2.00', () => {
    expect(legOf(feePair(['C', -10000], ['X', 9800], 200), 'c')).toMatchObject({ state: 'tracked', effectCents: 200 });
  });
  it('return, card larger (C −98 / X +100) → 0', () => {
    expect(legOf(feePair(['C', -9800], ['X', 10000], -200), 'c')).toMatchObject({ state: 'tracked', effectCents: 0 });
  });
  it('excluded card partner, any difference (C +100 / E −98) → the whole cash leg, −100', () => {
    expect(legOf(feePair(['C', 10000], ['E', -9800], 200), 'c')).toMatchObject({ state: 'untracked', reason: 'partner_excluded', effectCents: -10000 });
  });
  it('excluded card partner, return (C −100 / E +98) → +100', () => {
    expect(legOf(feePair(['C', -10000], ['E', 9800], 200), 'c')).toMatchObject({ state: 'untracked', effectCents: 10000 });
  });
  it('excluded cash account (F +100 / X −98) → nothing counted; card leg funded_from_excluded', () => {
    const ev = feePair(['F', 10000], ['X', -9800], 200);
    expect(legOf(ev, 'c')).toMatchObject({ state: 'not_counted' });
    expect(legOf(ev, 'k')).toMatchObject({ state: 'funded_from_excluded', effectCents: 0 });
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: 0, highCents: 0 });
  });
  it('including E later switches −100 → −2.00 (the pair stores both amounts)', () => {
    const ev = feePair(['C', 10000], ['E', -9800], 200, [C, X, { ...E, excludeFromCashFlow: false }]);
    expect(legOf(ev, 'c')).toMatchObject({ state: 'tracked', effectCents: -200 });
  });
  it('a difference not explicitly accepted (wrong accepted amount) leaves the pair inactive → unresolved', () => {
    const ev = feePair(['C', 10000], ['X', -9800], 0);
    expect(legOf(ev, 'c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'difference_not_accepted' });
    expect(ev.decisions[0]).toMatchObject({ status: 'inactive', detail: 'difference_not_accepted' });
  });
  it('a payment can never pair with a return (same signs) → inactive direction_mismatch', () => {
    const ev = feePair(['C', 10000], ['X', 10000], 0);
    expect(legOf(ev, 'c')).toMatchObject({ reason: 'decision_invalidated', detail: 'direction_mismatch' });
  });
  it('without a decision, a near amount within 5 days is only a suggestion (amount_differs), never paired', () => {
    const ev = evaluate({ transactions: [tx('c', 'C', '2026-09-01', 10000), tx('k', 'X', '2026-09-02', -9800)] });
    expect(legOf(ev, 'c')).toMatchObject({ state: 'unresolved', reason: 'amount_differs' });
    expect(legOf(ev, 'c').candidates).toEqual([{ transactionId: 'k', kind: 'near_amount', distanceDays: 1, differenceCents: 200, contradictsDecision: false }]);
  });
  it('$5.00 is suggested, $5.01 is not (T2)', () => {
    const at = (card: number) => legOf(evaluate({ transactions: [tx('c', 'C', '2026-09-01', 10000), tx('k', 'X', '2026-09-02', card)] }), 'c').reason;
    expect(at(-9500)).toBe('amount_differs');
    expect(at(-9499)).toBe('no_candidate');
  });
});

describe('§4.4 ambiguous matches', () => {
  const tie = [tx('c1', 'C', '2026-09-01', 40000), tx('c2', 'C', '2026-09-03', 40000), tx('x', 'X', '2026-09-02', -40000)];

  it('two payments, one card credit, equally close → all ambiguous, per-leg bounds sum to [−800, 0]', () => {
    const ev = evaluate({ transactions: tie });
    expect(ev.legs.map((l) => l.reason)).toEqual(['ambiguous', 'ambiguous', 'ambiguous']);
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: -80000, highCents: 0, unresolvedCount: 2 });
  });

  it('after the user picks one, the other payment stays unresolved (not untracked)', () => {
    const ev = evaluate({ transactions: tie, decisions: [decision('d', 'pair', ref('C', 'p-c1', 40000), ref('X', 'p-x', -40000))] });
    expect(legOf(ev, 'c1')).toMatchObject({ state: 'tracked', reason: 'user_pair' });
    expect(legOf(ev, 'c2')).toMatchObject({ state: 'unresolved', reason: 'no_candidate' });
  });

  it('one payment, two card credits on the same day → ambiguous', () => {
    const ev = evaluate({
      accounts: [C, X, Y],
      transactions: [tx('c', 'C', '2026-09-01', 40000), tx('x', 'X', '2026-09-02', -40000), tx('y', 'Y', '2026-09-02', -40000)],
    });
    expect(legOf(ev, 'c')).toMatchObject({ state: 'unresolved', reason: 'ambiguous' });
  });
});

describe('§3.2 precedence: user decisions over automation; §4.7 removal (T9)', () => {
  it('an active user decision stands against a tier-1-shaped leg, which is shown as a contradiction', () => {
    const ev = evaluate({
      transactions: [tx('c', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-02', -10000)],
      decisions: [decision('d', 'destination_unlinked', ref('C', 'p-c', 10000))],
    });
    const c = legOf(ev, 'c');
    expect(c).toMatchObject({ state: 'untracked', reason: 'user_confirmed_unlinked', effectCents: -10000 });
    expect(c.candidates).toEqual([{ transactionId: 'x', kind: 'tier1_competitor', distanceDays: 1, differenceCents: 0, contradictsDecision: true }]);
  });

  it('removal preserved the destination: untracked/removed_card (the card and its legs are gone)', () => {
    const ev = evaluate({
      accounts: [C, Y],
      transactions: [tx('c', 'C', '2026-09-01', 10000)],
      decisions: [decision('r', 'destination_removed_card', ref('C', 'p-c', 10000))],
    });
    expect(legOf(ev, 'c')).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -10000, decisionId: 'r' });
  });

  it('relinked card re-imports the matching leg → tier 1 outranks the removed-card decision → tracked', () => {
    const ev = evaluate({
      accounts: [C, account('X2', 'credit')],
      transactions: [tx('c', 'C', '2026-09-01', 10000), tx('x2', 'X2', '2026-09-02', -10000)],
      decisions: [decision('r', 'destination_removed_card', ref('C', 'p-c', 10000))],
    });
    expect(legOf(ev, 'c')).toMatchObject({ state: 'tracked', reason: 'auto_pair' });
  });

  it('a superseded (undone) decision is ignored', () => {
    const ev = evaluate({
      transactions: [tx('c', 'C', '2026-09-01', 10000)],
      decisions: [decision('d', 'destination_unlinked', ref('C', 'p-c', 10000), null, null, { supersededBy: 'd2' })],
    });
    expect(legOf(ev, 'c')).toMatchObject({ state: 'unresolved', reason: 'no_candidate' });
    expect(ev.decisions).toEqual([{ decisionId: 'd', kind: 'destination_unlinked', status: 'superseded', detail: null }]);
  });
});

describe('§3.6 / §4.8 lineage: decisions survive pending → posted in every order', () => {
  const pairOnPending = decision('d', 'pair', ref('C', 'pc', 10000), ref('X', 'pk', -10000));
  const Pc = tx('Pc', 'C', '2026-09-01', 10000, { plaid: 'pc', pending: true });
  const Pk = tx('Pk', 'X', '2026-09-08', -10000, { plaid: 'pk', pending: true }); // 7 days: needs the decision
  const Tc = (cents = 10000) => tx('Tc', 'C', '2026-09-02', cents, { plaid: 'tc', pendingOf: 'pc' });
  const Tk = tx('Tk', 'X', '2026-09-09', -10000, { plaid: 'tk', pendingOf: 'pk' });
  const waiting = (plaid: string, accountId: string): MatchingCarryover => ({
    accountId,
    pendingPlaidTransactionId: plaid,
    expiresAt: '2026-11-01T00:00:00Z',
    consumed: false,
  });

  it('decided on the pending rows → tracked/user_pair', () => {
    expect(legOf(evaluate({ transactions: [Pc, Pk], decisions: [pairOnPending] }), 'Pc')).toMatchObject({ state: 'tracked', reason: 'user_pair' });
  });

  it('both pending rows removed before either posts → no legs, decision kept inactive (waiting_to_post)', () => {
    const ev = evaluate({ transactions: [], decisions: [pairOnPending], carryovers: [waiting('pc', 'C'), waiting('pk', 'X')] });
    expect(ev.legs).toEqual([]);
    expect(ev.decisions[0]).toMatchObject({ status: 'inactive', detail: 'waiting_to_post' });
  });

  it('Tc posts while Pk is still waiting → Tc unresolved/matched_leg_not_posted', () => {
    const ev = evaluate({ transactions: [Tc()], decisions: [pairOnPending], carryovers: [waiting('pk', 'X')] });
    expect(legOf(ev, 'Tc')).toMatchObject({ state: 'unresolved', reason: 'matched_leg_not_posted', detail: 'waiting_to_post' });
  });

  it('Tc first then Tk, and Tk first then Tc, reach the same final result: tracked/user_pair', () => {
    const tcFirst = evaluate({ transactions: [Tc(), Tk], decisions: [pairOnPending] });
    const tkFirst = evaluate({ transactions: [Tk, Tc()], decisions: [pairOnPending] });
    expect(legOf(tcFirst, 'Tc')).toMatchObject({ state: 'tracked', reason: 'user_pair', partnerTransactionId: 'Tk' });
    expect(tkFirst).toEqual(tcFirst);
  });

  it('reversed arrival: Tc arrives while Pc still exists → Pc superseded (no state, not evidence), Tc current', () => {
    const ev = evaluate({ transactions: [Pc, Tc(), Tk], decisions: [pairOnPending] });
    expect(ev.supersededTransactionIds).toEqual(['Pc']);
    expect(ev.legs.map((l) => l.transactionId)).toEqual(['Tc', 'Tk']);
    expect(legOf(ev, 'Tc')).toMatchObject({ state: 'tracked', reason: 'user_pair' });
  });

  it("Tc's amount differs from the recorded pending amount → decision inactive (amount_changed), both legs unresolved", () => {
    const ev = evaluate({ transactions: [Tc(9800), Tk], decisions: [pairOnPending] });
    expect(legOf(ev, 'Tc')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'amount_changed' });
    expect(legOf(ev, 'Tk')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'amount_changed' });
    expect(ev.decisions[0]).toMatchObject({ status: 'inactive', detail: 'amount_changed' });
  });

  it('Pk cancelled: carry-over expired (or consumed with no posted row) → gone → Tc invalidated (partner_gone)', () => {
    const expired = { ...waiting('pk', 'X'), expiresAt: '2026-10-01T00:00:00Z' };
    for (const carryovers of [[expired], [{ ...waiting('pk', 'X'), consumed: true }], []]) {
      const ev = evaluate({ transactions: [Tc()], decisions: [pairOnPending], carryovers });
      expect(legOf(ev, 'Tc')).toMatchObject({ reason: 'decision_invalidated', detail: 'partner_gone' });
    }
  });

  it('a decision with no partner is carried to the posted row if the cents are equal, otherwise invalidated', () => {
    const d = decision('u', 'destination_unlinked', ref('C', 'pc', 10000));
    expect(legOf(evaluate({ transactions: [Tc()], decisions: [d] }), 'Tc')).toMatchObject({ state: 'untracked', reason: 'user_confirmed_unlinked' });
    expect(legOf(evaluate({ transactions: [Tc(9800)], decisions: [d] }), 'Tc')).toMatchObject({ reason: 'decision_invalidated', detail: 'amount_changed' });
  });

  it('not_this_pair on Pc–Xk applies to Tc–Xk once Tc posts (whatever the amount)', () => {
    const xk = tx('xk', 'X', '2026-09-03', -10000);
    const d = decision('n', 'not_this_pair', ref('C', 'pc', 10000), ref('X', 'p-xk', -10000));
    const ev = evaluate({ transactions: [Tc(), xk], decisions: [d] });
    expect(legOf(ev, 'Tc')).toMatchObject({ state: 'unresolved', reason: 'no_candidate' });
    const noDecision = evaluate({ transactions: [Tc(), xk] });
    expect(legOf(noDecision, 'Tc')).toMatchObject({ state: 'tracked', reason: 'auto_pair' });
  });

  it('two posted rows claiming one pending id → lineage_ambiguous (defensive)', () => {
    const tc2 = tx('Tc2', 'C', '2026-09-03', 10000, { plaid: 'tc2', pendingOf: 'pc' });
    const ev = evaluate({ transactions: [Tc(), tc2, Tk], decisions: [pairOnPending] });
    expect(ev.decisions[0]).toMatchObject({ status: 'inactive', detail: 'lineage_ambiguous' });
    expect(legOf(ev, 'Tk')).toMatchObject({ state: 'unresolved', detail: 'lineage_ambiguous' });
  });
});

describe('§4.9 role changes', () => {
  it('a leg overridden away from credit_card_payment invalidates its pair; it leaves the pool', () => {
    const ev = evaluate({
      transactions: [tx('c', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-08', -10000, { role: 'expense' })],
      decisions: [decision('d', 'pair', ref('C', 'p-c', 10000), ref('X', 'p-x', -10000))],
    });
    expect(ev.legs.map((l) => l.transactionId)).toEqual(['c']);
    expect(legOf(ev, 'c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'role_changed' });
  });

  it('a row overridden TO credit_card_payment joins the pool', () => {
    const rows = (role: string) => [tx('c', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-02', -10000, { role })];
    expect(evaluate({ transactions: rows('expense') }).legs.map((l) => l.transactionId)).toEqual(['c']);
    expect(legOf(evaluate({ transactions: rows('credit_card_payment') }), 'c')).toMatchObject({ state: 'tracked', reason: 'auto_pair' });
  });
});

describe('same-user boundaries', () => {
  const Cv = account('Cv', 'depository', false, V);
  const Xv = account('Xv', 'credit', false, V);

  it("another user's matching leg is never evidence, a pair or a candidate", () => {
    const ev = evaluate({
      accounts: [C, X, Cv, Xv],
      transactions: [tx('c', 'C', '2026-09-01', 10000), tx('xv', 'Xv', '2026-09-02', -10000)],
    });
    expect(ev.legs.map((l) => l.transactionId)).toEqual(['c']);
    expect(legOf(ev, 'c')).toMatchObject({ state: 'unresolved', reason: 'no_candidate', candidates: [] });
  });

  it("a decision naming another user's account is rejected (foreign_account) and has no effect", () => {
    const ev = evaluate({
      accounts: [C, X, Cv, Xv],
      transactions: [tx('c', 'C', '2026-09-01', 10000), tx('xv', 'Xv', '2026-09-08', -10000)],
      decisions: [decision('d', 'pair', ref('C', 'p-c', 10000), ref('Xv', 'p-xv', -10000))],
    });
    expect(ev.decisions).toEqual([{ decisionId: 'd', kind: 'pair', status: 'rejected', detail: 'foreign_account' }]);
    expect(legOf(ev, 'c').state).toBe('unresolved');
  });

  it("another user's decision touching our rows is rejected (foreign_user), never applied", () => {
    const ev = evaluate({
      accounts: [C, X],
      transactions: [tx('c', 'C', '2026-09-01', 10000)],
      decisions: [decision('d', 'destination_unlinked', ref('C', 'p-c', 10000), null, null, { userId: V })],
    });
    expect(ev.decisions).toEqual([{ decisionId: 'd', kind: 'destination_unlinked', status: 'rejected', detail: 'foreign_user' }]);
    expect(legOf(ev, 'c').state).toBe('unresolved');
  });

  it("a colliding pending id on another user's account never supersedes our row", () => {
    const ev = evaluate({
      accounts: [C, X, Cv],
      transactions: [tx('mine', 'C', '2026-09-01', 10000, { plaid: 'shared-pending', pending: true }), tx('theirs', 'Cv', '2026-09-02', 10000, { pendingOf: 'shared-pending' })],
    });
    expect(ev.supersededTransactionIds).toEqual([]);
    expect(ev.legs.map((l) => l.transactionId)).toEqual(['mine']);
  });

  it('evaluateCardPaymentsForAllUsers evaluates each user independently', () => {
    const all = evaluateCardPaymentsForAllUsers({
      asOf: '2026-10-15T00:00:00Z',
      accounts: [C, X, Cv, Xv],
      transactions: [tx('c', 'C', '2026-09-01', 10000), tx('xv', 'Xv', '2026-09-02', -10000), tx('cv', 'Cv', '2026-09-01', 10000)],
      carryovers: [],
      decisions: [],
    });
    expect(all.map((e) => e.userId)).toEqual([U, V]);
    expect(legOf(all[0], 'c').reason).toBe('no_candidate');
    expect(legOf(all[1], 'cv')).toMatchObject({ state: 'tracked', partnerTransactionId: 'xv' });
  });
});

describe('integrity and conflicting decisions', () => {
  it('rejects malformed input rather than guessing', () => {
    const base = { userId: U, asOf: '2026-10-15T00:00:00Z', accounts: [C, X], carryovers: [], decisions: [] };
    const bad = (transactions: MatchingTransaction[]) => () => evaluateCardPayments({ ...base, transactions });
    expect(bad([tx('a', 'C', '2026-09-01', 1), tx('a', 'C', '2026-09-02', 2)])).toThrow(CardPaymentMatchingIntegrityError);
    expect(bad([tx('a', 'ZZ', '2026-09-01', 1)])).toThrow(/unknown account/);
    expect(bad([tx('a', 'C', '2026-09-01', 1.5)])).toThrow(/integer cents/);
    expect(bad([tx('a', 'C', '2026-02-30', 1)])).toThrow(/calendar date/);
    expect(() =>
      evaluateCardPayments({ ...base, transactions: [], decisions: [decision('p', 'pair', ref('C', 'x', 1), ref('X', 'y', -1), null)] })
    ).toThrow(/accepted difference/);
  });

  it('two live decisions claiming one leg → both inactive (conflicting_decisions), legs unresolved', () => {
    const ev = evaluate({
      transactions: [tx('c', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-08', -10000)],
      decisions: [
        decision('d1', 'pair', ref('C', 'p-c', 10000), ref('X', 'p-x', -10000)),
        decision('d2', 'destination_unlinked', ref('C', 'p-c', 10000)),
      ],
    });
    expect(ev.decisions.map((d) => [d.decisionId, d.status, d.detail])).toEqual([
      ['d1', 'inactive', 'conflicting_decisions'],
      ['d2', 'inactive', 'conflicting_decisions'],
    ]);
    expect(legOf(ev, 'c')).toMatchObject({ state: 'unresolved', detail: 'conflicting_decisions' });
    expect(legOf(ev, 'x')).toMatchObject({ state: 'unresolved', detail: 'conflicting_decisions' });
  });
});

describe('§6.2 / §4.2 period ranges: each leg in its own month, no cross-month cancellation', () => {
  const rows = [tx('pay', 'C', '2026-09-28', 10000), tx('ret', 'C', '2026-10-03', -10000)];

  it('unresolved payment in September and return in October → [−100, 0] and [0, +100], never netted', () => {
    const ev = evaluate({ transactions: rows });
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: -10000, highCents: 0, unresolvedPaymentsCents: 10000 });
    expect(summarizeCardPaymentPeriod(ev, OCT)).toMatchObject({ lowCents: 0, highCents: 10000, unresolvedReturnsCents: 10000 });
  });

  it('confirmed individually → −100 in September and +100 in October', () => {
    const ev = evaluate({
      transactions: rows,
      decisions: [decision('a', 'destination_unlinked', ref('C', 'p-pay', 10000)), decision('b', 'destination_unlinked', ref('C', 'p-ret', -10000))],
    });
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: -10000, highCents: -10000, resolved: true });
    expect(summarizeCardPaymentPeriod(ev, OCT)).toMatchObject({ lowCents: 10000, highCents: 10000, resolved: true });
  });
});

// Requirements the pure evaluator does NOT satisfy. They are database or application integration
// work (design §3.5, §3.7, §11) and stay open until that work is built and verified there.
//
// Covered at the DATABASE level by slice 2a (draft PR #9), not by this file, and so no longer todos here:
//   13     input triggers bump in the writer's transaction  supabase/tests/access_control/sql/a09_card_payment_invalidation.sql
//   14, 15 stale states never readable; a failed evaluation  supabase/tests/access_control/sql/a10_card_payment_evaluator.sql
//          leaves the user stale (the reader half only)
//   16a    lock order L1 → L2, READ COMMITTED, publication     a10 (single session); concurrency/c12, c13
//   16b/c  no evaluator deadlock; RPC vs lock-free cycle      concurrency/c14 (50 rounds), c15
//   16d    account trigger scope                            a09
//   10     the SQL evaluator equals this oracle             supabase/tests/card_payment_evaluator (a CI step)
//   22     grants on the slice 2a objects                   sql/a08_card_payment_grants.sql
// Covered at the database level by slice 2b-1 (the decision RPCs, migration 20261001120000):
//   20     RPC ownership refusals (unknown = foreign)       sql/a11_card_payment_decision_rpcs.sql
//   21     link vs link (same version), vs a sync batch      concurrency/c16–c20; lock order c21
//          (both orders), vs a lock-free writer (both orders)
//   22     grants on the RPCs                               sql/a12_card_payment_decision_grants.sql
//          RPC-written decisions vs this oracle             supabase/tests/card_payment_evaluator/rpc_sequences.sql
describe('not covered by the pure evaluator (database / application integration)', () => {
  it.todo('§3.7 aggregation read protocol: an inconsistent or stale read returns `updating` with no figures (14–16, application side)');
  it.todo('decision RPCs vs the role override, the account-inclusion change and LIM removal (21, remaining pairs; those writers are not built)');
  it.todo('LIM removal writes destination_removed_card before its deletes, in one transaction (18)');
  it.todo('semanticAggregation.ts consumes stored states; its three it.fails tests flip to it (§5)');
  it.todo('frontend: reasons, actions, review list, ranges and the `updating` state (24–26)');
});
