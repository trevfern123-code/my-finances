import type { ManualLoanInput } from './api';

const LOAN_TYPES = new Set(['personal', 'student', 'mortgage', 'auto', 'other']);

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Mirrors every rule the server applies to a new manual loan (manualLoanController's required
 * fields, dataService's assertValidManualLoanFields, and the manual_loans loan_type CHECK), and
 * returns a user-facing message for the first violation, or null.
 *
 * This runs BEFORE a create attempt is persisted or sent, and it matters more than ordinary form
 * validation: once an attempt is sent its idempotency key and payload are locked until the server
 * confirms the outcome (see pendingManualLoanCreation.ts), so a payload the server rejects every
 * time would leave nothing to do but retry it forever. Catching it here means such a payload never
 * becomes an attempt at all.
 */
export function validateManualLoanInput(input: ManualLoanInput): string | null {
  if (!input.name) return 'Enter a name for the loan.';
  if (!LOAN_TYPES.has(input.loan_type)) return 'Choose a loan type.';
  if (typeof input.current_balance !== 'number' || !isFiniteNonNegative(input.current_balance)) {
    return 'Current balance must be zero or more.';
  }
  const optionalAmounts: [number | null, string][] = [
    [input.origination_principal_amount, 'Original loan amount'],
    [input.interest_rate_percentage, 'Interest rate'],
    [input.minimum_payment_amount, 'Minimum payment'],
  ];
  for (const [value, label] of optionalAmounts) {
    if (value !== null && !isFiniteNonNegative(value)) return `${label} must be zero or more.`;
  }
  if (input.term_months !== null && !(Number.isInteger(input.term_months) && input.term_months > 0)) {
    return 'Term must be a whole number of months, 1 or more.';
  }
  return null;
}
