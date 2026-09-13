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

/** Thrown by `getSemanticEffects` (Round 3 remediation §9) when a manual-loan-linked
 *  transaction's persisted amount/principal_portion is an impossible combination (non-finite,
 *  non-positive amount, or principal outside `[0, amount]`) — see that function's own doc comment
 *  for why this is a throw rather than a defensive clamp. */
export class SemanticIntegrityError extends Error {}

/** Thrown by `normalizePrincipalPortion` — the WRITE boundary for `principal_portion` (see
 *  dataService.ts's `linkTransactionToLoan`/`updateLinkedPaymentPrincipal`). An invalid value is
 *  rejected outright here, before it's ever persisted — this is the one place that matters most,
 *  since it's the only place that can refuse to write bad data in the first place. */
export class InvalidPrincipalPortionError extends Error {}

/** Thrown by `assertLinkedPaymentAmountIsCompatible` (Round 3 remediation §8) — a Plaid resync
 *  that changes a manual-loan-linked transaction's amount such that the already-stored
 *  `principal_portion` is no longer valid for the NEW amount. This is a data-integrity failure,
 *  not a recoverable one: dataService.ts's applyTransactionChanges throws this before persisting
 *  the incompatible amount, which aborts the whole sync attempt (see syncService.ts) rather than
 *  silently clamping the stored principal or corrupting loan-balance math. The user must edit or
 *  unlink the payment (adjusting principal_portion to fit the new amount, or removing the link)
 *  before sync can proceed for this item again. */
export class LinkedPaymentIntegrityError extends Error {}

/**
 * Validates that an already-linked payment's stored `principal_portion` is still compatible with
 * a NEW amount arriving via Plaid resync (Round 3 remediation §8) — the resync path has no
 * `normalizePrincipalPortion` write boundary of its own, since it isn't the thing writing
 * `principal_portion`. Requires: the new amount is finite and greater than 0; the stored
 * principal is finite; and the stored principal is in `[0, newAmount]`. Throws
 * `LinkedPaymentIntegrityError` rather than silently clamping or allowing `principal > amount` to
 * persist — see that error's own doc comment for why.
 */
export function assertLinkedPaymentAmountIsCompatible(newAmount: number, principalPortion: number | null): void {
  if (!Number.isFinite(newAmount) || newAmount <= 0) {
    throw new LinkedPaymentIntegrityError(
      `Resynced amount for a manual-loan-linked transaction must be finite and greater than 0 (got ${newAmount})`
    );
  }
  const principal = principalPortion ?? 0;
  if (!Number.isFinite(principal)) {
    throw new LinkedPaymentIntegrityError('Linked transaction principal_portion must be a finite number');
  }
  const normalizedAmount = roundToCents(newAmount);
  const normalizedPrincipal = roundToCents(principal);
  if (normalizedPrincipal < 0 || normalizedPrincipal > normalizedAmount) {
    throw new LinkedPaymentIntegrityError(
      `Existing principal_portion (${normalizedPrincipal}) is incompatible with the resynced amount (${normalizedAmount}) — edit or unlink this payment before sync can continue`
    );
  }
}

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
 * transaction amount and are never negative or NaN/Infinity — but unlike an earlier version of
 * this function (Round 2), an impossible persisted state is no longer silently clamped into a
 * plausible-looking result. `normalizePrincipalPortion` (write boundary) and
 * `assertLinkedPaymentAmountIsCompatible` (Plaid-resync boundary) are what SHOULD prevent bad data
 * from ever being written in the first place; this function is the last line of defense for data
 * that reached this state anyway (a bug in one of those boundaries, a manual DB edit, data written
 * before either validation existed) — Round 3 remediation §9 requires it to THROW
 * `SemanticIntegrityError` rather than clamp, since a clamped result (e.g. a negative amount
 * silently becoming a positive-looking debt_payment) is actively misleading to every aggregation
 * that calls this. A zero-amount component is omitted rather than emitted; a genuinely $0
 * transaction is itself impossible for a real payment and so is rejected below, not specially
 * handled.
 */
export function getSemanticEffects(txn: SemanticEffectsInput): SemanticEffect[] {
  if (txn.manualLoanId !== null && txn.userRoleOverride === null) {
    if (!Number.isFinite(txn.amount) || txn.amount <= 0) {
      throw new SemanticIntegrityError(
        `getSemanticEffects: a manual-loan-linked transaction's amount must be finite and greater than 0 (got ${txn.amount})`
      );
    }
    const normalizedAmount = roundToCents(txn.amount);
    const rawPrincipal = txn.principalPortion ?? 0;
    if (!Number.isFinite(rawPrincipal)) {
      throw new SemanticIntegrityError('getSemanticEffects: principal_portion must be a finite number');
    }
    const principal = roundToCents(rawPrincipal);
    if (principal < 0 || principal > normalizedAmount) {
      throw new SemanticIntegrityError(
        `getSemanticEffects: principal_portion (${principal}) must be between 0 and the transaction amount (${normalizedAmount})`
      );
    }
    // The complement, not an independently-rounded value — guarantees the two components always
    // sum exactly to normalizedAmount regardless of any rounding on principal itself.
    const interest = roundToCents(normalizedAmount - principal);

    const effects: SemanticEffect[] = [];
    if (principal !== 0) effects.push({ role: 'debt_payment', amount: principal });
    if (interest !== 0) effects.push({ role: 'expense', amount: interest });
    return effects;
  }

  return [{ role: txn.effectiveRole, amount: roundToCents(txn.amount) }];
}
