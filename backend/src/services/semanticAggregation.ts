/**
 * Financial Semantics Phase B — the pure, role-aware aggregation module
 * (FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §3, §4, §5, §7.3).
 *
 * NOT WIRED INTO ANY ENDPOINT YET (implementation slice 1). Nothing in the running application
 * imports this module; every existing calculation (`getSpendingSummary`, `aggregateByMonth`,
 * `getCategorySpendRows`/`aggregateSpendByCategory`) keeps its sign-based meaning. A later slice
 * feeds it from internally-paged fetches (`fetchAllPages.ts`) and publishes its figures in NEW
 * response fields only (design §6.4 — legacy fields are frozen).
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
 *  - §4.3 card payments, paired PER PAYMENT between a CASH-side leg (on a non-credit account — the
 *    money) and a CREDIT-side leg (on an included `credit` account — the liability), reciprocally,
 *    within ±5 days, opposite cents. Only cash-side legs can move tracked cash:
 *      cash + (payment out)   paired → tracked (0) · unpaired → untracked card outflow (subtracted)
 *      cash − (payment returned/reversed into checking)
 *                             paired with a credit + leg → tracked return (0)
 *                             unpaired → untracked returned payment (ADDED: cash arrived)
 *      credit − (card received a payment), unpaired → externally funded (0: no tracked cash moved)
 *      credit + (payment reversed on the card), unpaired → reversed externally (0)
 *    So a payment and its later return net to zero whether or not the card is tracked.
 *  - §4.5 refunds reduce spending in their own month and category; §4.6 splits inherit the parent's
 *    single role and are ignored for loan-decomposed parents; §5 C5 manual-loan interest appears in
 *    the Monthly Breakdown under the synthetic `LOAN_INTEREST` category.
 *
 * Rows on accounts excluded from cash flow are dropped before anything else: they are neither
 * aggregated nor partner candidates (design §4.1).
 *
 * FETCHED-CONTEXT CONTRACT. Callers pass every row in `pairingContextRange(period)` — the period
 * padded by `PAIRING_PAD_DAYS` on each side. Rows outside the period are only ever pairing evidence.
 * The pad is TWICE the widest matching window, because reciprocal matching is two hops deep: an
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
  /** Paired card payments, by the cash leg's magnitude (net zero in cash flow). */
  creditCardPaymentsTracked: number;
  /** Unpaired cash-side payments out (card not linked or excluded): subtracted in cash flow. */
  creditCardPaymentsUntracked: number;
  /** Paired returns: a cash-side −leg matched with the card's +leg (net zero in cash flow). */
  creditCardPaymentsReturnedTracked: number;
  /** Unpaired cash-side −legs — a payment returned into an included account from a card that is not
   *  tracked: ADDED in cash flow (the cash arrived). The counterpart of `creditCardPaymentsUntracked`,
   *  so a payment and its return net to zero. */
  creditCardPaymentsReturnedUntracked: number;
  /** Unpaired credit-side −legs (the card was paid from outside the tracked set): informational. */
  creditCardPaymentsExternallyFunded: number;
  /** Unpaired credit-side +legs (a payment reversed on the card, its cash side outside the tracked
   *  set): informational. */
  creditCardPaymentsReversedExternally: number;
  /** Σ refund effects, signed (refunds negative, reversals positive). Already inside `spending`. */
  refunds: number;
  /** Income − Spending − Debt payments − Untracked card outflows + Untracked card returns
   *  + External transfers. */
  cashFlow: number;
  /** (Cash flow + Known principal) / Income, or 0 when Income ≤ 0 (design §4.1 R-definitions). */
  savingsRate: number;
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
  allocation: 'row' | 'split' | 'interest';
  splitId?: string;
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
  };
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

// ---- Constants ---------------------------------------------------------------------------------

/** Same window Phase A reconciliation pairs transfers with (`TRANSFER_WINDOW_DAYS`). */
export const TRANSFER_PAIR_WINDOW_DAYS = 3;
/** Card-payment legs post with a delay (design §4.3). */
export const CARD_PAYMENT_PAIR_WINDOW_DAYS = 5;
/** How far outside the reporting period a caller must fetch rows: TWO of the widest matching window
 *  (reciprocal matching is two hops deep — see the fetched-context contract above). The matching
 *  windows themselves are unchanged; only the evidence fetched around the period grows. */
export const PAIRING_PAD_DAYS = 2 * Math.max(TRANSFER_PAIR_WINDOW_DAYS, CARD_PAYMENT_PAIR_WINDOW_DAYS);

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
  /** For internal_transfer / credit_card_payment rows: whether a reciprocal partner was found. */
  pair: PairStatus;
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

  // Card payments: a cash-side leg (non-credit account) pairs only with a credit-side leg (`credit`
  // account) of the opposite sign — a payment (cash +, credit −) or its return (cash −, credit +).
  const cardLegs = rows.filter((r) => r.role === 'credit_card_payment' && r.amountCents !== 0);
  const pairedCards = pairReciprocally(
    cardLegs,
    (leg, other) =>
      isCreditSide(leg) !== isCreditSide(other) &&
      other.amountCents === -leg.amountCents &&
      daysBetween(leg.txn.date, other.txn.date) <= CARD_PAYMENT_PAIR_WINDOW_DAYS
  );
  for (const leg of cardLegs) leg.pair = pairedCards.has(leg.txn.id) ? 'paired' : 'unpaired';
}

/** Resolves every row on an included account, then pairs transfer and card-payment legs across the
 *  full input (period + padding). Exported for tests and for later slices that need the same view. */
export function resolveRows(input: AggregationInput): ResolvedRow[] {
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
  return rows;
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
  refunds: number;
  unclassifiedCount: number;
  unclassifiedAmount: number;
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
    refunds: 0,
    unclassifiedCount: 0,
    unclassifiedAmount: 0,
  };
}

function addRow(t: CentTotals, row: ResolvedRow): void {
  if (row.unclassified) {
    t.unclassifiedCount += 1;
    t.unclassifiedAmount += row.amountCents;
  }
  for (const effect of row.effects) {
    switch (effect.role) {
      case 'expense':
        t.spending += effect.cents;
        break;
      case 'refund':
        t.spending += effect.cents;
        t.refunds += effect.cents;
        break;
      case 'income':
        t.income -= effect.cents; // Plaid sign: money in is negative
        break;
      case 'debt_payment':
        t.debtPayments += effect.cents;
        if (effect.fromLoanDecomposition) t.knownPrincipal += effect.cents;
        break;
      case 'internal_transfer':
        if (row.pair === 'paired') {
          if (effect.cents > 0) t.transfersInternal += effect.cents;
        } else {
          t.transfersExternal -= effect.cents; // signed as cash: out negative, in positive
        }
        break;
      case 'credit_card_payment': {
        const paired = row.pair === 'paired';
        if (!isCreditSide(row)) {
          // Cash side: the only legs that can move tracked cash.
          if (effect.cents > 0) {
            if (paired) t.creditCardPaymentsTracked += effect.cents;
            else t.creditCardPaymentsUntracked += effect.cents;
          } else if (paired) {
            t.creditCardPaymentsReturnedTracked -= effect.cents;
          } else {
            t.creditCardPaymentsReturnedUntracked -= effect.cents;
          }
        } else if (!paired) {
          // Credit side with no cash leg in the tracked set: a liability moved, no tracked cash did.
          if (effect.cents < 0) t.creditCardPaymentsExternallyFunded -= effect.cents;
          else t.creditCardPaymentsReversedExternally += effect.cents;
        }
        break;
      }
    }
  }
}

function finish(t: CentTotals): CashFlowTotals {
  const cashFlowCents =
    t.income -
    t.spending -
    t.debtPayments -
    t.creditCardPaymentsUntracked +
    t.creditCardPaymentsReturnedUntracked +
    t.transfersExternal;
  const savingsRate = t.income > 0 ? (cashFlowCents + t.knownPrincipal) / t.income : 0;
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
    refunds: toDollars(t.refunds),
    cashFlow: toDollars(cashFlowCents),
    savingsRate,
    unclassifiedCount: t.unclassifiedCount,
    unclassifiedAmount: toDollars(t.unclassifiedAmount),
  };
}

/** The period's role-aware cash-flow figures (design §5 C1–C4). */
export function aggregateCashFlow(input: AggregationInput): CashFlowTotals {
  const totals = emptyCentTotals();
  for (const row of resolveRows(input)) {
    if (row.inPeriod) addRow(totals, row);
  }
  return finish(totals);
}

/** The same figures per calendar month (YYYY-MM), ascending — the shape `monthly_spending[]` gains. */
export function aggregateCashFlowByMonth(input: AggregationInput): MonthlyCashFlow[] {
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

  for (const row of resolveRows(input)) {
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

/**
 * The `semantic` block each Monthly Breakdown month gains: role-aware spending grouped by Plaid
 * primary category (splits are never used here — unchanged from today), manual-loan interest under
 * `LOAN_INTEREST`, income, and the totals that were NOT counted as spending.
 */
export function aggregateMonthlyBreakdown(input: AggregationInput): MonthlyBreakdownSemantic[] {
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

    for (const effect of row.effects) {
      if (effect.role !== 'expense' && effect.role !== 'refund') continue;
      const interest = row.loanDecomposed;
      const key = interest ? LOAN_INTEREST_CATEGORY : row.txn.plaidCategory ?? UNCATEGORIZED_PLAID_CATEGORY;
      acc.byCategory.set(key, (acc.byCategory.get(key) ?? 0) + effect.cents);
      pushEffectRow(acc.effectRows, key, {
        transactionId: row.txn.id,
        date: row.txn.date,
        effectRole: effect.role,
        amount: toDollars(effect.cents),
        allocation: interest ? 'interest' : 'row',
      });
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
        },
        effectRows: acc.effectRows,
      };
    });
}
