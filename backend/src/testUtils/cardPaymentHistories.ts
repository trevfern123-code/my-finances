// Deterministic card-payment histories for tests — the Stage 2 generator, shared by
// backend/src/services/cardPaymentMatching.adversarial.test.ts (vitest) and the SQL oracle-equivalence
// harness supabase/tests/card_payment_evaluator (which compiles this file with tsc). Test-only: excluded
// from the production build (tsconfig.build.json excludes src/testUtils). Moved verbatim from the
// adversarial test; any change to it changes every generated case.
// 2026-10-06: preserved pairs (pair_counterpart_removed) are ADDED to each generated history from a separate
// random stream, after everything else: the accounts, rows, carry-overs and every other decision of a seed
// are exactly what they were before. System ambiguity holds are added the same way, from a third stream.
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
  return {
    input: {
      asOf: ASOF,
      accounts: [...a.accounts, ...b.accounts],
      transactions: [...a.transactions, ...b.transactions],
      carryovers: [...a.carryovers, ...b.carryovers],
      decisions: [...a.decisions, ...b.decisions, ...foreign, ...preserved, ...holds, ...corrected],
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
