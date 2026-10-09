// Deterministic card-payment histories for tests — the Stage 2 generator, shared by
// backend/src/services/cardPaymentMatching.adversarial.test.ts (vitest) and the SQL oracle-equivalence
// harness supabase/tests/card_payment_evaluator (which compiles this file with tsc). Test-only: excluded
// from the production build (tsconfig.build.json excludes src/testUtils). Moved verbatim from the
// adversarial test; any change to it changes every generated case.
// 2026-10-06: preserved pairs (pair_counterpart_removed) are ADDED to each generated history from a separate
// random stream, after everything else: the accounts, rows, carry-overs and every other decision of a seed
// are exactly what they were before. System ambiguity holds are added the same way, from a third stream.
// 2026-10-08: removal records in several copies — one key, several ids — are added the same way, from a fifth
// stream. This file also holds the hand-built scenarios for such rows (SEVERAL_ROW_SCENARIOS): both suites run
// that one definition against one hand-derived outcome.
import type {
  CardPaymentMatchingInput,
  CounterpartStatus,
  DecisionLegRef,
  MatchingAccount,
  MatchingCarryover,
  MatchingDecision,
  MatchingTransaction,
} from '../services/cardPaymentMatching';

const ASOF = '2026-11-15T00:00:00Z';

export const U = 'user-a';
export const V = 'user-b';
export const acct = (id: string, type: string | null, excluded = false, userId = U): MatchingAccount => ({
  id,
  userId,
  type,
  excludeFromCashFlow: excluded,
});
export const tx = (
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
export const ref = (accountId: string, plaid: string, cents: number): DecisionLegRef => ({ accountId, plaidTransactionId: plaid, cents });
export const mkDecision = (
  id: string,
  kind: MatchingDecision['kind'],
  a: DecisionLegRef,
  b: DecisionLegRef | null = null,
  accepted: number | null = kind === 'pair' ? 0 : null,
  userId = U
): MatchingDecision => ({ id, userId, kind, a, b, acceptedDifferenceCents: accepted, decidedSeq: 1, supersededBy: null });
/** A user-confirmed pair whose other account was removed: `a` is the surviving leg, `status` what was true of
 *  the removed side when its account was deleted. The removed leg's own reference is history only. */
export const mkPreserved = (
  id: string,
  a: DecisionLegRef,
  status: CounterpartStatus,
  accepted = 0,
  userId = U
): MatchingDecision => ({
  id,
  userId,
  kind: 'pair_counterpart_removed',
  a,
  b: null,
  acceptedDifferenceCents: accepted,
  decidedSeq: 1,
  supersededBy: null,
  counterpart: { plaidTransactionId: `${a.plaidTransactionId}-removed-counterpart`, cents: -a.cents, status },
});
export type HoldKind = 'ambiguity_hold_removed_card' | 'ambiguity_hold_removed_cash_account';
/** A system ambiguity hold on one possible pair of two surviving legs (a removal writes the card leg first),
 *  with the date of the candidate that was removed. `ambiguity_hold_removed_card`: that candidate was a card
 *  leg and competed for the cash leg; `…_removed_cash_account`: a cash leg, competing for the card leg. */
export const mkHold = (
  id: string,
  kind: HoldKind,
  a: DecisionLegRef,
  b: DecisionLegRef,
  counterpartDate: string,
  userId = U
): MatchingDecision => ({ id, userId, kind, a, b, acceptedDifferenceCents: null, decidedSeq: 1, supersededBy: null, counterpartDate });

/** mulberry32 — a small deterministic PRNG, so every generated case is reproducible from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export interface Generated {
  input: Omit<CardPaymentMatchingInput, 'userId'>;
}

/** One user's history: clustered dates across the Sep/Oct boundary, few distinct amounts, lineage. */
export function generateUser(r: () => number, userId: string, prefix: string, withDecisions: boolean) {
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

export function generate(seed: number, withDecisions = true): Generated {
  const r = rng(seed);
  const a = generateUser(r, U, 'a', withDecisions);
  const b = generateUser(r, V, 'b', withDecisions);
  // Occasionally a decision recorded under user B that names user A's rows (must be rejected).
  const foreign: MatchingDecision[] =
    r() < 0.3 && a.transactions.length > 0
      ? [mkDecision('b-foreign', 'destination_unlinked', ref(a.transactions[0].accountId, a.transactions[0].plaidTransactionId, a.transactions[0].amountCents), null, null, V)]
      : [];
  // Preserved pairs, from their OWN stream (nothing above depends on it). About half the seeds get none.
  // They land on any row of the user — cash or credit side, a leg or not, with a clean, waiting or
  // conflicting lineage — at the recorded amount or one cent off, with every frozen status, sometimes undone.
  const preserved: MatchingDecision[] = [];
  if (withDecisions) {
    const pr = rng((seed ^ 0x51ed270b) >>> 0);
    const pickP = <T>(xs: T[]): T => xs[Math.floor(pr() * xs.length)];
    const STATUSES: CounterpartStatus[] = [
      'valid', 'valid', 'valid', 'valid', 'waiting_to_post', 'waiting_to_post', 'amount_changed', 'amount_changed',
      'lineage_ambiguous', 'partner_gone', 'role_changed', 'sides_not_opposite', 'direction_mismatch',
      'difference_not_accepted', 'conflicting_decisions',
    ];
    for (const [userId, user, prefix] of [[U, a, 'a'], [V, b, 'b']] as const) {
      const n = pr() < 0.5 ? 0 : 1 + Math.floor(pr() * 2);
      for (let k = 0; k < n && user.transactions.length > 0; k++) {
        const t = pickP(user.transactions);
        const cents = pr() < 0.85 ? t.amountCents : t.amountCents + 1;
        const plaid = pr() < 0.3 && t.pendingTransactionId ? t.pendingTransactionId : t.plaidTransactionId;
        const decision = mkPreserved(`${prefix}k${k}`, ref(t.accountId, plaid, cents), pickP(STATUSES), pickP([0, 0, 0, 200, -200]), userId);
        preserved.push({ ...decision, decidedSeq: 200 + k, supersededBy: pr() < 0.1 ? 'undone' : null });
      }
    }
  }
  // Ambiguity holds, from their OWN stream too (nothing above depends on it). About half the seeds get none.
  // Mostly on a pair that tier 1 could form (opposite sides, opposite cents, within five days), so that the
  // hold matters; sometimes on any two rows. Either leg order, either kind, a removed-candidate date around
  // the first leg's (so the pair is sometimes withheld and sometimes not), the recorded cents or one cent
  // off, a pending id where there is one, sometimes undone, rarely the same hold twice.
  const holds: MatchingDecision[] = [];
  if (withDecisions) {
    const hr = rng((seed ^ 0x2f6a91c5) >>> 0);
    const pickH = <T>(xs: T[]): T => xs[Math.floor(hr() * xs.length)];
    for (const [userId, user, prefix] of [[U, a, 'a'], [V, b, 'b']] as const) {
      const n = hr() < 0.5 ? 0 : 1 + Math.floor(hr() * 3);
      const isCredit = (t: MatchingTransaction) => user.accounts.find((x) => x.id === t.accountId)!.type === 'credit';
      const days = (t: MatchingTransaction) => Math.round(Date.parse(`${t.date}T00:00:00Z`) / 86400000);
      const shaped: Array<[MatchingTransaction, MatchingTransaction]> = [];
      for (const x of user.transactions) {
        for (const y of user.transactions) {
          if (isCredit(x) && !isCredit(y) && y.amountCents === -x.amountCents && Math.abs(days(x) - days(y)) <= 5) shaped.push([x, y]);
        }
      }
      for (let k = 0; k < n && user.transactions.length > 0; k++) {
        const [x, y] = shaped.length > 0 && hr() < 0.75 ? pickH(shaped) : [pickH(user.transactions), pickH(user.transactions)];
        const [first, second] = hr() < 0.8 ? [x, y] : [y, x];
        const refH = (t: MatchingTransaction): DecisionLegRef =>
          ref(t.accountId, hr() < 0.3 && t.pendingTransactionId ? t.pendingTransactionId : t.plaidTransactionId, hr() < 0.9 ? t.amountCents : t.amountCents + 1);
        const kind = pickH<HoldKind>(['ambiguity_hold_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account']);
        const hold = mkHold(`${prefix}h${k}`, kind, refH(first), refH(second), addDays(first.date, Math.floor(hr() * 13) - 6), userId);
        holds.push({ ...hold, decidedSeq: 300 + k, supersededBy: hr() < 0.1 ? 'undone' : null });
        if (hr() < 0.1) holds.push({ ...hold, id: `${prefix}h${k}x`, decidedSeq: 320 + k });
      }
    }
  }
  // Revision 5 (the independent audit's P2), from a FOURTH stream of its own (nothing above depends on it):
  // sometimes a user with NO included card has a preserved pair on a cash payment whose amount the bank has
  // since corrected in the same direction — exactly the shape of the known-effect exception — with ANY frozen
  // status. The exception may apply only when the frozen status is one an amount explains (valid,
  // waiting_to_post, amount_changed); under every other one the leg must stay reserved and unresolved.
  const corrected: MatchingDecision[] = [];
  if (withDecisions) {
    const cr = rng((seed ^ 0x7c3b5e19) >>> 0);
    const pickC = <T>(xs: T[]): T => xs[Math.floor(cr() * xs.length)];
    const ANY_STATUS: CounterpartStatus[] = [
      'valid', 'waiting_to_post', 'amount_changed', 'lineage_ambiguous', 'partner_gone', 'role_changed',
      'sides_not_opposite', 'direction_mismatch', 'difference_not_accepted', 'conflicting_decisions',
    ];
    for (const [userId, user, prefix] of [[U, a, 'a'], [V, b, 'b']] as const) {
      const skip = cr() < 0.35;
      if (skip || user.accounts.some((x) => x.type === 'credit' && !x.excludeFromCashFlow)) continue;
      const cashLegs = user.transactions.filter((t) => user.accounts.find((x) => x.id === t.accountId)!.type !== 'credit' && Math.abs(t.amountCents) > 300);
      if (cashLegs.length === 0) continue;
      const t = pickC(cashLegs);
      const recorded = t.amountCents + Math.sign(t.amountCents) * pickC([200, 200, 1]);
      corrected.push({ ...mkPreserved(`${prefix}c0`, ref(t.accountId, t.plaidTransactionId, recorded), pickC(ANY_STATUS), 0, userId), decidedSeq: 400 });
    }
  }
  // Removal records in several copies, from a FIFTH stream of its own (nothing above depends on it). An
  // institution removal writes one destination_removed_card record per removed partner and never reuses one
  // (20261008120000): a payment matched to a card that is removed, linked again and removed again has two live
  // records with one key. The evaluator reads no column that tells them apart but the id: they are one record
  // to it, and the leg names the least id. Two shapes:
  //   * a record generated above — on any row, at whatever cents, undone or not — again under a second id,
  //     live, as a hold's second copy is;
  //   * two, rarely three, records of successive removals on one row, identical but for the id: mostly on a
  //     cash-side row that no card row fits within the tier 1 window, or on a cash-side row that a hold above
  //     names (so that the records are what the leg reads), sometimes on any row; the recorded cents or one
  //     cent off, a pending id where there is one. Listed in either order of their ids. Rarely one of them has
  //     been ended since: the others stand.
  const records: MatchingDecision[] = [];
  if (withDecisions) {
    const rr = rng((seed ^ 0x3a61d8f7) >>> 0);
    const pickR = <T>(xs: T[]): T => xs[Math.floor(rr() * xs.length)];
    for (const [userId, user, prefix] of [[U, a, 'a'], [V, b, 'b']] as const) {
      for (const d of user.decisions) {
        if (d.kind === 'destination_removed_card' && rr() < 0.3) records.push({ ...d, id: `${d.id}x`, decidedSeq: 500 + d.decidedSeq, supersededBy: null });
      }
      const isCredit = (t: MatchingTransaction) => user.accounts.find((x) => x.id === t.accountId)!.type === 'credit';
      const days = (t: MatchingTransaction) => Math.round(Date.parse(`${t.date}T00:00:00Z`) / 86400000);
      const names = (r: DecisionLegRef, t: MatchingTransaction) =>
        r.accountId === t.accountId && (r.plaidTransactionId === t.plaidTransactionId || r.plaidTransactionId === t.pendingTransactionId);
      const cashRows = user.transactions.filter((t) => !isCredit(t));
      const unfitted = cashRows.filter((c) => !user.transactions.some((k) => isCredit(k) && k.amountCents === -c.amountCents && Math.abs(days(k) - days(c)) <= 5));
      const held = cashRows.filter((c) => holds.some((h) => h.userId === userId && (names(h.a, c) || names(h.b!, c))));
      const n = rr() < 0.6 ? 0 : rr() < 0.75 ? 1 : 2;
      for (let k = 0; k < n && user.transactions.length > 0; k++) {
        const where = rr();
        const t = where < 0.4 && unfitted.length > 0 ? pickR(unfitted) : where < 0.8 && held.length > 0 ? pickR(held) : pickR(user.transactions);
        const key = ref(t.accountId, rr() < 0.3 && t.pendingTransactionId ? t.pendingTransactionId : t.plaidTransactionId, rr() < 0.9 ? t.amountCents : t.amountCents + 1);
        const copies = rr() < 0.8 ? 2 : 3;
        const ended = rr() < 0.15 ? Math.floor(rr() * copies) : -1;
        const group = Array.from({ length: copies }, (_, j): MatchingDecision => ({
          ...mkDecision(`${prefix}r${k}${'abc'[j]}`, 'destination_removed_card', key, null, null, userId),
          decidedSeq: 520 + 10 * k + j,
          supersededBy: j === ended ? 'undone' : null,
        }));
        records.push(...(rr() < 0.5 ? group : group.reverse()));
      }
    }
  }
  return {
    input: {
      asOf: ASOF,
      accounts: [...a.accounts, ...b.accounts],
      transactions: [...a.transactions, ...b.transactions],
      carryovers: [...a.carryovers, ...b.carryovers],
      decisions: [...a.decisions, ...b.decisions, ...foreign, ...preserved, ...holds, ...corrected, ...records],
    },
  };
}

export function shuffle<T>(xs: T[], r: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---- Hand-built scenarios with hand-derived outcomes, run by both suites -------------------------------

/** A hand-built history and what a person derived from the approved rules that each user must read, written
 *  as the SQL harness writes it (supabase/tests/card_payment_evaluator/export.cjs, "HAND-DERIVED
 *  EXPECTATIONS"). Per user, one line per leg — `<state>/<reason>/<effect>`, then, where there is one and in
 *  this order, ` detail=…`, ` partner=<txn id>`, ` decision=<decision id>`, ` range=<low>..<high>` (omitted
 *  when both bounds equal the effect) and ` cands=<txn id>:<kind>[,…]` (sorted) — and one per decision,
 *  `<status>[/<detail>]`. Nothing is left unstated: the lines are ALL of that user's, and a user who is not
 *  listed has no leg and no decision. */
export interface WrittenScenario {
  accounts: MatchingAccount[];
  transactions: MatchingTransaction[];
  carryovers?: MatchingCarryover[];
  /** In ascending order of their ids: the SQL harness numbers decisions in the order listed, so that "the
   *  least id" is the same decision there and here. */
  decisions: MatchingDecision[];
  /** The SQL harness writes the decisions last first: the row with the least id is then the newest one. */
  insertDecisionsLastFirst?: boolean;
  expect: Record<string, { legs: Record<string, string>; decisions: Record<string, string> }>;
}

/** What an institution removal leaves since it writes one system row per source (20261008120000): several
 *  identical ambiguity holds on one pair, and several destination_removed_card records on one leg. Both
 *  evaluators must read N identical live holds exactly as one hold, and several live records on a leg as one
 *  record, the leg naming the LEAST decision id. Each outcome was derived from the rules before either
 *  evaluator ran it, and both run this one definition: the vitest suite
 *  (cardPaymentMatching.adversarial.test.ts) and the SQL harness (export.cjs, then compare.cjs on the SQL
 *  result). "Ended" below is a row whose superseded_by is set; nothing in the application ends a system row
 *  yet, and these scenarios add no such path — they state what the evaluators already do with one. */
export const SEVERAL_ROW_SCENARIOS: Record<string, WrittenScenario> = (() => {
  // Included checking C and savings C2, included cards X and Y, an excluded card E and an excluded savings
  // account F, an account N of no type: an included card always exists, so "no included card" proves nothing.
  const accounts = [
    acct('C', 'depository'), acct('C2', 'depository'), acct('X', 'credit'), acct('Y', 'credit'),
    acct('E', 'credit', true), acct('F', 'depository', true), acct('N', null),
  ];
  const only = (legs: Record<string, string>, decisions: Record<string, string>) => ({ [U]: { legs, decisions } });
  const ended = (d: MatchingDecision): MatchingDecision => ({ ...d, supersededBy: 'undone' });
  // The records' payment: +100.00 on C, on 09-01. A record is what a removal writes on a payment it had
  // matched automatically to a card of the removed institution.
  const c = tx('c', 'C', '2026-09-01', 10000);
  const record = (id: string, plaid = 'p-c') => mkDecision(id, 'destination_removed_card', ref('C', plaid, 10000));
  // The holds' pair: a payment (09-10) and the kept card's leg one day later. The removed card's leg was dated
  // 09-11 too — a tie — so each hold a removal wrote on this pair carries 09-11. Card leg first.
  const hc = tx('c', 'C', '2026-09-10', 10000);
  const hy = tx('y', 'Y', '2026-09-11', -10000);
  const hold = (id: string) => mkHold(id, 'ambiguity_hold_removed_card', ref('Y', 'p-y', -10000), ref('C', 'p-c', 10000), '2026-09-11');
  // …withheld: both legs unresolved and each other's candidate; the payment a range, the card leg 0.
  const withheld = { c: 'unresolved/ambiguous/null range=-10000..0 cands=y:tier1_competitor', y: 'unresolved/ambiguous/0 cands=c:tier1_competitor' };
  // Two posted rows that both name the pending payment `pc`: a conflicting replacement group.
  const T1 = tx('T1', 'C', '2026-09-01', 10000, { plaid: 't1', pendingOf: 'pc' });
  const T2 = tx('T2', 'C', '2026-09-10', 10000, { plaid: 't2', pendingOf: 'pc' });
  const heldBy = (id: string) => `unresolved/ambiguous_replacement/null detail=lineage_ambiguous decision=${id} range=-10000..0`;
  return {
    // S98: two live records with one key on a payment that has no card leg anywhere. Each resolves to the
    // payment at its recorded cents, on the cash side: both active. No user decision, no tier 1 pair: the
    // payment reads its removal record — untracked / removed_card, −100.00, a figure and not a range — and
    // names r1, the lesser id. (Written last first in the database: r1 is then the newer row.)
    'S98-two-live-records-on-one-leg-read-as-one': {
      accounts,
      transactions: [c],
      decisions: [record('r1'), record('r2')],
      insertDecisionsLastFirst: true,
      expect: only({ c: 'untracked/removed_card/-10000 decision=r1' }, { r1: 'active', r2: 'active' }),
    },
    // S99: the same, the lesser one ended. An ended row is ignored; the other stands by itself: the same
    // reading, and the payment names r2.
    'S99-two-records-the-lesser-ended-the-other-is-read': {
      accounts,
      transactions: [c],
      decisions: [ended(record('r1')), record('r2')],
      expect: only({ c: 'untracked/removed_card/-10000 decision=r2' }, { r1: 'superseded', r2: 'active' }),
    },
    // S100: S98 after a relink — a card leg of −100.00 one day after the payment, each the other's only
    // candidate. Tier 1 outranks a record, however many there are: tracked / auto_pair, 0, no decision named.
    // Both records stay active and are not applied.
    'S100-two-live-records-stay-below-a-tier1-pair': {
      accounts,
      transactions: [c, tx('x2', 'X', '2026-09-02', -10000)],
      decisions: [record('r1'), record('r2')],
      expect: only({ c: 'tracked/auto_pair/0 partner=x2', x2: 'paired/auto_pair/0 partner=c' }, { r1: 'active', r2: 'active' }),
    },
    // S101: a payment k (09-10) with a record, and a kept card's leg b (09-13): each other's only candidate
    // (3 days), so they would pair. Three identical holds on (b, k) carry a removed leg's date, 09-11. That
    // leg would still be closer to k (1 day against 3): each hold withholds the pair, and three withhold it
    // as one does (the SQL harness's S87 is this history with one hold). k reads its record: untracked /
    // removed_card, −100.00. b is unresolved, 0, with k as its candidate.
    'S101-three-identical-holds-and-a-record': {
      accounts,
      transactions: [tx('k', 'C', '2026-09-10', 10000), tx('b', 'Y', '2026-09-13', -10000)],
      decisions: [
        ...['h1', 'h2', 'h3'].map((id) => mkHold(id, 'ambiguity_hold_removed_card', ref('Y', 'p-b', -10000), ref('C', 'p-k', 10000), '2026-09-11')),
        mkDecision('r', 'destination_removed_card', ref('C', 'p-k', 10000)),
      ],
      expect: only(
        { k: 'untracked/removed_card/-10000 decision=r', b: 'unresolved/ambiguous/0 cands=k:tier1_competitor' },
        { h1: 'active', h2: 'active', h3: 'active', r: 'active' }
      ),
    },
    // S102: two identical live holds on the tied pair, as two removals leave them. The removed leg is as close
    // to the payment as the kept card's leg is (1 day each): withheld, exactly as by one hold.
    'S102-two-identical-holds-withhold-as-one': {
      accounts,
      transactions: [hc, hy],
      decisions: [hold('h1'), hold('h2')],
      expect: only(withheld, { h1: 'active', h2: 'active' }),
    },
    // S103: one of the two is ended. The other is a dependency of its own and still withholds: ending one
    // never implies the other. The legs read exactly as in S102.
    'S103-two-identical-holds-one-ended-the-other-still-withholds': {
      accounts,
      transactions: [hc, hy],
      decisions: [ended(hold('h1')), hold('h2')],
      expect: only(withheld, { h1: 'superseded', h2: 'active' }),
    },
    // S104: both are ended. Nothing withholds the pair any more, and tier 1 forms it: tracked / auto_pair, 0.
    'S104-two-identical-holds-both-ended-the-pair-forms': {
      accounts,
      transactions: [hc, hy],
      decisions: [ended(hold('h1')), ended(hold('h2'))],
      expect: only({ c: 'tracked/auto_pair/0 partner=y', y: 'paired/auto_pair/0 partner=c' }, { h1: 'superseded', h2: 'superseded' }),
    },
    // S105: two records on a pending payment that two posted rows now both name. Neither record can say
    // which row it is about: both are inactive / lineage_ambiguous. Both rows are held — unresolved,
    // unmatched, the range −100.00..0 — and each names r1, the lesser of the two records that name it. The
    // card leg x is offered neither row: unresolved / no_candidate, 0.
    'S105-conflicting-replacements-named-by-two-records': {
      accounts,
      transactions: [T1, T2, tx('x', 'X', '2026-09-02', -10000)],
      decisions: [record('r1', 'pc'), record('r2', 'pc')],
      expect: only({ T1: heldBy('r1'), T2: heldBy('r1'), x: 'unresolved/no_candidate/0' }, { r1: 'inactive/lineage_ambiguous', r2: 'inactive/lineage_ambiguous' }),
    },
    // S106: the same rows; r1 names the second posted row by its own id, r2 the pending id. T2 is named by
    // both and names r1; T1 is named by r2 alone and names r2: a row names the least record that names IT, not
    // the least of all. (Written last first in the database.)
    'S106-conflicting-replacements-each-row-names-the-least-record-naming-it': {
      accounts,
      transactions: [T1, T2, tx('x', 'X', '2026-09-02', -10000)],
      decisions: [record('r1', 't2'), record('r2', 'pc')],
      insertDecisionsLastFirst: true,
      expect: only({ T1: heldBy('r2'), T2: heldBy('r1'), x: 'unresolved/no_candidate/0' }, { r1: 'inactive/lineage_ambiguous', r2: 'inactive/lineage_ambiguous' }),
    },
    // S107: a record and the user's own "a card I haven't linked" on the same payment. The user's decision
    // decides and is the one named: untracked / user_confirmed_unlinked, −100.00. The record stays active
    // and conflicts with nothing.
    'S107-one-record-and-a-user-confirmed-unlinked-destination': {
      accounts,
      transactions: [c],
      decisions: [record('r1'), mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000))],
      expect: only({ c: 'untracked/user_confirmed_unlinked/-10000 decision=u' }, { r1: 'active', u: 'active' }),
    },
    // S108: the same with two records: nothing changes but the list of decisions.
    'S108-two-records-and-a-user-confirmed-unlinked-destination': {
      accounts,
      transactions: [c],
      decisions: [record('r1'), record('r2'), mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000))],
      expect: only({ c: 'untracked/user_confirmed_unlinked/-10000 decision=u' }, { r1: 'active', r2: 'active', u: 'active' }),
    },
    // S109: a record and the user's preserved pair (its counterpart's account was removed; frozen valid) on the
    // same payment. Both would read untracked / removed_card, −100.00; the user's decision is the one that
    // decides, and the one named.
    'S109-one-record-and-a-preserved-user-pair': {
      accounts,
      transactions: [c],
      decisions: [record('r1'), mkPreserved('up', ref('C', 'p-c', 10000), 'valid')],
      expect: only({ c: 'untracked/removed_card/-10000 decision=up' }, { r1: 'active', up: 'active' }),
    },
    // S110: the same with two records.
    'S110-two-records-and-a-preserved-user-pair': {
      accounts,
      transactions: [c],
      decisions: [record('r1'), record('r2'), mkPreserved('up', ref('C', 'p-c', 10000), 'valid')],
      expect: only({ c: 'untracked/removed_card/-10000 decision=up' }, { r1: 'active', r2: 'active', up: 'active' }),
    },
    // S111: two records and a preserved pair whose removed side's amount had changed (inactive). The payment
    // stays reserved by the user's decision — unresolved, the range −100.00..0, needing review — and two
    // valid records do not stand in for it any more than one does.
    'S111-two-records-and-an-invalid-preserved-pair-the-leg-stays-reserved': {
      accounts,
      transactions: [c],
      decisions: [record('r1'), record('r2'), mkPreserved('up', ref('C', 'p-c', 10000), 'amount_changed')],
      expect: only(
        { c: 'unresolved/decision_invalidated/null detail=amount_changed decision=up range=-10000..0' },
        { r1: 'active', r2: 'active', up: 'inactive/amount_changed' }
      ),
    },
    // S112: S98 with both records ended. No record is left, an included card exists and nothing fits the
    // payment: unresolved / no_candidate, the range −100.00..0, no decision named.
    'S112-two-records-both-ended-the-payment-is-unresolved-again': {
      accounts,
      transactions: [c],
      decisions: [ended(record('r1')), ended(record('r2'))],
      expect: only({ c: 'unresolved/no_candidate/null range=-10000..0' }, { r1: 'superseded', r2: 'superseded' }),
    },
    // S113: two live records on a RETURN of 35.00 to the checking account (−35.00 in Plaid's sign). The effect
    // of a removed-card leg is −cents: +35.00, a figure; the lesser id is named.
    'S113-two-live-records-on-a-return': {
      accounts,
      transactions: [tx('ret', 'C', '2026-09-01', -3500)],
      decisions: ['r1', 'r2'].map((id) => mkDecision(id, 'destination_removed_card', ref('C', 'p-ret', -3500))),
      expect: only({ ret: 'untracked/removed_card/3500 decision=r1' }, { r1: 'active', r2: 'active' }),
    },
  };
})();
