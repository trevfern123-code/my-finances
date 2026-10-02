// Deterministic card-payment histories for tests — the Stage 2 generator, shared by
// backend/src/services/cardPaymentMatching.adversarial.test.ts (vitest) and the SQL oracle-equivalence
// harness supabase/tests/card_payment_evaluator (which compiles this file with tsc). Test-only: excluded
// from the production build (tsconfig.build.json excludes src/testUtils). Moved verbatim from the
// adversarial test; any change to it changes every generated case.
import type {
  CardPaymentMatchingInput,
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

export function shuffle<T>(xs: T[], r: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
