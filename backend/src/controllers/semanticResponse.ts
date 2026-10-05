import type { Request } from 'express';
import { CLIENT_API_LEVEL_HEADER, parseClientApiLevel } from '../middleware/clientApiLevel';
import { SemanticResultInconsistentError, splitMismatchFields, type SplitMismatchFields } from '../middleware/semanticErrors';
import type { CashFlowTotals, MonthlyBreakdownSemantic, SplitAllocationMismatchError } from '../services/semanticAggregation';
import type { SemanticUnavailable, SemanticUpdating } from '../services/semanticReadPath';

/**
 * Financial Semantics Phase B, integration slice I1 — how the role-aware read path appears on the
 * wire (FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §5, §6.1, §6.4; CARD_PAYMENT_PAIRING_DESIGN.md §6.2).
 *
 * THE FROZEN FIELDS ARE NEVER TOUCHED HERE. Every pre-existing response field keeps its sign-based
 * computation and value (§6.4); Phase B figures arrive only in the NEW fields below.
 *
 * Every Phase B semantic surface is opt-in for a client that declares API level 2 or above
 * (`X-Client-Api-Level`): the new fields on the three aggregate endpoints, and the effects endpoint
 * itself. A client below that — every bundle released so far — gets exactly the response it gets
 * today: the same body, no role-aware read, and no new semantic failure. This backend's own
 * `API_LEVEL` was left at 1 in slice I1 and is raised to 2 in slice I2, together with the frontend
 * that reads these fields; that tells a stale bundle a newer build exists and changes nothing it
 * receives.
 *
 * In a level-2 response the frozen and the role-aware fields are computed from the SAME snapshot rows
 * (`semanticReadPath.ts`), so they describe one database state.
 */
export const SEMANTIC_FIELDS_MIN_CLIENT_API_LEVEL = 2;

export function clientWantsSemanticFields(req: Request): boolean {
  const parsed = parseClientApiLevel(req.get(CLIENT_API_LEVEL_HEADER));
  return parsed.kind === 'valid' && parsed.level >= SEMANTIC_FIELDS_MIN_CLIENT_API_LEVEL;
}

/** The state of the role-aware figures in a response that also carries frozen fields. With any status
 *  other than `ok`, NO role-aware figure is present anywhere in that response. */
export type SemanticStatus =
  | { status: 'ok' }
  /** The stored card-payment states are behind the inputs, or the inputs changed under the read. */
  | { status: 'updating'; retry_after_ms: number; reason: string }
  /** The stored card-payment state could not be read at all; nothing is established about it. */
  | { status: 'unavailable'; retry_after_ms: number; reason: string }
  /** The budget aggregate is refused until the named splits are corrected (design §13 Q3). */
  | ({ status: 'refused' } & SplitMismatchFields);

export function semanticStatusOf(read: { status: 'ok' } | SemanticUpdating | SemanticUnavailable): SemanticStatus {
  if (read.status === 'ok') return { status: 'ok' };
  return { status: read.status, retry_after_ms: read.retryAfterMs, reason: read.reason };
}

/**
 * Pairs each frozen month with its role-aware month. Both lists come from the same snapshot rows, so
 * they must name exactly the same months; the union is built explicitly and a month present on only
 * one side is an integrity failure — it is never dropped, and never published frozen-only under an
 * `ok` status.
 */
export function alignMonths<F extends { month: string }, S extends { month: string }>(frozen: F[], semantic: S[]): [F, S][] {
  const frozenByMonth = new Map(frozen.map((entry) => [entry.month, entry]));
  const semanticByMonth = new Map(semantic.map((entry) => [entry.month, entry]));
  const months = Array.from(new Set([...frozenByMonth.keys(), ...semanticByMonth.keys()])).sort();
  return months.map((month) => {
    const f = frozenByMonth.get(month);
    const s = semanticByMonth.get(month);
    if (f === undefined || s === undefined) {
      throw new SemanticResultInconsistentError(`month ${month} is present only in the ${f === undefined ? 'role-aware' : 'frozen'} result`);
    }
    return [f, s];
  });
}

export function splitRefusalStatus(err: SplitAllocationMismatchError): SemanticStatus {
  return { status: 'refused', ...splitMismatchFields(err) };
}

function unresolvedFields(u: CashFlowTotals['cardPaymentsUnresolved']) {
  return { count: u.count, payments_amount: u.paymentsAmount, returns_amount: u.returnsAmount, by_reason: u.byReason };
}

/**
 * The role-aware fields a `monthly_spending[]` entry and `current_month` gain (design §5 C1–C4, §13 Q4;
 * pairing design §6.2). `income_semantic` is the role-aware income — the frozen `income` beside it
 * stays sign-based. `cash_flow` and `savings_rate` are single numbers only when no card payment in
 * the period is unresolved; otherwise they are null and the `_range` fields hold the two bounds.
 */
export function cashFlowFields(t: CashFlowTotals) {
  return {
    spending: t.spending,
    income_semantic: t.income,
    debt_payments: t.debtPayments,
    known_principal: t.knownPrincipal,
    debt_payments_unknown_principal: t.debtPaymentsUnknownPrincipal,
    transfers_internal: t.transfersInternal,
    transfers_external: t.transfersExternal,
    credit_card_payments_tracked: t.creditCardPaymentsTracked,
    credit_card_payments_untracked: t.creditCardPaymentsUntracked,
    credit_card_payments_returned_tracked: t.creditCardPaymentsReturnedTracked,
    credit_card_payments_returned_untracked: t.creditCardPaymentsReturnedUntracked,
    credit_card_payments_externally_funded: t.creditCardPaymentsExternallyFunded,
    credit_card_payments_reversed_externally: t.creditCardPaymentsReversedExternally,
    // "Unresolved card credits": informational only; asserts nothing about the source of funds.
    card_payments_unresolved_credit: t.cardPaymentsUnresolvedCredit,
    refunds: t.refunds,
    cash_flow: t.cashFlow,
    cash_flow_range: t.cashFlowRange,
    savings_rate: t.savingsRate,
    savings_rate_range: t.savingsRateRange,
    card_payments_unresolved: unresolvedFields(t.cardPaymentsUnresolved),
    unclassified_count: t.unclassifiedCount,
    unclassified_amount: t.unclassifiedAmount,
  };
}

/** The `semantic` block a Monthly Breakdown month gains (design §5 C5). `by_category` has the frozen
 *  field's shape and order (largest first); its amounts are signed and can be negative. */
export function monthlyBreakdownSemanticFields(m: MonthlyBreakdownSemantic) {
  return {
    spending: m.spending,
    income: m.income,
    by_category: Array.from(m.byCategory.entries())
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
    excluded: {
      transfers_internal: m.excluded.transfersInternal,
      transfers_external: m.excluded.transfersExternal,
      credit_card_payments_tracked: m.excluded.creditCardPaymentsTracked,
      credit_card_payments_untracked: m.excluded.creditCardPaymentsUntracked,
      credit_card_payments_returned_untracked: m.excluded.creditCardPaymentsReturnedUntracked,
      debt_payments: m.excluded.debtPayments,
      card_payments_unresolved: unresolvedFields(m.excluded.cardPaymentsUnresolved),
    },
  };
}
