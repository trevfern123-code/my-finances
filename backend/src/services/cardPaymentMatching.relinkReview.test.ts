import { describe, expect, it } from 'vitest';
import {
  CardPaymentMatchingIntegrityError,
  evaluateCardPayments,
  summarizeCardPaymentPeriod,
  type CardPaymentEvaluation,
  type DecisionLegRef,
  type MatchingAccount,
  type MatchingDecision,
  type MatchingReviewObligation,
  type MatchingTransaction,
} from './cardPaymentMatching';

// The relink-review guard in the reference evaluator (I3A-R packet 2-A; product approval of 2026-10-09).
// Every expected value is written out by hand from the approved rules — the same oracle the SQL harness
// asserts (supabase/tests/card_payment_recovery_review/sql/r01, r02), stated independently here.
//
// The fixture, in dollars: K +370 on checking C, the 10th. Its card X was removed with its institution on the
// 11th's leg; Y −370 on a card that stays, the 12th. The removal left a record D on K, a hold H on K/Y dated
// the 11th, and ONE review obligation on K that lists the edge K/Y. Amounts below are cents.

const U = 'user-1';
const account = (id: string, type: string | null, excluded = false, userId = U): MatchingAccount => ({ id, userId, type, excludeFromCashFlow: excluded });
const C = account('C', 'depository');
const CE = account('CE', 'depository', true);
const Y = account('Y', 'credit');
const W = account('W', 'credit');
const X2 = account('X2', 'credit');
const E = account('E', 'credit', true);

const tx = (id: string, accountId: string, day: number, cents: number, o: { pendingOf?: string; pending?: boolean } = {}): MatchingTransaction => ({
  id,
  accountId,
  plaidTransactionId: `p-${id}`,
  pendingTransactionId: o.pendingOf ?? null,
  pending: o.pending ?? false,
  date: `2026-09-${String(day).padStart(2, '0')}`,
  amountCents: cents,
  effectiveRole: 'credit_card_payment',
});
const ref = (accountId: string, id: string, cents: number): DecisionLegRef => ({ accountId, plaidTransactionId: `p-${id}`, cents });
let seq = 0;
const base = (id: string, kind: MatchingDecision['kind'], a: DecisionLegRef, b: DecisionLegRef | null, extra: Partial<MatchingDecision> = {}): MatchingDecision => ({
  id,
  userId: U,
  kind,
  a,
  b,
  acceptedDifferenceCents: kind === 'pair' ? 0 : null,
  decidedSeq: ++seq,
  supersededBy: null,
  ...extra,
});
/** The record D on a cash leg, and the hold H on card leg / cash leg dated the 11th. */
const record = (id: string, cash: DecisionLegRef) => base(id, 'destination_removed_card', cash, null);
const hold = (id: string, card: DecisionLegRef, cash: DecisionLegRef, day = 11) =>
  base(id, 'ambiguity_hold_removed_card', card, cash, { counterpartDate: `2026-09-${String(day).padStart(2, '0')}` });
const obligation = (id: string, anchor: DecisionLegRef, members: DecisionLegRef[], gap = false): MatchingReviewObligation => ({ id, userId: U, anchor, gap, members });

const K = tx('k', 'C', 10, 37000);
const YL = tx('y', 'Y', 12, -37000);
const kRef = ref('C', 'k', 37000);
const yRef = ref('Y', 'y', -37000);
const D = record('d', kRef);
const H = hold('h', yRef, kRef);
const O = obligation('o-1', kRef, [yRef]);

interface Scenario {
  accounts?: MatchingAccount[];
  transactions: MatchingTransaction[];
  decisions?: MatchingDecision[];
  obligations?: MatchingReviewObligation[];
}
const evaluate = (s: Scenario): CardPaymentEvaluation =>
  evaluateCardPayments({
    userId: U,
    asOf: '2026-10-15T00:00:00Z',
    accounts: s.accounts ?? [C, Y, W, X2],
    transactions: s.transactions,
    carryovers: [],
    decisions: s.decisions ?? [D, H],
    reviewObligations: s.obligations ?? [O],
  });
/** "state/reason/effect partner decision low..high": everything a reader sees of a leg. */
const line = (ev: CardPaymentEvaluation, id: string) => {
  const l = ev.legs.find((x) => x.transactionId === id)!;
  return `${l.state}/${l.reason}/${l.effectCents} partner=${l.partnerTransactionId ?? '-'} decision=${l.decisionId ?? '-'} range=${l.lowCents}..${l.highCents}`;
};
const reviewOf = (ev: CardPaymentEvaluation, id: string) => ev.reviews.find((r) => r.transactionId === id) ?? null;
const SEP = { start: '2026-09-01', end: '2026-10-01' };

describe('the approved oracle (E1, E7, E2)', () => {
  it('with nothing new: the hold withholds K/Y and the record gives −370; K is under review, nothing withheld by the guard', () => {
    const ev = evaluate({ transactions: [K, YL] });
    expect(line(ev, 'k')).toBe('untracked/removed_card/-37000 partner=- decision=d range=-37000..-37000');
    expect(reviewOf(ev, 'k')).toEqual({ transactionId: 'k', guardWithheld: false, withheldPartnerTransactionId: null, obligationIds: ['o-1'], coverageGap: false });
    expect(reviewOf(ev, 'y')).toBeNull();
  });

  it('E1 — the return on the 14th is farther than Y: K/Y is still the selected pair, H withholds it, the guard withholds nothing: −370', () => {
    const ev = evaluate({ transactions: [K, YL, tx('x2', 'X2', 14, -37000)] });
    expect(line(ev, 'k')).toBe('untracked/removed_card/-37000 partner=- decision=d range=-37000..-37000');
    expect(reviewOf(ev, 'k')).toMatchObject({ guardWithheld: false });
    expect(line(ev, 'x2')).toBe('unresolved/ambiguous/0 partner=- decision=- range=0..0');
    expect(reviewOf(ev, 'x2')).toBeNull();
  });

  it('E7 — an UNRELATED payment on the 11th would win (1 day against 2): withheld both ways; K is the range, the card leg 0', () => {
    const ev = evaluate({ transactions: [K, YL, tx('w', 'W', 11, -37000)] });
    expect(line(ev, 'k')).toBe('unresolved/relink_review_required/null partner=- decision=- range=-37000..0');
    expect(line(ev, 'w')).toBe('unresolved/relink_review_required/0 partner=- decision=- range=0..0');
    expect(reviewOf(ev, 'k')).toEqual({ transactionId: 'k', guardWithheld: true, withheldPartnerTransactionId: 'w', obligationIds: ['o-1'], coverageGap: false });
    expect(reviewOf(ev, 'w')).toEqual({ transactionId: 'w', guardWithheld: true, withheldPartnerTransactionId: 'k', obligationIds: ['o-1'], coverageGap: false });
    // Nothing is selected in the withheld pair's place, and both legs stay candidates of each other.
    expect(line(ev, 'y')).toBe('unresolved/ambiguous/0 partner=- decision=- range=0..0');
    expect(ev.legs.find((l) => l.transactionId === 'k')!.candidates.map((c) => c.transactionId)).toEqual(['w', 'y']);
    expect(ev.legs.find((l) => l.transactionId === 'w')!.candidates.map((c) => c.transactionId)).toEqual(['k']);
    // H and D are untouched and still apply: nothing was retired.
    expect(ev.decisions).toEqual([
      { decisionId: 'd', kind: 'destination_removed_card', status: 'active', detail: null },
      { decisionId: 'h', kind: 'ambiguity_hold_removed_card', status: 'active', detail: null },
    ]);
    // The aggregate carries the uncertainty.
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: -37000, highCents: 0, resolved: false, unresolvedCount: 1, byReason: { relink_review_required: 1 } });
  });

  it('E2 — the GENUINE return on the original day: identity is not consent; the same outcome as E7', () => {
    const ev = evaluate({ transactions: [K, YL, tx('x2', 'X2', 11, -37000)] });
    expect(line(ev, 'k')).toBe('unresolved/relink_review_required/null partner=- decision=- range=-37000..0');
    expect(line(ev, 'x2')).toBe('unresolved/relink_review_required/0 partner=- decision=- range=0..0');
  });

  it('without the obligation (the evaluator before this packet): the unrelated leg pairs — tracked, 0', () => {
    const ev = evaluate({ transactions: [K, YL, tx('w', 'W', 11, -37000)], obligations: [] });
    expect(line(ev, 'k')).toBe('tracked/auto_pair/0 partner=w decision=- range=0..0');
    expect(ev.reviews).toEqual([]);
  });
});

describe('user authority comes first', () => {
  it('an explicit pair K/X2 gives 0; the obligation, H and D remain; K is still an affected payment', () => {
    const pair = base('p', 'pair', kRef, ref('X2', 'x2', -37000));
    const ev = evaluate({ transactions: [K, YL, tx('x2', 'X2', 11, -37000)], decisions: [D, H, pair] });
    expect(line(ev, 'k')).toBe('tracked/user_pair/0 partner=x2 decision=p range=0..0');
    expect(line(ev, 'x2')).toBe('paired/user_pair/0 partner=k decision=p range=0..0');
    expect(reviewOf(ev, 'k')).toMatchObject({ guardWithheld: false, obligationIds: ['o-1'] });
    expect(ev.decisions.filter((d) => d.kind !== 'pair').every((d) => d.status === 'active')).toBe(true);
  });

  it('after an ordinary undo (the pair superseded by itself) the guarded range is back', () => {
    const undone = base('p', 'pair', kRef, ref('X2', 'x2', -37000), { supersededBy: 'p' });
    const ev = evaluate({ transactions: [K, YL, tx('x2', 'X2', 11, -37000)], decisions: [D, H, undone] });
    expect(line(ev, 'k')).toBe('unresolved/relink_review_required/null partner=- decision=- range=-37000..0');
  });

  it('a dismissal of K/W: K/Y is selected and H withholds it — the retained record gives −370; a NEW w2 gets no permission', () => {
    const w = tx('w', 'W', 11, -37000);
    const dismissal = base('n', 'not_this_pair', kRef, ref('W', 'w', -37000));
    expect(line(evaluate({ transactions: [K, YL, w], decisions: [D, H, dismissal] }), 'k')).toBe('untracked/removed_card/-37000 partner=- decision=d range=-37000..-37000');
    const ev = evaluate({ transactions: [K, YL, w, tx('w2', 'W', 11, -37000)], decisions: [D, H, dismissal] });
    expect(line(ev, 'k')).toBe('unresolved/relink_review_required/null partner=- decision=- range=-37000..0');
    expect(reviewOf(ev, 'k')).toMatchObject({ withheldPartnerTransactionId: 'w2' });
  });

  it('a "card I haven\'t linked" decision holds the leg: the guard has nothing to withhold', () => {
    const unlinked = base('u', 'destination_unlinked', kRef, null);
    const ev = evaluate({ transactions: [K, YL, tx('w', 'W', 11, -37000)], decisions: [D, H, unlinked] });
    expect(line(ev, 'k')).toBe('untracked/user_confirmed_unlinked/-37000 partner=- decision=u range=-37000..-37000');
    expect(reviewOf(ev, 'w')).toBeNull();
  });

  it('a preserved confirmation — active or frozen inactive — keeps the leg; no obligation edge is needed or used', () => {
    const preserved = (status: 'valid' | 'partner_gone') =>
      base('pc', 'pair_counterpart_removed', kRef, null, { acceptedDifferenceCents: 0, counterpart: { plaidTransactionId: 'p-x', cents: -37000, status } });
    const o = obligation('o-1', kRef, []);
    const rows = [K, YL, tx('x2', 'X2', 11, -37000)];
    expect(line(evaluate({ transactions: rows, decisions: [preserved('valid')], obligations: [o] }), 'k')).toBe('untracked/removed_card/-37000 partner=- decision=pc range=-37000..-37000');
    const frozen = evaluate({ transactions: rows, decisions: [preserved('partner_gone')], obligations: [o] });
    expect(line(frozen, 'k')).toBe('unresolved/decision_invalidated/null partner=- decision=pc range=-37000..0');
    expect(frozen.legs.find((l) => l.transactionId === 'k')!.detail).toBe('partner_gone');
    expect(reviewOf(frozen, 'x2')).toBeNull();
  });
});

describe('accounts excluded from cash flow, and no included card', () => {
  it('the returning card is EXCLUDED and another included card exists: K stays the guarded range; the excluded leg is not counted', () => {
    const ev = evaluate({ accounts: [C, Y, E], transactions: [K, YL, tx('e', 'E', 11, -37000)] });
    expect(line(ev, 'k')).toBe('unresolved/relink_review_required/null partner=- decision=- range=-37000..0');
    expect(line(ev, 'e')).toBe('not_counted/excluded_account/0 partner=- decision=- range=0..0');
    expect(reviewOf(ev, 'e')).toMatchObject({ guardWithheld: true, withheldPartnerTransactionId: 'k' });
  });

  it('the PAYMENT is on an excluded account: not counted, 0 — with its review state; the card leg unresolved, 0', () => {
    const k = tx('k', 'CE', 10, 37000);
    const ke = ref('CE', 'k', 37000);
    const ev = evaluate({ accounts: [CE, Y, W], transactions: [k, YL, tx('w', 'W', 11, -37000)], decisions: [record('d', ke), hold('h', yRef, ke)], obligations: [obligation('o-1', ke, [yRef])] });
    expect(line(ev, 'k')).toBe('not_counted/excluded_account/0 partner=- decision=- range=0..0');
    expect(reviewOf(ev, 'k')).toMatchObject({ guardWithheld: true, withheldPartnerTransactionId: 'w' });
    expect(line(ev, 'w')).toBe('unresolved/relink_review_required/0 partner=- decision=- range=0..0');
  });

  it('NO included card exists: the independently established outflow −370, with the review state; the record is not named', () => {
    const yExcluded = account('Y', 'credit', true);
    const ev = evaluate({ accounts: [C, yExcluded, E], transactions: [K, YL, tx('e', 'E', 11, -37000)] });
    expect(line(ev, 'k')).toBe('untracked/no_included_card/-37000 partner=- decision=- range=-37000..-37000');
    expect(reviewOf(ev, 'k')).toMatchObject({ guardWithheld: true, withheldPartnerTransactionId: 'e' });
  });
});

describe('known surviving edges: every obligation, either leg, lineage — never amounts, never similarity', () => {
  // Y comes strictly closer than the removed leg was (the 10th): the hold releases K/Y.
  const yCloser = tx('y', 'Y', 10, -37000);

  it('a pair the obligation lists stays automatic under the existing rules', () => {
    const ev = evaluate({ transactions: [K, yCloser] });
    expect(line(ev, 'k')).toBe('tracked/auto_pair/0 partner=y decision=- range=0..0');
    expect(reviewOf(ev, 'k')).toMatchObject({ guardWithheld: false });
  });

  it('TWO obligations on one payment: a pair only one of them lists is withheld; a pair both list is automatic', () => {
    const second = obligation('o-2', kRef, []);
    expect(line(evaluate({ transactions: [K, yCloser], obligations: [O, second] }), 'k')).toBe('unresolved/relink_review_required/null partner=- decision=- range=-37000..0');
    const both = evaluate({ transactions: [K, yCloser], obligations: [O, obligation('o-2', kRef, [yRef])] });
    expect(line(both, 'k')).toBe('tracked/auto_pair/0 partner=y decision=- range=0..0');
    expect(reviewOf(both, 'k')).toMatchObject({ obligationIds: ['o-1', 'o-2'] });
  });

  it('a coverage gap lists nothing: even the hold\'s own pair is withheld once the hold releases it', () => {
    const gap = obligation('o-gap', kRef, [], true);
    const ev = evaluate({ transactions: [K, yCloser], obligations: [O, gap] });
    expect(line(ev, 'k')).toBe('unresolved/relink_review_required/null partner=- decision=- range=-37000..0');
    expect(reviewOf(ev, 'k')).toEqual({ transactionId: 'k', guardWithheld: true, withheldPartnerTransactionId: 'y', obligationIds: ['o-1', 'o-gap'], coverageGap: true });
  });

  it('the affected leg can be the CARD leg: a new cash leg that would pair with it is withheld, and reads the range', () => {
    // Card leg yc −600 on Y the 10th (its cash partner was removed); kept cash k6 +600 the 13th; a NEW n +600 the 10th.
    const yc = tx('yc', 'Y', 10, -60000);
    const k6 = tx('k6', 'C', 13, 60000);
    const o = obligation('o-c', ref('Y', 'yc', -60000), [ref('C', 'k6', 60000)]);
    const mirrorHold = base('hm', 'ambiguity_hold_removed_cash_account', ref('Y', 'yc', -60000), ref('C', 'k6', 60000), { counterpartDate: '2026-09-11' });
    const ev = evaluate({ transactions: [yc, k6, tx('n', 'C', 10, 60000)], decisions: [mirrorHold], obligations: [o] });
    expect(line(ev, 'n')).toBe('unresolved/relink_review_required/null partner=- decision=- range=-60000..0');
    expect(line(ev, 'yc')).toBe('unresolved/relink_review_required/0 partner=- decision=- range=0..0');
    expect(reviewOf(ev, 'n')).toMatchObject({ withheldPartnerTransactionId: 'yc', obligationIds: ['o-c'] });
  });

  it('pending rows that post are the same lineages: still affected, still a known edge', () => {
    const kPosted = tx('k2', 'C', 10, 37000, { pendingOf: 'p-k' });
    const yPosted = tx('y2', 'Y', 10, -37000, { pendingOf: 'p-y' });
    const ev = evaluate({ transactions: [{ ...K, pending: true }, { ...YL, pending: true }, kPosted, yPosted] });
    expect(line(ev, 'k2')).toBe('tracked/auto_pair/0 partner=y2 decision=- range=0..0');
    expect(reviewOf(ev, 'k2')).toMatchObject({ guardWithheld: false, obligationIds: ['o-1'] });
    expect(reviewOf(ev, 'k')).toBeNull(); // the superseded pending row is not a leg
  });

  it('a corrected AMOUNT is still the same edge: the existing rule (new evidence, the ordinary rules decide) is unchanged', () => {
    // Both amounts corrected to 360.00: the hold and the record no longer apply; the two pre-removal legs pair.
    const ev = evaluate({ transactions: [tx('k', 'C', 10, 36000), tx('y', 'Y', 12, -36000)] });
    expect(line(ev, 'k')).toBe('tracked/auto_pair/0 partner=y decision=- range=0..0');
    expect(ev.decisions.map((d) => `${d.decisionId}:${d.status}/${d.detail}`)).toEqual(['d:inactive/amount_changed', 'h:inactive/amount_changed']);
    expect(reviewOf(ev, 'k')).toMatchObject({ guardWithheld: false });
  });

  it('similarity is not membership: another transaction with the same account, amount and date is not the listed one', () => {
    // The listed leg y is gone; a look-alike on the same card, the same day, the same cents has another id.
    const ev = evaluate({ transactions: [K, tx('lookalike', 'Y', 10, -37000)], decisions: [D] });
    expect(line(ev, 'k')).toBe('unresolved/relink_review_required/null partner=- decision=- range=-37000..0');
  });

  it('an obligation whose payment has no current row, or is another user\'s, concerns nothing', () => {
    const detached = obligation('o-x', ref('C', 'gone', 37000), []);
    const foreign: MatchingReviewObligation = { ...obligation('o-f', kRef, []), userId: 'user-2' };
    const ev = evaluate({ transactions: [K, tx('w', 'W', 11, -37000)], decisions: [], obligations: [detached, foreign] });
    expect(line(ev, 'k')).toBe('tracked/auto_pair/0 partner=w decision=- range=0..0');
    expect(ev.reviews).toEqual([]);
  });
});

describe('determinism and integrity', () => {
  it('the result does not depend on the order of the obligations or of the rows', () => {
    const rows = [K, YL, tx('w', 'W', 11, -37000)];
    const obligations = [O, obligation('o-2', kRef, [yRef]), obligation('o-gap', kRef, [], true)];
    const a = evaluate({ transactions: rows, obligations });
    const b = evaluate({ transactions: [...rows].reverse(), obligations: [...obligations].reverse() });
    expect(b).toEqual(a);
  });

  it('with no obligations the legs are exactly what they were before the guard existed', () => {
    const rows = [K, YL, tx('w', 'W', 11, -37000)];
    const without = evaluateCardPayments({ userId: U, asOf: '2026-10-15T00:00:00Z', accounts: [C, Y, W], transactions: rows, carryovers: [], decisions: [D, H] });
    const withEmpty = evaluate({ accounts: [C, Y, W], transactions: rows, obligations: [] });
    expect(withEmpty).toEqual(without);
    expect(without.reviews).toEqual([]);
  });

  it('refuses a duplicate obligation id, non-integer cents, and a gap that lists an edge', () => {
    const rows = [K, YL];
    expect(() => evaluate({ transactions: rows, obligations: [O, O] })).toThrow(CardPaymentMatchingIntegrityError);
    expect(() => evaluate({ transactions: rows, obligations: [obligation('o', { ...kRef, cents: 1.5 }, [])] })).toThrow(CardPaymentMatchingIntegrityError);
    expect(() => evaluate({ transactions: rows, obligations: [obligation('o', kRef, [yRef], true)] })).toThrow(CardPaymentMatchingIntegrityError);
  });
});
