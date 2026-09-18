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
  // The form's date inputs only ever produce YYYY-MM-DD (or null); anything else would be rejected by
  // the database's date type on every attempt.
  if (input.origination_date !== null && !isCalendarDate(input.origination_date)) return 'Enter a valid start date.';
  if (input.next_payment_due_date !== null && !isCalendarDate(input.next_payment_due_date)) {
    return 'Enter a valid next payment date.';
  }
  return null;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const NUMBER_FIELDS = ['current_balance'] as const;
const NULLABLE_NUMBER_FIELDS = [
  'origination_principal_amount',
  'interest_rate_percentage',
  'term_months',
  'minimum_payment_amount',
] as const;
const STRING_FIELDS = ['name', 'loan_type'] as const;
const NULLABLE_STRING_FIELDS = ['origination_date', 'next_payment_due_date', 'notes', 'match_text'] as const;
const ALL_FIELDS: readonly string[] = [
  ...NUMBER_FIELDS,
  ...NULLABLE_NUMBER_FIELDS,
  ...STRING_FIELDS,
  ...NULLABLE_STRING_FIELDS,
].sort();

/**
 * Runtime check that an UNTRUSTED value (e.g. one read back from browser storage) is a complete,
 * well-typed ManualLoanInput that would also pass validateManualLoanInput — returning it, or null.
 *
 * Round 14 remediation: the persisted pending-creation record's payload used to be accepted as a
 * ManualLoanInput if it was any non-array object, then cast — so `{}` or a record with a string
 * balance would be "resumed" and submitted. This checks the exact field set (every field of the
 * interface is required; nothing extra), each field's type and nullability, then applies the SAME
 * semantic rules new input must pass (finite non-negative amounts, whole-number term, known loan
 * type, valid dates) by calling validateManualLoanInput rather than restating them.
 */
export function parseManualLoanInput(value: unknown): ManualLoanInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== ALL_FIELDS.length || keys.some((k, i) => k !== ALL_FIELDS[i])) return null;

  for (const field of NUMBER_FIELDS) if (typeof record[field] !== 'number') return null;
  for (const field of NULLABLE_NUMBER_FIELDS) {
    if (record[field] !== null && typeof record[field] !== 'number') return null;
  }
  for (const field of STRING_FIELDS) if (typeof record[field] !== 'string') return null;
  for (const field of NULLABLE_STRING_FIELDS) {
    if (record[field] !== null && typeof record[field] !== 'string') return null;
  }

  const input = record as unknown as ManualLoanInput;
  return validateManualLoanInput(input) === null ? input : null;
}
