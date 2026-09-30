/**
 * Financial Semantics Phase B — card-payment matching REFERENCE EVALUATOR (pure).
 * Implements CARD_PAYMENT_PAIRING_DESIGN.md rev 3 §3.1–§3.6 and §4 (approved 2026-09-29).
 *
 * NOT WIRED INTO ANYTHING. No route, service, script or frontend imports this module; the live app's
 * calculations and `semanticAggregation.ts` (Phase B slice 1) are unchanged. The design makes a SQL
 * evaluator the production implementation (§3.8) and this module its oracle; persistence, triggers,
 * version bookkeeping, the read protocol and the RPCs (§3.5, §3.7) are later database work.
 *
 * Pure: no database, network, filesystem or clock. The only time input is `asOf`, used to decide
 * whether a carry-over has expired (§3.6) and to label a leg "recent" — the label never changes a
 * state or an effect (§3.4: elapsed time proves nothing). Deterministic: the result depends only on
 * the input's content, never on array order; every output list is sorted.
 *
 * What it decides, per card leg of ONE user (effective role `credit_card_payment`, non-zero amount,
 * not superseded by its posted replacement):
 *  - Cash-side legs (any account whose type is not 'credit', including NULL) move cash flow; they end
 *    `tracked` (0, or the accepted fee remainder), `untracked` (−amount: a payment subtracts, a return
 *    adds) or `unresolved` (bounds {0, −amount}). A cash-side leg on an EXCLUDED account is evidence
 *    only: `not_counted`, 0.
 *  - Credit-side legs never move cash flow (D5): `paired`, `funded_from_excluded`, `unresolved` or
 *    `not_counted` (excluded card), always 0.
 * Precedence (§3.2): an active user decision; else (a leg claimed by an inactive user decision stays
 * unresolved — §3.6); else a tier 1 pair; else a removed-card decision; else no included card; else
 * unresolved with the reason from the candidates. Nothing else ever makes a leg untracked (§3.4).
 *
 * Conflicting replacements (APPROVED by Trevor, 2026-09-30): when more than one posted row on the same
 * user/account names the same pending id, the matching of every such row stays unresolved
 * (`ambiguous_replacement`) — ahead of every precedence step above, whatever decision exists or none.
 * No replacement is chosen, no resolved effect is published, and the rows are neither matched
 * automatically nor offered as other legs' candidates. Nothing is deleted, merged or selected; a later
 * snapshot with a single replacement evaluates normally.
 *
 * Amounts are integer cents (Plaid sign: + out, − in). Dates are YYYY-MM-DD.
 */

// ---- Approved parameters (design §3.3, §10 T2) ---------------------------------------------------

/** Tier 1 automatic pairing window (exact cents, reciprocal). */
export const AUTO_PAIR_WINDOW_DAYS = 5;
/** Tier 2: exact-amount suggestions reach this far (6 – 60 days). Suggestions only. */
export const SUGGESTION_HORIZON_DAYS = 60;
/** Tier 2: near-amount suggestions differ by 1 cent to this many cents, within the tier 1 window. */
export const NEAR_AMOUNT_TOLERANCE_CENTS = 500;
/** Labelling only ("Waiting for … to show this payment" vs "We can't tell…"). Never evidence. */
export const RECENT_LABEL_DAYS = 10;

// ---- Input ----------------------------------------------------------------------------------------

export interface MatchingAccount {
  id: string;
  /** Owner (accounts → plaid_items.user_id). */
  userId: string;
  /** Plaid type; only 'credit' makes a leg credit-side. NULL is cash-side (as semanticAggregation.ts). */
  type: string | null;
  excludeFromCashFlow: boolean;
}

export interface MatchingTransaction {
  id: string;
  accountId: string;
  plaidTransactionId: string;
  /** On a posted row: the Plaid id of the pending row it replaces (continuity). */
  pendingTransactionId: string | null;
  pending: boolean;
  date: string;
  /** Integer cents, Plaid sign convention. */
  amountCents: number;
  /** `coalesce(user_role_override, auto_role)`. */
  effectiveRole: string | null;
}

/** A continuity carry-over: a pending row that was removed and may still post (§3.6 step 3). */
export interface MatchingCarryover {
  accountId: string;
  pendingPlaidTransactionId: string;
  /** ISO timestamp. */
  expiresAt: string;
  consumed: boolean;
}

/** A decision leg: the Plaid id and cents AT DECISION TIME, on its account (lineage key, §3.5). */
export interface DecisionLegRef {
  accountId: string;
  plaidTransactionId: string;
  cents: number;
}

export type DecisionKind = 'pair' | 'not_this_pair' | 'destination_unlinked' | 'destination_removed_card';

export interface MatchingDecision {
  id: string;
  userId: string;
  kind: DecisionKind;
  a: DecisionLegRef;
  /** Required for `pair` and `not_this_pair`; null for the single-leg kinds. */
  b: DecisionLegRef | null;
  /** `pair` only: |cash cents| − |credit cents| that the user explicitly accepted (0 for an exact
   *  pair). Must equal the recorded legs' actual difference (§4.3, T6). Null for other kinds. */
  acceptedDifferenceCents: number | null;
  decidedSeq: number;
  /** Set when the user undid or replaced it; a superseded decision is ignored. */
  supersededBy: string | null;
}

export interface CardPaymentMatchingInput {
  userId: string;
  /** ISO timestamp — the evaluation's notion of "now" (carry-over expiry, recency label). */
  asOf: string;
  accounts: MatchingAccount[];
  transactions: MatchingTransaction[];
  carryovers: MatchingCarryover[];
  decisions: MatchingDecision[];
}

// ---- Output ---------------------------------------------------------------------------------------

export type LegSide = 'cash' | 'credit';
export type LegDirection = 'payment' | 'return';

export type CardLegState =
  | 'tracked'
  | 'untracked'
  | 'unresolved'
  | 'paired'
  | 'funded_from_excluded'
  | 'not_counted';

export type CardLegReason =
  | 'auto_pair'
  | 'user_pair'
  | 'partner_excluded'
  | 'no_included_card'
  | 'user_confirmed_unlinked'
  | 'removed_card'
  | 'no_candidate'
  | 'possible_match'
  | 'amount_differs'
  | 'ambiguous'
  | 'matched_leg_not_posted'
  | 'decision_invalidated'
  /** More than one posted row on this account names the same pending id (approved rule, 2026-09-30). */
  | 'ambiguous_replacement'
  | 'excluded_account';

/** Why a user decision is inactive (§3.6). */
export type InactiveDetail =
  | 'waiting_to_post'
  | 'partner_gone'
  | 'lineage_ambiguous'
  | 'role_changed'
  | 'amount_changed'
  | 'not_cash_side'
  | 'sides_not_opposite'
  | 'direction_mismatch'
  | 'difference_not_accepted'
  | 'conflicting_decisions';

export type CandidateKind = 'tier1_competitor' | 'exact_amount' | 'return_of_pair' | 'near_amount';

export interface CandidateRef {
  transactionId: string;
  kind: CandidateKind;
  distanceDays: number;
  /** |this leg| − |candidate| in cents (0 for exact). */
  differenceCents: number;
  /** The leg carries an active user decision and this evidence contradicts it (§3.2): shown as a
   *  suggestion, never applied. The same limits and dismissals apply as for any suggestion. */
  contradictsDecision: boolean;
}

export interface CardLegResult {
  transactionId: string;
  accountId: string;
  date: string;
  amountCents: number;
  pending: boolean;
  side: LegSide;
  direction: LegDirection;
  /** The leg's own account is included in cash flow. */
  accountIncluded: boolean;
  state: CardLegState;
  reason: CardLegReason;
  /** For `decision_invalidated` / `matched_leg_not_posted`: why the decision is inactive. */
  detail: InactiveDetail | null;
  partnerTransactionId: string | null;
  decisionId: string | null;
  candidates: CandidateRef[];
  /** Resolved effect on cash flow in cents; null while a counted (included cash-side) leg is
   *  unresolved. Always 0 for credit-side legs and legs on excluded accounts (never counted). */
  effectCents: number | null;
  /** Bounds of the effect: equal to effectCents when resolved; {0, −amount} sorted when unresolved. */
  lowCents: number;
  highCents: number;
  /** Fee pairs (§4.3): the excess on each side (0 otherwise). */
  cashExcessCents: number;
  cardExcessCents: number;
  /** Label only (§6.1 wording). */
  recent: boolean;
}

export type DecisionStatus = 'active' | 'inactive' | 'superseded' | 'rejected';

export interface DecisionResult {
  decisionId: string;
  kind: DecisionKind;
  status: DecisionStatus;
  detail: InactiveDetail | 'foreign_user' | 'foreign_account' | null;
}

export interface CardPaymentEvaluation {
  userId: string;
  /** One entry per card leg of the user, sorted by transactionId. */
  legs: CardLegResult[];
  /** One entry per decision owned by the user or touching the user's accounts, sorted by id. */
  decisions: DecisionResult[];
  /** Pending rows replaced by a posted row still present (§3.6 step 1): no state, not evidence. */
  supersededTransactionIds: string[];
}

export class CardPaymentMatchingIntegrityError extends Error {
  readonly code = 'card_payment_matching_integrity';
  constructor(message: string) {
    super(`card_payment_matching_integrity: ${message}`);
  }
}

// ---- Helpers --------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(date: string, what: string): number {
  if (!DATE.test(date)) throw new CardPaymentMatchingIntegrityError(`${what} must be YYYY-MM-DD (got '${date}')`);
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new CardPaymentMatchingIntegrityError(`${what} is not a calendar date (got '${date}')`);
  }
  return Math.round(ms / DAY_MS);
}

function timestamp(value: string, what: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new CardPaymentMatchingIntegrityError(`${what} must be an ISO timestamp (got '${value}')`);
  return ms;
}

function assertCents(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new CardPaymentMatchingIntegrityError(`${what} must be integer cents (got ${value})`);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

const DECISION_KINDS: ReadonlySet<string> = new Set<DecisionKind>([
  'pair',
  'not_this_pair',
  'destination_unlinked',
  'destination_removed_card',
]);

interface Leg {
  txn: MatchingTransaction;
  account: MatchingAccount;
  day: number;
  side: LegSide;
}

type Lineage =
  | { kind: 'row'; txn: MatchingTransaction }
  | { kind: 'waiting' }
  | { kind: 'gone' }
  /** More than one posted row names the same pending id (§3.6 step 1): every one is a candidate. */
  | {
      kind: 'ambiguous';
      /** Every row of the conflicting group. */
      txns: MatchingTransaction[];
      /** The rows the decision leg actually names: the whole group when it names the pending id, only
       *  that row when it names one conflicting replacement by its own posted id. */
      named: MatchingTransaction[];
    };

interface UserDecisionView {
  decision: MatchingDecision;
  /** Current rows, when the lineage has one. */
  rows: (MatchingTransaction | null)[];
  inactive: InactiveDetail | null;
}

// ---- Evaluation -----------------------------------------------------------------------------------

export function evaluateCardPayments(input: CardPaymentMatchingInput): CardPaymentEvaluation {
  const asOfMs = timestamp(input.asOf, 'asOf');
  const asOfDay = Math.floor(asOfMs / DAY_MS);

  // -- Structural validation over the whole input (any user): ids are unique and every row names a
  //    known account, so ownership can always be decided.
  const accountsById = new Map<string, MatchingAccount>();
  for (const a of input.accounts) {
    if (accountsById.has(a.id)) throw new CardPaymentMatchingIntegrityError(`duplicate account id '${a.id}'`);
    accountsById.set(a.id, a);
  }
  const txnIds = new Set<string>();
  const plaidIds = new Set<string>();
  for (const t of input.transactions) {
    if (txnIds.has(t.id)) throw new CardPaymentMatchingIntegrityError(`duplicate transaction id '${t.id}'`);
    txnIds.add(t.id);
    if (plaidIds.has(t.plaidTransactionId)) {
      throw new CardPaymentMatchingIntegrityError(`duplicate plaid transaction id on transaction '${t.id}'`);
    }
    plaidIds.add(t.plaidTransactionId);
    if (!accountsById.has(t.accountId)) {
      throw new CardPaymentMatchingIntegrityError(`transaction '${t.id}' names an unknown account`);
    }
    assertCents(t.amountCents, `transaction '${t.id}' amountCents`);
    dayNumber(t.date, `transaction '${t.id}' date`);
  }
  for (const c of input.carryovers) {
    if (!accountsById.has(c.accountId)) throw new CardPaymentMatchingIntegrityError('a carry-over names an unknown account');
    timestamp(c.expiresAt, 'carry-over expiresAt');
  }
  const decisionIds = new Set<string>();
  for (const d of input.decisions) {
    if (decisionIds.has(d.id)) throw new CardPaymentMatchingIntegrityError(`duplicate decision id '${d.id}'`);
    decisionIds.add(d.id);
    if (!DECISION_KINDS.has(d.kind)) throw new CardPaymentMatchingIntegrityError(`decision '${d.id}' has unknown kind`);
    const twoLeg = d.kind === 'pair' || d.kind === 'not_this_pair';
    if (twoLeg !== (d.b !== null)) {
      throw new CardPaymentMatchingIntegrityError(`decision '${d.id}' (${d.kind}) has the wrong number of legs`);
    }
    for (const ref of d.b === null ? [d.a] : [d.a, d.b]) assertCents(ref.cents, `decision '${d.id}' leg cents`);
    if (d.kind === 'pair') {
      if (d.acceptedDifferenceCents === null) {
        throw new CardPaymentMatchingIntegrityError(`pair decision '${d.id}' must record its accepted difference`);
      }
      assertCents(d.acceptedDifferenceCents, `decision '${d.id}' acceptedDifferenceCents`);
    } else if (d.acceptedDifferenceCents !== null) {
      throw new CardPaymentMatchingIntegrityError(`decision '${d.id}' (${d.kind}) cannot carry an accepted difference`);
    }
    if (!Number.isSafeInteger(d.decidedSeq)) throw new CardPaymentMatchingIntegrityError(`decision '${d.id}' decidedSeq`);
  }

  // -- The user's view: only their accounts and the rows, carry-overs and decisions on them.
  const userId = input.userId;
  const owns = (accountId: string) => accountsById.get(accountId)?.userId === userId;
  const userAccounts = input.accounts.filter((a) => a.userId === userId);
  const userTxns = input.transactions.filter((t) => owns(t.accountId));
  const userCarryovers = input.carryovers.filter((c) => owns(c.accountId));

  // §3.6 step 1: a pending row whose Plaid id another row ON THE SAME ACCOUNT names as its
  // pending_transaction_id is superseded — no state, not evidence.
  const byAccountPlaid = new Map<string, MatchingTransaction>();
  const replacements = new Map<string, MatchingTransaction[]>();
  for (const t of userTxns) {
    byAccountPlaid.set(`${t.accountId}\u0000${t.plaidTransactionId}`, t);
    if (t.pendingTransactionId !== null) {
      const key = `${t.accountId}\u0000${t.pendingTransactionId}`;
      const list = replacements.get(key) ?? [];
      list.push(t);
      replacements.set(key, list);
    }
  }
  const superseded = new Set<string>();
  for (const t of userTxns) {
    if (replacements.has(`${t.accountId}\u0000${t.plaidTransactionId}`)) superseded.add(t.id);
  }
  // Conflicting replacements (approved rule, 2026-09-30): every row of a group of more than one row on
  // the same account naming the same pending id. Role- and decision-independent: the conflict is in
  // the bank data, and no input here says which replacement is right.
  const conflictGroupOf = new Map<string, MatchingTransaction[]>();
  for (const group of replacements.values()) {
    if (group.length > 1) for (const t of group) conflictGroupOf.set(t.id, group);
  }

  function resolveLineage(ref: DecisionLegRef): Lineage {
    const key = `${ref.accountId}\u0000${ref.plaidTransactionId}`;
    const posted = replacements.get(key);
    if (posted !== undefined) return posted.length === 1 ? { kind: 'row', txn: posted[0] } : { kind: 'ambiguous', txns: posted, named: posted };
    const row = byAccountPlaid.get(key);
    // A decision naming one conflicting replacement by its own posted id is just as ambiguous.
    if (row !== undefined && conflictGroupOf.has(row.id)) return { kind: 'ambiguous', txns: conflictGroupOf.get(row.id)!, named: [row] };
    if (row !== undefined) return { kind: 'row', txn: row };
    const waiting = userCarryovers.some(
      (c) =>
        c.accountId === ref.accountId &&
        c.pendingPlaidTransactionId === ref.plaidTransactionId &&
        !c.consumed &&
        timestamp(c.expiresAt, 'carry-over expiresAt') > asOfMs
    );
    return waiting ? { kind: 'waiting' } : { kind: 'gone' };
  }

  const isCardRow = (t: MatchingTransaction) =>
    t.effectiveRole === 'credit_card_payment' && t.amountCents !== 0 && !superseded.has(t.id);
  const sideOf = (accountId: string): LegSide => (accountsById.get(accountId)!.type === 'credit' ? 'credit' : 'cash');

  const legs = new Map<string, Leg>();
  for (const t of userTxns) {
    if (!isCardRow(t)) continue;
    const account = accountsById.get(t.accountId)!;
    legs.set(t.id, { txn: t, account, day: dayNumber(t.date, 'date'), side: sideOf(t.accountId) });
  }

  // -- Decisions (§3.5, §3.6).
  const decisionResults = new Map<string, DecisionResult>();
  const dismissed = new Set<string>();
  const userDecisions: UserDecisionView[] = [];
  const removedCard = new Map<string, MatchingDecision>();
  /** Held (conflicting) row id → ids of the decisions whose lineage names it (reporting only). */
  const namedBy = new Map<string, string[]>();
  const noteHeld = (d: MatchingDecision, lineages: Lineage[]) => {
    for (const l of lineages) {
      if (l.kind !== 'ambiguous') continue;
      for (const t of l.named) namedBy.set(t.id, [...(namedBy.get(t.id) ?? []), d.id]);
    }
  };

  for (const d of input.decisions) {
    const refs = d.b === null ? [d.a] : [d.a, d.b];
    const touchesUser = refs.some((r) => owns(r.accountId));
    if (d.userId !== userId) {
      // Another user's decision is never applied here; report it only if it names our accounts.
      if (touchesUser) decisionResults.set(d.id, { decisionId: d.id, kind: d.kind, status: 'rejected', detail: 'foreign_user' });
      continue;
    }
    if (!refs.every((r) => owns(r.accountId))) {
      decisionResults.set(d.id, { decisionId: d.id, kind: d.kind, status: 'rejected', detail: 'foreign_account' });
      continue;
    }
    if (d.supersededBy !== null) {
      decisionResults.set(d.id, { decisionId: d.id, kind: d.kind, status: 'superseded', detail: null });
      continue;
    }
    const lineages = refs.map(resolveLineage);
    const rows = lineages.map((l) => (l.kind === 'row' ? l.txn : null));

    if (d.kind === 'not_this_pair') {
      // Suppresses one candidate whenever both legs have current rows, whatever the amounts.
      const active = rows[0] !== null && rows[1] !== null;
      if (active) dismissed.add(edgeKey(rows[0]!.id, rows[1]!.id));
      const detail = active ? null : lineageDetail(lineages);
      decisionResults.set(d.id, { decisionId: d.id, kind: d.kind, status: active ? 'active' : 'inactive', detail });
      continue;
    }

    let inactive: InactiveDetail | null = lineageDetail(lineages);
    if (inactive === null) {
      inactive = shapeDetail(d, rows as MatchingTransaction[]);
    }
    noteHeld(d, lineages);
    if (d.kind === 'destination_removed_card') {
      // System-written (§4.7): ranks below tier 1 and claims nothing. Inactive → simply not applied.
      // (An ambiguous lineage makes it inactive; its replacements are held by the lineage guard — Q12.)
      decisionResults.set(d.id, { decisionId: d.id, kind: d.kind, status: inactive === null ? 'active' : 'inactive', detail: inactive });
      if (inactive === null) {
        const prev = removedCard.get(rows[0]!.id);
        if (prev === undefined || cmp(d.id, prev.id) < 0) removedCard.set(rows[0]!.id, d);
      }
      continue;
    }
    userDecisions.push({ decision: d, rows, inactive });
  }

  function shapeDetail(d: MatchingDecision, rows: MatchingTransaction[]): InactiveDetail | null {
    const refs = d.b === null ? [d.a] : [d.a, d.b];
    // Amount first: a row whose amount became 0 is no longer a card leg, but what changed is the
    // amount, not the role.
    if (rows.some((r, i) => r.amountCents !== refs[i].cents)) return 'amount_changed';
    if (rows.some((r) => !isCardRow(r))) return 'role_changed';
    if (d.kind !== 'pair') return sideOf(rows[0].accountId) === 'cash' ? null : 'not_cash_side';
    const sides = rows.map((r) => sideOf(r.accountId));
    if (sides[0] === sides[1]) return 'sides_not_opposite';
    const cash = sides[0] === 'cash' ? rows[0] : rows[1];
    const credit = sides[0] === 'cash' ? rows[1] : rows[0];
    if (Math.sign(cash.amountCents) !== -Math.sign(credit.amountCents)) return 'direction_mismatch';
    if (Math.abs(cash.amountCents) - Math.abs(credit.amountCents) !== d.acceptedDifferenceCents) return 'difference_not_accepted';
    return null;
  }

  // Claims: every non-superseded user pair / destination decision claims its current card rows,
  // active or not. (Rows of an ambiguous lineage are held by the lineage-level guard instead.) A row
  // claimed twice is a conflict: every decision involved becomes inactive.
  // A decision whose two references resolve to the same row claims it once (it is then simply not a
  // valid pair — sides_not_opposite — not a conflict with itself).
  const claimsByLeg = new Map<string, UserDecisionView[]>();
  for (const view of userDecisions) {
    const rowIds = new Set(view.rows.filter((r): r is MatchingTransaction => r !== null).map((r) => r.id));
    for (const rowId of rowIds) {
      if (!legs.has(rowId)) continue;
      const list = claimsByLeg.get(rowId) ?? [];
      list.push(view);
      claimsByLeg.set(rowId, list);
    }
  }
  for (const list of claimsByLeg.values()) {
    // Sorted so the decision reported on a leg never depends on input order.
    list.sort((x, y) => cmp(x.decision.id, y.decision.id));
    if (list.length > 1) for (const view of list) view.inactive = 'conflicting_decisions';
  }
  for (const view of userDecisions) {
    const d = view.decision;
    decisionResults.set(d.id, {
      decisionId: d.id,
      kind: d.kind,
      status: view.inactive === null ? 'active' : 'inactive',
      detail: view.inactive,
    });
  }
  const claimOf = (legId: string): UserDecisionView | undefined => claimsByLeg.get(legId)?.[0];

  // -- Tier 1 (§3.3): unclaimed legs of the whole evidence pool (included AND excluded accounts, T5).
  const pool = [...legs.values()]
    .filter((l) => !claimsByLeg.has(l.txn.id) && !conflictGroupOf.has(l.txn.id))
    .sort((x, y) => cmp(x.txn.id, y.txn.id));
  const tier1Edge = (x: Leg, y: Leg) =>
    x !== y &&
    x.side !== y.side &&
    y.txn.amountCents === -x.txn.amountCents &&
    Math.abs(x.day - y.day) <= AUTO_PAIR_WINDOW_DAYS &&
    !dismissed.has(edgeKey(x.txn.id, y.txn.id));
  const tier1 = pairReciprocally(pool, tier1Edge);

  const includedCreditExists = userAccounts.some((a) => a.type === 'credit' && !a.excludeFromCashFlow);

  // Tracked pairs (for the return-of-pair suggestion label): cash leg id → credit leg id.
  const trackedPairs: Array<{ cash: Leg; credit: Leg }> = [];

  // -- States.
  const results: CardLegResult[] = [];
  const legList = [...legs.values()].sort((x, y) => cmp(x.txn.id, y.txn.id));

  function candidatesFor(leg: Leg): CandidateRef[] {
    const out: CandidateRef[] = [];
    for (const other of pool) {
      if (other === leg || other.side === leg.side) continue;
      if (dismissed.has(edgeKey(leg.txn.id, other.txn.id))) continue;
      const distance = Math.abs(leg.day - other.day);
      const exact = other.txn.amountCents === -leg.txn.amountCents;
      if (exact && distance <= AUTO_PAIR_WINDOW_DAYS) {
        out.push({ transactionId: other.txn.id, kind: 'tier1_competitor', distanceDays: distance, differenceCents: 0, contradictsDecision: false });
        continue;
      }
      if (tier1.has(other.txn.id)) continue; // tier 2 suggests only legs left unpaired
      if (exact && distance <= SUGGESTION_HORIZON_DAYS) {
        const kind: CandidateKind = isReturnOfPair(leg, other) ? 'return_of_pair' : 'exact_amount';
        out.push({ transactionId: other.txn.id, kind, distanceDays: distance, differenceCents: 0, contradictsDecision: false });
        continue;
      }
      const diff = Math.abs(leg.txn.amountCents) - Math.abs(other.txn.amountCents);
      if (
        Math.sign(other.txn.amountCents) === -Math.sign(leg.txn.amountCents) &&
        Math.abs(diff) >= 1 &&
        Math.abs(diff) <= NEAR_AMOUNT_TOLERANCE_CENTS &&
        distance <= AUTO_PAIR_WINDOW_DAYS
      ) {
        out.push({ transactionId: other.txn.id, kind: 'near_amount', distanceDays: distance, differenceCents: diff, contradictsDecision: false });
      }
    }
    return out.sort((p, q) => p.distanceDays - q.distanceDays || cmp(p.transactionId, q.transactionId));
  }

  function isReturnOfPair(leg: Leg, other: Leg): boolean {
    // A cash-side return and a credit-side reversal of equal cents on the same two accounts as an
    // earlier tracked pair, both dated after it (§3.3, T3: a suggestion, never applied).
    const cash = leg.side === 'cash' ? leg : other;
    const credit = leg.side === 'cash' ? other : leg;
    if (!(cash.txn.amountCents < 0 && credit.txn.amountCents > 0)) return false;
    return trackedPairs.some(
      (p) =>
        p.cash.account.id === cash.account.id &&
        p.credit.account.id === credit.account.id &&
        Math.abs(p.cash.txn.amountCents) === Math.abs(cash.txn.amountCents) &&
        p.cash.day < cash.day &&
        p.credit.day < credit.day
    );
  }

  function unresolvedReason(cands: CandidateRef[]): CardLegReason {
    if (cands.some((c) => c.kind === 'tier1_competitor')) return 'ambiguous';
    if (cands.some((c) => c.kind === 'exact_amount' || c.kind === 'return_of_pair')) return 'possible_match';
    if (cands.some((c) => c.kind === 'near_amount')) return 'amount_differs';
    return 'no_candidate';
  }

  // First pass: every leg whose state does not depend on the return-of-pair label.
  interface Draft {
    leg: Leg;
    state: CardLegState;
    reason: CardLegReason | null; // null → unresolved, reason from candidates (second pass)
    detail: InactiveDetail | null;
    partner: Leg | null;
    decisionId: string | null;
    effectCents: number | null;
    cashExcessCents: number;
    cardExcessCents: number;
    contradictions: boolean;
  }
  const drafts: Draft[] = [];

  for (const leg of legList) {
    const included = !leg.account.excludeFromCashFlow;
    const draft: Draft = {
      leg,
      state: 'unresolved',
      reason: null,
      detail: null,
      partner: null,
      decisionId: null,
      effectCents: null,
      cashExcessCents: 0,
      cardExcessCents: 0,
      contradictions: false,
    };
    const claim = claimOf(leg.txn.id);
    const tier1Partner = tier1.get(leg.txn.id);

    if (conflictGroupOf.has(leg.txn.id)) {
      // 0. Conflicting replacement (approved rule): unresolved, unmatched, whatever decision exists.
      draft.reason = 'ambiguous_replacement';
      draft.detail = 'lineage_ambiguous';
      draft.decisionId = [...(namedBy.get(leg.txn.id) ?? [])].sort(cmp)[0] ?? null;
    } else if (claim !== undefined && claim.inactive === null) {
      // 1. An active user decision.
      draft.decisionId = claim.decision.id;
      draft.contradictions = true;
      if (claim.decision.kind === 'destination_unlinked') {
        setResolved(draft, 'untracked', 'user_confirmed_unlinked', -leg.txn.amountCents);
      } else {
        const partnerRow = claim.rows.find((r) => r !== null && r.id !== leg.txn.id)!;
        const partner = legs.get(partnerRow.id)!;
        draft.partner = partner;
        applyPair(draft, partner, 'user_pair');
      }
    } else if (claim !== undefined) {
      // A leg claimed by an inactive user decision stays unresolved (§3.6).
      draft.decisionId = claim.decision.id;
      draft.detail = claim.inactive;
      draft.reason = claim.inactive === 'waiting_to_post' ? 'matched_leg_not_posted' : 'decision_invalidated';
    } else if (tier1Partner !== undefined) {
      // 2. Tier 1.
      draft.partner = tier1Partner;
      applyPair(draft, tier1Partner, 'auto_pair');
    } else if (leg.side === 'cash' && removedCard.has(leg.txn.id)) {
      // 3. A known destination preserved through institution removal (§4.7, T9).
      draft.decisionId = removedCard.get(leg.txn.id)!.id;
      setResolved(draft, 'untracked', 'removed_card', -leg.txn.amountCents);
    } else if (leg.side === 'cash' && !includedCreditExists) {
      // 4. Proof: no included card exists, so nothing can be tracked (§4.5).
      setResolved(draft, 'untracked', 'no_included_card', -leg.txn.amountCents);
    }

    // Legs on excluded accounts are evidence only; credit-side legs never move cash flow.
    if (!included) {
      draft.state = 'not_counted';
      draft.reason = 'excluded_account';
      draft.effectCents = 0;
      draft.detail = null;
    } else if (leg.side === 'credit') {
      draft.effectCents = 0;
    }
    drafts.push(draft);
  }

  function setResolved(draft: Draft, state: CardLegState, reason: CardLegReason, effect: number): void {
    draft.state = state;
    draft.reason = reason;
    draft.effectCents = effect;
  }

  function applyPair(draft: Draft, partner: Leg, reason: 'auto_pair' | 'user_pair'): void {
    const leg = draft.leg;
    const cash = leg.side === 'cash' ? leg : partner;
    const credit = leg.side === 'cash' ? partner : leg;
    const c = cash.txn.amountCents;
    const k = credit.txn.amountCents;
    const matched = Math.min(Math.abs(c), Math.abs(k));
    const cashExcess = Math.abs(c) - matched;
    const cardExcess = Math.abs(k) - matched;
    draft.cashExcessCents = cashExcess;
    draft.cardExcessCents = cardExcess;
    if (leg.side === 'cash') {
      if (credit.account.excludeFromCashFlow) {
        // Destination outside the tracked set: the whole cash leg counts, any difference (§4.3).
        setResolved(draft, 'untracked', 'partner_excluded', -c);
      } else {
        // Cash excess counts like an unpaired cash leg of the same direction; card excess is 0.
        setResolved(draft, 'tracked', reason, cashExcess === 0 ? 0 : -Math.sign(c) * cashExcess);
      }
      // A tracked pair — both legs on included accounts — is what a later return can be "of" (§3.3).
      if (!credit.account.excludeFromCashFlow && !cash.account.excludeFromCashFlow) trackedPairs.push({ cash, credit });
    } else {
      const state: CardLegState = cash.account.excludeFromCashFlow ? 'funded_from_excluded' : 'paired';
      draft.state = state;
      draft.reason = reason;
      draft.effectCents = 0;
    }
  }

  // Second pass: candidates, unresolved reasons, bounds.
  for (const draft of drafts) {
    const leg = draft.leg;
    const unresolved = draft.state === 'unresolved';
    let candidates: CandidateRef[] = [];
    if (unresolved && conflictGroupOf.has(leg.txn.id)) {
      candidates = [];
    } else if (unresolved) {
      candidates = candidatesFor(leg);
      if (draft.reason === null) draft.reason = unresolvedReason(candidates);
    } else if (draft.contradictions) {
      // An active user decision stands; every piece of evidence the suggestion rules would show for
      // this leg — tier-1-shaped, exact 6–60 days, near amount, return-of-pair — contradicts it and is
      // listed (§3.2). candidatesFor applies the usual limits and dismissals; the partner of a user
      // pair is held by the decision and never appears.
      candidates = candidatesFor(leg).map((c) => ({ ...c, contradictsDecision: true }));
    }

    const counted = leg.side === 'cash' && !leg.account.excludeFromCashFlow;
    let low: number;
    let high: number;
    let effect = draft.effectCents;
    if (!counted) {
      low = 0;
      high = 0;
      effect = 0;
    } else if (unresolved) {
      low = Math.min(0, -leg.txn.amountCents);
      high = Math.max(0, -leg.txn.amountCents);
      effect = null;
    } else {
      low = effect!;
      high = effect!;
    }

    results.push({
      transactionId: leg.txn.id,
      accountId: leg.account.id,
      date: leg.txn.date,
      amountCents: leg.txn.amountCents,
      pending: leg.txn.pending,
      side: leg.side,
      direction: leg.side === 'cash' ? (leg.txn.amountCents > 0 ? 'payment' : 'return') : leg.txn.amountCents < 0 ? 'payment' : 'return',
      accountIncluded: !leg.account.excludeFromCashFlow,
      state: draft.state,
      reason: draft.reason!,
      detail: draft.detail,
      partnerTransactionId: draft.partner?.txn.id ?? null,
      decisionId: draft.decisionId,
      candidates,
      effectCents: effect,
      lowCents: low,
      highCents: high,
      cashExcessCents: draft.cashExcessCents,
      cardExcessCents: draft.cardExcessCents,
      recent: asOfDay - leg.day < RECENT_LABEL_DAYS,
    });
  }

  return {
    userId,
    legs: results,
    decisions: [...decisionResults.values()].sort((x, y) => cmp(x.decisionId, y.decisionId)),
    supersededTransactionIds: [...superseded].sort(cmp),
  };
}

function lineageDetail(lineages: Lineage[]): InactiveDetail | null {
  if (lineages.some((l) => l.kind === 'ambiguous')) return 'lineage_ambiguous';
  if (lineages.some((l) => l.kind === 'gone')) return 'partner_gone';
  if (lineages.some((l) => l.kind === 'waiting')) return 'waiting_to_post';
  return null;
}

/**
 * Reciprocal pairing (the Phase A / slice 1 rule): a leg's best candidate is the closest-dated one;
 * a tie at the best distance is ambiguous; a pair stands only when each leg is the other's best.
 * Returns leg id → partner leg for every paired leg. Order-independent.
 */
function pairReciprocally(pool: Leg[], isCandidate: (x: Leg, y: Leg) => boolean): Map<string, Leg> {
  const best = new Map<string, Leg | null>();
  const bestFor = (leg: Leg): Leg | null => {
    if (best.has(leg.txn.id)) return best.get(leg.txn.id)!;
    const candidates = pool.filter((other) => isCandidate(leg, other));
    let result: Leg | null = null;
    if (candidates.length > 0) {
      const distances = candidates.map((c) => Math.abs(c.day - leg.day));
      const min = Math.min(...distances);
      const closest = candidates.filter((_, i) => distances[i] === min);
      result = closest.length === 1 ? closest[0] : null;
    }
    best.set(leg.txn.id, result);
    return result;
  };
  const paired = new Map<string, Leg>();
  for (const leg of pool) {
    const mine = bestFor(leg);
    if (mine === null) continue;
    const theirs = bestFor(mine);
    if (theirs !== null && theirs.txn.id === leg.txn.id) {
      paired.set(leg.txn.id, mine);
      paired.set(mine.txn.id, leg);
    }
  }
  return paired;
}

// ---- Period summary (§5, §6.2) ------------------------------------------------------------------

export interface CardPaymentPeriodSummary {
  /** Sum of every counted cash-side leg's lower / upper bound in the period. */
  lowCents: number;
  highCents: number;
  /** True when nothing counted in the period is unresolved (then low = high). */
  resolved: boolean;
  unresolvedCount: number;
  unresolvedPaymentsCents: number;
  unresolvedReturnsCents: number;
  byReason: Partial<Record<CardLegReason, number>>;
}

/**
 * Card-payment contribution to one period's cash flow, as a range. Each leg counts only in its own
 * date's period — a payment and a return in different periods never cancel (payment-and-return
 * shortcut deferred). `period` is half-open [start, end), YYYY-MM-DD.
 */
export function summarizeCardPaymentPeriod(
  evaluation: CardPaymentEvaluation,
  period: { start: string; end: string }
): CardPaymentPeriodSummary {
  dayNumber(period.start, 'period.start');
  dayNumber(period.end, 'period.end');
  const summary: CardPaymentPeriodSummary = {
    lowCents: 0,
    highCents: 0,
    resolved: true,
    unresolvedCount: 0,
    unresolvedPaymentsCents: 0,
    unresolvedReturnsCents: 0,
    byReason: {},
  };
  for (const leg of evaluation.legs) {
    if (leg.side !== 'cash' || !leg.accountIncluded) continue;
    if (!(leg.date >= period.start && leg.date < period.end)) continue;
    summary.lowCents += leg.lowCents;
    summary.highCents += leg.highCents;
    if (leg.state === 'unresolved') {
      summary.resolved = false;
      summary.unresolvedCount += 1;
      if (leg.direction === 'payment') summary.unresolvedPaymentsCents += Math.abs(leg.amountCents);
      else summary.unresolvedReturnsCents += Math.abs(leg.amountCents);
      summary.byReason[leg.reason] = (summary.byReason[leg.reason] ?? 0) + 1;
    }
  }
  return summary;
}

/**
 * Evaluates every user present in `accounts` independently (mixed-user input). No evidence, pair or
 * decision ever crosses users: each evaluation sees only its own user's accounts and rows.
 */
export function evaluateCardPaymentsForAllUsers(
  input: Omit<CardPaymentMatchingInput, 'userId'>
): CardPaymentEvaluation[] {
  const users = [...new Set(input.accounts.map((a) => a.userId))].sort(cmp);
  return users.map((userId) => evaluateCardPayments({ ...input, userId }));
}
