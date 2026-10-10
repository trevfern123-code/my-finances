/**
 * Financial Semantics Phase B — the pure, role-aware aggregation module
 * (FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §3, §4, §5, §7.3).
 *
 * Pure: no I/O. `semanticReadPath.ts` feeds it from ONE coherent database snapshot — the
 * transactions, their splits and the stored card-payment matching states read in a single statement
 * (`financialSnapshot.ts`). Its figures are published in NEW response fields only (design
 * §6.4): every existing calculation (`getSpendingSummary`, `aggregateByMonth`,
 * `getCategorySpendRows`/`aggregateSpendByCategory`) keeps its sign-based meaning.
 *
 * Every dollar goes through `getSemanticEffects()` — the Phase A aggregation contract — so a
 * manual-loan-linked payment contributes its principal as a debt payment and its interest as
 * spending, never the whole amount as either (design §4.4). The rules implemented here:
 *
 *  - §4.1 effect → aggregate mapping, the tracked-set principle, R0 (a NULL effective role falls back
 *    to its sign and is COUNTED as unclassified) and R9 (an impossible loan-linked row is an
 *    integrity failure that names the row — never a clamped, plausible-looking number).
 *  - §4.2 transfers: an `internal_transfer` leg is internal (contributes 0) when it pairs with a
 *    reciprocal opposite leg on another INCLUDED account within ±3 days; otherwise it is an external
 *    transfer, counted in cash flow with its sign, never as spending or income.
 *  - §4.3 card payments are NOT paired here. Every card-payment leg arrives with its STORED matching
 *    state (CARD_PAYMENT_PAIRING_DESIGN.md §3.2, §5): the caller reads the states through
 *    `get_card_payment_states` and passes them as `cardPayments`. A CASH-side leg (on a non-credit
 *    account — the money) is the only kind that can move tracked cash:
 *      tracked    → 0, except a fee pair's cash excess, which counts like an unpaired cash leg
 *      untracked  → payment out: subtracted · payment returned into the account: added
 *      unresolved → NOT guessed: the leg contributes its two possible effects as a RANGE, and the
 *                   period has no single cash-flow figure until it is resolved (decision T1)
 *    A CREDIT-side leg (on a `credit` account — the liability) never moves cash flow (D5). One whose
 *    cash side is ESTABLISHED to be outside the tracked set (paid from an excluded account, or the card
 *    excess of a fee pair) is reported as externally funded (−) or reversed externally (+). One the
 *    stored state calls `unresolved` asserts nothing about the source of funds: it is reported only as
 *    an unresolved card credit.
 *    A card leg with no stored state is an integrity failure — it is never read as untracked.
 *  - §4.5 refunds reduce spending in their own month and category; §4.6 splits inherit the parent's
 *    single role and are ignored for loan-decomposed parents; §5 C5 manual-loan interest appears in
 *    the Monthly Breakdown under the synthetic `LOAN_INTEREST` category.
 *
 * Rows on accounts excluded from cash flow are dropped before anything else: they are neither
 * aggregated nor partner candidates (design §4.1).
 *
 * FETCHED-CONTEXT CONTRACT (transfers). Callers pass every row in `pairingContextRange(period)` — the
 * period padded by `PAIRING_PAD_DAYS` on each side. Rows outside the period are only ever pairing
 * evidence. Card payments need no padding: their states come from the user's whole history.
 * The pad is TWICE the transfer matching window, because reciprocal matching is two hops deep: an
 * in-period leg's candidates lie within one window of it, and deciding whether a candidate's OWN
 * best match is that leg (or a tie with a competitor) needs the candidate's candidates, up to a
 * second window further out. With this pad the in-period result is identical to the result over
 * complete surrounding history; with only one window of padding, an out-of-range competitor that
 * makes a match ambiguous is missed and the leg is wrongly paired (design §4.2/§4.3, §9.1).
 *
 * All arithmetic is in integer cents; every figure is converted back to dollars once, at the end.
 */

import { roundToCents } from './money';
import { getSemanticEffects, SemanticIntegrityError, type SemanticEffect } from './semanticEffects';
import type { SemanticRole } from './transactionClassifier';

// ---- Public input types ------------------------------------------------------------------------

export interface AggregationAccount {
  id: string;
  /** Plaid account type (`depository`, `credit`, `loan`, …) — only `credit` matters here: it is the
   *  account a card-payment's card leg must be on to track the payment. */
  type: string | null;
  /** `accounts.exclude_from_cash_flow`. Rows on such accounts are ignored entirely. */
  excludeFromCashFlow: boolean;
}

export interface AggregationTransaction {
  id: string;
  accountId: string;
  /** YYYY-MM-DD (the plain SQL `date`). */
  date: string;
  /** Plaid sign convention: positive = money out, negative = money in. */
  amount: number;
  /** Plaid's primary category (`transactions.category`) — the Monthly Breakdown's grouping key. */
  plaidCategory: string | null;
  budgetCategoryId: string | null;
  /** `transactions.effective_role` (`coalesce(user_role_override, auto_role)`); null when the row
   *  has never been classified (R0). */
  effectiveRole: string | null;
  userRoleOverride: string | null;
  manualLoanId: string | null;
  principalPortion: number | null;
}

export interface AggregationSplit {
  id: string;
  transactionId: string;
  budgetCategoryId: string;
  amount: number;
}

/** A reporting period, [start, end) in YYYY-MM-DD — the same half-open convention as
 *  `budgetPeriod.ts`'s ranges. Omitted: every non-padding row counts. */
export interface AggregationPeriod {
  start: string;
  end: string;
}

export interface AggregationInput {
  accounts: AggregationAccount[];
  transactions: AggregationTransaction[];
  period?: AggregationPeriod;
}

/**
 * One card-payment leg's stored matching state, in the shape `get_card_payment_states` returns it
 * (CARD_PAYMENT_PAIRING_DESIGN.md §3.5). The reference evaluator's `CardLegResult` is assignable to
 * it, so tests can feed this module from the same oracle the SQL evaluator is checked against.
 */
export interface CardLegStateInput {
  transactionId: string;
  accountId: string;
  amountCents: number;
  /** `cash` or `credit`. */
  side: string;
  /** The leg's own account is included in cash flow. */
  accountIncluded: boolean;
  /** `tracked` | `untracked` | `unresolved` (cash side); `paired` | `funded_from_excluded` |
   *  `unresolved` (credit side); `not_counted` (a leg on an excluded account — never aggregated). */
  state: string;
  /** Why. For an unresolved leg this is the key of `cardPaymentsUnresolved.byReason`; since packet 2-A it can
   *  be `relink_review_required` (the relink-review guard withheld the leg's automatic pair). The aggregation
   *  does not interpret it: an unresolved cash leg is its range, whatever the reason. */
  reason: string;
  /** The resolved effect on cash flow in cents; null while a counted cash-side leg is unresolved. */
  effectCents: number | null;
  lowCents: number;
  highCents: number;
  cashExcessCents: number;
  cardExcessCents: number;
}

/** The stored states the card-dependent aggregates need. They must describe exactly the version of
 *  the inputs the `transactions` were read at — that is the read protocol's job, not this module's. */
/** The review state of one leg (packet 2-A; `get_card_payment_states` → `reviews`): it is an affected
 *  payment of an institution removal, or the relink-review guard withheld its automatic pair. */
export interface CardLegReviewInput {
  transactionId: string;
  guardWithheld: boolean;
  withheldPartnerTransactionId: string | null;
  obligationIds: string[];
  coverageGap: boolean;
}

export interface CardPaymentStates {
  legs: CardLegStateInput[];
  /** Present when the database carries the evaluator contract of 20261009120000. No aggregate reads it: a
   *  withheld leg's uncertainty is already in its own state and bounds. It is carried so that one snapshot
   *  holds everything a reader needs to say which figures are under review. */
  reviews?: CardLegReviewInput[];
  /** Pending rows replaced by a posted row that is still present (pairing design §3.6): they have no
   *  state and are not counted. */
  supersededTransactionIds: string[];
}

/** Input of every card-dependent aggregate (cash flow, the Monthly Breakdown's excluded lines). */
export interface CashFlowInput extends AggregationInput {
  cardPayments: CardPaymentStates;
}

// ---- Public output types -----------------------------------------------------------------------

/** Every published figure of design §4.1 / §5 C1–C4. Money is in dollars, cent-exact. */
export interface CashFlowTotals {
  /** Σ income effects, as a positive magnitude (a positive row overridden to income reduces it). */
  income: number;
  /** Σ expense + refund effects, signed (refunds negative, refund reversals positive). */
  spending: number;
  /** Σ debt-payment effects: known manual-loan principal + whole Plaid-categorised loan payments. */
  debtPayments: number;
  /** The manual-loan-linked principal inside `debtPayments` — exactly known. */
  knownPrincipal: number;
  /** `debtPayments − knownPrincipal`: loan payments whose principal share is unknown (design §4.4). */
  debtPaymentsUnknownPrincipal: number;
  /** Paired transfers inside the tracked set, reported by the outgoing leg's magnitude. */
  transfersInternal: number;
  /** Unpaired transfer legs, signed as cash (out negative, in positive); counted in cash flow. */
  transfersExternal: number;
  /** Tracked card payments, by the matched part of the cash leg (net zero in cash flow). */
  creditCardPaymentsTracked: number;
  /** Cash-side payments out whose destination is established to be outside the included cards (an
   *  excluded card, no included card, a confirmed unlinked or removed card), plus a fee pair's cash
   *  excess: subtracted in cash flow. */
  creditCardPaymentsUntracked: number;
  /** Tracked returns: a cash-side −leg matched with the card's +leg (net zero in cash flow). */
  creditCardPaymentsReturnedTracked: number;
  /** Cash-side −legs established as returned from outside the included cards: ADDED in cash flow (the
   *  cash arrived). The counterpart of `creditCardPaymentsUntracked`, so a payment and its return net
   *  to zero. */
  creditCardPaymentsReturnedUntracked: number;
  /** Credit-side −legs whose cash side is ESTABLISHED to be outside the tracked set: the card was paid
   *  from an account excluded from cash flow, or this is the card excess of a fee pair. Informational,
   *  never in cash flow. An unresolved credit-side leg is NOT here (see `cardPaymentsUnresolvedCredit`). */
  creditCardPaymentsExternallyFunded: number;
  /** The same for credit-side +legs (a payment reversed on the card): informational. */
  creditCardPaymentsReversedExternally: number;
  /** "Unresolved card credits": credit-side legs whose stored state is `unresolved`. Informational only
   *  — it asserts nothing about where the money came from, and its cash-flow effect is zero (D5). The
   *  signed net of those legs as credits to the card: a payment into the card counts +, a reversal −. */
  cardPaymentsUnresolvedCredit: number;
  /** Σ refund effects, signed (refunds negative, reversals positive). Already inside `spending`. */
  refunds: number;
  /** Income − Spending − Debt payments − Untracked card outflows + Untracked card returns
   *  + External transfers. A single number ONLY when no cash-side card leg in the period is
   *  unresolved; otherwise null and `cashFlowRange` holds the two possible figures (decision T1). */
  cashFlow: number | null;
  /** The bounds of cash flow. `high − low` = Σ |unresolved cash-side card legs|; equal when resolved. */
  cashFlowRange: { low: number; high: number };
  /** (Cash flow + Known principal) / Income, or 0 when Income ≤ 0 (design §4.1 R-definitions). Null
   *  exactly when `cashFlow` is. */
  savingsRate: number | null;
  savingsRateRange: { low: number; high: number };
  /** The cash-side card legs whose destination is not established (pairing design §3.2, §5). They are
   *  in NO other card-payment total above. */
  cardPaymentsUnresolved: {
    count: number;
    /** Σ |amount| of unresolved payments out. */
    paymentsAmount: number;
    /** Σ |amount| of unresolved returns. */
    returnsAmount: number;
    byReason: Record<string, number>;
  };
  /** Rows with a NULL effective role, counted by their sign fallback (R0). */
  unclassifiedCount: number;
  /** The SIGNED NET of those rows' amounts, Plaid convention (+ out, − in): an unclassified $45
   *  purchase and an unclassified $20 deposit give 25. Read together with `unclassifiedCount`. */
  unclassifiedAmount: number;
}

export interface MonthlyCashFlow extends CashFlowTotals {
  /** YYYY-MM */
  month: string;
}

/** One contribution to a bucket total — what a drill-down lists (design §7.3). */
export interface EffectRow {
  transactionId: string;
  date: string;
  effectRole: SemanticRole;
  /** Dollars, Plaid-signed (a refund is negative). */
  amount: number;
  allocation: 'row' | 'split' | 'interest' | 'principal';
  splitId?: string;
}

/** One drill-down measure per published cash-flow total (design §7.3). An effect row's `amount` under
 *  a measure is its contribution to that total, in the total's own sign convention, so the rows of a
 *  measure sum exactly to the figure they explain. */
export const CASH_FLOW_MEASURES = [
  'spending',
  'income',
  'debt_payments',
  'known_principal',
  'debt_payments_unknown_principal',
  'refunds',
  'transfers_internal',
  'transfers_external',
  'credit_card_payments_tracked',
  'credit_card_payments_untracked',
  'credit_card_payments_returned_tracked',
  'credit_card_payments_returned_untracked',
  'credit_card_payments_externally_funded',
  'credit_card_payments_reversed_externally',
  'card_payments_unresolved_credit',
  'card_payments_unresolved_payments',
  'card_payments_unresolved_returns',
  'unclassified',
] as const;
export type CashFlowMeasure = (typeof CASH_FLOW_MEASURES)[number];

export interface CashFlowDetail {
  totals: CashFlowTotals;
  /** Every measure is present (possibly empty). */
  effectRows: Map<CashFlowMeasure, EffectRow[]>;
}

export interface BudgetSpend {
  /** Signed spending per budget category (can be negative after a refund — never clamped). */
  byCategory: Map<string, number>;
  /** Spending with no budget category. */
  unassigned: number;
  /** Σ of every allocation (by category + unassigned). */
  total: number;
  /** Contributions per bucket; the key is a category id, or null for unassigned. */
  effectRows: Map<string | null, EffectRow[]>;
}

export const LOAN_INTEREST_CATEGORY = 'LOAN_INTEREST';
export const UNCATEGORIZED_PLAID_CATEGORY = 'Uncategorized';

export interface MonthlyBreakdownSemantic {
  month: string;
  spending: number;
  income: number;
  /** Signed spending per Plaid primary category; manual-loan interest under `LOAN_INTEREST`. */
  byCategory: Map<string, number>;
  excluded: {
    transfersInternal: number;
    transfersExternal: number;
    creditCardPaymentsTracked: number;
    creditCardPaymentsUntracked: number;
    creditCardPaymentsReturnedUntracked: number;
    debtPayments: number;
    /** Card payments whose destination is not established: in neither card line above. */
    cardPaymentsUnresolved: CashFlowTotals['cardPaymentsUnresolved'];
  };
  effectRows: Map<string, EffectRow[]>;
}

/** Role-aware spending of a period grouped by Plaid primary category — the bucket totals a Monthly
 *  Breakdown drill-down reconciles to (design §7.3). */
export interface PlaidCategorySpend {
  /** Signed spending per Plaid primary category; manual-loan interest under `LOAN_INTEREST`. */
  byCategory: Map<string, number>;
  total: number;
  effectRows: Map<string, EffectRow[]>;
}

// ---- Errors ------------------------------------------------------------------------------------

/**
 * R9: an integrity failure while aggregating — a manual-loan-linked row whose amount/principal is
 * impossible (from `getSemanticEffects`), a non-finite amount, or a role value outside the six
 * Phase A roles. Carries the offending row's id (the caller's own row — the API layer may relay it
 * as `{ code: 'semantic_integrity_error', transaction_id }`). Extends `SemanticIntegrityError` so
 * existing `instanceof` handling still applies. The whole aggregate fails: no partial totals.
 */
export class SemanticAggregationIntegrityError extends SemanticIntegrityError {
  constructor(
    readonly transactionId: string,
    message: string
  ) {
    super(`semantic_integrity_error: transaction ${transactionId}: ${message}`);
  }
}

/**
 * Trevor's decision on design §13 Q3: when a spending-eligible transaction's splits do not sum to it
 * in integer cents, the BUDGET aggregate is refused until the splits are corrected — stored splits
 * are never modified and no unassigned adjustment is invented. Deliberately NOT a
 * `SemanticIntegrityError`: this is a budget-allocation problem, not loan data, and must not be
 * shown as one. Only `aggregateBudgetSpend` raises it; cash flow and the Monthly Breakdown (which
 * never read splits) stay available. `transactionId` is the first affected row; every affected row
 * is in `mismatches`.
 */
export class SplitAllocationMismatchError extends Error {
  readonly code = 'split_allocation_mismatch';
  readonly transactionId: string;
  constructor(readonly mismatches: { transactionId: string; parentAmount: number; splitTotal: number }[]) {
    const first = mismatches[0];
    super(
      `split_allocation_mismatch: transaction ${first.transactionId}: its splits total ${first.splitTotal.toFixed(2)} but the ` +
        `transaction is ${first.parentAmount.toFixed(2)}` +
        (mismatches.length > 1 ? ` (and ${mismatches.length - 1} more)` : '') +
        '; budget figures are paused until the splits are corrected'
    );
    this.transactionId = first.transactionId;
  }
}

/**
 * A card-payment leg whose stored matching state is missing or does not describe the row it is keyed
 * to (CARD_PAYMENT_PAIRING_DESIGN.md §3.2: "No state means unresolved … a missing state is an
 * integrity failure, reported as such. It is never read as untracked."). The whole aggregate fails: no
 * partial totals, and no fallback to in-module pairing. Deliberately NOT a `SemanticIntegrityError`:
 * that one is presented as a loan-data problem.
 */
export class CardPaymentStateIntegrityError extends Error {
  readonly code = 'card_payment_state_integrity';
  constructor(
    readonly transactionId: string,
    message: string
  ) {
    super(`card_payment_state_integrity: transaction ${transactionId}: ${message}`);
  }
}

// ---- Constants ---------------------------------------------------------------------------------

/** Same window Phase A reconciliation pairs transfers with (`TRANSFER_WINDOW_DAYS`). */
export const TRANSFER_PAIR_WINDOW_DAYS = 3;
/** How far outside the reporting period a caller must fetch rows: TWO transfer windows (reciprocal
 *  matching is two hops deep — see the fetched-context contract above). Card payments no longer
 *  contribute to it: their matching runs over the whole history in the database evaluator
 *  (CARD_PAYMENT_PAIRING_DESIGN.md §5). */
export const PAIRING_PAD_DAYS = 2 * TRANSFER_PAIR_WINDOW_DAYS;

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The rows a caller must supply for `period`: [start − PAIRING_PAD_DAYS, end + PAIRING_PAD_DAYS),
 *  the same half-open convention as the period. */
export function pairingContextRange(period: AggregationPeriod): AggregationPeriod {
  return { start: shiftDate(period.start, -PAIRING_PAD_DAYS), end: shiftDate(period.end, PAIRING_PAD_DAYS) };
}

const SEMANTIC_ROLES: ReadonlySet<string> = new Set<SemanticRole>([
  'expense',
  'income',
  'internal_transfer',
  'credit_card_payment',
  'debt_payment',
  'refund',
]);

// ---- Row resolution ----------------------------------------------------------------------------

type PairStatus = 'none' | 'paired' | 'unpaired';

/** How a card-payment leg counts, read from its stored state. Cents are magnitudes. */
export type CardLegTreatment =
  /** Cash side, destination established. `trackedCents + untrackedCents` = |amount|. */
  | { kind: 'cash_resolved'; direction: 'payment' | 'return'; trackedCents: number; untrackedCents: number }
  /** Cash side, destination not established: the effect is one of `lowCents` / `highCents`. */
  | { kind: 'cash_unresolved'; direction: 'payment' | 'return'; lowCents: number; highCents: number; reason: string }
  /** Credit side: never in cash flow. `outsideCents` is established to have its cash side outside the
   *  tracked set; `unresolvedCents` is not established either way. */
  | { kind: 'credit'; direction: 'payment' | 'return'; outsideCents: number; unresolvedCents: number }
  /** A pending row superseded by its posted replacement, or a zero-amount row: not a card leg. */
  | { kind: 'not_a_leg' };

interface CentEffect {
  role: SemanticRole;
  cents: number;
  /** True for the two effects of a manual-loan decomposition (no override). */
  fromLoanDecomposition: boolean;
}

export interface ResolvedRow {
  txn: AggregationTransaction;
  account: AggregationAccount;
  amountCents: number;
  /** The effective role, or its sign fallback when unclassified. */
  role: SemanticRole;
  unclassified: boolean;
  effects: CentEffect[];
  /** Loan-linked without an override: two effects, splits ignored (design §4.6). */
  loanDecomposed: boolean;
  inPeriod: boolean;
  /** For internal_transfer rows: whether a reciprocal partner was found. */
  pair: PairStatus;
  /** For in-period credit_card_payment rows of a card-dependent aggregate: the stored treatment.
   *  Null for every other row, and for every row of an aggregate that does not read card states. */
  card: CardLegTreatment | null;
}

function toCents(dollars: number): number {
  return Math.round(roundToCents(dollars) * 100);
}

function toDollars(cents: number): number {
  return roundToCents(cents / 100);
}

function assertRole(txn: AggregationTransaction, value: string | null, field: string): SemanticRole | null {
  if (value === null) return null;
  if (!SEMANTIC_ROLES.has(value)) {
    throw new SemanticAggregationIntegrityError(txn.id, `${field} '${value}' is not a Phase A semantic role`);
  }
  return value as SemanticRole;
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / msPerDay;
}

function inPeriod(date: string, period: AggregationPeriod | undefined): boolean {
  return period === undefined || (date >= period.start && date < period.end);
}

function resolveRow(txn: AggregationTransaction, account: AggregationAccount, period?: AggregationPeriod): ResolvedRow {
  if (!Number.isFinite(txn.amount)) {
    throw new SemanticAggregationIntegrityError(txn.id, `amount must be a finite number (got ${txn.amount})`);
  }
  const effectiveRole = assertRole(txn, txn.effectiveRole, 'effective_role');
  const override = assertRole(txn, txn.userRoleOverride, 'user_role_override');
  const unclassified = effectiveRole === null;
  // R0: an unclassified row counts exactly as today's sign-based view would count it.
  const role: SemanticRole = effectiveRole ?? (txn.amount > 0 ? 'expense' : 'income');

  let effects: SemanticEffect[];
  try {
    effects = getSemanticEffects({
      amount: txn.amount,
      effectiveRole: role,
      manualLoanId: txn.manualLoanId,
      principalPortion: txn.principalPortion,
      userRoleOverride: override,
    });
  } catch (err) {
    if (err instanceof SemanticIntegrityError) {
      throw new SemanticAggregationIntegrityError(txn.id, err.message);
    }
    throw err;
  }

  const loanDecomposed = txn.manualLoanId !== null && override === null;
  return {
    txn,
    account,
    amountCents: toCents(txn.amount),
    role,
    unclassified,
    effects: effects.map((e) => ({ role: e.role, cents: toCents(e.amount), fromLoanDecomposition: loanDecomposed })),
    loanDecomposed,
    inPeriod: inPeriod(txn.date, period),
    pair: 'none',
    card: null,
  };
}

// ---- Reciprocal pairing (design §4.2, §4.3) ----------------------------------------------------

/**
 * Pairs legs reciprocally, the same shape as Phase A's `computeReciprocalTransferResolution` and
 * `rankTransferCandidates`: a leg's best candidate is the closest-dated one; a tie at the best
 * distance is ambiguous (no pair — never guessed); a pair stands only when each leg is the other's
 * own best candidate. Pure and order-independent: every decision reads the same candidate lists.
 */
function pairReciprocally(
  legs: ResolvedRow[],
  isCandidate: (leg: ResolvedRow, other: ResolvedRow) => boolean
): Set<string> {
  const best = new Map<string, ResolvedRow | 'ambiguous' | null>();
  function bestFor(leg: ResolvedRow): ResolvedRow | 'ambiguous' | null {
    if (best.has(leg.txn.id)) return best.get(leg.txn.id)!;
    const candidates = legs.filter((other) => other !== leg && isCandidate(leg, other));
    let result: ResolvedRow | 'ambiguous' | null = null;
    if (candidates.length > 0) {
      const distances = candidates.map((c) => daysBetween(leg.txn.date, c.txn.date));
      const minDistance = Math.min(...distances);
      const closest = candidates.filter((_, i) => distances[i] === minDistance);
      result = closest.length === 1 ? closest[0] : 'ambiguous';
    }
    best.set(leg.txn.id, result);
    return result;
  }

  const paired = new Set<string>();
  for (const leg of legs) {
    const mine = bestFor(leg);
    if (mine === null || mine === 'ambiguous') continue;
    const theirs = bestFor(mine);
    if (theirs !== null && theirs !== 'ambiguous' && theirs.txn.id === leg.txn.id) {
      paired.add(leg.txn.id);
      paired.add(mine.txn.id);
    }
  }
  return paired;
}

/** A card-payment leg on a credit account is the liability side; any other account holds cash. */
function isCreditSide(row: ResolvedRow): boolean {
  return row.account.type === 'credit';
}

function resolvePairs(rows: ResolvedRow[]): void {
  // Transfers: both legs must carry the internal_transfer role (a leg whose other side is still
  // classified as income/expense is not a pair — design §13 Q2).
  const transferLegs = rows.filter((r) => r.role === 'internal_transfer' && r.amountCents !== 0);
  const pairedTransfers = pairReciprocally(
    transferLegs,
    (leg, other) =>
      other.amountCents === -leg.amountCents &&
      other.txn.accountId !== leg.txn.accountId &&
      daysBetween(leg.txn.date, other.txn.date) <= TRANSFER_PAIR_WINDOW_DAYS
  );
  for (const leg of transferLegs) leg.pair = pairedTransfers.has(leg.txn.id) ? 'paired' : 'unpaired';
}

// ---- Card payments from stored states (CARD_PAYMENT_PAIRING_DESIGN.md §3.2, §4.3, §5) -----------

interface CardStateIndex {
  byId: Map<string, CardLegStateInput>;
  superseded: Set<string>;
}

function indexCardStates(states: CardPaymentStates): CardStateIndex {
  const byId = new Map<string, CardLegStateInput>();
  for (const leg of states.legs) {
    if (byId.has(leg.transactionId)) {
      throw new CardPaymentStateIntegrityError(leg.transactionId, 'more than one stored matching state for this leg');
    }
    byId.set(leg.transactionId, leg);
  }
  return { byId, superseded: new Set(states.supersededTransactionIds) };
}

/**
 * Reads one in-period card-payment row's treatment from its stored state. Nothing is inferred: a
 * missing state, or one that does not describe this row (another amount, account or side — which
 * would mean the rows and the states are not one version), fails the aggregate.
 */
function resolveCardLeg(row: ResolvedRow, cards: CardStateIndex): CardLegTreatment {
  const id = row.txn.id;
  // A zero-amount row is not a card leg and has no state (as in slice 1; matching handoff §5 Q10).
  if (row.amountCents === 0) return { kind: 'not_a_leg' };
  if (cards.superseded.has(id)) return { kind: 'not_a_leg' };
  const state = cards.byId.get(id);
  const fail = (message: string): never => {
    throw new CardPaymentStateIntegrityError(id, message);
  };
  if (state === undefined) return fail('no stored matching state for this card-payment leg');
  if (state.amountCents !== row.amountCents) return fail('the stored state is for a different amount');
  if (state.accountId !== row.txn.accountId) return fail('the stored state is for a different account');
  const creditSide = isCreditSide(row);
  if (state.side !== (creditSide ? 'credit' : 'cash')) return fail(`the stored state is on the '${state.side}' side`);
  if (state.accountIncluded !== true) return fail('the stored state says the account is excluded from cash flow');
  const magnitude = Math.abs(row.amountCents);

  if (creditSide) {
    // Credit side (D5): labelled only. A payment INTO the card is negative, a reversal positive.
    const direction = row.amountCents < 0 ? 'payment' : 'return';
    if (state.effectCents !== 0) return fail('a credit-side leg must have a zero effect');
    if (state.state === 'paired') {
      const excess = state.cardExcessCents;
      if (!Number.isInteger(excess) || excess < 0 || excess > magnitude) return fail('the card excess is out of range');
      return { kind: 'credit', direction, outsideCents: excess, unresolvedCents: 0 };
    }
    // Paired with a cash leg on an account excluded from cash flow: established to be outside the
    // tracked set (decision T5 makes that leg evidence).
    if (state.state === 'funded_from_excluded') return { kind: 'credit', direction, outsideCents: magnitude, unresolvedCents: 0 };
    // Not established: no source of funds is asserted.
    if (state.state === 'unresolved') return { kind: 'credit', direction, outsideCents: 0, unresolvedCents: magnitude };
    return fail(`'${state.state}' is not a credit-side state`);
  }

  const direction = row.amountCents > 0 ? 'payment' : 'return';
  if (state.state === 'unresolved') {
    const low = Math.min(0, -row.amountCents);
    const high = Math.max(0, -row.amountCents);
    if (state.effectCents !== null || state.lowCents !== low || state.highCents !== high) {
      return fail('an unresolved leg must carry no effect and the bounds {0, −amount}');
    }
    return { kind: 'cash_unresolved', direction, lowCents: low, highCents: high, reason: state.reason };
  }
  if (state.state === 'tracked' || state.state === 'untracked') {
    const effect = state.effectCents;
    if (effect === null || !Number.isInteger(effect)) return fail('a resolved leg must carry an integer effect');
    // A payment can only take cash out (−amount … 0), a return can only bring it in (0 … +|amount|).
    const inRange = direction === 'payment' ? effect <= 0 && effect >= -magnitude : effect >= 0 && effect <= magnitude;
    if (!inRange) return fail('the stored effect is outside the range this leg can have');
    const untracked = Math.abs(effect);
    if (state.state === 'untracked' && untracked !== magnitude) return fail('an untracked leg must count in full');
    // A tracked leg counts only by its cash excess — the part of a fee pair that never reached the card.
    if (state.state === 'tracked' && untracked !== state.cashExcessCents) return fail('a tracked leg must count exactly its cash excess');
    return { kind: 'cash_resolved', direction, trackedCents: magnitude - untracked, untrackedCents: untracked };
  }
  return fail(`'${state.state}' is not a cash-side state of an included account`);
}

function resolveAll(input: AggregationInput, cardPayments: CardPaymentStates | null): ResolvedRow[] {
  const accountsById = new Map(input.accounts.map((a) => [a.id, a]));
  const rows: ResolvedRow[] = [];
  for (const txn of input.transactions) {
    const account = accountsById.get(txn.accountId);
    if (!account) {
      throw new SemanticAggregationIntegrityError(txn.id, `account ${txn.accountId} was not supplied`);
    }
    if (account.excludeFromCashFlow) continue; // outside the tracked set: neither counted nor a candidate
    rows.push(resolveRow(txn, account, input.period));
  }
  resolvePairs(rows);
  if (cardPayments !== null) {
    const cards = indexCardStates(cardPayments);
    for (const row of rows) {
      // Only rows that are aggregated need a state; padding rows are transfer evidence only. And only
      // a row that contributes a card-payment EFFECT: a loan-decomposed row reports principal and
      // interest whatever its role says, so no card state is read for it.
      if (row.inPeriod && row.effects.some((effect) => effect.role === 'credit_card_payment')) {
        row.card = resolveCardLeg(row, cards);
      }
    }
  }
  return rows;
}

/** Resolves every row on an included account, pairs transfer legs across the full input (period +
 *  padding), and reads every in-period card-payment leg's treatment from its stored state. */
export function resolveRows(input: CashFlowInput): ResolvedRow[] {
  return resolveAll(input, input.cardPayments);
}

// ---- Cash flow (design §4.1, §5 C1–C4) ---------------------------------------------------------

interface CentTotals {
  income: number;
  spending: number;
  debtPayments: number;
  knownPrincipal: number;
  transfersInternal: number;
  transfersExternal: number;
  creditCardPaymentsTracked: number;
  creditCardPaymentsUntracked: number;
  creditCardPaymentsReturnedTracked: number;
  creditCardPaymentsReturnedUntracked: number;
  creditCardPaymentsExternallyFunded: number;
  creditCardPaymentsReversedExternally: number;
  cardPaymentsUnresolvedCredit: number;
  refunds: number;
  unclassifiedCount: number;
  unclassifiedAmount: number;
  /** Unresolved cash-side card legs: Σ of their lower and upper possible effects, and their sizes. */
  unresolvedLow: number;
  unresolvedHigh: number;
  unresolvedCount: number;
  unresolvedPayments: number;
  unresolvedReturns: number;
  unresolvedByReason: Map<string, number>;
}

function emptyCentTotals(): CentTotals {
  return {
    income: 0,
    spending: 0,
    debtPayments: 0,
    knownPrincipal: 0,
    transfersInternal: 0,
    transfersExternal: 0,
    creditCardPaymentsTracked: 0,
    creditCardPaymentsUntracked: 0,
    creditCardPaymentsReturnedTracked: 0,
    creditCardPaymentsReturnedUntracked: 0,
    creditCardPaymentsExternallyFunded: 0,
    creditCardPaymentsReversedExternally: 0,
    cardPaymentsUnresolvedCredit: 0,
    refunds: 0,
    unclassifiedCount: 0,
    unclassifiedAmount: 0,
    unresolvedLow: 0,
    unresolvedHigh: 0,
    unresolvedCount: 0,
    unresolvedPayments: 0,
    unresolvedReturns: 0,
    unresolvedByReason: new Map(),
  };
}

/** Receives each contribution a row makes to a published total, in that total's sign convention. */
type Emit = (measure: CashFlowMeasure, cents: number, role: SemanticRole, allocation: EffectRow['allocation']) => void;

function addRow(t: CentTotals, row: ResolvedRow, emit?: Emit): void {
  const add = (measure: CashFlowMeasure, cents: number, role: SemanticRole, allocation: EffectRow['allocation'] = 'row') => {
    if (cents !== 0) emit?.(measure, cents, role, allocation);
  };
  if (row.unclassified) {
    t.unclassifiedCount += 1;
    t.unclassifiedAmount += row.amountCents;
    // Listed even at zero, so the rows of this measure are exactly the rows counted.
    emit?.('unclassified', row.amountCents, row.role, 'row');
  }
  for (const effect of row.effects) {
    switch (effect.role) {
      case 'expense':
        t.spending += effect.cents;
        add('spending', effect.cents, 'expense', effect.fromLoanDecomposition ? 'interest' : 'row');
        break;
      case 'refund':
        t.spending += effect.cents;
        t.refunds += effect.cents;
        add('spending', effect.cents, 'refund');
        add('refunds', effect.cents, 'refund');
        break;
      case 'income':
        t.income -= effect.cents; // Plaid sign: money in is negative
        add('income', -effect.cents, 'income');
        break;
      case 'debt_payment':
        t.debtPayments += effect.cents;
        add('debt_payments', effect.cents, 'debt_payment', effect.fromLoanDecomposition ? 'principal' : 'row');
        if (effect.fromLoanDecomposition) {
          t.knownPrincipal += effect.cents;
          add('known_principal', effect.cents, 'debt_payment', 'principal');
        } else {
          // Published as debtPayments − knownPrincipal: exactly the debt-payment effects with no
          // manual-loan split behind them.
          add('debt_payments_unknown_principal', effect.cents, 'debt_payment');
        }
        break;
      case 'internal_transfer':
        if (row.pair === 'paired') {
          if (effect.cents > 0) {
            t.transfersInternal += effect.cents;
            add('transfers_internal', effect.cents, 'internal_transfer');
          }
        } else {
          t.transfersExternal -= effect.cents; // signed as cash: out negative, in positive
          add('transfers_external', -effect.cents, 'internal_transfer');
        }
        break;
      case 'credit_card_payment': {
        const card = row.card;
        if (card === null) {
          // Unreachable through the exported aggregates: every card-dependent one resolves the states
          // first. Refuse rather than count a card leg whose state was never read.
          throw new CardPaymentStateIntegrityError(row.txn.id, 'the card-payment state was not resolved');
        }
        const role = 'credit_card_payment';
        if (card.kind === 'cash_resolved') {
          // Cash side: the only legs that can move tracked cash.
          if (card.direction === 'payment') {
            t.creditCardPaymentsTracked += card.trackedCents;
            t.creditCardPaymentsUntracked += card.untrackedCents;
            add('credit_card_payments_tracked', card.trackedCents, role);
            add('credit_card_payments_untracked', card.untrackedCents, role);
          } else {
            t.creditCardPaymentsReturnedTracked += card.trackedCents;
            t.creditCardPaymentsReturnedUntracked += card.untrackedCents;
            add('credit_card_payments_returned_tracked', card.trackedCents, role);
            add('credit_card_payments_returned_untracked', card.untrackedCents, role);
          }
        } else if (card.kind === 'cash_unresolved') {
          // Not established: never counted as tracked or untracked. Both possible effects are kept.
          t.unresolvedLow += card.lowCents;
          t.unresolvedHigh += card.highCents;
          t.unresolvedCount += 1;
          if (card.direction === 'payment') {
            t.unresolvedPayments += Math.abs(row.amountCents);
            add('card_payments_unresolved_payments', Math.abs(row.amountCents), role);
          } else {
            t.unresolvedReturns += Math.abs(row.amountCents);
            add('card_payments_unresolved_returns', Math.abs(row.amountCents), role);
          }
          t.unresolvedByReason.set(card.reason, (t.unresolvedByReason.get(card.reason) ?? 0) + 1);
        } else if (card.kind === 'credit') {
          // Credit side: a liability moved, no tracked cash did (D5). What is ESTABLISHED to be outside
          // the tracked set is labelled so; what is not established is only "unresolved".
          if (card.direction === 'payment') {
            t.creditCardPaymentsExternallyFunded += card.outsideCents;
            add('credit_card_payments_externally_funded', card.outsideCents, role);
          } else {
            t.creditCardPaymentsReversedExternally += card.outsideCents;
            add('credit_card_payments_reversed_externally', card.outsideCents, role);
          }
          // Signed as a credit to the card: a payment into it +, a reversal −.
          const credit = card.direction === 'payment' ? card.unresolvedCents : -card.unresolvedCents;
          t.cardPaymentsUnresolvedCredit += credit;
          add('card_payments_unresolved_credit', credit, role);
        }
        break;
      }
    }
  }
}

function finish(t: CentTotals): CashFlowTotals {
  // Everything except the unresolved cash-side card legs, whose effect is one of two values each.
  const establishedCents =
    t.income -
    t.spending -
    t.debtPayments -
    t.creditCardPaymentsUntracked +
    t.creditCardPaymentsReturnedUntracked +
    t.transfersExternal;
  const lowCents = establishedCents + t.unresolvedLow;
  const highCents = establishedCents + t.unresolvedHigh;
  const resolved = t.unresolvedCount === 0;
  const rate = (cashFlowCents: number) => (t.income > 0 ? (cashFlowCents + t.knownPrincipal) / t.income : 0);
  return {
    income: toDollars(t.income),
    spending: toDollars(t.spending),
    debtPayments: toDollars(t.debtPayments),
    knownPrincipal: toDollars(t.knownPrincipal),
    debtPaymentsUnknownPrincipal: toDollars(t.debtPayments - t.knownPrincipal),
    transfersInternal: toDollars(t.transfersInternal),
    transfersExternal: toDollars(t.transfersExternal),
    creditCardPaymentsTracked: toDollars(t.creditCardPaymentsTracked),
    creditCardPaymentsUntracked: toDollars(t.creditCardPaymentsUntracked),
    creditCardPaymentsReturnedTracked: toDollars(t.creditCardPaymentsReturnedTracked),
    creditCardPaymentsReturnedUntracked: toDollars(t.creditCardPaymentsReturnedUntracked),
    creditCardPaymentsExternallyFunded: toDollars(t.creditCardPaymentsExternallyFunded),
    creditCardPaymentsReversedExternally: toDollars(t.creditCardPaymentsReversedExternally),
    cardPaymentsUnresolvedCredit: toDollars(t.cardPaymentsUnresolvedCredit),
    refunds: toDollars(t.refunds),
    cashFlow: resolved ? toDollars(establishedCents) : null,
    cashFlowRange: { low: toDollars(lowCents), high: toDollars(highCents) },
    savingsRate: resolved ? rate(establishedCents) : null,
    savingsRateRange: { low: rate(lowCents), high: rate(highCents) },
    cardPaymentsUnresolved: {
      count: t.unresolvedCount,
      paymentsAmount: toDollars(t.unresolvedPayments),
      returnsAmount: toDollars(t.unresolvedReturns),
      byReason: Object.fromEntries(Array.from(t.unresolvedByReason.entries()).sort(([a], [b]) => a.localeCompare(b))),
    },
    unclassifiedCount: t.unclassifiedCount,
    unclassifiedAmount: toDollars(t.unclassifiedAmount),
  };
}

/** The period's role-aware cash-flow figures (design §5 C1–C4). */
export function aggregateCashFlow(input: CashFlowInput): CashFlowTotals {
  const totals = emptyCentTotals();
  for (const row of resolveRows(input)) {
    if (row.inPeriod) addRow(totals, row);
  }
  return finish(totals);
}

/**
 * The same figures together with the effect rows behind each one (design §7.3): for every measure,
 * Σ `amount` over its rows = the published total, because both come from the same pass over the
 * same rows. An unresolved cash-side card leg is in no resolved card total; it is listed only under
 * the unresolved-amount measure of its direction, which is what `cardPaymentsUnresolved` publishes.
 */
export function aggregateCashFlowDetail(input: CashFlowInput): CashFlowDetail {
  const totals = emptyCentTotals();
  const effectRows = new Map<CashFlowMeasure, EffectRow[]>(CASH_FLOW_MEASURES.map((m) => [m, []]));
  for (const row of resolveRows(input)) {
    if (!row.inPeriod) continue;
    addRow(totals, row, (measure, cents, role, allocation) => {
      effectRows.get(measure)!.push({
        transactionId: row.txn.id,
        date: row.txn.date,
        effectRole: role,
        amount: toDollars(cents),
        allocation,
      });
    });
  }
  return { totals: finish(totals), effectRows };
}

/** The same figures per calendar month (YYYY-MM), ascending — the shape `monthly_spending[]` gains. */
export function aggregateCashFlowByMonth(input: CashFlowInput): MonthlyCashFlow[] {
  const byMonth = new Map<string, CentTotals>();
  for (const row of resolveRows(input)) {
    if (!row.inPeriod) continue;
    const month = row.txn.date.slice(0, 7);
    const totals = byMonth.get(month) ?? emptyCentTotals();
    addRow(totals, row);
    byMonth.set(month, totals);
  }
  return Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, totals]) => ({ month, ...finish(totals) }));
}

// ---- Budget spend (design §4.5, §4.6, §5 C6, §7.3) ---------------------------------------------

function pushEffectRow<K>(map: Map<K, EffectRow[]>, key: K, row: EffectRow): void {
  const list = map.get(key);
  if (list) list.push(row);
  else map.set(key, [row]);
}

/**
 * Role-aware spending per budget category: expense/refund effects only, signed. An unsplit row
 * goes to its own `budget_category_id`; a split parent goes through its splits (each split takes the
 * parent's single role); a manual-loan-linked row without an override contributes only its interest,
 * unassigned, and its splits are ignored. Transfers, card payments and debt payments contribute
 * nothing, split or not. Every allocation is also returned as an effect row, so a drill-down lists
 * exactly what the total adds up to.
 *
 * If any spending-eligible split parent's splits do not sum to it in integer cents (or a split amount
 * is not a finite number), the whole budget aggregate is refused with `SplitAllocationMismatchError`
 * naming every affected transaction (Trevor's decision on design §13 Q3). Splits on parents the role
 * rules exclude (transfers, card payments, debt payments, loan-decomposed rows) are never read, so
 * they cannot block the budget.
 */
export function aggregateBudgetSpend(input: AggregationInput & { splits: AggregationSplit[] }): BudgetSpend {
  const splitsByTxn = new Map<string, AggregationSplit[]>();
  for (const split of input.splits) {
    const list = splitsByTxn.get(split.transactionId);
    if (list) list.push(split);
    else splitsByTxn.set(split.transactionId, [split]);
  }

  const cents = new Map<string | null, number>();
  const effectRows = new Map<string | null, EffectRow[]>();
  const splitMismatches: SplitAllocationMismatchError['mismatches'] = [];
  const allocate =(key: string | null, amountCents: number, row: EffectRow) => {
    cents.set(key, (cents.get(key) ?? 0) + amountCents);
    pushEffectRow(effectRows, key, row);
  };

  // Budget spend never depends on a card-payment leg's state (card payments are never spending), so
  // it reads none.
  for (const row of resolveAll(input, null)) {
    if (!row.inPeriod) continue;
    const base = { transactionId: row.txn.id, date: row.txn.date };

    if (row.loanDecomposed) {
      for (const effect of row.effects) {
        if (effect.role !== 'expense') continue; // the principal is a debt payment
        allocate(null, effect.cents, { ...base, effectRole: 'expense', amount: toDollars(effect.cents), allocation: 'interest' });
      }
      continue;
    }

    const effect = row.effects[0];
    if (effect === undefined || (effect.role !== 'expense' && effect.role !== 'refund')) continue;

    const splits = splitsByTxn.get(row.txn.id) ?? [];
    if (splits.length === 0) {
      allocate(row.txn.budgetCategoryId, effect.cents, {
        ...base,
        effectRole: effect.role,
        amount: toDollars(effect.cents),
        allocation: 'row',
      });
      continue;
    }

    // Validate before allocating anything: a mismatched parent must not contribute a partial figure.
    const splitCents = splits.map((split) => (Number.isFinite(split.amount) ? toCents(split.amount) : Number.NaN));
    const splitTotal = splitCents.reduce((sum, c) => sum + c, 0);
    if (splitTotal !== effect.cents) {
      splitMismatches.push({
        transactionId: row.txn.id,
        parentAmount: toDollars(effect.cents),
        splitTotal: Number.isFinite(splitTotal) ? toDollars(splitTotal) : Number.NaN,
      });
      continue;
    }
    splits.forEach((split, i) =>
      allocate(split.budgetCategoryId, splitCents[i], {
        ...base,
        effectRole: effect.role,
        amount: toDollars(splitCents[i]),
        allocation: 'split',
        splitId: split.id,
      })
    );
  }

  if (splitMismatches.length > 0) throw new SplitAllocationMismatchError(splitMismatches);

  const byCategory = new Map<string, number>();
  let totalCents = 0;
  for (const [key, value] of cents) {
    totalCents += value;
    if (key !== null) byCategory.set(key, toDollars(value));
  }
  return {
    byCategory,
    unassigned: toDollars(cents.get(null) ?? 0),
    total: toDollars(totalCents),
    effectRows,
  };
}

// ---- Monthly Breakdown (design §5 C5, §7.3) ----------------------------------------------------

/** One row's spending contributions under the Monthly Breakdown's grouping: its expense and refund
 *  effects by Plaid primary category, a loan-decomposed row's interest under `LOAN_INTEREST`. The one
 *  place that rule lives, so the months' totals and a drill-down's rows cannot disagree. */
function plaidCategoryContributions(row: ResolvedRow): { key: string; cents: number; effectRow: EffectRow }[] {
  const contributions: { key: string; cents: number; effectRow: EffectRow }[] = [];
  for (const effect of row.effects) {
    if (effect.role !== 'expense' && effect.role !== 'refund') continue;
    const interest = row.loanDecomposed;
    contributions.push({
      key: interest ? LOAN_INTEREST_CATEGORY : row.txn.plaidCategory ?? UNCATEGORIZED_PLAID_CATEGORY,
      cents: effect.cents,
      effectRow: {
        transactionId: row.txn.id,
        date: row.txn.date,
        effectRole: effect.role,
        amount: toDollars(effect.cents),
        allocation: interest ? 'interest' : 'row',
      },
    });
  }
  return contributions;
}

/**
 * The period's role-aware spending by Plaid primary category, with the effect rows of each bucket.
 * Like the budget aggregate it reads no card-payment state: a card payment is never spending.
 */
export function aggregateSpendByPlaidCategory(input: AggregationInput): PlaidCategorySpend {
  const cents = new Map<string, number>();
  const effectRows = new Map<string, EffectRow[]>();
  for (const row of resolveAll(input, null)) {
    if (!row.inPeriod) continue;
    for (const contribution of plaidCategoryContributions(row)) {
      cents.set(contribution.key, (cents.get(contribution.key) ?? 0) + contribution.cents);
      pushEffectRow(effectRows, contribution.key, contribution.effectRow);
    }
  }
  let totalCents = 0;
  for (const value of cents.values()) totalCents += value;
  return {
    byCategory: new Map(Array.from(cents.entries()).map(([k, v]) => [k, toDollars(v)])),
    total: toDollars(totalCents),
    effectRows,
  };
}

/**
 * The `semantic` block each Monthly Breakdown month gains: role-aware spending grouped by Plaid
 * primary category (splits are never used here — unchanged from today), manual-loan interest under
 * `LOAN_INTEREST`, income, and the totals that were NOT counted as spending.
 */
export function aggregateMonthlyBreakdown(input: CashFlowInput): MonthlyBreakdownSemantic[] {
  interface MonthAcc {
    totals: CentTotals;
    byCategory: Map<string, number>;
    effectRows: Map<string, EffectRow[]>;
  }
  const months = new Map<string, MonthAcc>();

  for (const row of resolveRows(input)) {
    if (!row.inPeriod) continue;
    const month = row.txn.date.slice(0, 7);
    const acc = months.get(month) ?? { totals: emptyCentTotals(), byCategory: new Map(), effectRows: new Map() };
    months.set(month, acc);
    addRow(acc.totals, row);

    for (const contribution of plaidCategoryContributions(row)) {
      acc.byCategory.set(contribution.key, (acc.byCategory.get(contribution.key) ?? 0) + contribution.cents);
      pushEffectRow(acc.effectRows, contribution.key, contribution.effectRow);
    }
  }

  return Array.from(months.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, acc]) => {
      const t = finish(acc.totals);
      return {
        month,
        spending: t.spending,
        income: t.income,
        byCategory: new Map(Array.from(acc.byCategory.entries()).map(([k, v]) => [k, toDollars(v)])),
        excluded: {
          transfersInternal: t.transfersInternal,
          transfersExternal: t.transfersExternal,
          creditCardPaymentsTracked: t.creditCardPaymentsTracked,
          creditCardPaymentsUntracked: t.creditCardPaymentsUntracked,
          creditCardPaymentsReturnedUntracked: t.creditCardPaymentsReturnedUntracked,
          debtPayments: t.debtPayments,
          cardPaymentsUnresolved: t.cardPaymentsUnresolved,
        },
        effectRows: acc.effectRows,
      };
    });
}
