import { describe, expect, it } from 'vitest';
import {
  AUTO_PAIR_WINDOW_DAYS,
  evaluateCardPayments,
  summarizeCardPaymentPeriod,
  type CardLegResult,
  type CardPaymentEvaluation,
  type CardPaymentMatchingInput,
  type DecisionLegRef,
  type MatchingAccount,
  type MatchingCarryover,
  type MatchingDecision,
  type MatchingTransaction,
} from './cardPaymentMatching';

// Stage 2 — adversarial tests for the card-payment matching reference evaluator.
//
// Two kinds of assertion, kept apart:
//  * SCENARIOS: hand-built inputs whose expected outcome is derived from the approved rules
//    (CARD_PAYMENT_PAIRING_DESIGN.md rev 3) by hand and written down before running.
//  * INVARIANTS: properties every evaluation must satisfy for ANY input, checked over bounded
//    generated histories (fixed seeds, reproducible). An invariant is a restatement of an approved
//    rule computed independently in this file — never by calling the evaluator's internals.
// Nothing here involves a database: the §3.7 concurrency/invalidation requirements (16a–16d) are NOT
// exercised by these tests.

const U = 'user-a';
const V = 'user-b';
const acct = (id: string, type: string | null, excluded = false, userId = U): MatchingAccount => ({
  id,
  userId,
  type,
  excludeFromCashFlow: excluded,
});
const tx = (
  id: string,
  accountId: string,
  date: string,
  cents: number,
  o: { plaid?: string; pendingOf?: string; pending?: boolean; role?: string | null } = {}
): MatchingTransaction => ({
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
const mkDecision = (
  id: string,
  kind: MatchingDecision['kind'],
  a: DecisionLegRef,
  b: DecisionLegRef | null = null,
  accepted: number | null = kind === 'pair' ? 0 : null,
  userId = U
): MatchingDecision => ({ id, userId, kind, a, b, acceptedDifferenceCents: accepted, decidedSeq: 1, supersededBy: null });

const C = acct('C', 'depository');
const C2 = acct('C2', 'depository');
const X = acct('X', 'credit');
const Y = acct('Y', 'credit');
const E = acct('E', 'credit', true);
const F = acct('F', 'depository', true);
const ASOF = '2026-11-15T00:00:00Z';

function run(
  transactions: MatchingTransaction[],
  o: { accounts?: MatchingAccount[]; decisions?: MatchingDecision[]; carryovers?: MatchingCarryover[] } = {}
): CardPaymentEvaluation {
  return evaluateCardPayments({
    userId: U,
    asOf: ASOF,
    accounts: o.accounts ?? [C, C2, X, Y, E, F],
    transactions,
    carryovers: o.carryovers ?? [],
    decisions: o.decisions ?? [],
  });
}
const byId = (ev: CardPaymentEvaluation) => new Map(ev.legs.map((l) => [l.transactionId, l]));
const reasons = (ev: CardPaymentEvaluation) => Object.fromEntries(ev.legs.map((l) => [l.transactionId, `${l.state}/${l.reason}`]));

// ---- Scenarios ------------------------------------------------------------------------------------

describe('scenarios: duplicate amounts, competing candidates, reciprocity, ties', () => {
  it('an alternating chain 1 day apart has a tie at every inner leg → nothing pairs, all ambiguous', () => {
    // C1(9/1) X1(9/2) C2(9/3) X2(9/4): X1 is 1 day from C1 and C2 (tie); C2 is 1 day from X1 and X2
    // (tie). C1's only best is X1 but X1 has no unique best → no reciprocal pair anywhere.
    const ev = run([
      tx('c1', 'C', '2026-09-01', 10000),
      tx('x1', 'X', '2026-09-02', -10000),
      tx('c2', 'C', '2026-09-03', 10000),
      tx('x2', 'X', '2026-09-04', -10000),
    ]);
    expect(reasons(ev)).toEqual({
      c1: 'unresolved/ambiguous',
      c2: 'unresolved/ambiguous',
      x1: 'unresolved/ambiguous',
      x2: 'unresolved/ambiguous',
    });
    expect(summarizeCardPaymentPeriod(ev, { start: '2026-09-01', end: '2026-10-01' })).toMatchObject({ lowCents: -20000, highCents: 0 });
  });

  it('the same chain with uneven gaps pairs each payment with its nearest card leg', () => {
    // C1(9/1) X1(9/2) C2(9/4) X2(9/5): C1→X1 (1 < 4), X1→C1 (1 < 2); C2→X2 (1 < 2), X2→C2 (1 < 4).
    const ev = run([
      tx('c1', 'C', '2026-09-01', 10000),
      tx('x1', 'X', '2026-09-02', -10000),
      tx('c2', 'C', '2026-09-04', 10000),
      tx('x2', 'X', '2026-09-05', -10000),
    ]);
    const m = byId(ev);
    expect(m.get('c1')).toMatchObject({ state: 'tracked', partnerTransactionId: 'x1' });
    expect(m.get('c2')).toMatchObject({ state: 'tracked', partnerTransactionId: 'x2' });
  });

  it('a non-reciprocal best: C1 prefers X, X prefers C2 → C2–X pair, C1 left ambiguous (not untracked)', () => {
    // C1(9/1) X(9/4) C2(9/5): X is 3 from C1 and 1 from C2.
    const ev = run([tx('c1', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-04', -10000), tx('c2', 'C2', '2026-09-05', 10000)]);
    expect(reasons(ev)).toEqual({ c1: 'unresolved/ambiguous', c2: 'tracked/auto_pair', x: 'paired/auto_pair' });
  });

  it('same-side opposite amounts never pair: two cash legs, two credit legs', () => {
    const ev = run([
      tx('c', 'C', '2026-09-01', 10000),
      tx('c2', 'C2', '2026-09-01', -10000),
      tx('x', 'X', '2026-09-20', -30000),
      tx('y', 'Y', '2026-09-20', 30000),
    ]);
    for (const leg of ev.legs) {
      expect(leg.state).toBe('unresolved');
      expect(leg.partnerTransactionId).toBeNull();
    }
  });

  it('an excluded cash leg competes as evidence: F and C equally close to X → X ambiguous; C unresolved', () => {
    const ev = run([tx('f', 'F', '2026-09-01', 10000), tx('c', 'C', '2026-09-03', 10000), tx('x', 'X', '2026-09-02', -10000)]);
    expect(reasons(ev)).toEqual({ c: 'unresolved/ambiguous', f: 'not_counted/excluded_account', x: 'unresolved/ambiguous' });
  });

  it('an excluded card closer than two included ones decides the destination (T5): untracked, no range', () => {
    const ev = run([
      tx('c', 'C', '2026-09-10', 20000),
      tx('e', 'E', '2026-09-11', -20000),
      tx('x', 'X', '2026-09-13', -20000),
      tx('y', 'Y', '2026-09-14', -20000),
    ]);
    expect(byId(ev).get('c')).toMatchObject({ state: 'untracked', reason: 'partner_excluded', lowCents: -20000, highCents: -20000 });
  });
});

describe('scenarios: payments and returns across month boundaries', () => {
  const SEP = { start: '2026-09-01', end: '2026-10-01' };
  const OCT = { start: '2026-10-01', end: '2026-11-01' };

  it('a tier 1 pair spanning Sep 30 → Oct 2 tracks the September payment; October has nothing counted', () => {
    const ev = run([tx('c', 'C', '2026-09-30', 10000), tx('x', 'X', '2026-10-02', -10000)]);
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: 0, highCents: 0, resolved: true });
    expect(summarizeCardPaymentPeriod(ev, OCT)).toMatchObject({ lowCents: 0, highCents: 0, resolved: true, unresolvedCount: 0 });
  });

  it('a return on Oct 1 paired with a reversal on Sep 29 is tracked in October (0)', () => {
    const ev = run([tx('c', 'C', '2026-10-01', -10000), tx('x', 'X', '2026-09-29', 10000)]);
    expect(byId(ev).get('c')).toMatchObject({ state: 'tracked', direction: 'return', effectCents: 0 });
  });

  it('a payment confirmed unlinked in September and its return confirmed in October never cancel', () => {
    const rows = [tx('pay', 'C', '2026-09-29', 10000), tx('ret', 'C', '2026-10-02', -10000)];
    const ev = run(rows, {
      decisions: [mkDecision('a', 'destination_unlinked', ref('C', 'p-pay', 10000)), mkDecision('b', 'destination_unlinked', ref('C', 'p-ret', -10000))],
    });
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: -10000, highCents: -10000 });
    expect(summarizeCardPaymentPeriod(ev, OCT)).toMatchObject({ lowCents: 10000, highCents: 10000 });
    expect(summarizeCardPaymentPeriod(ev, { start: '2026-09-01', end: '2026-11-01' })).toMatchObject({ lowCents: 0, highCents: 0 });
  });
});

describe('scenarios: pending → posted in every arrival order (§4.8)', () => {
  // Pc (C, 9/1) and Pk (X, 9/8) are 7 days apart — only the user pair decided on them links them.
  const decisionOnPending = mkDecision('d', 'pair', ref('C', 'pc', 10000), ref('X', 'pk', -10000));
  type Event = 'removePc' | 'postTc' | 'removePk' | 'postTk';
  const events: Event[] = ['removePc', 'postTc', 'removePk', 'postTk'];
  const permutations = (xs: Event[]): Event[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  function snapshot(done: Set<Event>, withDecision: boolean) {
    const transactions: MatchingTransaction[] = [];
    const carryovers: MatchingCarryover[] = [];
    const side = (pendingEvent: Event, postEvent: Event, row: MatchingTransaction, posted: MatchingTransaction) => {
      if (!done.has(pendingEvent)) transactions.push(row);
      else carryovers.push({ accountId: row.accountId, pendingPlaidTransactionId: row.plaidTransactionId, expiresAt: '2026-12-31T00:00:00Z', consumed: done.has(postEvent) });
      if (done.has(postEvent)) transactions.push(posted);
    };
    side('removePc', 'postTc', tx('Pc', 'C', '2026-09-01', 10000, { plaid: 'pc', pending: true }), tx('Tc', 'C', '2026-09-02', 10000, { plaid: 'tc', pendingOf: 'pc' }));
    side('removePk', 'postTk', tx('Pk', 'X', '2026-09-08', -10000, { plaid: 'pk', pending: true }), tx('Tk', 'X', '2026-09-09', -10000, { plaid: 'tk', pendingOf: 'pk' }));
    return run(transactions, { carryovers, decisions: withDecision ? [decisionOnPending] : [] });
  }

  it('all 24 orders: every intermediate snapshot follows the §4.8 table; the cash leg is never untracked', () => {
    for (const order of permutations(events)) {
      const done = new Set<Event>();
      for (const e of order) {
        done.add(e);
        const ev = snapshot(done, true);
        const cashCurrent = done.has('postTc') ? 'Tc' : done.has('removePc') ? null : 'Pc';
        const cardCurrent = done.has('postTk') ? 'Tk' : done.has('removePk') ? null : 'Pk';
        const m = byId(ev);
        expect([...m.keys()].sort()).toEqual([cashCurrent, cardCurrent].filter((x): x is string => x !== null).sort());
        if (cashCurrent && cardCurrent) {
          expect(m.get(cashCurrent)).toMatchObject({ state: 'tracked', reason: 'user_pair', partnerTransactionId: cardCurrent });
        } else if (cashCurrent) {
          expect(m.get(cashCurrent)).toMatchObject({ state: 'unresolved', reason: 'matched_leg_not_posted' });
        } else if (cardCurrent) {
          expect(m.get(cardCurrent)).toMatchObject({ state: 'unresolved', reason: 'matched_leg_not_posted', lowCents: 0, highCents: 0 });
        }
        for (const leg of ev.legs) expect(leg.state).not.toBe('untracked');
      }
      expect(byId(snapshot(done, true)).get('Tc')).toMatchObject({ state: 'tracked', partnerTransactionId: 'Tk' });
    }
  });

  it('all 24 orders without a decision: the legs (7 days apart) are only ever a possible match, never untracked', () => {
    for (const order of permutations(events)) {
      const done = new Set<Event>();
      for (const e of order) {
        done.add(e);
        for (const leg of snapshot(done, false).legs) expect(leg.state).toBe('unresolved');
      }
    }
  });

  it('the final result does not depend on the order', () => {
    const finals = permutations(events).map((order) => snapshot(new Set(order), true));
    for (const f of finals) expect(f).toEqual(finals[0]);
  });
});

describe('scenarios: amount or role changes invalidate decisions; restoring them reactivates', () => {
  const pairDecision = mkDecision('d', 'pair', ref('C', 'p-c', 10000), ref('X', 'p-x', -10000));
  const rows = (cashCents: number, cardRole: string | null) => [
    tx('c', 'C', '2026-09-01', cashCents),
    tx('x', 'X', '2026-09-20', -10000, { role: cardRole }),
  ];

  it('amount change → inactive; back to the recorded amount → active again (the decision is kept)', () => {
    expect(byId(run(rows(9999, 'credit_card_payment'), { decisions: [pairDecision] })).get('c')).toMatchObject({
      state: 'unresolved',
      detail: 'amount_changed',
    });
    expect(byId(run(rows(10000, 'credit_card_payment'), { decisions: [pairDecision] })).get('c')).toMatchObject({
      state: 'tracked',
      reason: 'user_pair',
    });
  });

  it('role change on the partner → inactive (role_changed); the partner is no longer a leg', () => {
    const ev = run(rows(10000, 'internal_transfer'), { decisions: [pairDecision] });
    expect(ev.legs.map((l) => l.transactionId)).toEqual(['c']);
    expect(byId(ev).get('c')).toMatchObject({ state: 'unresolved', detail: 'role_changed' });
  });

  it('a NULL role (unclassified) is not a card leg either', () => {
    const ev = run(rows(10000, null), { decisions: [pairDecision] });
    expect(byId(ev).get('c')).toMatchObject({ detail: 'role_changed' });
  });

  it('REGRESSION: a leg whose amount became 0 is reported as amount_changed, not role_changed', () => {
    const ev = run([tx('c', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-20', 0)], { decisions: [pairDecision] });
    expect(byId(ev).get('c')).toMatchObject({ state: 'unresolved', detail: 'amount_changed' });
  });

  it('REGRESSION: a pair whose two references resolve to the SAME row is sides_not_opposite, not a conflict', () => {
    // Leg A names the pending id, leg B the posted id of the same lineage: one row, one side.
    const d = mkDecision('d', 'pair', ref('C', 'pc', 10000), ref('C', 'tc', 10000));
    const ev = run([tx('Tc', 'C', '2026-09-02', 10000, { plaid: 'tc', pendingOf: 'pc' })], { decisions: [d] });
    expect(ev.decisions).toEqual([{ decisionId: 'd', kind: 'pair', status: 'inactive', detail: 'sides_not_opposite' }]);
    expect(byId(ev).get('Tc')).toMatchObject({ state: 'unresolved', detail: 'sides_not_opposite' });
  });
});

describe('scenarios: determinism regressions and candidate edge cases', () => {
  it('REGRESSION: conflicting decisions report the same decision on a leg whatever their input order', () => {
    // Found by the generated reordering test: the leg named whichever conflicting decision came first.
    const rows = [tx('c', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-20', -10000)];
    const d1 = mkDecision('d1', 'pair', ref('C', 'p-c', 10000), ref('X', 'p-x', -10000));
    const d2 = mkDecision('d2', 'destination_unlinked', ref('C', 'p-c', 10000));
    const forward = run(rows, { decisions: [d1, d2] });
    const backward = run(rows, { decisions: [d2, d1] });
    expect(backward).toEqual(forward);
    expect(byId(forward).get('c')).toMatchObject({ decisionId: 'd1', detail: 'conflicting_decisions' });
  });

  it('dismissing one side of a tie removes that edge: the remaining candidate pairs automatically', () => {
    // C1 and C2 are both 1 day from X (a tie). "Not this one" on C1–X leaves X one exact candidate.
    const rows = [tx('c1', 'C', '2026-09-01', 10000), tx('c2', 'C2', '2026-09-03', 10000), tx('x', 'X', '2026-09-02', -10000)];
    const ev = run(rows, { decisions: [mkDecision('n', 'not_this_pair', ref('C', 'p-c1', 10000), ref('X', 'p-x', -10000))] });
    expect(reasons(ev)).toEqual({ c1: 'unresolved/no_candidate', c2: 'tracked/auto_pair', x: 'paired/auto_pair' });
  });

  it('return-of-pair needs the same two accounts: a reversal on a different card is only an exact-amount match', () => {
    const ev = run([
      tx('p', 'C', '2026-09-01', 10000),
      tx('k', 'X', '2026-09-02', -10000),
      tx('rev', 'Y', '2026-09-10', 10000),
      tx('ret', 'C', '2026-09-20', -10000),
    ]);
    expect(byId(ev).get('ret')!.candidates.map((c) => c.kind)).toEqual(['exact_amount']);
  });

  it('return-of-pair needs an earlier TRACKED pair: after a payment to an excluded card it is only an exact match', () => {
    const ev = run([
      tx('p', 'C', '2026-09-01', 10000),
      tx('k', 'E', '2026-09-02', -10000),
      tx('rev', 'E', '2026-09-10', 10000),
      tx('ret', 'C', '2026-09-20', -10000),
    ]);
    expect(byId(ev).get('p')).toMatchObject({ state: 'untracked', reason: 'partner_excluded' });
    expect(byId(ev).get('ret')!.candidates.map((c) => c.kind)).toEqual(['exact_amount']);
  });
});

describe('Codex review of the overnight work — REGRESSIONS (written failing, before the fixes)', () => {
  // Finding 1 (§3.6): when more than one posted row names the same pending id, the lineage is
  // ambiguous. The decision is inactive (lineage_ambiguous) AND every ambiguous replacement candidate
  // stays unresolved and unavailable for automatic matching — none may be auto-paired.
  const T1 = tx('T1', 'C', '2026-09-01', 10000, { plaid: 't1', pendingOf: 'pc' });
  const T2 = tx('T2', 'C', '2026-09-10', 10000, { plaid: 't2', pendingOf: 'pc' });

  it('single-leg decision: both ambiguous replacements stay unresolved/lineage_ambiguous; the card leg is not auto-paired', () => {
    const rows = [T1, T2, tx('x', 'X', '2026-09-02', -10000)];
    const d = mkDecision('u', 'destination_unlinked', ref('C', 'pc', 10000));
    const orders = [rows, [...rows].reverse(), [rows[2], rows[0], rows[1]]];
    const results = orders.map((transactions) => run(transactions, { decisions: [d] }));
    for (const ev of results) {
      expect(ev.decisions).toEqual([{ decisionId: 'u', kind: 'destination_unlinked', status: 'inactive', detail: 'lineage_ambiguous' }]);
      for (const id of ['T1', 'T2']) {
        expect(byId(ev).get(id)).toMatchObject({
          state: 'unresolved',
          reason: 'ambiguous_replacement',
          detail: 'lineage_ambiguous',
          decisionId: 'u',
          partnerTransactionId: null,
          effectCents: null,
          lowCents: -10000,
          highCents: 0,
        });
      }
      expect(byId(ev).get('x')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
      for (const leg of ev.legs) expect(['tracked', 'paired', 'untracked']).not.toContain(leg.state);
      expect(ev).toEqual(results[0]);
    }
  });

  it('pair decision: the ambiguous cash replacements AND the named card leg stay unresolved; a nearby card leg does not auto-pair with them', () => {
    const rows = [T1, T2, tx('Pk', 'X', '2026-09-20', -10000, { plaid: 'pk' }), tx('y', 'Y', '2026-09-02', -10000)];
    const d = mkDecision('d', 'pair', ref('C', 'pc', 10000), ref('X', 'pk', -10000));
    const orders = [rows, [...rows].reverse(), [rows[3], rows[1], rows[2], rows[0]]];
    const results = orders.map((transactions) => run(transactions, { decisions: [d] }));
    for (const ev of results) {
      expect(ev.decisions[0]).toMatchObject({ status: 'inactive', detail: 'lineage_ambiguous' });
      for (const id of ['T1', 'T2']) {
        expect(byId(ev).get(id)).toMatchObject({ state: 'unresolved', reason: 'ambiguous_replacement', detail: 'lineage_ambiguous', decisionId: 'd', partnerTransactionId: null });
      }
      // The pair's other, unambiguous leg is held by the now-inactive decision.
      expect(byId(ev).get('Pk')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'lineage_ambiguous', partnerTransactionId: null });
      expect(byId(ev).get('y')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
      expect(ev).toEqual(results[0]);
    }
  });

  it('pair decision with the ambiguity on the CARD side: both card replacements held, no auto-pair with a nearby payment', () => {
    const K1 = tx('K1', 'X', '2026-09-02', -10000, { plaid: 'k1', pendingOf: 'pk' });
    const K2 = tx('K2', 'X', '2026-09-12', -10000, { plaid: 'k2', pendingOf: 'pk' });
    const rows = [tx('Pc', 'C', '2026-09-25', 10000, { plaid: 'pc' }), K1, K2, tx('c2', 'C2', '2026-09-01', 10000)];
    const d = mkDecision('d', 'pair', ref('C', 'pc', 10000), ref('X', 'pk', -10000));
    const a = run(rows, { decisions: [d] });
    const b = run([...rows].reverse(), { decisions: [d] });
    expect(b).toEqual(a);
    for (const id of ['Pc', 'K1', 'K2']) expect(byId(a).get(id)).toMatchObject({ state: 'unresolved', detail: 'lineage_ambiguous' });
    expect(byId(a).get('c2')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
  });

  // Finding 2 (§3.2): an active user decision stands, but contradicting TIER 2 evidence (not only
  // tier-1-shaped legs) must stay visible as candidates, within the usual limits and dismissals.
  const unlinked = mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000));
  const pay = tx('c', 'C', '2026-09-01', 10000);

  it('a late exact match (6 days) contradicting "unlinked" is listed; the confirmed effect is kept', () => {
    const c = byId(run([pay, tx('x', 'X', '2026-09-07', -10000)], { decisions: [unlinked] })).get('c')!;
    expect(c).toMatchObject({ state: 'untracked', reason: 'user_confirmed_unlinked', effectCents: -10000 });
    expect(c.candidates).toEqual([{ transactionId: 'x', kind: 'exact_amount', distanceDays: 6, differenceCents: 0, contradictsDecision: true }]);
  });

  it('a near-amount suggestion (−98 one day later) contradicting "unlinked" is listed', () => {
    const c = byId(run([pay, tx('x', 'X', '2026-09-02', -9800)], { decisions: [unlinked] })).get('c')!;
    expect(c).toMatchObject({ state: 'untracked', effectCents: -10000 });
    expect(c.candidates).toEqual([{ transactionId: 'x', kind: 'near_amount', distanceDays: 1, differenceCents: 200, contradictsDecision: true }]);
  });

  it('the suggestion limits still apply to contradictions: 61 days or $5.01 are not listed', () => {
    for (const card of [tx('x', 'X', '2026-11-01', -10000), tx('x', 'X', '2026-09-02', -9499)]) {
      expect(byId(run([pay, card], { decisions: [unlinked] })).get('c')!.candidates).toEqual([]);
    }
  });

  it('a dismissed candidate is not listed as a contradiction either', () => {
    const dismissed = mkDecision('n', 'not_this_pair', ref('C', 'p-c', 10000), ref('X', 'p-x', -10000));
    const c = byId(run([pay, tx('x', 'X', '2026-09-07', -10000)], { decisions: [unlinked, dismissed] })).get('c')!;
    expect(c.candidates).toEqual([]);
  });

  it('an active user pair lists a contradicting late exact match on another card', () => {
    const ev = run([pay, tx('far', 'Y', '2026-10-15', -10000), tx('late', 'X', '2026-09-08', -10000)], {
      decisions: [mkDecision('d', 'pair', ref('C', 'p-c', 10000), ref('Y', 'p-far', -10000))],
    });
    expect(byId(ev).get('c')).toMatchObject({ state: 'tracked', reason: 'user_pair', partnerTransactionId: 'far' });
    expect(byId(ev).get('c')!.candidates).toEqual([
      { transactionId: 'late', kind: 'exact_amount', distanceDays: 7, differenceCents: 0, contradictsDecision: true },
    ]);
  });
});

describe('APPROVED RULE (Trevor, 2026-09-30): conflicting replacements stay unresolved at the lineage level', () => {
  // When more than one posted row on the same user/account names the same pending id, the matching of
  // every such row stays unresolved: no replacement is chosen, no resolved effect is published, and the
  // rows are neither matched automatically nor offered as other legs' candidates — whatever decision
  // exists, or none. Nothing is deleted, merged or selected. A later snapshot with one replacement
  // evaluates normally, with no manual action.
  const T1 = tx('T1', 'C', '2026-09-01', 10000, { plaid: 't1', pendingOf: 'pc' });
  const T2 = tx('T2', 'C', '2026-09-10', 10000, { plaid: 't2', pendingOf: 'pc' });
  const X1 = tx('x', 'X', '2026-09-02', -10000);
  const held = (ev: CardPaymentEvaluation, id: string, decisionId: string | null) =>
    expect(byId(ev).get(id)).toMatchObject({
      state: 'unresolved',
      reason: 'ambiguous_replacement',
      detail: 'lineage_ambiguous',
      decisionId,
      partnerTransactionId: null,
      effectCents: null,
      candidates: [],
    });
  const noLegListsHeld = (ev: CardPaymentEvaluation, ids: string[]) => {
    for (const leg of ev.legs) {
      expect(ids).not.toContain(leg.partnerTransactionId);
      for (const c of leg.candidates) expect(ids).not.toContain(c.transactionId);
    }
  };
  const orders = <T,>(xs: T[]) => [xs, [...xs].reverse(), [...xs.slice(1), xs[0]]];

  it('Q12 closed — a removed-card decision: both replacements held, the card leg not auto-paired', () => {
    const d = mkDecision('r', 'destination_removed_card', ref('C', 'pc', 10000));
    const results = orders([T1, T2, X1]).map((t) => run(t, { decisions: [d] }));
    for (const ev of results) {
      expect(ev.decisions).toEqual([{ decisionId: 'r', kind: 'destination_removed_card', status: 'inactive', detail: 'lineage_ambiguous' }]);
      held(ev, 'T1', 'r');
      held(ev, 'T2', 'r');
      expect(byId(ev).get('x')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
      noLegListsHeld(ev, ['T1', 'T2']);
      expect(ev).toEqual(results[0]);
    }
  });

  it('no saved decision: both replacements held; other legs neither pair with nor list them', () => {
    const later = tx('c2', 'C2', '2026-09-20', 10000); // an exact late candidate for x (18 days)
    const results = orders([T1, T2, X1, later]).map((t) => run(t));
    for (const ev of results) {
      held(ev, 'T1', null);
      held(ev, 'T2', null);
      expect(byId(ev).get('x')).toMatchObject({ state: 'unresolved', reason: 'possible_match', partnerTransactionId: null });
      expect(byId(ev).get('x')!.candidates.map((c) => c.transactionId)).toEqual(['c2']);
      noLegListsHeld(ev, ['T1', 'T2']);
      expect(ev).toEqual(results[0]);
    }
  });

  it('a user decision naming one replacement by its own posted id is held too (decided before the second arrived)', () => {
    const d = mkDecision('p', 'pair', ref('C', 't1', 10000), ref('X', 'p-x', -10000));
    const ev = run([T1, T2, X1], { decisions: [d] });
    expect(ev.decisions).toEqual([{ decisionId: 'p', kind: 'pair', status: 'inactive', detail: 'lineage_ambiguous' }]);
    held(ev, 'T1', 'p');
    held(ev, 'T2', null);
    expect(byId(ev).get('x')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'lineage_ambiguous' });
  });

  it('the held rows keep the approved period-specific bounds (Sep payment, Oct return, never netted)', () => {
    const P1 = tx('P1', 'C', '2026-09-28', 10000, { plaid: 'p1', pendingOf: 'pp' });
    const P2 = tx('P2', 'C', '2026-09-29', 10000, { plaid: 'p2', pendingOf: 'pp' });
    const R1 = tx('R1', 'C', '2026-10-03', -10000, { plaid: 'r1', pendingOf: 'pr' });
    const R2 = tx('R2', 'C', '2026-10-04', -10000, { plaid: 'r2', pendingOf: 'pr' });
    const ev = run([P1, P2, R1, R2]);
    expect(summarizeCardPaymentPeriod(ev, { start: '2026-09-01', end: '2026-10-01' })).toMatchObject({ lowCents: -20000, highCents: 0, resolved: false, byReason: { ambiguous_replacement: 2 } });
    expect(summarizeCardPaymentPeriod(ev, { start: '2026-10-01', end: '2026-11-01' })).toMatchObject({ lowCents: 0, highCents: 20000, resolved: false });
  });

  it('excluded-account treatment is preserved: conflicting rows on an excluded account stay not counted and unmatched', () => {
    const F1 = tx('F1', 'F', '2026-09-01', 10000, { plaid: 'f1', pendingOf: 'pf' });
    const F2 = tx('F2', 'F', '2026-09-05', 10000, { plaid: 'f2', pendingOf: 'pf' });
    const ev = run([F1, F2, X1]);
    for (const id of ['F1', 'F2']) expect(byId(ev).get(id)).toMatchObject({ state: 'not_counted', reason: 'excluded_account', partnerTransactionId: null, lowCents: 0, highCents: 0 });
    expect(byId(ev).get('x')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
    noLegListsHeld(ev, ['F1', 'F2']);
  });

  it('isolation: one replacement per ACCOUNT is not a conflict, and another user\'s row never makes ours ambiguous', () => {
    const onC = tx('onC', 'C', '2026-09-01', 10000, { plaid: 'onc', pendingOf: 'shared' });
    const onC2 = tx('onC2', 'C2', '2026-09-20', 10000, { plaid: 'onc2', pendingOf: 'shared' });
    const theirs = tx('theirs', 'Cb', '2026-09-01', 10000, { plaid: 'theirs', pendingOf: 'shared' });
    const accounts = [C, C2, X, Y, E, F, acct('Cb', 'depository', false, V)];
    const ev = evaluateCardPayments({ userId: U, asOf: ASOF, accounts, transactions: [onC, onC2, theirs, X1], carryovers: [], decisions: [] });
    expect(byId(ev).get('onC')).toMatchObject({ state: 'tracked', reason: 'auto_pair', partnerTransactionId: 'x' });
    expect(byId(ev).get('onC2')!.reason).not.toBe('ambiguous_replacement');
    expect(ev.legs.map((l) => l.transactionId)).not.toContain('theirs');
  });

  it('a corrected snapshot with one replacement evaluates normally — no manual action needed to clear the hold', () => {
    const snapshots = { conflicted: [T1, T2, X1], corrected: [T1, X1] };
    // No decision: the corrected snapshot auto-pairs under the ordinary tier 1 rule.
    expect(byId(run(snapshots.conflicted)).get('T1')!.reason).toBe('ambiguous_replacement');
    expect(byId(run(snapshots.corrected)).get('T1')).toMatchObject({ state: 'tracked', reason: 'auto_pair', partnerTransactionId: 'x' });
    // A user decision becomes active again by itself.
    const u = mkDecision('u', 'destination_unlinked', ref('C', 'pc', 10000));
    const again = run(snapshots.corrected, { decisions: [u] });
    expect(again.decisions[0]).toMatchObject({ status: 'active', detail: null });
    expect(byId(again).get('T1')).toMatchObject({ state: 'untracked', reason: 'user_confirmed_unlinked', effectCents: -10000 });
    // A removed-card decision applies again once the replacement is unambiguous (no card leg present).
    const r = mkDecision('r', 'destination_removed_card', ref('C', 'pc', 10000));
    expect(byId(run([T1], { decisions: [r] })).get('T1')).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -10000 });
    expect(byId(run([T1, T2], { decisions: [r] })).get('T1')!.reason).toBe('ambiguous_replacement');
  });

  it('ordinary relinking with a single replacement still matches automatically (tier 1 outranks removed-card)', () => {
    const r = mkDecision('r', 'destination_removed_card', ref('C', 'pc', 10000));
    const ev = run([T1, tx('x2', 'X2', '2026-09-02', -10000)], { accounts: [C, acct('X2', 'credit')], decisions: [r] });
    expect(byId(ev).get('T1')).toMatchObject({ state: 'tracked', reason: 'auto_pair', partnerTransactionId: 'x2' });
  });
});

describe('APPROVED (Trevor, 2026-09-30, batch 2): changed confirmations, removed-card reevaluation, returns, excluded evidence', () => {
  const SEP = { start: '2026-09-01', end: '2026-10-01' };
  // No included credit account: only an excluded card and cash accounts.
  const noIncludedCard = [C, C2, E, F];

  // ---- 1. A changed user confirmation keeps its entries reserved -----------------------------------
  it('1. a confirmed pair whose card amount changed stays reserved: neither leg is reused for another payment', () => {
    // User paired c (+100) with x (−100, 20 days later). The bank corrects x to −98. A second payment
    // c2 +98 one day before x would be a tier 1 match for x if x were free.
    const ev = run(
      [tx('c', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-21', -9800), tx('c2', 'C2', '2026-09-20', 9800)],
      { decisions: [mkDecision('d', 'pair', ref('C', 'p-c', 10000), ref('X', 'p-x', -10000))] }
    );
    expect(ev.decisions[0]).toMatchObject({ status: 'inactive', detail: 'amount_changed' });
    expect(byId(ev).get('x')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'amount_changed', partnerTransactionId: null });
    expect(byId(ev).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', partnerTransactionId: null });
    expect(byId(ev).get('c2')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
    expect(byId(ev).get('c2')!.candidates.map((c) => c.transactionId)).not.toContain('x');
  });

  // ---- 2. The narrow known-effect exception ($100 → $98, no included card) -------------------------
  const unlinked100 = mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000));

  it('2. confirmed $100 unlinked payment corrected to $98, no included card → effect −98; confirmation inactive, needs review; reserved', () => {
    // An excluded card leg of −98 one day later would be a tier 1 partner if the payment were free.
    const ev = run([tx('c', 'C', '2026-09-01', 9800), tx('e', 'E', '2026-09-02', -9800)], { accounts: noIncludedCard, decisions: [unlinked100] });
    const c = byId(ev).get('c')!;
    expect(c).toMatchObject({
      state: 'untracked',
      reason: 'no_included_card',
      effectCents: -9800,
      lowCents: -9800,
      highCents: -9800,
      // the invalidated confirmation stays attached and visibly needs review — a separate fact
      decisionId: 'u',
      detail: 'amount_changed',
      // reserved: not matched automatically
      partnerTransactionId: null,
    });
    expect(ev.decisions).toEqual([{ decisionId: 'u', kind: 'destination_unlinked', status: 'inactive', detail: 'amount_changed' }]);
    expect(byId(ev).get('e')).toMatchObject({ state: 'not_counted', partnerTransactionId: null });
    expect(summarizeCardPaymentPeriod(ev, SEP)).toMatchObject({ lowCents: -9800, highCents: -9800, resolved: true });
  });

  it('2. the same exception for a confirmed return corrected in the same direction (−100 → −98) → +98', () => {
    const d = mkDecision('u', 'destination_unlinked', ref('C', 'p-c', -10000));
    const c = byId(run([tx('c', 'C', '2026-09-01', -9800)], { accounts: noIncludedCard, decisions: [d] })).get('c')!;
    expect(c).toMatchObject({ state: 'untracked', reason: 'no_included_card', effectCents: 9800, detail: 'amount_changed', decisionId: 'u' });
  });

  it('2 (negative). an included credit account prevents the exception → still unresolved [−98, 0]', () => {
    const c = byId(run([tx('c', 'C', '2026-09-01', 9800)], { decisions: [unlinked100] })).get('c')!;
    expect(c).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'amount_changed', lowCents: -9800, highCents: 0 });
  });

  it('2 (negative). a direction change (+100 → −98) is not a same-direction correction → unresolved', () => {
    const c = byId(run([tx('c', 'C', '2026-09-01', -9800)], { accounts: noIncludedCard, decisions: [unlinked100] })).get('c')!;
    expect(c).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'amount_changed', lowCents: 0, highCents: 9800 });
  });

  it('2 (negative). conflicting replacements are never an exception, even with no included card', () => {
    const d = mkDecision('u', 'destination_unlinked', ref('C', 'pc', 10000));
    const ev = run(
      [tx('T1', 'C', '2026-09-01', 9800, { plaid: 't1', pendingOf: 'pc' }), tx('T2', 'C', '2026-09-05', 9800, { plaid: 't2', pendingOf: 'pc' })],
      { accounts: noIncludedCard, decisions: [d] }
    );
    for (const id of ['T1', 'T2']) expect(byId(ev).get(id)).toMatchObject({ state: 'unresolved', reason: 'ambiguous_replacement', effectCents: null });
  });

  it('2 (negative). conflicting decisions are never an exception', () => {
    const ev = run([tx('c', 'C', '2026-09-01', 9800)], {
      accounts: noIncludedCard,
      decisions: [unlinked100, mkDecision('u2', 'destination_unlinked', ref('C', 'p-c', 9800))],
    });
    expect(byId(ev).get('c')).toMatchObject({ state: 'unresolved', detail: 'conflicting_decisions', effectCents: null });
  });

  it('2 (negative). a changed role is never an exception: the row is no longer a card leg, no effect is published', () => {
    const ev = run([tx('c', 'C', '2026-09-01', 9800, { role: 'expense' })], { accounts: noIncludedCard, decisions: [unlinked100] });
    expect(ev.legs).toEqual([]);
    expect(ev.decisions[0]).toMatchObject({ status: 'inactive', detail: 'amount_changed' });
  });

  it('2 (negative). a confirmed pair whose amount changed (missing counterpart shape) is not extended → unresolved', () => {
    const ev = run([tx('c', 'C', '2026-09-01', 9800), tx('e', 'E', '2026-09-20', -10000)], {
      accounts: noIncludedCard,
      decisions: [mkDecision('d', 'pair', ref('C', 'p-c', 10000), ref('E', 'p-e', -10000))],
    });
    expect(byId(ev).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'amount_changed', effectCents: null });
  });

  it('2 (negative). an ownership failure is not the exception: the rejected decision attaches nothing to the leg', () => {
    const foreign = { ...unlinked100, userId: V };
    const c = byId(run([tx('c', 'C', '2026-09-01', 9800)], { accounts: noIncludedCard, decisions: [foreign] })).get('c')!;
    // The ordinary no-included-card proof applies (unchanged behaviour); no decision is named, nothing needs review.
    expect(c).toMatchObject({ state: 'untracked', reason: 'no_included_card', decisionId: null, detail: null });
  });

  it('2. when the bank restores the recorded amount, the confirmation is active again (no manual clearing)', () => {
    const c = byId(run([tx('c', 'C', '2026-09-01', 10000)], { accounts: noIncludedCard, decisions: [unlinked100] })).get('c')!;
    expect(c).toMatchObject({ state: 'untracked', reason: 'user_confirmed_unlinked', detail: null, decisionId: 'u' });
  });

  // ---- 3. An invalidated removed-card record is reevaluated under the ordinary rules ---------------
  const removed100 = mkDecision('r', 'destination_removed_card', ref('C', 'p-c', 10000));

  it('3. removed-card record invalidated by an amount change + a clear tier 1 match → matched automatically', () => {
    const ev = run([tx('c', 'C', '2026-09-01', 9800), tx('x', 'X', '2026-09-02', -9800)], { decisions: [removed100] });
    expect(ev.decisions[0]).toMatchObject({ status: 'inactive', detail: 'amount_changed' });
    expect(byId(ev).get('c')).toMatchObject({ state: 'tracked', reason: 'auto_pair', partnerTransactionId: 'x' });
  });

  it('3. …with no qualifying match and an included card → unresolved; the invalid record is not proof', () => {
    const c = byId(run([tx('c', 'C', '2026-09-01', 9800)], { decisions: [removed100] })).get('c')!;
    expect(c).toMatchObject({ state: 'unresolved', reason: 'no_candidate', lowCents: -9800, highCents: 0 });
    expect(c.reason).not.toBe('removed_card');
  });

  it('3. …with independent current evidence (no included card) → untracked by that evidence, not by the record', () => {
    const c = byId(run([tx('c', 'C', '2026-09-01', 9800)], { accounts: noIncludedCard, decisions: [removed100] })).get('c')!;
    expect(c).toMatchObject({ state: 'untracked', reason: 'no_included_card', effectCents: -9800 });
  });

  it('3. …never overrides a protected user confirmation, and never bypasses the conflicting-replacement guard', () => {
    const withUser = run([tx('c', 'C', '2026-09-01', 9800), tx('x', 'X', '2026-09-02', -9800)], {
      decisions: [removed100, mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 9800))],
    });
    expect(byId(withUser).get('c')).toMatchObject({ state: 'untracked', reason: 'user_confirmed_unlinked', decisionId: 'u' });
    const conflicted = run(
      [tx('T1', 'C', '2026-09-01', 9800, { plaid: 't1', pendingOf: 'pc' }), tx('T2', 'C', '2026-09-03', 9800, { plaid: 't2', pendingOf: 'pc' }), tx('x', 'X', '2026-09-02', -9800)],
      { decisions: [mkDecision('r', 'destination_removed_card', ref('C', 'pc', 10000))] }
    );
    for (const id of ['T1', 'T2']) expect(byId(conflicted).get(id)).toMatchObject({ reason: 'ambiguous_replacement', partnerTransactionId: null });
  });

  // ---- 4. Return suggestions: refund and reversal up to 60 days apart; the original may be older ----
  const returnCase = (reversalDate: string, returnDate: string) =>
    run([
      tx('p', 'C', '2026-06-01', 10000),
      tx('k', 'X', '2026-06-02', -10000),
      tx('rev', 'X', reversalDate, 10000),
      tx('ret', 'C', returnDate, -10000),
    ]);

  it('4. refund 60 days after the reversal → return-of-pair suggestion (original payment 100+ days older)', () => {
    const ret = byId(returnCase('2026-09-10', '2026-11-09')).get('ret')!;
    expect(ret).toMatchObject({ state: 'unresolved', reason: 'possible_match' });
    expect(ret.candidates).toEqual([{ transactionId: 'rev', kind: 'return_of_pair', distanceDays: 60, differenceCents: 0, contradictsDecision: false }]);
  });

  it('4. refund 61 days after the reversal → no suggestion (manual matching stays unrestricted)', () => {
    const ev = returnCase('2026-09-10', '2026-11-10');
    expect(byId(ev).get('ret')).toMatchObject({ state: 'unresolved', reason: 'no_candidate', candidates: [] });
    const manual = run(
      [tx('p', 'C', '2026-06-01', 10000), tx('k', 'X', '2026-06-02', -10000), tx('rev', 'X', '2026-09-10', 10000), tx('ret', 'C', '2026-11-10', -10000)],
      { decisions: [mkDecision('m', 'pair', ref('C', 'p-ret', -10000), ref('X', 'p-rev', 10000))] }
    );
    expect(byId(manual).get('ret')).toMatchObject({ state: 'tracked', reason: 'user_pair', partnerTransactionId: 'rev' });
  });

  it('4. the automatic window is unchanged: within 5 days a return pairs automatically, at 6 it is only suggested', () => {
    expect(byId(returnCase('2026-09-10', '2026-09-15')).get('ret')).toMatchObject({ state: 'tracked', reason: 'auto_pair' });
    expect(byId(returnCase('2026-09-10', '2026-09-16')).get('ret')).toMatchObject({ state: 'unresolved', reason: 'possible_match' });
  });

  // ---- 5. Possible matches on excluded cards are shown against "unlinked" --------------------------
  it('5. an excluded-card leg contradicting "unlinked" is listed (exact late and tier-1-shaped); effect unchanged', () => {
    const d = mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000));
    const late = byId(run([tx('c', 'C', '2026-09-01', 10000), tx('e', 'E', '2026-09-08', -10000)], { decisions: [d] })).get('c')!;
    expect(late).toMatchObject({ state: 'untracked', reason: 'user_confirmed_unlinked', effectCents: -10000 });
    expect(late.candidates).toEqual([{ transactionId: 'e', kind: 'exact_amount', distanceDays: 7, differenceCents: 0, contradictsDecision: true }]);
    const near = byId(run([tx('c', 'C', '2026-09-01', 10000), tx('e', 'E', '2026-09-02', -10000)], { decisions: [d] })).get('c')!;
    expect(near).toMatchObject({ state: 'untracked', reason: 'user_confirmed_unlinked', effectCents: -10000 });
    expect(near.candidates).toEqual([{ transactionId: 'e', kind: 'tier1_competitor', distanceDays: 1, differenceCents: 0, contradictsDecision: true }]);
  });
});

describe('scenarios: decisions take precedence over suggestions and automation (§3.2)', () => {
  it('a user pair 40 days apart stands; the tier-1-shaped leg is a contradiction, and is not paired with the claimed leg', () => {
    const ev = run(
      [tx('c', 'C', '2026-09-01', 10000), tx('near', 'X', '2026-09-02', -10000), tx('far', 'Y', '2026-10-11', -10000)],
      { decisions: [mkDecision('d', 'pair', ref('C', 'p-c', 10000), ref('Y', 'p-far', -10000))] }
    );
    const m = byId(ev);
    expect(m.get('c')).toMatchObject({ state: 'tracked', reason: 'user_pair', partnerTransactionId: 'far' });
    expect(m.get('c')!.candidates).toEqual([{ transactionId: 'near', kind: 'tier1_competitor', distanceDays: 1, differenceCents: 0, contradictsDecision: true }]);
    expect(m.get('near')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
  });

  it('a claimed leg is removed from automatic pairing: a second payment near the claimed card leg does not pair with it', () => {
    const ev = run(
      [tx('c1', 'C', '2026-08-01', 10000), tx('x', 'X', '2026-09-02', -10000), tx('c2', 'C', '2026-09-01', 10000)],
      { decisions: [mkDecision('d', 'pair', ref('C', 'p-c1', 10000), ref('X', 'p-x', -10000))] }
    );
    expect(byId(ev).get('c2')).toMatchObject({ state: 'unresolved', reason: 'no_candidate' });
  });

  it('suggestions never become matches on their own: exact 6–60 days, near amount, return-of-pair all stay unresolved', () => {
    const ev = run([
      tx('p', 'C', '2026-09-01', 10000),
      tx('k', 'X', '2026-09-02', -10000),
      tx('rev', 'X', '2026-09-10', 10000),
      tx('ret', 'C', '2026-09-20', -10000),
      tx('fee', 'C2', '2026-09-25', 30000),
      tx('feek', 'Y', '2026-09-26', -29800),
    ]);
    const m = byId(ev);
    expect(m.get('ret')).toMatchObject({ state: 'unresolved', reason: 'possible_match' });
    expect(m.get('fee')).toMatchObject({ state: 'unresolved', reason: 'amount_differs' });
  });
});

describe('scenarios: mixed users', () => {
  it("mirror-image legs of two users never cross: each user's own legs only", () => {
    const accounts = [C, X, acct('Cb', 'depository', false, V), acct('Xb', 'credit', false, V)];
    const transactions = [tx('a-pay', 'C', '2026-09-01', 10000), tx('b-card', 'Xb', '2026-09-02', -10000), tx('b-pay', 'Cb', '2026-09-01', 10000), tx('a-card', 'X', '2026-09-20', -10000)];
    const a = evaluateCardPayments({ userId: U, asOf: ASOF, accounts, transactions, carryovers: [], decisions: [] });
    const b = evaluateCardPayments({ userId: V, asOf: ASOF, accounts, transactions, carryovers: [], decisions: [] });
    expect(a.legs.map((l) => l.transactionId)).toEqual(['a-card', 'a-pay']);
    expect(b.legs.map((l) => l.transactionId)).toEqual(['b-card', 'b-pay']);
    expect(byId(b).get('b-pay')).toMatchObject({ state: 'tracked', partnerTransactionId: 'b-card' });
    expect(byId(a).get('a-pay')).toMatchObject({ state: 'unresolved', reason: 'possible_match' });
  });
});

// ---- Generated histories and invariants -----------------------------------------------------------

/** mulberry32 — a small deterministic PRNG, so every generated case is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

interface Generated {
  input: Omit<CardPaymentMatchingInput, 'userId'>;
}

/** One user's history: clustered dates across the Sep/Oct boundary, few distinct amounts, lineage. */
function generateUser(r: () => number, userId: string, prefix: string, withDecisions: boolean) {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const hasIncludedCard = r() > 0.15;
  const accounts: MatchingAccount[] = [
    acct(`${prefix}C`, 'depository', false, userId),
    acct(`${prefix}N`, null, false, userId),
    acct(`${prefix}F`, 'depository', true, userId),
    acct(`${prefix}E`, 'credit', true, userId),
    ...(hasIncludedCard ? [acct(`${prefix}X`, 'credit', false, userId), acct(`${prefix}Y`, 'credit', false, userId)] : []),
  ];
  const cash = accounts.filter((a) => a.type !== 'credit');
  const credit = accounts.filter((a) => a.type === 'credit');
  const transactions: MatchingTransaction[] = [];
  const carryovers: MatchingCarryover[] = [];
  const n = 4 + Math.floor(r() * 12);
  let i = 0;
  const next = () => `${prefix}t${i++}`;
  for (let k = 0; k < n; k++) {
    const isCredit = r() < 0.5;
    const account = pick(isCredit ? credit : cash);
    const base = pick([10000, 25000, 40000]) + (r() < 0.15 ? pick([-200, 200, 500, -501]) : 0);
    const isReturn = r() < 0.25;
    const cents = (isCredit ? -1 : 1) * (isReturn ? -1 : 1) * base;
    const offset = r() < 0.85 ? Math.floor(r() * 14) - 7 : Math.floor(r() * 140) - 70;
    const date = addDays('2026-09-28', offset);
    const role = r() < 0.06 ? pick(['expense', 'internal_transfer', null]) : 'credit_card_payment';
    const id = next();
    const lineage = r();
    if (lineage < 0.2) {
      // pending → posted: sometimes both present (superseded pending), sometimes only one, sometimes
      // neither (a waiting or expired carry-over).
      const pendingPlaid = `${id}-pending`;
      const postedCents = r() < 0.15 ? cents + pick([100, -100]) : cents;
      const variant = Math.floor(r() * 4);
      if (variant !== 2) transactions.push(tx(`${id}p`, account.id, date, cents, { plaid: pendingPlaid, pending: true, role }));
      if (variant !== 1) transactions.push(tx(id, account.id, addDays(date, Math.floor(r() * 3)), postedCents, { plaid: `${id}-posted`, pendingOf: pendingPlaid, role }));
      // Rarely, a second posted row names the same pending id: an ambiguous lineage (§3.6).
      if (variant !== 1 && r() < 0.25) {
        transactions.push(tx(`${id}dup`, account.id, addDays(date, 3 + Math.floor(r() * 8)), cents, { plaid: `${id}-dup`, pendingOf: pendingPlaid, role }));
      }
      if (variant === 2 || variant === 3) {
        carryovers.push({ accountId: account.id, pendingPlaidTransactionId: pendingPlaid, expiresAt: r() < 0.5 ? '2026-12-31T00:00:00Z' : '2026-10-01T00:00:00Z', consumed: variant === 3 });
      }
    } else {
      transactions.push(tx(id, account.id, date, cents, { plaid: `${id}-plaid`, role }));
    }
  }
  const decisions: MatchingDecision[] = [];
  if (withDecisions) {
    const refOf = (t: MatchingTransaction, cents = t.amountCents): DecisionLegRef =>
      ref(t.accountId, r() < 0.3 && t.pendingTransactionId ? t.pendingTransactionId : t.plaidTransactionId, cents);
    const m = Math.floor(r() * 5);
    for (let k = 0; k < m && transactions.length > 0; k++) {
      const a = pick(transactions);
      const b = pick(transactions);
      const kind = pick<MatchingDecision['kind']>(['pair', 'pair', 'not_this_pair', 'destination_unlinked', 'destination_removed_card']);
      const id = `${prefix}d${k}`;
      if (kind === 'pair' || kind === 'not_this_pair') {
        const aCash = accounts.find((x) => x.id === a.accountId)!.type !== 'credit';
        const cashT = aCash ? a : b;
        const credT = aCash ? b : a;
        const diff = Math.abs(cashT.amountCents) - Math.abs(credT.amountCents);
        const accepted = kind === 'pair' ? (r() < 0.8 ? diff : diff + 1) : null;
        decisions.push({ ...mkDecision(id, kind, refOf(a), refOf(b), accepted, userId), decidedSeq: k });
      } else {
        decisions.push({ ...mkDecision(id, kind, refOf(a, r() < 0.9 ? a.amountCents : a.amountCents + 1), null, null, userId), decidedSeq: k, supersededBy: r() < 0.1 ? 'undone' : null });
      }
    }
  }
  // Approved exception (2026-09-30): sometimes a user with no included card confirmed a cash payment as
  // "unlinked" at an amount the bank has since corrected in the same direction.
  if (withDecisions && !hasIncludedCard && r() < 0.6) {
    const cashLegs = transactions.filter((t) => cash.some((c) => c.id === t.accountId) && Math.abs(t.amountCents) > 100);
    if (cashLegs.length > 0) {
      const t = pick(cashLegs);
      decisions.push({ ...mkDecision(`${prefix}dx`, 'destination_unlinked', ref(t.accountId, t.plaidTransactionId, t.amountCents + Math.sign(t.amountCents) * 200), null, null, userId), decidedSeq: 99 });
    }
  }
  return { accounts, transactions, carryovers, decisions };
}

function generate(seed: number, withDecisions = true): Generated {
  const r = rng(seed);
  const a = generateUser(r, U, 'a', withDecisions);
  const b = generateUser(r, V, 'b', withDecisions);
  // Occasionally a decision recorded under user B that names user A's rows (must be rejected).
  const foreign: MatchingDecision[] =
    r() < 0.3 && a.transactions.length > 0
      ? [mkDecision('b-foreign', 'destination_unlinked', ref(a.transactions[0].accountId, a.transactions[0].plaidTransactionId, a.transactions[0].amountCents), null, null, V)]
      : [];
  return {
    input: {
      asOf: ASOF,
      accounts: [...a.accounts, ...b.accounts],
      transactions: [...a.transactions, ...b.transactions],
      carryovers: [...a.carryovers, ...b.carryovers],
      decisions: [...a.decisions, ...b.decisions, ...foreign],
    },
  };
}

function shuffle<T>(xs: T[], r: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const SEEDS = Array.from({ length: 300 }, (_, i) => 1000 + i);
const UNTRACKED_REASONS = new Set(['partner_excluded', 'no_included_card', 'user_confirmed_unlinked', 'removed_card']);

/** The approved rules, restated as properties of a single evaluation. */
function checkInvariants(input: CardPaymentMatchingInput, ev: CardPaymentEvaluation): void {
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const own = input.transactions.filter((t) => accounts.get(t.accountId)!.userId === input.userId);
  // Superseded: a pending row replaced by another row on the same account (§3.6 step 1).
  const superseded = new Set(
    own.filter((t) => own.some((o) => o.accountId === t.accountId && o.pendingTransactionId === t.plaidTransactionId)).map((t) => t.id)
  );
  const expectedLegIds = own
    .filter((t) => t.effectiveRole === 'credit_card_payment' && t.amountCents !== 0 && !superseded.has(t.id))
    .map((t) => t.id)
    .sort();
  // I1 exactly the user's current card legs, once each.
  expect(ev.legs.map((l) => l.transactionId)).toEqual(expectedLegIds);
  expect(ev.supersededTransactionIds).toEqual([...superseded].sort());

  const legs = new Map(ev.legs.map((l) => [l.transactionId, l]));
  const decisions = new Map(ev.decisions.map((d) => [d.decisionId, d]));
  const includedCardExists = input.accounts.some((a) => a.userId === input.userId && a.type === 'credit' && !a.excludeFromCashFlow);

  for (const leg of ev.legs) {
    const account = accounts.get(leg.accountId)!;
    expect(account.userId).toBe(input.userId);
    const counted = leg.side === 'cash' && !account.excludeFromCashFlow;
    expect(leg.side).toBe(account.type === 'credit' ? 'credit' : 'cash');

    // I2 only included cash-side legs move cash flow.
    if (!counted) {
      expect([leg.lowCents, leg.highCents, leg.effectCents]).toEqual([0, 0, 0]);
      if (account.excludeFromCashFlow) expect(leg.state).toBe('not_counted');
    }
    // I3 bounds: resolved → a point; unresolved → exactly {0, −amount}.
    if (counted && leg.state === 'unresolved') {
      expect(leg.effectCents).toBeNull();
      expect([leg.lowCents, leg.highCents]).toEqual([Math.min(0, -leg.amountCents), Math.max(0, -leg.amountCents)]);
    } else if (counted) {
      expect(leg.lowCents).toBe(leg.effectCents);
      expect(leg.highCents).toBe(leg.effectCents);
    }
    // I4 untracked only through evidence or the user, with the full signed amount.
    if (leg.state === 'untracked') {
      expect(UNTRACKED_REASONS.has(leg.reason)).toBe(true);
      expect(leg.effectCents).toBe(-leg.amountCents);
      if (leg.reason === 'partner_excluded') {
        const partner = legs.get(leg.partnerTransactionId!)!;
        expect(accounts.get(partner.accountId)).toMatchObject({ type: 'credit', excludeFromCashFlow: true });
      }
      if (leg.reason === 'user_confirmed_unlinked') expect(decisions.get(leg.decisionId!)).toMatchObject({ kind: 'destination_unlinked', status: 'active' });
      if (leg.reason === 'removed_card') expect(decisions.get(leg.decisionId!)).toMatchObject({ kind: 'destination_removed_card', status: 'active' });
      if (leg.reason === 'no_included_card') expect(includedCardExists).toBe(false);
    }
    // I5 tracked only with a partner on an included card; the fee remainder follows §4.3.
    if (leg.state === 'tracked') {
      const partner = legs.get(leg.partnerTransactionId!)!;
      expect(accounts.get(partner.accountId)).toMatchObject({ type: 'credit', excludeFromCashFlow: false });
      expect(Math.sign(partner.amountCents)).toBe(-Math.sign(leg.amountCents));
      const excess = Math.abs(leg.amountCents) - Math.abs(partner.amountCents);
      expect(leg.effectCents).toBe(excess > 0 ? -Math.sign(leg.amountCents) * excess : 0);
      if (leg.reason === 'auto_pair') {
        expect(partner.amountCents).toBe(-leg.amountCents);
        expect(Math.abs(Date.parse(partner.date) - Date.parse(leg.date)) / 86400000).toBeLessThanOrEqual(AUTO_PAIR_WINDOW_DAYS);
      } else {
        expect(leg.reason).toBe('user_pair');
        expect(decisions.get(leg.decisionId!)).toMatchObject({ kind: 'pair', status: 'active' });
      }
    }
    // I6 pairs are symmetric.
    if (leg.partnerTransactionId !== null && (leg.reason === 'auto_pair' || leg.reason === 'user_pair')) {
      expect(legs.get(leg.partnerTransactionId)!.partnerTransactionId).toBe(leg.transactionId);
    }
    // Decisions named on a leg are the user's own.
    if (leg.decisionId !== null) expect(decisions.has(leg.decisionId)).toBe(true);
  }
  // I8 (Codex review): every replacement of an ambiguous lineage named by one of the user's live
  // pair / destination decisions is held — never resolved, never paired automatically.
  for (const d of input.decisions) {
    if (d.userId !== input.userId || d.supersededBy !== null || !(d.kind === 'pair' || d.kind === 'destination_unlinked')) continue;
    const refs = d.b === null ? [d.a] : [d.a, d.b];
    if (!refs.every((r) => accounts.get(r.accountId)?.userId === input.userId)) continue;
    for (const r of refs) {
      const replacements = own.filter((t) => t.accountId === r.accountId && t.pendingTransactionId === r.plaidTransactionId);
      if (replacements.length < 2) continue;
      for (const t of replacements) {
        const leg = legs.get(t.id);
        if (leg === undefined) continue;
        expect(['unresolved', 'not_counted']).toContain(leg.state);
        expect(leg.partnerTransactionId).toBeNull();
        expect(leg.decisionId).not.toBeNull();
      }
    }
  }
  // I10 (approved rule, 2026-09-30): every row of a conflicting replacement group — more than one row on
  // the same account naming the same pending id — is held, whatever decisions exist: never resolved,
  // never paired, never another leg's partner or candidate.
  const groups = new Map<string, MatchingTransaction[]>();
  for (const t of own) {
    if (t.pendingTransactionId === null) continue;
    const key = `${t.accountId}|${t.pendingTransactionId}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const conflicting = new Set([...groups.values()].filter((g) => g.length > 1).flat().map((t) => t.id));
  for (const leg of ev.legs) {
    if (conflicting.has(leg.transactionId)) {
      expect(leg.partnerTransactionId).toBeNull();
      expect(leg.candidates).toEqual([]);
      if (leg.accountIncluded) expect(leg).toMatchObject({ state: 'unresolved', reason: 'ambiguous_replacement' });
      else expect(leg.state).toBe('not_counted');
    } else {
      expect(leg.reason).not.toBe('ambiguous_replacement');
    }
    if (leg.partnerTransactionId !== null) expect(conflicting.has(leg.partnerTransactionId)).toBe(false);
    for (const c of leg.candidates) expect(conflicting.has(c.transactionId)).toBe(false);
  }
  // I11 (approved exception, 2026-09-30): a leg that publishes an effect while carrying an inactive
  // decision is exactly the narrow exception — a same-direction amount correction of a user-confirmed
  // unlinked destination, no included card — and stays reserved. Nothing else combines the two.
  for (const leg of ev.legs) {
    if (leg.detail === null || leg.state === 'unresolved' || leg.state === 'not_counted') continue;
    expect(leg).toMatchObject({ state: 'untracked', reason: 'no_included_card', detail: 'amount_changed', partnerTransactionId: null });
    expect(includedCardExists).toBe(false);
    const d = input.decisions.find((x) => x.id === leg.decisionId)!;
    expect(d.kind).toBe('destination_unlinked');
    expect(Math.sign(leg.amountCents)).toBe(Math.sign(d.a.cents));
    expect(leg.amountCents).not.toBe(d.a.cents);
    expect(decisions.get(d.id)).toMatchObject({ status: 'inactive', detail: 'amount_changed' });
  }
  // I9 (Codex review): a candidate contradicts a decision exactly when its leg has an active user
  // decision; everywhere else candidates are ordinary suggestions.
  for (const leg of ev.legs) {
    const activeUserDecision =
      leg.decisionId !== null &&
      decisions.get(leg.decisionId)?.status === 'active' &&
      ['pair', 'destination_unlinked'].includes(decisions.get(leg.decisionId)!.kind);
    for (const c of leg.candidates) expect(c.contradictsDecision).toBe(activeUserDecision);
  }
  // Decisions of another user are never applied.
  for (const d of input.decisions) {
    if (d.userId !== input.userId) expect(decisions.get(d.id)?.status ?? 'rejected').toBe('rejected');
  }

  // I7 period ranges: low ≤ high, width = Σ|unresolved counted amount|, and months add up with no
  // cross-month netting.
  const months = [
    { start: '2026-06-01', end: '2026-09-01' },
    { start: '2026-09-01', end: '2026-10-01' },
    { start: '2026-10-01', end: '2027-01-01' },
  ];
  const parts = months.map((p) => summarizeCardPaymentPeriod(ev, p));
  const whole = summarizeCardPaymentPeriod(ev, { start: '2026-06-01', end: '2027-01-01' });
  for (const [k, s] of parts.entries()) {
    expect(s.lowCents).toBeLessThanOrEqual(s.highCents);
    const unresolved = ev.legs.filter(
      (l) => l.side === 'cash' && l.accountIncluded && l.state === 'unresolved' && l.date >= months[k].start && l.date < months[k].end
    );
    expect(s.highCents - s.lowCents).toBe(unresolved.reduce((sum, l) => sum + Math.abs(l.amountCents), 0));
    expect(s.resolved).toBe(unresolved.length === 0);
  }
  expect(parts.reduce((x, s) => x + s.lowCents, 0)).toBe(whole.lowCents);
  expect(parts.reduce((x, s) => x + s.highCents, 0)).toBe(whole.highCents);
}

describe('invariants over 300 generated two-user histories (seeds 1000–1299)', () => {
  it('every evaluation satisfies the approved rules (I1–I11)', () => {
    for (const seed of SEEDS) {
      const { input } = generate(seed);
      for (const userId of [U, V]) {
        const full = { ...input, userId };
        checkInvariants(full, evaluateCardPayments(full));
      }
    }
  });

  it('reordering every input array yields the same result (determinism)', () => {
    for (const seed of SEEDS) {
      const { input } = generate(seed);
      const r = rng(seed ^ 0x5eed);
      const reordered = {
        ...input,
        userId: U,
        accounts: shuffle(input.accounts, r),
        transactions: shuffle(input.transactions, r),
        carryovers: shuffle(input.carryovers, r),
        decisions: shuffle(input.decisions, r),
      };
      expect(evaluateCardPayments(reordered)).toEqual(evaluateCardPayments({ ...input, userId: U }));
    }
  });

  it("isolation: another user's accounts, rows, carry-overs and decisions never change a user's legs", () => {
    for (const seed of SEEDS) {
      const { input } = generate(seed);
      const accounts = new Map(input.accounts.map((a) => [a.id, a]));
      const mine = (accountId: string) => accounts.get(accountId)!.userId === U;
      const alone = {
        userId: U,
        asOf: input.asOf,
        accounts: input.accounts.filter((a) => a.userId === U),
        transactions: input.transactions.filter((t) => mine(t.accountId)),
        carryovers: input.carryovers.filter((c) => mine(c.accountId)),
        decisions: input.decisions.filter((d) => d.userId === U),
      };
      const together = evaluateCardPayments({ ...input, userId: U });
      expect(together.legs).toEqual(evaluateCardPayments(alone).legs);
    }
  });

  it('time proves nothing: moving asOf never changes a state, an effect or a bound (only labels and details)', () => {
    for (const seed of SEEDS) {
      const { input } = generate(seed);
      const at = (asOf: string) =>
        evaluateCardPayments({ ...input, userId: U, asOf }).legs.map((l) => [l.transactionId, l.state, l.effectCents, l.lowCents, l.highCents]);
      expect(at('2026-09-01T00:00:00Z')).toEqual(at('2028-01-01T00:00:00Z'));
    }
  });

  it('with no decisions, tier 1 is exactly the reciprocal-closest rule (independent restatement)', () => {
    for (const seed of SEEDS) {
      const { input } = generate(seed, false);
      const ev = evaluateCardPayments({ ...input, userId: U });
      const legs = ev.legs;
      const day = (l: CardLegResult) => Date.parse(`${l.date}T00:00:00Z`) / 86400000;
      // The approved lineage-level rule (2026-09-30): rows of a conflicting replacement group (more than
      // one row on one account naming the same pending id) are outside automatic matching.
      const claimants = new Map<string, number>();
      for (const t of input.transactions) {
        if (t.pendingTransactionId !== null) claimants.set(`${t.accountId}|${t.pendingTransactionId}`, (claimants.get(`${t.accountId}|${t.pendingTransactionId}`) ?? 0) + 1);
      }
      const byTxn = new Map(input.transactions.map((t) => [t.id, t]));
      const conflicting = (l: CardLegResult) => {
        const t = byTxn.get(l.transactionId)!;
        return t.pendingTransactionId !== null && claimants.get(`${t.accountId}|${t.pendingTransactionId}`)! > 1;
      };
      const pool = legs.filter((l) => !conflicting(l));
      const edges = (l: CardLegResult) =>
        pool.filter((o) => o !== l && o.side !== l.side && o.amountCents === -l.amountCents && Math.abs(day(o) - day(l)) <= AUTO_PAIR_WINDOW_DAYS);
      const best = (l: CardLegResult): CardLegResult | null => {
        const es = edges(l);
        if (es.length === 0) return null;
        const d = Math.min(...es.map((o) => Math.abs(day(o) - day(l))));
        const closest = es.filter((o) => Math.abs(day(o) - day(l)) === d);
        return closest.length === 1 ? closest[0] : null;
      };
      for (const l of legs) {
        if (conflicting(l)) {
          expect(l.partnerTransactionId).toBeNull();
          continue;
        }
        const b = best(l);
        const expectedPartner = b !== null && best(b) === l ? b.transactionId : null;
        expect(l.partnerTransactionId).toBe(expectedPartner);
        // Unresolved legs with a tier-1-shaped edge are ambiguous; without one they never are.
        if (l.state === 'unresolved') expect(l.reason === 'ambiguous').toBe(edges(l).length > 0);
        expect(['user_pair', 'user_confirmed_unlinked', 'decision_invalidated', 'matched_leg_not_posted', 'removed_card']).not.toContain(l.reason);
      }
    }
  });

  it('the generator exercises the interesting cases (guards against a vacuous run)', () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      const { input } = generate(seed);
      for (const leg of evaluateCardPayments({ ...input, userId: U }).legs) {
        seen.add(`${leg.state}/${leg.reason}`);
        if (leg.detail === 'lineage_ambiguous') seen.add(`${leg.state}/${leg.reason}/lineage_ambiguous`);
        if (leg.candidates.some((c) => c.contradictsDecision)) seen.add('contradiction');
        if (leg.state === 'untracked' && leg.detail === 'amount_changed') seen.add('known-effect exception');
      }
    }
    for (const needed of [
      'tracked/auto_pair',
      'tracked/user_pair',
      'untracked/partner_excluded',
      'untracked/no_included_card',
      'untracked/user_confirmed_unlinked',
      'untracked/removed_card',
      'unresolved/ambiguous',
      'unresolved/possible_match',
      'unresolved/amount_differs',
      'unresolved/no_candidate',
      'unresolved/decision_invalidated',
      'not_counted/excluded_account',
      'unresolved/ambiguous_replacement/lineage_ambiguous',
      'contradiction',
      'known-effect exception',
    ]) {
      expect(seen, needed).toContain(needed);
    }
  });
});
