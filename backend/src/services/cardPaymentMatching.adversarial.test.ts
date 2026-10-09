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
import { acct, generate, mkDecision, mkHold, mkPreserved, ref, rng, SEVERAL_ROW_SCENARIOS, shuffle, tx, U, V } from '../testUtils/cardPaymentHistories';

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

describe('APPROVED (Trevor, 2026-10-06): a user-confirmed pair survives the removal of its counterpart\'s account', () => {
  // The decision the institution removal writes: the user's pair, kept on the leg that survived. The removed
  // leg is gone from the input altogether (its account was deleted); what was true of it is frozen.
  const kept = (status: Parameters<typeof mkPreserved>[2], a: DecisionLegRef = ref('C', 'p-c', 10000), accepted = 0) => mkPreserved('k', a, status, accepted);
  const c = tx('c', 'C', '2026-09-01', 10000);
  const y = tx('y', 'Y', '2026-09-02', -10000); // a competing card leg: exact, one day away

  it('valid → untracked / removed_card, −amount, held by the user decision; the competing card leg is only a contradiction', () => {
    const ev = run([c, y], { decisions: [kept('valid')] });
    expect(byId(ev).get('c')).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -10000, decisionId: 'k', partnerTransactionId: null, detail: null });
    expect(byId(ev).get('c')!.candidates).toEqual([{ transactionId: 'y', kind: 'tier1_competitor', distanceDays: 1, differenceCents: 0, contradictsDecision: true }]);
    expect(byId(ev).get('y')).toMatchObject({ state: 'unresolved', reason: 'no_candidate', partnerTransactionId: null });
    expect(ev.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'active', detail: null }]);
  });

  it('without it the same rows pair automatically — the reservation is what keeps the competitor out', () => {
    expect(reasons(run([c, y]))).toEqual({ c: 'tracked/auto_pair', y: 'paired/auto_pair' });
    expect(reasons(run([c, y], { decisions: [{ ...kept('valid'), supersededBy: 'undone' }] }))).toEqual({ c: 'tracked/auto_pair', y: 'paired/auto_pair' });
  });

  it('it is NOT the system record: destination_removed_card on the same rows is outranked by the tier 1 pair', () => {
    expect(reasons(run([c, y], { decisions: [mkDecision('r', 'destination_removed_card', ref('C', 'p-c', 10000))] }))).toEqual({ c: 'tracked/auto_pair', y: 'paired/auto_pair' });
  });

  it('a counterpart that was only waiting to post invalidates nothing', () => {
    expect(byId(run([c, y], { decisions: [kept('waiting_to_post')] })).get('c')).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -10000 });
  });

  it.each(['amount_changed', 'lineage_ambiguous', 'partner_gone', 'role_changed', 'sides_not_opposite', 'direction_mismatch', 'difference_not_accepted', 'conflicting_decisions'] as const)(
    'a counterpart frozen as %s keeps it inactive: reserved, unresolved, no effect, the competitor not paired',
    (status) => {
      const ev = run([c, y], { decisions: [kept(status)] });
      expect(byId(ev).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: status, decisionId: 'k', effectCents: null, lowCents: -10000, highCents: 0, partnerTransactionId: null });
      expect(byId(ev).get('y')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
      expect(ev.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'inactive', detail: status }]);
    }
  );

  it('the surviving leg\'s own amount change invalidates it too, and restoring the amount reactivates it', () => {
    const changed = run([tx('c', 'C', '2026-09-01', 9800), tx('y', 'Y', '2026-09-02', -9800)], { decisions: [kept('valid')] });
    expect(byId(changed).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'amount_changed', partnerTransactionId: null });
    expect(byId(changed).get('y')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
    expect(byId(run([c], { decisions: [kept('valid')] })).get('c')).toMatchObject({ state: 'untracked', reason: 'removed_card' });
  });

  it('a frozen invalid status is never undone by a relink: the re-imported card leg with the ORIGINAL amount does not pair', () => {
    const ev = run([c, tx('x2', 'X', '2026-09-02', -10000)], { decisions: [kept('amount_changed')] });
    expect(byId(ev).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'amount_changed', partnerTransactionId: null });
    expect(byId(ev).get('x2')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
  });

  it('the mirror case: the surviving leg is the CARD leg → funded_from_excluded / removed_cash_account, 0; a competing cash leg stays unresolved', () => {
    const card = tx('y', 'Y', '2026-09-02', -10000);
    const cash2 = tx('c2', 'C2', '2026-09-03', 10000);
    const ev = run([card, cash2], { decisions: [kept('valid', ref('Y', 'p-y', -10000))] });
    expect(byId(ev).get('y')).toMatchObject({ side: 'credit', state: 'funded_from_excluded', reason: 'removed_cash_account', effectCents: 0, lowCents: 0, highCents: 0, decisionId: 'k', partnerTransactionId: null });
    expect(byId(ev).get('c2')).toMatchObject({ state: 'unresolved', reason: 'no_candidate', effectCents: null, partnerTransactionId: null });
    // without it, the cash leg would be tracked against this card: a resolved 0 nothing established
    expect(reasons(run([card, cash2]))).toEqual({ c2: 'tracked/auto_pair', y: 'paired/auto_pair' });
  });

  it('the mirror case, invalid: the card leg is reserved and unresolved (0), and still not available to the competitor', () => {
    const ev = run([tx('y', 'Y', '2026-09-02', -10000), tx('c2', 'C2', '2026-09-03', 10000)], { decisions: [kept('amount_changed', ref('Y', 'p-y', -10000))] });
    expect(byId(ev).get('y')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'amount_changed', effectCents: 0, partnerTransactionId: null });
    expect(byId(ev).get('c2')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
  });

  it('pending → posted: recorded on the pending id, it follows the posted row; while only a carry-over exists it waits', () => {
    const onPending = kept('valid', ref('C', 'pc', 10000));
    const posted = run([tx('Tc', 'C', '2026-09-02', 10000, { plaid: 'tc', pendingOf: 'pc' }), y], { decisions: [onPending] });
    expect(byId(posted).get('Tc')).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -10000, decisionId: 'k' });
    const waiting = run([y], { decisions: [onPending], carryovers: [{ accountId: 'C', pendingPlaidTransactionId: 'pc', expiresAt: '2026-12-31T00:00:00Z', consumed: false }] });
    expect(waiting.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'inactive', detail: 'waiting_to_post' }]);
    expect(waiting.legs.map((l) => l.transactionId)).toEqual(['y']);
  });

  it('conflicting replacements of the surviving leg: both held unresolved, the decision named, no effect, no competitor', () => {
    const ev = run(
      [tx('T1', 'C', '2026-09-01', 10000, { plaid: 't1', pendingOf: 'pc' }), tx('T2', 'C', '2026-09-10', 10000, { plaid: 't2', pendingOf: 'pc' }), y],
      { decisions: [kept('valid', ref('C', 'pc', 10000))] }
    );
    for (const id of ['T1', 'T2']) expect(byId(ev).get(id)).toMatchObject({ state: 'unresolved', reason: 'ambiguous_replacement', decisionId: 'k', partnerTransactionId: null, effectCents: null });
    expect(byId(ev).get('y')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
    expect(ev.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'inactive', detail: 'lineage_ambiguous' }]);
  });

  it('the no-included-card rule can establish the effect by itself (same-direction amount change, cash side only); the confirmation stays inactive', () => {
    const noCard = [C, C2, E, F];
    const frozen = run([c], { accounts: noCard, decisions: [kept('amount_changed')] });
    expect(byId(frozen).get('c')).toMatchObject({ state: 'untracked', reason: 'no_included_card', effectCents: -10000, detail: 'amount_changed', decisionId: 'k' });
    expect(frozen.decisions[0]).toMatchObject({ status: 'inactive', detail: 'amount_changed' });
    const live = run([tx('c', 'C', '2026-09-01', 9800)], { accounts: noCard, decisions: [kept('valid')] });
    expect(byId(live).get('c')).toMatchObject({ state: 'untracked', reason: 'no_included_card', effectCents: -9800, detail: 'amount_changed' });
    // not for another frozen reason, and not when an included card exists
    expect(byId(run([c], { accounts: noCard, decisions: [kept('lineage_ambiguous')] })).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated' });
    expect(byId(run([c], { decisions: [kept('amount_changed')] })).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated' });
  });

  // ---- Revision 5 (the independent audit's P2) ---------------------------------------------------------
  // A frozen status of the REMOVED side other than an amount is never masked by what later happens to the
  // amount of the leg that SURVIVED. Before the correction the surviving amount was checked first, the
  // decision then read `amount_changed`, and with no included card the known-effect exception published
  // untracked / no_included_card — although the removed counterpart's invalidity was never resolved.
  const DISQUALIFIERS = ['lineage_ambiguous', 'partner_gone', 'role_changed', 'sides_not_opposite', 'direction_mismatch', 'difference_not_accepted', 'conflicting_decisions'] as const;
  const AMOUNT_ONLY = ['valid', 'waiting_to_post', 'amount_changed'] as const;
  const noCardAccounts = [C, C2, E, F];
  const corrected = tx('c', 'C', '2026-09-01', 9800); // the bank corrects the confirmed +100.00 payment to +98.00

  it.each(DISQUALIFIERS)(
    'P2. frozen %s + the surviving amount corrected in the same direction, no included card → NOT the known-effect exception: reserved, unresolved, the frozen reason kept',
    (status) => {
      const ev = run([corrected], { accounts: noCardAccounts, decisions: [kept(status)] });
      expect(byId(ev).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: status, decisionId: 'k', effectCents: null, lowCents: -9800, highCents: 0, partnerTransactionId: null });
      expect(ev.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'inactive', detail: status }]);
    }
  );

  it.each(AMOUNT_ONLY)('P2. frozen %s + the same correction, no included card → the exception still applies: an amount is the only thing wrong', (status) => {
    const ev = run([corrected], { accounts: noCardAccounts, decisions: [kept(status)] });
    expect(byId(ev).get('c')).toMatchObject({ state: 'untracked', reason: 'no_included_card', effectCents: -9800, lowCents: -9800, highCents: -9800, detail: 'amount_changed', decisionId: 'k', partnerTransactionId: null });
    expect(ev.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'inactive', detail: 'amount_changed' }]);
  });

  it.each(DISQUALIFIERS)('P2. frozen %s: no false recovery, the reservation holds against a competitor, and only the user releases the leg', (status) => {
    const d = kept(status);
    // the bank restores the recorded amount: the frozen reason is still the reason
    expect(byId(run([c], { accounts: noCardAccounts, decisions: [d] })).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: status, effectCents: null });
    // with an included card and a competing leg at the CORRECTED amount: still reserved; the competitor is not paired
    const competing = run([corrected, tx('y', 'Y', '2026-09-02', -9800)], { decisions: [d] });
    expect(byId(competing).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: status, decisionId: 'k', partnerTransactionId: null, effectCents: null });
    expect(byId(competing).get('y')).toMatchObject({ state: 'unresolved', partnerTransactionId: null });
    expect(byId(competing).get('y')!.candidates).toEqual([]);
    // a correction in the OTHER direction: the frozen reason too (it was never the exception)
    expect(byId(run([tx('c', 'C', '2026-09-01', -9800)], { accounts: noCardAccounts, decisions: [d] })).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: status });
    // the user undoes it: the leg is free, and current evidence decides alone, attached to no decision
    const undone = { ...d, supersededBy: 'undone' };
    expect(byId(run([corrected], { accounts: noCardAccounts, decisions: [undone] })).get('c')).toMatchObject({ state: 'untracked', reason: 'no_included_card', effectCents: -9800, detail: null, decisionId: null });
    expect(reasons(run([corrected, tx('y', 'Y', '2026-09-02', -9800)], { decisions: [undone] }))).toEqual({ c: 'tracked/auto_pair', y: 'paired/auto_pair' });
  });

  it('P2. frozen valid: the surviving amount corrected and later restored → the confirmation is active again by itself (genuine recovery)', () => {
    expect(byId(run([corrected], { accounts: noCardAccounts, decisions: [kept('valid')] })).get('c')).toMatchObject({ state: 'untracked', reason: 'no_included_card', detail: 'amount_changed' });
    const restored = run([c], { accounts: noCardAccounts, decisions: [kept('valid')] });
    expect(byId(restored).get('c')).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -10000, detail: null, decisionId: 'k' });
    expect(restored.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'active', detail: null }]);
  });

  it('P2. the mirror: a card leg whose frozen cash side was ambiguous stays reserved and unresolved (0) through an amount correction', () => {
    const ev = run([tx('y', 'Y', '2026-09-02', -9800), tx('c2', 'C2', '2026-09-03', 9800)], { decisions: [kept('lineage_ambiguous', ref('Y', 'p-y', -10000))] });
    expect(byId(ev).get('y')).toMatchObject({ side: 'credit', state: 'unresolved', reason: 'decision_invalidated', detail: 'lineage_ambiguous', effectCents: 0, decisionId: 'k', partnerTransactionId: null });
    expect(byId(ev).get('c2')).toMatchObject({ state: 'unresolved', partnerTransactionId: null, effectCents: null });
    expect(ev.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'inactive', detail: 'lineage_ambiguous' }]);
  });

  it('P2. a surviving row that is no longer a card leg (re-classified, or amount 0): the decision still reports the frozen reason; nothing is published for the row', () => {
    for (const row of [tx('c', 'C', '2026-09-01', 9800, { role: 'expense' }), tx('c', 'C', '2026-09-01', 0)]) {
      const ev = run([row], { accounts: noCardAccounts, decisions: [kept('partner_gone')] });
      expect(ev.legs).toEqual([]);
      expect(ev.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'inactive', detail: 'partner_gone' }]);
    }
  });

  it('P2. the SURVIVING reference\'s own lineage still comes first: waiting, then — once it posts at another amount — the frozen reason, never the exception', () => {
    const onPending = kept('lineage_ambiguous', ref('C', 'pc', 10000));
    const waiting = run([], { accounts: noCardAccounts, decisions: [onPending], carryovers: [{ accountId: 'C', pendingPlaidTransactionId: 'pc', expiresAt: '2026-12-31T00:00:00Z', consumed: false }] });
    expect(waiting.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'inactive', detail: 'waiting_to_post' }]);
    const posted = run([tx('Tc', 'C', '2026-09-02', 9800, { plaid: 'tc', pendingOf: 'pc' })], { accounts: noCardAccounts, decisions: [onPending] });
    expect(byId(posted).get('Tc')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'lineage_ambiguous', decisionId: 'k', effectCents: null });
    // conflicting replacements of the surviving leg keep their own guard, whatever is frozen
    const conflicting = run(
      [tx('T1', 'C', '2026-09-01', 9800, { plaid: 't1', pendingOf: 'pc' }), tx('T2', 'C', '2026-09-10', 9800, { plaid: 't2', pendingOf: 'pc' })],
      { accounts: noCardAccounts, decisions: [kept('partner_gone', ref('C', 'pc', 10000))] }
    );
    for (const id of ['T1', 'T2']) expect(byId(conflicting).get(id)).toMatchObject({ state: 'unresolved', reason: 'ambiguous_replacement', detail: 'lineage_ambiguous', decisionId: 'k', effectCents: null });
    expect(conflicting.decisions).toEqual([{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'inactive', detail: 'lineage_ambiguous' }]);
  });

  it('a surviving reference with no current row: its own lineage alone gives the reason, under every frozen status — ambiguous, else waiting, else gone', () => {
    // Hand-built, and checked against the invariants too, so that I12's restatement for a reference without
    // a current row is checked on each of the three lineage outcomes.
    const T1 = tx('T1', 'C', '2026-09-01', 10000, { plaid: 't1', pendingOf: 'pc' });
    const T2 = tx('T2', 'C', '2026-09-10', 10000, { plaid: 't2', pendingOf: 'pc' });
    const carry = (o: Partial<MatchingCarryover> = {}): MatchingCarryover => ({ accountId: 'C', pendingPlaidTransactionId: 'pc', expiresAt: '2026-12-31T00:00:00Z', consumed: false, ...o });
    const inactive = (detail: string) => [{ decisionId: 'k', kind: 'pair_counterpart_removed', status: 'inactive', detail }];
    for (const status of [...DISQUALIFIERS, ...AMOUNT_ONLY]) {
      const decisionsOf = (transactions: MatchingTransaction[], carryovers: MatchingCarryover[], a: DecisionLegRef = ref('C', 'pc', 10000)) => {
        const input: CardPaymentMatchingInput = { userId: U, asOf: ASOF, accounts: [C, C2, X, Y, E, F], transactions, carryovers, decisions: [kept(status, a)] };
        const ev = evaluateCardPayments(input);
        checkInvariants(input, ev);
        return ev.decisions;
      };
      // gone: no row and no carry-over, or only a carry-over that is expired, consumed or on another account
      expect(decisionsOf([], [])).toEqual(inactive('partner_gone'));
      expect(decisionsOf([], [carry({ expiresAt: '2026-11-14T00:00:00Z' })])).toEqual(inactive('partner_gone'));
      expect(decisionsOf([], [carry({ consumed: true })])).toEqual(inactive('partner_gone'));
      expect(decisionsOf([], [carry({ accountId: 'C2' })])).toEqual(inactive('partner_gone'));
      // waiting: a live carry-over names it
      expect(decisionsOf([], [carry()])).toEqual(inactive('waiting_to_post'));
      // ambiguous: two rows replace it, or it names one of two conflicting replacements — also beside a live carry-over
      expect(decisionsOf([T1, T2], [])).toEqual(inactive('lineage_ambiguous'));
      expect(decisionsOf([T1, T2], [carry()])).toEqual(inactive('lineage_ambiguous'));
      expect(decisionsOf([T1, T2], [], ref('C', 't1', 10000))).toEqual(inactive('lineage_ambiguous'));
    }
  });

  it('a second live user decision on the same leg is a conflict, as for any two user decisions', () => {
    const ev = run([c, y], { decisions: [kept('valid'), mkDecision('p', 'pair', ref('C', 'p-c', 10000), ref('Y', 'p-y', -10000))] });
    expect(byId(ev).get('c')).toMatchObject({ state: 'unresolved', reason: 'decision_invalidated', detail: 'conflicting_decisions' });
    expect(ev.decisions.map((d) => [d.decisionId, d.status, d.detail])).toEqual([['k', 'inactive', 'conflicting_decisions'], ['p', 'inactive', 'conflicting_decisions']]);
  });

  it('on an excluded cash account it is evidence only (not counted); a difference the user accepted does not shrink the effect', () => {
    expect(byId(run([tx('f', 'F', '2026-09-01', 10000)], { decisions: [kept('valid', ref('F', 'p-f', 10000))] })).get('f')).toMatchObject({ state: 'not_counted', reason: 'excluded_account', effectCents: 0 });
    expect(byId(run([tx('c', 'C', '2026-09-01', 8000)], { decisions: [kept('valid', ref('C', 'p-c', 8000), 200)] })).get('c')).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -8000 });
  });

  it('input validation: the removed counterpart is required for this kind and refused for every other', () => {
    const bare = { ...kept('valid'), counterpart: null };
    expect(() => run([c], { decisions: [bare] })).toThrow(/wrong removed-counterpart record/);
    expect(() => run([c], { decisions: [{ ...mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000)), counterpart: kept('valid').counterpart }] })).toThrow(/wrong removed-counterpart record/);
    expect(() => run([c], { decisions: [{ ...kept('valid'), acceptedDifferenceCents: null }] })).toThrow(/must record its accepted difference/);
    expect(() => run([c], { decisions: [{ ...kept('valid'), counterpart: { ...kept('valid').counterpart!, status: 'nonsense' as never } }] })).toThrow(/unknown counterpart status/);
  });
});

describe('APPROVED (Trevor, 2026-10-06): institution removal is not evidence — the system ambiguity hold', () => {
  // What a removal leaves behind for a payment that a removed card and a kept card both fitted: the removed
  // card's leg is gone from the input altogether; a hold names the two legs that are left and the removed
  // leg's date. Expected outcomes below are derived from the approved rule, not from the evaluator.
  const c = tx('c', 'C', '2026-09-10', 10000); // the payment
  const y = tx('y', 'Y', '2026-09-11', -10000); // the kept card's leg, one day later
  // The removed card's leg was dated 09-11 as well: a tie. Card leg first, as a removal writes it.
  const hold = (date = '2026-09-11', kind: 'ambiguity_hold_removed_card' | 'ambiguity_hold_removed_cash_account' = 'ambiguity_hold_removed_card') =>
    mkHold('h', kind, ref('Y', 'p-y', -10000), ref('C', 'p-c', 10000), date);
  const partners = (ev: CardPaymentEvaluation) => Object.fromEntries(ev.legs.map((l) => [l.transactionId, l.partnerTransactionId]));

  it('A. without the hold, deleting the other candidate would pair the two legs that are left', () => {
    expect(reasons(run([c, y]))).toEqual({ c: 'tracked/auto_pair', y: 'paired/auto_pair' });
  });

  it('A. with the hold the pair is withheld: both legs unresolved, each other\'s candidate, no effect, no decision on either', () => {
    const ev = run([c, y], { decisions: [hold()] });
    expect(byId(ev).get('c')).toMatchObject({ state: 'unresolved', reason: 'ambiguous', detail: null, partnerTransactionId: null, decisionId: null, effectCents: null, lowCents: -10000, highCents: 0 });
    expect(byId(ev).get('c')!.candidates).toEqual([{ transactionId: 'y', kind: 'tier1_competitor', distanceDays: 1, differenceCents: 0, contradictsDecision: false }]);
    expect(byId(ev).get('y')).toMatchObject({ state: 'unresolved', reason: 'ambiguous', partnerTransactionId: null, decisionId: null, effectCents: 0, lowCents: 0, highCents: 0 });
    expect(ev.decisions).toEqual([{ decisionId: 'h', kind: 'ambiguity_hold_removed_card', status: 'active', detail: null }]);
  });

  it('it publishes no effect of its own: the period is a range, exactly as for any unresolved payment', () => {
    const s = summarizeCardPaymentPeriod(run([c, y], { decisions: [hold()] }), { start: '2026-09-01', end: '2026-10-01' });
    expect(s).toMatchObject({ lowCents: -10000, highCents: 0, resolved: false, unresolvedCount: 1, byReason: { ambiguous: 1 } });
  });

  it('the removed candidate\'s date decides: at least as close as the partner → withheld; strictly farther → the pair stands', () => {
    // c is 09-10 and y 09-11 (distance 1). Removed candidate on 09-10 (0), 09-11 or 09-09 (1): withheld.
    for (const date of ['2026-09-10', '2026-09-11', '2026-09-09']) expect(partners(run([c, y], { decisions: [hold(date)] }))).toEqual({ c: null, y: null });
    // On 09-12 or 09-08 (2): the kept card was already strictly closer, so the removal changed nothing.
    for (const date of ['2026-09-12', '2026-09-08']) expect(partners(run([c, y], { decisions: [hold(date)] }))).toEqual({ c: 'y', y: 'c' });
  });

  it('C. a later DATE change that brings the partner strictly closer releases the pair; one that does not, does not', () => {
    // The kept card's leg is re-dated to the payment's own day: distance 0 < 1.
    expect(reasons(run([c, tx('y', 'Y', '2026-09-10', -10000)], { decisions: [hold()] }))).toEqual({ c: 'tracked/auto_pair', y: 'paired/auto_pair' });
    // Re-dated farther away (09-13, distance 3 ≥ 1): still withheld.
    expect(partners(run([c, tx('y', 'Y', '2026-09-13', -10000)], { decisions: [hold()] }))).toEqual({ c: null, y: null });
    // The PAYMENT is re-dated to 09-12: the kept card is at 1, the removed candidate (09-11) at 1 → still a tie.
    expect(partners(run([tx('c', 'C', '2026-09-12', 10000), y], { decisions: [hold()] }))).toEqual({ c: null, y: null });
    // …and to 09-13 with the kept card re-dated to 09-13 too: 0 against 2 → released.
    expect(partners(run([tx('c', 'C', '2026-09-13', 10000), tx('y', 'Y', '2026-09-13', -10000)], { decisions: [hold()] }))).toEqual({ c: 'y', y: 'c' });
  });

  it('C. a changed AMOUNT is new evidence: the hold is inactive and the ordinary rules decide alone', () => {
    // Both corrected to 98.00: the removed candidate (100.00) would no longer fit; the two legs pair.
    const both = run([tx('c', 'C', '2026-09-10', 9800), tx('y', 'Y', '2026-09-11', -9800)], { decisions: [hold()] });
    expect(reasons(both)).toEqual({ c: 'tracked/auto_pair', y: 'paired/auto_pair' });
    expect(both.decisions).toEqual([{ decisionId: 'h', kind: 'ambiguity_hold_removed_card', status: 'inactive', detail: 'amount_changed' }]);
    // Only one corrected: they no longer fit each other at all (a near-amount suggestion, never applied).
    expect(reasons(run([tx('c', 'C', '2026-09-10', 9800), y], { decisions: [hold()] }))).toEqual({ c: 'unresolved/amount_differs', y: 'unresolved/amount_differs' });
  });

  it('C. a NEW transaction is evaluated as always: a strictly closer one pairs; an equally close one is a tie of its own', () => {
    const closer = run([c, y, tx('n', 'X', '2026-09-10', -10000)], { decisions: [hold()] });
    expect(partners(closer)).toEqual({ c: 'n', n: 'c', y: null });
    expect(byId(closer).get('c')).toMatchObject({ state: 'tracked', reason: 'auto_pair', effectCents: 0 });
    const tied = run([c, y, tx('n', 'X', '2026-09-11', -10000)], { decisions: [hold()] });
    expect(partners(tied)).toEqual({ c: null, n: null, y: null });
  });

  it('E. relink: the re-imported leg of the removed card ties with the kept card again, as before the removal — and pairs once the kept card no longer fits', () => {
    const x2 = tx('x2', 'X', '2026-09-11', -10000); // the same bank transaction under a new id
    const relinked = run([c, y, x2], { decisions: [hold()] });
    expect(partners(relinked)).toEqual({ c: null, x2: null, y: null });
    expect(byId(relinked).get('c')).toMatchObject({ state: 'unresolved', reason: 'ambiguous' });
    // The kept card's leg is corrected by the bank: only the re-imported leg fits. The hold is about (c, y)
    // only, and inactive besides: it does not stand in the way.
    const after = run([c, tx('y', 'Y', '2026-09-11', -9900), x2], { decisions: [hold()] });
    expect(partners(after)).toEqual({ c: 'x2', x2: 'c', y: null });
    // The same when the kept card's leg is withdrawn altogether.
    expect(partners(run([c, x2], { decisions: [hold()] }))).toEqual({ c: 'x2', x2: 'c' });
  });

  it('D. an explicit user decision wins, whichever it is; the hold neither blocks nor conflicts with it', () => {
    const confirm = run([c, y], { decisions: [hold(), mkDecision('p', 'pair', ref('C', 'p-c', 10000), ref('Y', 'p-y', -10000))] });
    expect(byId(confirm).get('c')).toMatchObject({ state: 'tracked', reason: 'user_pair', effectCents: 0, partnerTransactionId: 'y', decisionId: 'p' });
    expect(confirm.decisions.map((d) => [d.decisionId, d.status, d.detail])).toEqual([['h', 'active', null], ['p', 'active', null]]);
    const unlinked = run([c, y], { decisions: [hold(), mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000))] });
    expect(byId(unlinked).get('c')).toMatchObject({ state: 'untracked', reason: 'user_confirmed_unlinked', effectCents: -10000, decisionId: 'u' });
    const dismissed = run([c, y], { decisions: [hold(), mkDecision('n', 'not_this_pair', ref('C', 'p-c', 10000), ref('Y', 'p-y', -10000), null)] });
    expect(reasons(dismissed)).toEqual({ c: 'unresolved/no_candidate', y: 'unresolved/no_candidate' });
    // A preserved user confirmation on the payment (user strength) decides it, hold or no hold.
    const preserved = run([c, y], { decisions: [hold(), mkPreserved('k', ref('C', 'p-c', 10000), 'valid')] });
    expect(byId(preserved).get('c')).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -10000, decisionId: 'k' });
  });

  it('it is NOT user strength: both legs stay in the pool, and nothing else pairs in the withheld pair\'s place', () => {
    // A second payment, two days after the kept card's leg. That leg's closest candidate is still c.
    const ev = run([c, y, tx('c2', 'C2', '2026-09-13', 10000)], { decisions: [hold()] });
    expect(partners(ev)).toEqual({ c: null, c2: null, y: null });
    // c2 still sees the kept card's leg as a tier-1-shaped candidate (a claimed leg would not be listed).
    expect(byId(ev).get('c2')!.candidates.map((x) => [x.transactionId, x.kind])).toEqual([['y', 'tier1_competitor']]);
    // And it is not the system record of a known destination either: no removed-card effect.
    expect(byId(ev).get('c')!.reason).not.toBe('removed_card');
  });

  it('B. three candidates, one removed: the two that are left tie by themselves — and neither becomes proven when the other drops out', () => {
    const y2 = tx('y2', 'X', '2026-09-11', -10000);
    const holds = [hold(), mkHold('h2', 'ambiguity_hold_removed_card', ref('X', 'p-y2', -10000), ref('C', 'p-c', 10000), '2026-09-11')];
    expect(partners(run([c, y, y2], { decisions: holds }))).toEqual({ c: null, y: null, y2: null });
    expect(partners(run([c, y, y2]))).toEqual({ c: null, y: null, y2: null }); // a tie with or without holds
    // y2 is withdrawn later: without the holds c would pair with y; with them it stays unresolved.
    expect(partners(run([c, y]))).toEqual({ c: 'y', y: 'c' });
    expect(partners(run([c, y], { decisions: holds }))).toEqual({ c: null, y: null });
  });

  it('the mirror: a removed CASH leg competed for the card leg; the kind says whose candidate it was', () => {
    // c 09-10, y 09-12 (distance 2). Removed candidate dated 09-13: one day from the card leg, three from the payment.
    const far = tx('y', 'Y', '2026-09-12', -10000);
    const of = (kind: 'ambiguity_hold_removed_card' | 'ambiguity_hold_removed_cash_account') => mkHold('h', kind, ref('Y', 'p-y', -10000), ref('C', 'p-c', 10000), '2026-09-13');
    // It competed for the CARD leg (1 ≤ 2): withheld. The card leg is unresolved, 0; the payment is NOT read as tracked.
    const mirror = run([c, far], { decisions: [of('ambiguity_hold_removed_cash_account')] });
    expect(byId(mirror).get('y')).toMatchObject({ side: 'credit', state: 'unresolved', reason: 'ambiguous', effectCents: 0, partnerTransactionId: null });
    expect(byId(mirror).get('c')).toMatchObject({ state: 'unresolved', reason: 'ambiguous', effectCents: null, partnerTransactionId: null });
    // Had it competed for the PAYMENT (3 > 2), the kept card would have been strictly closer: the pair stands.
    expect(partners(run([c, far], { decisions: [of('ambiguity_hold_removed_card')] }))).toEqual({ c: 'y', y: 'c' });
  });

  it('the order of the two legs in the record does not matter', () => {
    const reversed = mkHold('h', 'ambiguity_hold_removed_card', ref('C', 'p-c', 10000), ref('Y', 'p-y', -10000), '2026-09-11');
    expect(run([c, y], { decisions: [reversed] })).toEqual(run([c, y], { decisions: [hold()] }));
  });

  it('pending → posted: the same payment with the same amount is not new evidence; a shifted date is judged as any date change', () => {
    const onPending = mkHold('h', 'ambiguity_hold_removed_card', ref('Y', 'p-y', -10000), ref('C', 'pc', 10000), '2026-09-11');
    const samePosted = run([tx('Tc', 'C', '2026-09-10', 10000, { plaid: 'tc', pendingOf: 'pc' }), y], { decisions: [onPending] });
    expect(partners(samePosted)).toEqual({ Tc: null, y: null });
    // Posted on 09-11, the kept card's own day (0), while the removed candidate (09-11) is at 0 too: still a tie.
    expect(partners(run([tx('Tc', 'C', '2026-09-11', 10000, { plaid: 'tc', pendingOf: 'pc' }), y], { decisions: [onPending] }))).toEqual({ Tc: null, y: null });
    // The kept card's leg posts on 09-10 instead, the payment's day (0 against the removed candidate's 1): released.
    const yPosted = tx('Ty', 'Y', '2026-09-10', -10000, { plaid: 'ty', pendingOf: 'p-y' });
    expect(partners(run([c, yPosted], { decisions: [hold()] }))).toEqual({ Ty: 'c', c: 'Ty' });
    // While the payment is only a carry-over there is no leg to hold; the record waits.
    const waiting = run([y], { decisions: [onPending], carryovers: [{ accountId: 'C', pendingPlaidTransactionId: 'pc', expiresAt: '2026-12-31T00:00:00Z', consumed: false }] });
    expect(waiting.decisions).toEqual([{ decisionId: 'h', kind: 'ambiguity_hold_removed_card', status: 'inactive', detail: 'waiting_to_post' }]);
  });

  it('conflicting replacements keep their own guard; the hold is never the decision named on them', () => {
    const ev = run(
      [tx('T1', 'C', '2026-09-10', 10000, { plaid: 't1', pendingOf: 'pc' }), tx('T2', 'C', '2026-09-12', 10000, { plaid: 't2', pendingOf: 'pc' }), y],
      { decisions: [mkHold('h', 'ambiguity_hold_removed_card', ref('Y', 'p-y', -10000), ref('C', 'pc', 10000), '2026-09-11')] }
    );
    for (const id of ['T1', 'T2']) expect(byId(ev).get(id)).toMatchObject({ state: 'unresolved', reason: 'ambiguous_replacement', decisionId: null, partnerTransactionId: null });
    expect(ev.decisions).toEqual([{ decisionId: 'h', kind: 'ambiguity_hold_removed_card', status: 'inactive', detail: 'lineage_ambiguous' }]);
  });

  it('a re-classified or same-side leg makes the hold inactive, and it then does nothing', () => {
    const role = run([c, tx('y', 'Y', '2026-09-11', -10000, { role: 'expense' })], { decisions: [hold()] });
    expect(role.decisions[0]).toMatchObject({ status: 'inactive', detail: 'role_changed' });
    const sameSide = run([c, tx('c9', 'C2', '2026-09-11', -10000)], { decisions: [mkHold('h', 'ambiguity_hold_removed_card', ref('C2', 'p-c9', -10000), ref('C', 'p-c', 10000), '2026-09-11')] });
    expect(sameSide.decisions[0]).toMatchObject({ status: 'inactive', detail: 'sides_not_opposite' });
  });

  it('an earlier removal\'s system record still applies once tier 1 is withheld; the hold adds nothing to it', () => {
    const ev = run([c, y], { decisions: [hold(), mkDecision('r', 'destination_removed_card', ref('C', 'p-c', 10000))] });
    expect(byId(ev).get('c')).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -10000, decisionId: 'r', partnerTransactionId: null });
  });

  it('undone (superseded) holds are ignored', () => {
    expect(reasons(run([c, y], { decisions: [{ ...hold(), supersededBy: 'undone' }] }))).toEqual({ c: 'tracked/auto_pair', y: 'paired/auto_pair' });
  });

  it('F. ownership: another user\'s hold never applies here, and a hold naming someone else\'s account is rejected', () => {
    const others = [C, C2, X, Y, E, F, acct('VC', 'depository', false, V), acct('VY', 'credit', false, V)];
    const foreign = run([c, y], { accounts: others, decisions: [{ ...hold(), userId: V }] });
    expect(reasons(foreign)).toEqual({ c: 'tracked/auto_pair', y: 'paired/auto_pair' });
    expect(foreign.decisions).toEqual([{ decisionId: 'h', kind: 'ambiguity_hold_removed_card', status: 'rejected', detail: 'foreign_user' }]);
    const mixed = run([c, y, tx('vy', 'VY', '2026-09-11', -10000)], { accounts: others, decisions: [mkHold('h', 'ambiguity_hold_removed_card', ref('VY', 'p-vy', -10000), ref('C', 'p-c', 10000), '2026-09-11')] });
    expect(mixed.decisions).toEqual([{ decisionId: 'h', kind: 'ambiguity_hold_removed_card', status: 'rejected', detail: 'foreign_account' }]);
    expect(reasons(mixed)).toEqual({ c: 'tracked/auto_pair', y: 'paired/auto_pair' });
    // The other user's own evaluation is untouched by our hold.
    const theirs = evaluateCardPayments({ userId: V, asOf: ASOF, accounts: others, transactions: [c, y, tx('vc', 'VC', '2026-09-10', 10000), tx('vy', 'VY', '2026-09-11', -10000)], carryovers: [], decisions: [hold()] });
    expect(Object.fromEntries(theirs.legs.map((l) => [l.transactionId, `${l.state}/${l.reason}`]))).toEqual({ vc: 'tracked/auto_pair', vy: 'paired/auto_pair' });
    expect(theirs.decisions).toEqual([]);
  });

  it('input validation: the removed candidate\'s date and the second leg are required for a hold and the date refused for every other kind', () => {
    expect(() => run([c, y], { decisions: [{ ...hold(), counterpartDate: null }] })).toThrow(/wrong removed-candidate date/);
    expect(() => run([c, y], { decisions: [{ ...hold(), counterpartDate: '2026-02-30' }] })).toThrow(/not a calendar date/);
    expect(() => run([c, y], { decisions: [{ ...hold(), b: null }] })).toThrow(/wrong number of legs/);
    expect(() => run([c, y], { decisions: [{ ...mkDecision('p', 'pair', ref('C', 'p-c', 10000), ref('Y', 'p-y', -10000)), counterpartDate: '2026-09-11' }] })).toThrow(/wrong removed-candidate date/);
    expect(() => run([c, y], { decisions: [{ ...hold(), acceptedDifferenceCents: 0 }] })).toThrow(/cannot carry an accepted difference/);
  });
});

describe('institution removal writes one system row per source (20261008120000): several identical holds on a pair, several records on a leg', () => {
  // Institution removal no longer merges what it writes. Two removed candidates with one date, or a second
  // removal, leave identical ambiguity holds on one pair; a card that is removed, linked again and removed
  // again leaves two records on one payment. The evaluator is not changed. These tests pin the two readings
  // that migration relies on: N identical live holds withhold exactly as one, and several live records on a
  // leg read as one record, the leg naming the LEAST decision id.
  // The scenarios and their hand-derived outcomes are SEVERAL_ROW_SCENARIOS (testUtils/cardPaymentHistories.ts);
  // the SQL harness runs the same definitions against the SQL evaluator (supabase/tests/card_payment_evaluator).
  // "Ended" is a row whose supersededBy is set. Nothing ends a system row yet: the evaluator has always
  // ignored a superseded decision, and that is all these tests use.

  // An evaluation as SEVERAL_ROW_SCENARIOS writes one: a line per leg and a line per decision.
  const written = (ev: CardPaymentEvaluation) => ({
    legs: Object.fromEntries(
      ev.legs.map((l) => [
        l.transactionId,
        `${l.state}/${l.reason}/${l.effectCents}` +
          (l.detail === null ? '' : ` detail=${l.detail}`) +
          (l.partnerTransactionId === null ? '' : ` partner=${l.partnerTransactionId}`) +
          (l.decisionId === null ? '' : ` decision=${l.decisionId}`) +
          (l.lowCents === l.effectCents && l.highCents === l.effectCents ? '' : ` range=${l.lowCents}..${l.highCents}`) +
          (l.candidates.length === 0 ? '' : ` cands=${l.candidates.map((c) => `${c.transactionId}:${c.kind}`).sort().join(',')}`),
      ])
    ),
    decisions: Object.fromEntries(ev.decisions.map((d) => [d.decisionId, `${d.status}${d.detail === null ? '' : `/${d.detail}`}`])),
  });
  const inputOf = (name: string, userId = U): CardPaymentMatchingInput => {
    const s = SEVERAL_ROW_SCENARIOS[name];
    return { userId, asOf: ASOF, accounts: s.accounts, transactions: s.transactions, carryovers: s.carryovers ?? [], decisions: s.decisions };
  };
  const orders = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  const end = (d: MatchingDecision): MatchingDecision => ({ ...d, supersededBy: 'ended' });

  it.each(Object.keys(SEVERAL_ROW_SCENARIOS))('%s: each user reads what was derived by hand, in whatever order the decisions are listed', (name) => {
    const scenario = SEVERAL_ROW_SCENARIOS[name];
    // The SQL harness numbers decisions in the order listed; listed ascending, "the least id" is the same decision there.
    const ids = scenario.decisions.map((d) => d.id);
    expect(ids).toEqual([...ids].sort());
    for (const userId of [U, V]) {
      const input = inputOf(name, userId);
      const ev = evaluateCardPayments(input);
      expect(written(ev)).toEqual(scenario.expect[userId] ?? { legs: {}, decisions: {} });
      checkInvariants(input, ev);
      for (const decisions of orders(scenario.decisions)) expect(evaluateCardPayments({ ...input, decisions })).toEqual(ev);
    }
  });

  it('N identical live holds withhold exactly as one: any number of them, whichever is left, whichever is ended', () => {
    // What the two legs read once nothing withholds their pair (S101's record is then outranked by tier 1).
    const released: Record<string, Record<string, string>> = {
      'S101-three-identical-holds-and-a-record': { b: 'paired/auto_pair', k: 'tracked/auto_pair' },
      'S102-two-identical-holds-withhold-as-one': { c: 'tracked/auto_pair', y: 'paired/auto_pair' },
    };
    for (const name of Object.keys(released)) {
      const input = inputOf(name);
      const isHold = (d: MatchingDecision) => d.kind === 'ambiguity_hold_removed_card';
      const holds = input.decisions.filter(isHold);
      const rest = input.decisions.filter((d) => !isHold(d));
      const legsWith = (decisions: MatchingDecision[]) => evaluateCardPayments({ ...input, decisions }).legs;
      const all = legsWith(input.decisions);
      // Every way of ending some of them or of never having had them: while one is live the legs read the same.
      for (let live = 1; live < 2 ** holds.length; live++) {
        const isLive = (i: number) => ((live >> i) & 1) === 1;
        expect(legsWith([...rest, ...holds.filter((_, i) => isLive(i))])).toEqual(all);
        expect(legsWith([...rest, ...holds.map((h, i) => (isLive(i) ? h : end(h)))])).toEqual(all);
      }
      // Ten more copies change nothing.
      expect(legsWith([...input.decisions, ...Array.from({ length: 10 }, (_, i) => ({ ...holds[0], id: `more-${i}` }))])).toEqual(all);
      // With none, or with every one ended, the pair forms: it was the holds that withheld it.
      expect(reasons(evaluateCardPayments({ ...input, decisions: rest }))).toEqual(released[name]);
      expect(reasons(evaluateCardPayments({ ...input, decisions: [...rest, ...holds.map(end)] }))).toEqual(released[name]);
    }
  });

  it('several live records on one leg read as one record, and the leg names the least id — of the live and valid ones, in any order', () => {
    const base = inputOf('S98-two-live-records-on-one-leg-read-as-one');
    const [r1] = base.decisions;
    const read = (decisions: MatchingDecision[]) => byId(evaluateCardPayments({ ...base, decisions })).get('c')!;
    const one = read([r1]);
    expect(one).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -10000, lowCents: -10000, highCents: -10000, detail: null, decisionId: 'r1', partnerTransactionId: null, candidates: [] });
    // Two, three or twelve records: the leg reads exactly what it reads with one.
    for (const n of [2, 3, 12]) {
      const copies = Array.from({ length: n }, (_, i) => ({ ...r1, id: `r${String(i + 1).padStart(2, '0')}` }));
      for (const decisions of [copies, [...copies].reverse()]) expect(read(decisions)).toEqual({ ...one, decisionId: 'r01' });
    }
    // The least LIVE one: with the lesser ones ended the leg names the next, and reads the same.
    const three = ['ra', 'rb', 'rc'].map((id) => ({ ...r1, id }));
    for (const order of orders(three)) {
      expect(read(order)).toEqual({ ...one, decisionId: 'ra' });
      expect(read(order.map((d) => (d.id === 'ra' ? end(d) : d)))).toEqual({ ...one, decisionId: 'rb' });
      expect(read(order.map((d) => (d.id === 'rc' ? d : end(d))))).toEqual({ ...one, decisionId: 'rc' });
    }
    // The least VALID one: a record at other cents is no copy. It is inactive, and never the one named.
    const stale = { ...r1, id: 'r0', a: { ...r1.a, cents: 9900 } };
    for (const decisions of [[stale, r1], [r1, stale]]) {
      expect(read(decisions)).toEqual(one);
      expect(evaluateCardPayments({ ...base, decisions }).decisions).toEqual([
        { decisionId: 'r0', kind: 'destination_removed_card', status: 'inactive', detail: 'amount_changed' },
        { decisionId: 'r1', kind: 'destination_removed_card', status: 'active', detail: null },
      ]);
    }
    // Ids are ordered as the database orders uuids — byte by byte, which for their lowercase text is
    // character by character: a digit before a letter.
    const uuids = ['a0000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-000000000003', '9fffffff-ffff-4fff-8fff-ffffffffffff'];
    for (const order of orders(uuids)) expect(read(order.map((id) => ({ ...r1, id })))).toEqual({ ...one, decisionId: '0b000000-0000-4000-8000-000000000003' });
  });
});

// ---- Generated histories and invariants -----------------------------------------------------------


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
      if (leg.reason === 'removed_card') {
        expect(decisions.get(leg.decisionId!)!.status).toBe('active');
        expect(['destination_removed_card', 'pair_counterpart_removed']).toContain(decisions.get(leg.decisionId!)!.kind);
      }
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
    if (d.userId !== input.userId || d.supersededBy !== null || !(d.kind === 'pair' || d.kind === 'destination_unlinked' || d.kind === 'pair_counterpart_removed')) continue;
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
    expect(['destination_unlinked', 'pair_counterpart_removed']).toContain(d.kind);
    expect(leg.side).toBe('cash');
    expect(Math.sign(leg.amountCents)).toBe(Math.sign(d.a.cents));
    // What changed is the surviving leg's amount or — for a preserved pair only — the removed side's.
    if (d.kind === 'destination_unlinked' || d.counterpart!.status !== 'amount_changed') expect(leg.amountCents).not.toBe(d.a.cents);
    expect(decisions.get(d.id)).toMatchObject({ status: 'inactive', detail: 'amount_changed' });
    // Revision 5 (the audit's P2), restated from the INPUT, not from the reported detail: for a preserved
    // pair an amount must be the ONLY thing wrong. Whatever the surviving leg's amount did, the frozen status
    // of the removed side is one that an amount explains — never lineage_ambiguous, partner_gone,
    // role_changed, a relational reason or conflicting_decisions.
    if (d.kind === 'pair_counterpart_removed') expect(['valid', 'waiting_to_post', 'amount_changed']).toContain(d.counterpart!.status);
  }
  // I9 (Codex review): a candidate contradicts a decision exactly when its leg has an active user
  // decision; everywhere else candidates are ordinary suggestions.
  for (const leg of ev.legs) {
    const activeUserDecision =
      leg.decisionId !== null &&
      decisions.get(leg.decisionId)?.status === 'active' &&
      ['pair', 'destination_unlinked', 'pair_counterpart_removed'].includes(decisions.get(leg.decisionId)!.kind);
    for (const c of leg.candidates) expect(c.contradictsDecision).toBe(activeUserDecision);
  }
  // The one current, unconflicted row a decision leg reference resolves to by lineage, if it has one (§3.6).
  const currentRow = (r: DecisionLegRef): MatchingTransaction | undefined => {
    const replacements = own.filter((t) => t.accountId === r.accountId && t.pendingTransactionId === r.plaidTransactionId);
    if (replacements.length > 1) return undefined;
    const row = replacements.length === 1 ? replacements[0] : own.find((t) => t.accountId === r.accountId && t.plaidTransactionId === r.plaidTransactionId);
    return row === undefined || conflicting.has(row.id) ? undefined : row;
  };
  // I12 (Trevor, 2026-10-06): a preserved pair is a USER decision on the leg that survived. Restated here
  // from the input alone. Its frozen counterpart status decides whether it can be active; a leg it holds has
  // no partner and is nobody's partner or candidate; active → the removed-destination effect on the cash
  // side and "funded from outside" (0) on the credit side; inactive → reserved and unresolved, except the
  // known-effect exception (I11).
  const claimable = (d: MatchingDecision) =>
    d.userId === input.userId && d.supersededBy === null && (d.kind === 'pair' || d.kind === 'destination_unlinked' || d.kind === 'pair_counterpart_removed');
  for (const d of input.decisions) {
    if (d.kind !== 'pair_counterpart_removed' || d.userId !== input.userId) continue;
    const result = decisions.get(d.id)!;
    expect(result.kind).toBe('pair_counterpart_removed');
    if (accounts.get(d.a.accountId)?.userId !== input.userId) {
      expect(result).toMatchObject({ status: 'rejected', detail: 'foreign_account' });
      continue;
    }
    if (d.supersededBy !== null) {
      expect(result.status).toBe('superseded');
      continue;
    }
    const frozenInvalid = !['valid', 'waiting_to_post'].includes(d.counterpart!.status);
    if (result.status === 'active') expect(frozenInvalid).toBe(false);
    if (frozenInvalid) expect(result.status).toBe('inactive');
    // Revision 5 (the audit's P2): the decision's result, restated IN FULL from the input, in the order of
    // the rule. The surviving reference's own lineage first. Then a second live user decision on the same
    // leg (a conflict). Then a frozen status other than an amount — WHATEVER the surviving row's amount or
    // role is now: a correction of the leg that survived never stands in its place. Then the surviving row's
    // amount, then its role; then a frozen amount change of the removed side; otherwise it is active.
    const frozenDisqualifier = frozenInvalid && d.counterpart!.status !== 'amount_changed';
    const survivingRow = currentRow(d.a);
    if (survivingRow === undefined) {
      // No current row: the lineage alone gives the reason. Rows that name the reference make it ambiguous
      // (a single replacement, or an unconflicted row of its own, would have been the current row); with
      // none, it is waiting while a live carry-over names it, and gone otherwise.
      const named = own.filter((t) => t.accountId === d.a.accountId && (t.pendingTransactionId === d.a.plaidTransactionId || t.plaidTransactionId === d.a.plaidTransactionId));
      const waitingNow = input.carryovers.some(
        (c) => c.accountId === d.a.accountId && c.pendingPlaidTransactionId === d.a.plaidTransactionId && !c.consumed && Date.parse(c.expiresAt) > Date.parse(input.asOf)
      );
      expect(result).toMatchObject({ status: 'inactive', detail: named.length > 0 ? 'lineage_ambiguous' : waitingNow ? 'waiting_to_post' : 'partner_gone' });
    } else {
      const isLeg = legs.has(survivingRow.id);
      const rivals = input.decisions.filter((x) => {
        if (x.id === d.id || !claimable(x)) return false;
        const refs = x.b === null ? [x.a] : [x.a, x.b];
        return refs.every((r) => accounts.get(r.accountId)?.userId === input.userId) && refs.some((r) => currentRow(r)?.id === survivingRow.id);
      });
      const expected =
        isLeg && rivals.length > 0
          ? 'conflicting_decisions'
          : frozenDisqualifier
            ? d.counterpart!.status
            : survivingRow.amountCents !== d.a.cents
              ? 'amount_changed'
              : !isLeg
                ? 'role_changed'
                : d.counterpart!.status === 'amount_changed'
                  ? 'amount_changed'
                  : null;
      expect(result).toMatchObject({ status: expected === null ? 'active' : 'inactive', detail: expected });
    }
    for (const leg of ev.legs) {
      if (leg.decisionId !== d.id || leg.reason === 'ambiguous_replacement') continue;
      // the leg is held by this decision
      expect(leg.partnerTransactionId).toBeNull();
      for (const other of ev.legs) {
        expect(other.partnerTransactionId).not.toBe(leg.transactionId);
        expect(other.candidates.map((c) => c.transactionId)).not.toContain(leg.transactionId);
      }
      if (!leg.accountIncluded) {
        expect(leg.state).toBe('not_counted');
      } else if (result.status === 'active') {
        if (leg.side === 'cash') expect(leg).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -leg.amountCents, detail: null });
        else expect(leg).toMatchObject({ state: 'funded_from_excluded', reason: 'removed_cash_account', effectCents: 0, detail: null });
      } else if (leg.state !== 'unresolved') {
        expect(leg).toMatchObject({ state: 'untracked', reason: 'no_included_card', detail: 'amount_changed' }); // I11
        expect(frozenDisqualifier).toBe(false); // …and never while the removed side had another disqualifier (P2)
      } else {
        expect(leg).toMatchObject({ reason: 'decision_invalidated', detail: result.detail });
      }
    }
  }
  // …and the credit-side "funded from a removed cash account" label comes from nothing else.
  for (const leg of ev.legs) {
    if (leg.reason !== 'removed_cash_account') continue;
    expect(leg).toMatchObject({ side: 'credit', state: 'funded_from_excluded', effectCents: 0, partnerTransactionId: null });
    expect(decisions.get(leg.decisionId!)).toMatchObject({ kind: 'pair_counterpart_removed', status: 'active' });
  }
  // A row claimed by more than one live user decision (of any user kind) makes each of them conflicting.
  const claimsPerRow = new Map<string, number>();
  for (const d of input.decisions) {
    if (!claimable(d)) continue;
    const refs = d.b === null ? [d.a] : [d.a, d.b];
    if (!refs.every((r) => accounts.get(r.accountId)?.userId === input.userId)) continue;
    const rowIds = new Set<string>();
    for (const r of refs) {
      const replacements = own.filter((t) => t.accountId === r.accountId && t.pendingTransactionId === r.plaidTransactionId);
      const row = replacements.length === 1 ? replacements[0] : replacements.length === 0 ? own.find((t) => t.accountId === r.accountId && t.plaidTransactionId === r.plaidTransactionId) : undefined;
      if (row !== undefined && legs.has(row.id) && !conflicting.has(row.id)) rowIds.add(row.id);
    }
    for (const id of rowIds) claimsPerRow.set(id, (claimsPerRow.get(id) ?? 0) + 1);
  }
  for (const [rowId, n] of claimsPerRow) {
    const leg = legs.get(rowId)!;
    expect(leg.decisionId).not.toBeNull();
    if (n > 1) expect(decisions.get(leg.decisionId!)).toMatchObject({ status: 'inactive', detail: 'conflicting_decisions' });
  }

  // I13 (Trevor, 2026-10-06): an ambiguity hold is a system record on ONE possible pair. Restated from the
  // input: which holds apply, and which automatic pairs they withhold. Then compared with the same input
  // WITHOUT its holds: the only thing a hold may do is make such a pair absent. It forms no pair, claims no
  // leg, is no leg's decision, and never changes the state, the effect or the partner of any other leg.
  const isHold = (d: MatchingDecision) => d.kind === 'ambiguity_hold_removed_card' || d.kind === 'ambiguity_hold_removed_cash_account';
  const dayOf = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const txnById = new Map(own.map((t) => [t.id, t]));
  const without = evaluateCardPayments({ ...input, decisions: input.decisions.filter((d) => !isHold(d)) });
  const legsWithout = new Map(without.legs.map((l) => [l.transactionId, l]));
  const withheld = new Set<string>();
  for (const d of input.decisions) {
    if (!isHold(d) || d.userId !== input.userId) continue;
    const result = decisions.get(d.id)!;
    expect(result.kind).toBe(d.kind);
    for (const leg of ev.legs) expect(leg.decisionId).not.toBe(d.id);
    if (![d.a, d.b!].every((r) => accounts.get(r.accountId)?.userId === input.userId)) {
      expect(result).toMatchObject({ status: 'rejected', detail: 'foreign_account' });
      continue;
    }
    if (d.supersededBy !== null) {
      expect(result.status).toBe('superseded');
      continue;
    }
    const ra = currentRow(d.a);
    const rb = currentRow(d.b!);
    const applies =
      ra !== undefined && rb !== undefined && ra.amountCents === d.a.cents && rb.amountCents === d.b!.cents &&
      legs.has(ra.id) && legs.has(rb.id) && legs.get(ra.id)!.side !== legs.get(rb.id)!.side;
    expect(result.status).toBe(applies ? 'active' : 'inactive');
    if (!applies) continue;
    const ownerSide = d.kind === 'ambiguity_hold_removed_card' ? 'cash' : 'credit';
    const owner = legs.get(ra!.id)!.side === ownerSide ? ra! : rb!;
    const other = owner === ra ? rb! : ra!;
    const removedAtLeastAsClose = Math.abs(dayOf(d.counterpartDate!) - dayOf(owner.date)) <= Math.abs(dayOf(owner.date) - dayOf(other.date));
    // "would pair automatically" is read from the evaluation without holds: a partner and no decision.
    const before = legsWithout.get(owner.id)!;
    if (removedAtLeastAsClose && before.partnerTransactionId === other.id && before.decisionId === null) {
      withheld.add(owner.id);
      withheld.add(other.id);
    }
  }
  expect(without.legs.map((l) => l.transactionId)).toEqual(ev.legs.map((l) => l.transactionId));
  for (const leg of ev.legs) {
    const before = legsWithout.get(leg.transactionId)!;
    if (withheld.has(leg.transactionId)) {
      // The pair is absent; what the leg then reads is what the rules below tier 1 say, never a hold's own
      // effect: unresolved (a cash leg with its range), or an existing lower rule (an earlier system record,
      // no included card), or not counted.
      expect(before.reason === 'auto_pair' || before.reason === 'partner_excluded' || before.reason === 'excluded_account').toBe(true);
      expect(leg.partnerTransactionId).toBeNull();
      expect(['auto_pair', 'user_pair', 'partner_excluded']).not.toContain(leg.reason);
      if (leg.state === 'unresolved') expect(leg.reason).toBe('ambiguous');
      else if (leg.state === 'untracked') expect(['removed_card', 'no_included_card']).toContain(leg.reason);
      else expect(leg.state).toBe('not_counted');
      const partnerBefore = txnById.get(before.partnerTransactionId!)!;
      if (leg.state === 'unresolved') expect(leg.candidates.map((c) => c.transactionId)).toContain(partnerBefore.id);
    } else {
      // Every other leg: the same state, effect, bounds, partner and decision as without any hold.
      expect([leg.state, leg.effectCents, leg.lowCents, leg.highCents, leg.partnerTransactionId, leg.decisionId, leg.detail])
        .toEqual([before.state, before.effectCents, before.lowCents, before.highCents, before.partnerTransactionId, before.decisionId, before.detail]);
    }
  }
  // …and the decisions that are not holds come out exactly as they do without holds.
  expect(ev.decisions.filter((d) => !isHold(d as unknown as MatchingDecision))).toEqual(without.decisions);

  // I14 (20261008120000): institution removal writes one destination_removed_card record per removed partner,
  // so a leg can have several live records. Restated from the input. A live record is active exactly when its
  // reference resolves to a current cash-side card leg at the recorded cents, whatever else is recorded on
  // that leg. And a leg that no user decision claims, no conflicting replacement holds and tier 1 does not
  // pair reads its records as ONE: untracked / removed_card (not counted on an excluded account), naming the
  // LEAST id among the active ones — never an ended one, never an invalid one.
  const recordsOn = new Map<string, string[]>();
  for (const d of input.decisions) {
    if (d.kind !== 'destination_removed_card' || d.userId !== input.userId) continue;
    const result = decisions.get(d.id)!;
    expect(result.kind).toBe('destination_removed_card');
    if (accounts.get(d.a.accountId)?.userId !== input.userId) {
      expect(result).toMatchObject({ status: 'rejected', detail: 'foreign_account' });
      continue;
    }
    if (d.supersededBy !== null) {
      expect(result.status).toBe('superseded');
      continue;
    }
    const row = currentRow(d.a);
    const applies = row !== undefined && row.amountCents === d.a.cents && legs.get(row.id)?.side === 'cash';
    expect(result.status).toBe(applies ? 'active' : 'inactive');
    if (applies) recordsOn.set(row.id, [...(recordsOn.get(row.id) ?? []), d.id]);
  }
  for (const leg of ev.legs) {
    if (conflicting.has(leg.transactionId)) continue;
    const least = [...(recordsOn.get(leg.transactionId) ?? [])].sort()[0];
    const namesRecord = leg.decisionId !== null && decisions.get(leg.decisionId)!.kind === 'destination_removed_card';
    if (namesRecord) expect(leg.decisionId).toBe(least);
    if (least === undefined || leg.partnerTransactionId !== null || !(leg.decisionId === null || namesRecord)) continue;
    expect(leg.decisionId).toBe(least);
    if (leg.accountIncluded) expect(leg).toMatchObject({ state: 'untracked', reason: 'removed_card', effectCents: -leg.amountCents, detail: null, candidates: [] });
    else expect(leg.state).toBe('not_counted');
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
  it('every evaluation satisfies the approved rules (I1–I14)', () => {
    for (const seed of SEEDS) {
      const { input } = generate(seed);
      for (const userId of [U, V]) {
        const full = { ...input, userId };
        checkInvariants(full, evaluateCardPayments(full));
      }
    }
  });

  it('system rows that differ only in their id read as one: ending all but one of them changes nothing a reader is shown', () => {
    // 20261008120000: a removal writes one hold and one record per source, so identical rows are routine.
    // For every user that has live holds or live records identical in every field the evaluator reads but
    // the id: end all of them but one — the least id, then the greatest — and evaluate again. Every leg reads
    // the same; a leg that named a record names one that is still live; the ended rows are reported
    // superseded and no other decision changes. Ending one never ends another.
    const isSystemRow = (d: MatchingDecision) => d.kind === 'destination_removed_card' || d.kind.startsWith('ambiguity_hold_');
    let checked = 0;
    for (const seed of SEEDS) {
      const { input } = generate(seed);
      for (const userId of [U, V]) {
        const groups = new Map<string, string[]>();
        for (const d of input.decisions) {
          if (d.userId !== userId || d.supersededBy !== null || !isSystemRow(d)) continue;
          const key = JSON.stringify([d.kind, d.a, d.b, d.counterpartDate ?? null]);
          groups.set(key, [...(groups.get(key) ?? []), d.id]);
        }
        const several = [...groups.values()].filter((g) => g.length > 1).map((g) => [...g].sort());
        if (several.length === 0) continue;
        checked += 1;
        const full = { ...input, userId };
        const ev = evaluateCardPayments(full);
        const kindOf = new Map(ev.decisions.map((d) => [d.decisionId, d.kind]));
        // Which record a leg names is not compared: it is the least one left (I14).
        const namedRecord = new Set(ev.legs.filter((l) => l.decisionId !== null && kindOf.get(l.decisionId) === 'destination_removed_card').map((l) => l.transactionId));
        const unnamed = (legs: CardLegResult[]) => legs.map((l) => (namedRecord.has(l.transactionId) ? { ...l, decisionId: null } : l));
        for (const kept of [several.map((g) => g[0]), several.map((g) => g[g.length - 1])]) {
          const ended = new Set(several.flat().filter((id) => !kept.includes(id)));
          const one = evaluateCardPayments({ ...full, decisions: full.decisions.map((d) => (ended.has(d.id) ? { ...d, supersededBy: 'ended' } : d)) });
          expect(unnamed(one.legs)).toEqual(unnamed(ev.legs));
          for (const l of one.legs) expect(l.decisionId !== null && ended.has(l.decisionId)).toBe(false);
          expect(one.decisions).toEqual(ev.decisions.map((d) => (ended.has(d.decisionId) ? { ...d, status: 'superseded', detail: null } : d)));
        }
      }
    }
    // Not vacuous: the generator makes such rows for a good part of the users.
    expect(checked).toBeGreaterThan(100);
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
      const ev = evaluateCardPayments({ ...input, userId: U });
      const kindOf = new Map(ev.decisions.map((d) => [d.decisionId, d]));
      for (const leg of ev.legs) {
        const d = leg.decisionId === null ? undefined : kindOf.get(leg.decisionId);
        if (d?.kind !== 'pair_counterpart_removed') continue;
        seen.add(`preserved:${leg.side}:${d.status}:${leg.state}/${leg.reason}`);
        if (d.status === 'inactive') seen.add(`preserved-inactive:${d.detail}`);
        // Revision 5 (P2): the shape of the known-effect exception — an included cash leg of a user with no
        // included card whose amount the bank corrected in the same direction — under each kind of frozen status.
        const preserved = input.decisions.find((x) => x.id === d.decisionId)!;
        const noIncludedCard = !input.accounts.some((x) => x.userId === U && x.type === 'credit' && !x.excludeFromCashFlow);
        // (A row of a conflicting replacement group names the decision too, and keeps its own guard: not this case.)
        if (leg.reason !== 'ambiguous_replacement' && leg.side === 'cash' && leg.accountIncluded && noIncludedCard && leg.amountCents !== preserved.a.cents && Math.sign(leg.amountCents) === Math.sign(preserved.a.cents)) {
          const amountOnly = ['valid', 'waiting_to_post', 'amount_changed'].includes(preserved.counterpart!.status);
          seen.add(`preserved-corrected:${amountOnly ? 'amount-only' : 'frozen-disqualifier'}:${leg.state}/${leg.reason}`);
          if (!amountOnly && d.detail === preserved.counterpart!.status) seen.add('preserved-corrected:the-frozen-reason-is-reported');
        }
        if (leg.candidates.some((c) => c.contradictsDecision)) seen.add('preserved:contradiction');
      }
      // Ambiguity holds: withholding a pair (seen by comparing with the same input without holds), applying
      // to a pair that stands because the partner is strictly closer, and inactive.
      const isHoldKind = (kind: string) => kind.startsWith('ambiguity_hold_');
      const noHolds = evaluateCardPayments({ ...input, userId: U, decisions: input.decisions.filter((d) => !isHoldKind(d.kind)) });
      const partnerWithout = new Map(noHolds.legs.map((l) => [l.transactionId, l.partnerTransactionId]));
      for (const leg of ev.legs) {
        if (partnerWithout.get(leg.transactionId) != null && leg.partnerTransactionId === null) seen.add(`hold:withheld:${leg.side}:${leg.state}/${leg.reason}`);
      }
      const partnerNow = new Map(ev.legs.map((l) => [l.transactionId, l.partnerTransactionId]));
      for (const d of input.decisions) {
        if (!isHoldKind(d.kind) || d.userId !== U) continue;
        const result = kindOf.get(d.id)!;
        seen.add(`hold:${d.kind}:${result.status}${result.detail === null ? '' : `:${result.detail}`}`);
        if (result.status !== 'active') continue;
        const rowOf = (r: DecisionLegRef) => input.transactions.find((t) => t.accountId === r.accountId && (t.pendingTransactionId === r.plaidTransactionId || t.plaidTransactionId === r.plaidTransactionId && !input.transactions.some((o) => o.accountId === t.accountId && o.pendingTransactionId === t.plaidTransactionId)));
        const [ra, rb] = [rowOf(d.a), rowOf(d.b!)];
        if (ra !== undefined && rb !== undefined && partnerNow.get(ra.id) === rb.id) seen.add('hold:the-pair-stands');
        // The same hold more than once (20261008120000: one hold per removed candidate), live and withholding.
        const copies = input.decisions.filter((x) => x.kind === d.kind && x.userId === U && x.supersededBy === null && JSON.stringify([x.a, x.b, x.counterpartDate]) === JSON.stringify([d.a, d.b, d.counterpartDate]));
        if (copies.length > 1 && ra !== undefined && rb !== undefined && partnerWithout.get(ra.id) === rb.id && partnerNow.get(ra.id) === null) seen.add('holds:identical:withholding');
      }
      // Several live records on one leg (20261008120000: one record per removed partner): read as one, by
      // themselves or because a hold withholds the pair; dormant behind a tier 1 pair or under a user
      // decision; with the lesser one ended; and listed with the least id NOT first, so that an evaluator
      // that kept the first one it met would show.
      const txnOf = new Map(input.transactions.map((t) => [t.id, t]));
      const recordsOf = (t: MatchingTransaction, how: (r: DecisionLegRef) => boolean) =>
        input.decisions.filter((x) => x.kind === 'destination_removed_card' && x.userId === U && x.a.accountId === t.accountId && how(x.a));
      for (const leg of ev.legs) {
        const t = txnOf.get(leg.transactionId)!;
        const named = leg.decisionId === null ? undefined : kindOf.get(leg.decisionId);
        if (leg.reason === 'ambiguous_replacement') {
          const namers = recordsOf(t, (r) => r.plaidTransactionId === t.pendingTransactionId || r.plaidTransactionId === t.plaidTransactionId).filter((x) => x.supersededBy === null);
          if (named?.kind === 'destination_removed_card' && namers.length > 1) seen.add('records:several:conflicting-replacements');
          continue;
        }
        const onLeg = recordsOf(t, (r) => r.cents === t.amountCents && (r.plaidTransactionId === t.plaidTransactionId || r.plaidTransactionId === t.pendingTransactionId));
        const live = onLeg.filter((x) => kindOf.get(x.id)!.status === 'active').map((x) => x.id);
        if (live.length === 1 && leg.decisionId === live[0] && onLeg.some((x) => x.supersededBy !== null && x.id < live[0])) seen.add('records:the-lesser-ended:the-greater-named');
        if (live.length < 2) continue;
        if (named?.kind === 'destination_removed_card') {
          seen.add(`records:several:read:${leg.state}/${leg.reason}`);
          if (live[0] !== [...live].sort()[0]) seen.add('records:several:read:the-least-is-not-listed-first');
          if (partnerWithout.get(leg.transactionId) != null) seen.add('records:several:read:behind-a-withheld-pair');
        } else if (named === undefined && leg.partnerTransactionId !== null) seen.add('records:several:dormant:tier1-pair');
        else if (named !== undefined) seen.add(`records:several:dormant:user-decision:${named.status}`);
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
      // the preserved pair (pair_counterpart_removed), on both sides, active and inactive
      'preserved:cash:active:untracked/removed_card',
      'preserved:credit:active:funded_from_excluded/removed_cash_account',
      'preserved:cash:inactive:unresolved/decision_invalidated',
      'preserved:credit:inactive:unresolved/decision_invalidated',
      'preserved-inactive:amount_changed',
      'preserved-inactive:lineage_ambiguous',
      'preserved-inactive:conflicting_decisions',
      'preserved:contradiction',
      // revision 5 (P2): a corrected surviving amount with no included card — the exception when an amount is
      // the only thing wrong, and reserved + unresolved under every other frozen status
      'preserved-corrected:amount-only:untracked/no_included_card',
      'preserved-corrected:frozen-disqualifier:unresolved/decision_invalidated',
      'preserved-corrected:the-frozen-reason-is-reported',
      // the system ambiguity hold: both kinds, withholding on either side, not withholding, inactive
      'hold:withheld:cash:unresolved/ambiguous',
      'hold:withheld:credit:unresolved/ambiguous',
      'hold:the-pair-stands',
      'hold:ambiguity_hold_removed_card:active',
      'hold:ambiguity_hold_removed_cash_account:active',
      'hold:ambiguity_hold_removed_card:inactive:amount_changed',
      'hold:ambiguity_hold_removed_card:inactive:sides_not_opposite',
      'hold:ambiguity_hold_removed_card:superseded',
      // one system row per source (20261008120000): identical holds that withhold; several records on a leg
      'holds:identical:withholding',
      'hold:withheld:cash:untracked/removed_card',
      'records:several:read:untracked/removed_card',
      'records:several:read:not_counted/excluded_account',
      'records:several:read:the-least-is-not-listed-first',
      'records:several:read:behind-a-withheld-pair',
      'records:several:dormant:tier1-pair',
      'records:several:dormant:user-decision:active',
      'records:several:dormant:user-decision:inactive',
      'records:the-lesser-ended:the-greater-named',
      'records:several:conflicting-replacements',
    ]) {
      expect(seen, needed).toContain(needed);
    }
    // …and a frozen disqualifier never comes out as a published effect (the masked case of the audit's P2).
    expect([...seen].filter((x) => x.startsWith('preserved-corrected:frozen-disqualifier:') && !x.endsWith(':unresolved/decision_invalidated'))).toEqual([]);
  });
});
