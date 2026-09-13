/**
 * Financial Semantics Foundation, Phase A — the canonical aggregation contract.
 *
 * `effective_role` (the generated DB column, `coalesce(user_role_override, auto_role)`) is
 * sufficient for an ordinary transaction, and is what future filtering/indexing/UI/reporting
 * should use directly. It is NOT sufficient for a manual-loan-linked transaction without a user
 * override: Plaid never tells us the principal/interest split of a loan payment, so this app
 * represents it as one transaction row carrying TWO semantic effects — some of the amount is
 * `debt_payment` (principal, excluded from spend), the rest is `expense` (interest/fees, real
 * spend) — and a single scalar column cannot hold two different roles for two different portions
 * of the same row's amount.
 *
 * getSemanticEffects() is therefore the one function every dollar-aggregating financial
 * calculation (income, spend, budgets, cash flow — all Phase B+ work, not wired up yet) must call,
 * rather than filtering `WHERE effective_role = ...` directly: for the overwhelming majority of
 * transactions (not manual-loan-linked) it returns exactly the same thing `effective_role` would,
 * but for a decomposed loan payment it returns both components, so neither is silently lost
 * (undercounting real spend) nor the whole amount double-counted as ordinary expense.
 *
 * Deliberately NOT persisted as `transaction_splits` rows: that table is entirely user-facing
 * (category splits a person deliberately creates), and giving the system its own reason to write
 * rows there would risk colliding with or being confused for a user's own splits on the same
 * transaction. This decomposition is computed on the fly, every time, from columns that already
 * exist directly on `transactions` (`manual_loan_id`, `principal_portion`) — nothing new to keep
 * in sync, nothing that can go stale.
 */

import { roundToCents } from './money';
import type { SemanticRole } from './transactionClassifier';

export interface SemanticEffect {
  role: SemanticRole;
  amount: number;
}

/** Thrown by `normalizePrincipalPortion` — the WRITE boundary for `principal_portion` (see
 *  dataService.ts's `linkTransactionToLoan`/`updateLinkedPaymentPrincipal`). An invalid value is
 *  rejected outright here, before it's ever persisted — this is the one place that matters most,
 *  since it's the only place that can refuse to write bad data in the first place. */
export class InvalidPrincipalPortionError extends Error {}

/**
 * Validates and cent-normalizes a `principal_portion` value before it's persisted. Requires a
 * finite number in `[0, transactionAmount]` (a payment can't apply negative or more-than-the-whole
 * -payment principal) — anything else throws rather than silently persisting an impossible value.
 */
export function normalizePrincipalPortion(transactionAmount: number, principalPortion: number): number {
  if (!Number.isFinite(principalPortion)) {
    throw new InvalidPrincipalPortionError('principal_portion must be a finite number');
  }
  const normalized = roundToCents(principalPortion);
  const normalizedAmount = roundToCents(transactionAmount);
  if (normalized < 0 || normalized > normalizedAmount) {
    throw new InvalidPrincipalPortionError(
      `principal_portion (${normalized}) must be between 0 and the transaction amount (${normalizedAmount})`
    );
  }
  return normalized;
}

/** The subset of a transaction's fields getSemanticEffects() needs. */
export interface SemanticEffectsInput {
  amount: number;
  effectiveRole: SemanticRole;
  manualLoanId: string | null;
  /** Null unless manualLoanId is set — the portion of `amount` that reduces the loan's principal;
   *  the remainder (amount - principalPortion) is interest/fees. */
  principalPortion: number | null;
  /** The user's own override, if any — per the approved design, an explicit override on a
   *  manual-loan-linked transaction replaces the decomposition entirely: the WHOLE amount is
   *  reported as the single overridden role, and no principal/interest split is produced. Loan
   *  balance bookkeeping (manual_loans.current_balance, driven by principalPortion) is completely
   *  unaffected by this — this function only ever describes REPORTING effects, never loan-balance
   *  math. */
  userRoleOverride: SemanticRole | null;
}

/**
 * Returns one effect for an ordinary transaction (or a loan-linked transaction with an explicit
 * user override), or two effects (debt_payment + expense) for a loan-linked transaction without
 * an override. The returned effects' amounts always sum back to exactly the cent-normalized
 * transaction amount, are never negative, and are never NaN/Infinity, regardless of what's
 * actually persisted on `principalPortion` — `normalizePrincipalPortion` is what prevents an
 * invalid value from ever being WRITTEN (dataService.ts), but this function still defensively
 * clamps whatever it's handed (e.g. data written before that validation existed) rather than
 * propagating garbage into an aggregation. A zero-amount component is omitted rather than emitted.
 */
export function getSemanticEffects(txn: SemanticEffectsInput): SemanticEffect[] {
  if (txn.manualLoanId !== null && txn.userRoleOverride === null) {
    const normalizedAmount = roundToCents(txn.amount);
    const rawPrincipal = txn.principalPortion ?? 0;
    const safePrincipal = Number.isFinite(rawPrincipal) ? rawPrincipal : 0;
    const clampedPrincipal = Math.min(Math.max(0, safePrincipal), normalizedAmount);
    const principal = roundToCents(clampedPrincipal);
    // The complement, not an independently-rounded value — guarantees the two components always
    // sum exactly to normalizedAmount regardless of any rounding on principal itself.
    const interest = roundToCents(normalizedAmount - principal);

    const effects: SemanticEffect[] = [];
    if (principal !== 0) effects.push({ role: 'debt_payment', amount: principal });
    if (interest !== 0) effects.push({ role: 'expense', amount: interest });
    if (effects.length === 0) effects.push({ role: 'debt_payment', amount: 0 }); // the transaction itself was $0
    return effects;
  }

  return [{ role: txn.effectiveRole, amount: roundToCents(txn.amount) }];
}
