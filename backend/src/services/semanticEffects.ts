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

import type { SemanticRole } from './transactionClassifier';

export interface SemanticEffect {
  role: SemanticRole;
  amount: number;
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
 * an override. The returned effects' amounts always sum back to exactly the transaction's own
 * `amount`.
 */
export function getSemanticEffects(txn: SemanticEffectsInput): SemanticEffect[] {
  if (txn.manualLoanId !== null && txn.userRoleOverride === null) {
    const principal = txn.principalPortion ?? 0;
    const interest = txn.amount - principal;
    const effects: SemanticEffect[] = [{ role: 'debt_payment', amount: principal }];
    // Only add the interest/fee component if it's actually non-zero — a payment recorded as 100%
    // principal shouldn't produce a spurious zero-amount 'expense' line in every aggregation.
    if (interest !== 0) effects.push({ role: 'expense', amount: interest });
    return effects;
  }

  return [{ role: txn.effectiveRole, amount: txn.amount }];
}
