import { describe, expect, it } from 'vitest';
import type { ManualLoanInput } from './api';
import { parseManualLoanInput, validateManualLoanInput } from './manualLoanValidation';

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

describe('parseManualLoanInput (Round 14) — runtime check of an UNTRUSTED stored payload', () => {
  const complete: ManualLoanInput = {
    name: 'Car',
    loan_type: 'auto',
    current_balance: 1234.56,
    origination_principal_amount: 20000,
    interest_rate_percentage: 4.9,
    origination_date: '2024-02-29',
    term_months: 60,
    minimum_payment_amount: 350,
    next_payment_due_date: '2026-10-01',
    notes: 'Unicode ✓ and "quotes"',
    match_text: 'CAR LENDER',
  };

  it('a complete valid payload is accepted and round-trips exactly through JSON', () => {
    const roundTripped = JSON.parse(JSON.stringify(complete));
    expect(parseManualLoanInput(roundTripped)).toEqual(complete);
    expect(parseManualLoanInput(valid)).toEqual(valid);
  });

  it.each([
    ['null', null],
    ['a string', 'loan'],
    ['an array', [complete]],
    ['an empty object', {}],
  ])('rejects %s', (_label, value) => {
    expect(parseManualLoanInput(value)).toBeNull();
  });

  it.each(Object.keys(complete))('rejects a payload missing required field %s', (field) => {
    const copy: Record<string, unknown> = { ...complete };
    delete copy[field];
    expect(parseManualLoanInput(copy)).toBeNull();
  });

  it.each([
    ['string balance', { current_balance: '1234.56' }],
    ['numeric name', { name: 42 }],
    ['numeric loan_type', { loan_type: 1 }],
    ['string term', { term_months: '60' }],
    ['numeric date', { origination_date: 20240229 }],
    ['boolean notes', { notes: true }],
    ['object match_text', { match_text: { text: 'x' } }],
    ['array amount', { minimum_payment_amount: [350] }],
  ])('rejects a wrong type: %s', (_label, patch) => {
    expect(parseManualLoanInput({ ...complete, ...patch })).toBeNull();
  });

  it.each([
    ['null name', { name: null }],
    ['null loan_type', { loan_type: null }],
    ['null current_balance', { current_balance: null }],
    ['undefined nullable field', { notes: undefined }],
  ])('rejects incorrect nullability: %s', (_label, patch) => {
    expect(parseManualLoanInput({ ...complete, ...patch })).toBeNull();
  });

  it('accepts null for every nullable field', () => {
    expect(
      parseManualLoanInput({
        ...complete,
        origination_principal_amount: null,
        interest_rate_percentage: null,
        origination_date: null,
        term_months: null,
        minimum_payment_amount: null,
        next_payment_due_date: null,
        notes: null,
        match_text: null,
      })
    ).not.toBeNull();
  });

  it.each([
    ['NaN balance', { current_balance: Number.NaN }],
    ['Infinity balance', { current_balance: Number.POSITIVE_INFINITY }],
    ['-Infinity original amount', { origination_principal_amount: Number.NEGATIVE_INFINITY }],
    ['NaN rate', { interest_rate_percentage: Number.NaN }],
    ['Infinity minimum payment', { minimum_payment_amount: Number.POSITIVE_INFINITY }],
    ['NaN term', { term_months: Number.NaN }],
  ])('rejects a non-finite number: %s', (_label, patch) => {
    expect(parseManualLoanInput({ ...complete, ...patch })).toBeNull();
  });

  it.each([
    ['negative balance', { current_balance: -1 }],
    ['fractional term', { term_months: 1.5 }],
    ['unknown loan type', { loan_type: 'credit' }],
    ['empty name', { name: '' }],
    ['impossible date', { origination_date: '2023-02-29' }],
    ['non-ISO date', { next_payment_due_date: '10/01/2026' }],
  ])('rejects a payload that is well-typed but breaks a rule new input must pass: %s', (_label, patch) => {
    expect(parseManualLoanInput({ ...complete, ...patch })).toBeNull();
  });

  it('rejects unknown extra fields', () => {
    expect(parseManualLoanInput({ ...complete, user_id: 'someone-else' })).toBeNull();
  });
});

describe('Round 15: dates PostgreSQL can accept — year zero is rejected in both date fields', () => {
  const base: ManualLoanInput = { ...valid, name: 'Dated Loan' };
  const dateFields = ['origination_date', 'next_payment_due_date'] as const;

  it.each(dateFields)('validateManualLoanInput rejects year zero in %s', (field) => {
    expect(validateManualLoanInput({ ...base, [field]: '0000-01-01' })).not.toBeNull();
    expect(validateManualLoanInput({ ...base, [field]: '0000-02-29' })).not.toBeNull();
  });

  it.each(dateFields)('parseManualLoanInput rejects year zero in %s', (field) => {
    expect(parseManualLoanInput({ ...base, [field]: '0000-01-01' })).toBeNull();
  });

  it.each(dateFields)('year 0001 and a real leap day stay valid in %s, and round-trip exactly', (field) => {
    for (const date of ['0001-01-01', '2024-02-29']) {
      expect(validateManualLoanInput({ ...base, [field]: date })).toBeNull();
      expect(parseManualLoanInput({ ...base, [field]: date })).toEqual({ ...base, [field]: date });
    }
  });

  it.each(dateFields)('impossible dates remain invalid in %s', (field) => {
    for (const date of ['2023-02-29', '2024-13-01', '2024-04-31', '2024-00-10']) {
      expect(validateManualLoanInput({ ...base, [field]: date })).not.toBeNull();
    }
  });
});
