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
 *  - §4.3 card payments, paired PER PAYMENT: a payer leg (+) is tracked (0) when it pairs with a
 *    reciprocal card leg (−) on an included `credit` account within ±5 days; an unpaired payer leg is
 *    an untracked card outflow (subtracted in cash flow); an unpaired card leg is an externally
 *    funded inflow (0 — no tracked cash moved).
 *  - §4.5 refunds reduce spending in their own month and category; §4.6 splits inherit the parent's
 *    single role and are ignored for loan-decomposed parents; §5 C5 manual-loan interest appears in
 *    the Monthly Breakdown under the synthetic `LOAN_INTEREST` category.
 *
 * Rows on accounts excluded from cash flow are dropped before anything else: they are neither
 * aggregated nor partner candidates (design §4.1). Callers pass rows for the reporting period PLUS a
 * padding of `PAIRING_PAD_DAYS` on each side; padding rows are only ever pairing candidates, so a
 * card leg that posts after the period still tracks the in-period payment (design §4.3, §9.1).
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
  /** Paired card payments, by the payer leg's magnitude (net zero in cash flow). */
  creditCardPaymentsTracked: number;
  /** Unpaired payer legs (card not linked or excluded): subtracted in cash flow. */
  creditCardPaymentsUntracked: number;
  /** Unpaired card-side legs (paid from outside the tracked set): informational, not cash. */
  creditCardPaymentsExternallyFunded: number;
  /** Σ refund effects, signed (refunds negative, reversals positive). Already inside `spending`. */
  refunds: number;
  /** Income − Spending − Debt payments − Untracked card outflows + External transfers. */
  cashFlow: number;
  /** (Cash flow + Known principal) / Income, or 0 when Income ≤ 0 (design §4.1 R-definitions). */
  savingsRate: number;
  /** Rows with a NULL effective role, counted by their sign fallback (R0). */
  unclassifiedCount: number;
  /** Σ of those rows' amounts, Plaid-signed. */
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
  /** Split parents whose split rows do not sum to the parent amount (cent-exact). They are
   *  allocated exactly as stored — the legacy behaviour — and surfaced here (see design §13 Q3). */
  splitMismatches: { transactionId: string; parentAmount: number; splitTotal: number }[];
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

// ---- Constants ---------------------------------------------------------------------------------

/** Same window Phase A reconciliation pairs transfers with (`TRANSFER_WINDOW_DAYS`). */
export const TRANSFER_PAIR_WINDOW_DAYS = 3;
/** Card-payment legs post with a delay (design §4.3). */
export const CARD_PAYMENT_PAIR_WINDOW_DAYS = 5;
/** How far outside the reporting period a caller must fetch rows so every in-period leg can find
 *  its partner — the larger of the two windows. */
export const PAIRING_PAD_DAYS = Math.max(TRANSFER_PAIR_WINDOW_DAYS, CARD_PAYMENT_PAIR_WINDOW_DAYS);

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

  // Card payments: a payer leg (+) pairs only with a card leg (−) on a `credit` account.
  const cardLegs = rows.filter((r) => r.role === 'credit_card_payment' && r.amountCents !== 0);
  const isPayer = (r: ResolvedRow) => r.amountCents > 0;
  const isCardSide = (r: ResolvedRow) => r.amountCents < 0 && r.account.type === 'credit';
  const pairedCards = pairReciprocally(cardLegs, (leg, other) => {
    const oppositeKinds = (isPayer(leg) && isCardSide(other)) || (isCardSide(leg) && isPayer(other));
    return (
      oppositeKinds &&
      other.amountCents === -leg.amountCents &&
      other.txn.accountId !== leg.txn.accountId &&
      daysBetween(leg.txn.date, other.txn.date) <= CARD_PAYMENT_PAIR_WINDOW_DAYS
    );
  });
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
  creditCardPaymentsExternallyFunded: number;
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
    creditCardPaymentsExternallyFunded: 0,
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
      case 'credit_card_payment':
        if (effect.cents > 0) {
          if (row.pair === 'paired') t.creditCardPaymentsTracked += effect.cents;
          else t.creditCardPaymentsUntracked += effect.cents;
        } else if (row.pair !== 'paired') {
          t.creditCardPaymentsExternallyFunded -= effect.cents;
        }
        break;
    }
  }
}

function finish(t: CentTotals): CashFlowTotals {
  const cashFlowCents =
    t.income - t.spending - t.debtPayments - t.creditCardPaymentsUntracked + t.transfersExternal;
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
    creditCardPaymentsExternallyFunded: toDollars(t.creditCardPaymentsExternallyFunded),
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
  const splitMismatches: BudgetSpend['splitMismatches'] = [];
  const allocate = (key: string | null, amountCents: number, row: EffectRow) => {
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

    let splitTotal = 0;
    for (const split of splits) {
      if (!Number.isFinite(split.amount)) {
        throw new SemanticAggregationIntegrityError(row.txn.id, `split ${split.id} amount must be a finite number`);
      }
      const splitCents = toCents(split.amount);
      splitTotal += splitCents;
      allocate(split.budgetCategoryId, splitCents, {
        ...base,
        effectRole: effect.role,
        amount: toDollars(splitCents),
        allocation: 'split',
        splitId: split.id,
      });
    }
    if (splitTotal !== effect.cents) {
      splitMismatches.push({
        transactionId: row.txn.id,
        parentAmount: toDollars(effect.cents),
        splitTotal: toDollars(splitTotal),
      });
    }
  }

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
    splitMismatches,
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
          debtPayments: t.debtPayments,
        },
        effectRows: acc.effectRows,
      };
    });
}
