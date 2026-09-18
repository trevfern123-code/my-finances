import { describe, expect, it } from 'vitest';
import type { ManualLoanInput } from './api';
import { validateManualLoanInput } from './manualLoanValidation';

const valid: ManualLoanInput = {
  name: 'Car',
  loan_type: 'personal',
  current_balance: 0,
  origination_principal_amount: null,
  interest_rate_percentage: null,
  origination_date: null,
  term_months: null,
  minimum_payment_amount: null,
  next_payment_due_date: null,
  notes: null,
  match_text: null,
};

describe('validateManualLoanInput (Round 12) — mirrors every server rejection for a new loan', () => {
  it('accepts a minimal valid loan, including zero and null values', () => {
    expect(validateManualLoanInput(valid)).toBeNull();
    expect(validateManualLoanInput({ ...valid, term_months: 360, interest_rate_percentage: 0, minimum_payment_amount: 0 })).toBeNull();
  });

  it.each([
    ['empty name', { name: '' }],
    ['unknown loan type', { loan_type: 'credit' as ManualLoanInput['loan_type'] }],
    ['negative balance', { current_balance: -0.01 }],
    ['NaN balance', { current_balance: Number.NaN }],
    ['infinite balance', { current_balance: Number.POSITIVE_INFINITY }],
    ['negative original amount', { origination_principal_amount: -1 }],
    ['NaN interest rate', { interest_rate_percentage: Number.NaN }],
    ['infinite minimum payment', { minimum_payment_amount: Number.POSITIVE_INFINITY }],
    ['fractional term', { term_months: 12.5 }],
    ['zero term', { term_months: 0 }],
    ['negative term', { term_months: -3 }],
  ])('rejects %s', (_label, patch) => {
    expect(validateManualLoanInput({ ...valid, ...patch })).not.toBeNull();
  });
});
