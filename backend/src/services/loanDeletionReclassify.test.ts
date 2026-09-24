import { describe, expect, it } from 'vitest';
import { buildLoanDeletionReclassifyPayload } from './loanDeletionReclassify';

describe('buildLoanDeletionReclassifyPayload (Round 11 remediation)', () => {
  it('echoes every classifier input it used as exp_*, alongside the resulting role', () => {
    const [row] = buildLoanDeletionReclassifyPayload([
      {
        id: 'txn-1',
        amount: 120.5,
        category: 'GENERAL_MERCHANDISE',
        personal_finance_category_detailed: 'GENERAL_MERCHANDISE_OTHER',
        personal_finance_category_confidence: 'HIGH',
      },
    ]);

    expect(row).toEqual({
      id: 'txn-1',
      auto_role: 'expense',
      role_source: 'sign_default',
      role_confidence: 'low',
      classifier_version: 1,
      exp_amount: 120.5,
      exp_category: 'GENERAL_MERCHANDISE',
      exp_pfc_detailed: 'GENERAL_MERCHANDISE_OTHER',
      exp_pfc_confidence: 'HIGH',
    });
  });

  it('classifies from the CURRENT inputs: the same row re-read as LOAN_PAYMENTS becomes debt_payment/category_primary_fallback', () => {
    // The exact before/after pair the committed PostgreSQL harness races (delete_reclassify_race).
    const before = buildLoanDeletionReclassifyPayload([
      { id: 't', amount: 75, category: 'GENERAL_MERCHANDISE', personal_finance_category_detailed: null, personal_finance_category_confidence: null },
    ])[0];
    const after = buildLoanDeletionReclassifyPayload([
      { id: 't', amount: 75, category: 'LOAN_PAYMENTS', personal_finance_category_detailed: null, personal_finance_category_confidence: null },
    ])[0];

    expect(before).toMatchObject({ auto_role: 'expense', role_source: 'sign_default', exp_category: 'GENERAL_MERCHANDISE' });
    expect(after).toMatchObject({ auto_role: 'debt_payment', role_source: 'category_primary_fallback', exp_category: 'LOAN_PAYMENTS' });
  });
});
