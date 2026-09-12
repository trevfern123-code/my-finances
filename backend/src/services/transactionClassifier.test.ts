import { describe, expect, it } from 'vitest';
import { classifyCore, classifyRowLevel, CURRENT_CLASSIFIER_VERSION, type ClassifierRowInput } from './transactionClassifier';

function input(overrides: Partial<ClassifierRowInput> = {}): ClassifierRowInput {
  return {
    amount: 42,
    personalFinanceCategoryPrimary: null,
    personalFinanceCategoryDetailed: null,
    personalFinanceCategoryConfidence: null,
    manualLoanId: null,
    ...overrides,
  };
}

describe('classifyCore — core roles', () => {
  it('paycheck: negative amount always falls to step F (refund candidate) first — final role is still income, low confidence, even though it will never actually resolve as a refund', () => {
    // Per the approved precedence, ANY negative amount not caught by steps A-E is a refund
    // candidate (step F) — there is no "this is obviously just income" shortcut. The row is still
    // correctly classified as income immediately (never left unclassified); role_source just
    // records that it's provisionally tagged for a refund-match check that a real paycheck will
    // simply never match against (see roleReconciliation.ts) and so will permanently keep this
    // fallback — a known, harmless labeling quirk, not a functional one.
    const core = classifyCore(input({ amount: -2000, personalFinanceCategoryPrimary: 'INCOME' }));
    expect(core.status).toBe('relational_candidate');
    expect(core.status === 'relational_candidate' && core.candidate.kind).toBe('refund');
    expect(core.status === 'relational_candidate' && core.candidate.fallback).toEqual({
      autoRole: 'income',
      roleSource: 'refund_candidate_unconfirmed',
      roleConfidence: 'low',
      classifierVersion: CURRENT_CLASSIFIER_VERSION,
    });
  });

  it('normal expense: positive amount, ordinary category -> expense, sign_default, low', () => {
    const core = classifyCore(input({ amount: 25, personalFinanceCategoryPrimary: 'FOOD_AND_DRINK' }));
    expect(core).toEqual({
      status: 'final',
      result: { autoRole: 'expense', roleSource: 'sign_default', roleConfidence: 'low', classifierVersion: CURRENT_CLASSIFIER_VERSION },
    });
  });

  it('credit-card purchase: same as any ordinary positive expense (no special-casing by account type here)', () => {
    const core = classifyCore(input({ amount: 60, personalFinanceCategoryPrimary: 'GENERAL_MERCHANDISE' }));
    expect(core.status).toBe('final');
    expect(core.status === 'final' && core.result.autoRole).toBe('expense');
  });

  it('high-confidence credit-card payment -> credit_card_payment, category_detailed, high', () => {
    const core = classifyCore(
      input({
        amount: 500,
        personalFinanceCategoryPrimary: 'LOAN_PAYMENTS',
        personalFinanceCategoryDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        personalFinanceCategoryConfidence: 'VERY_HIGH',
      })
    );
    expect(core).toEqual({
      status: 'final',
      result: {
        autoRole: 'credit_card_payment',
        roleSource: 'category_detailed',
        roleConfidence: 'high',
        classifierVersion: CURRENT_CLASSIFIER_VERSION,
      },
    });
  });

  it('credit-card payment detailed present but LOW confidence -> falls to generic LOAN_PAYMENTS fallback, not credit_card_payment', () => {
    const core = classifyCore(
      input({
        amount: 500,
        personalFinanceCategoryPrimary: 'LOAN_PAYMENTS',
        personalFinanceCategoryDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        personalFinanceCategoryConfidence: 'LOW',
      })
    );
    expect(core).toEqual({
      status: 'final',
      result: {
        autoRole: 'debt_payment',
        roleSource: 'category_primary_fallback',
        roleConfidence: 'low',
        classifierVersion: CURRENT_CLASSIFIER_VERSION,
      },
    });
  });

  it('generic LOAN_PAYMENTS fallback (no detailed at all) -> debt_payment, category_primary_fallback, low', () => {
    const core = classifyCore(input({ amount: 400, personalFinanceCategoryPrimary: 'LOAN_PAYMENTS' }));
    expect(core).toEqual({
      status: 'final',
      result: {
        autoRole: 'debt_payment',
        roleSource: 'category_primary_fallback',
        roleConfidence: 'low',
        classifierVersion: CURRENT_CLASSIFIER_VERSION,
      },
    });
  });

  it('high-confidence account transfer -> internal_transfer, category_detailed_account_transfer, high', () => {
    const core = classifyCore(
      input({
        amount: 200,
        personalFinanceCategoryPrimary: 'TRANSFER_OUT',
        personalFinanceCategoryDetailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
        personalFinanceCategoryConfidence: 'HIGH',
      })
    );
    expect(core).toEqual({
      status: 'final',
      result: {
        autoRole: 'internal_transfer',
        roleSource: 'category_detailed_account_transfer',
        roleConfidence: 'high',
        classifierVersion: CURRENT_CLASSIFIER_VERSION,
      },
    });
  });

  it('account-transfer detailed present but only MEDIUM confidence -> relational transfer candidate, not final', () => {
    const core = classifyCore(
      input({
        amount: 200,
        personalFinanceCategoryPrimary: 'TRANSFER_OUT',
        personalFinanceCategoryDetailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
        personalFinanceCategoryConfidence: 'MEDIUM',
      })
    );
    expect(core.status).toBe('relational_candidate');
    expect(core.status === 'relational_candidate' && core.candidate.kind).toBe('transfer');
    expect(core.status === 'relational_candidate' && core.candidate.fallback.autoRole).toBe('expense');
    expect(core.status === 'relational_candidate' && core.candidate.fallback.roleSource).toBe('transfer_like_unconfirmed');
  });

  it('sign fallback: positive amount, no recognized category -> expense/sign_default/low', () => {
    const core = classifyCore(input({ amount: 15 }));
    expect(core).toEqual({
      status: 'final',
      result: { autoRole: 'expense', roleSource: 'sign_default', roleConfidence: 'low', classifierVersion: CURRENT_CLASSIFIER_VERSION },
    });
  });
});

describe('classifyCore — manual-loan precedence (step A)', () => {
  it('manual_loan_id present always wins, even over a high-confidence credit-card-payment category', () => {
    const core = classifyCore(
      input({
        amount: 500,
        manualLoanId: 'loan-1',
        personalFinanceCategoryPrimary: 'LOAN_PAYMENTS',
        personalFinanceCategoryDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        personalFinanceCategoryConfidence: 'VERY_HIGH',
      })
    );
    expect(core).toEqual({
      status: 'final',
      result: {
        autoRole: 'debt_payment',
        roleSource: 'manual_loan_link',
        roleConfidence: 'high',
        classifierVersion: CURRENT_CLASSIFIER_VERSION,
      },
    });
  });

  it('manual_loan_id present wins over a TRANSFER category too', () => {
    const core = classifyCore(
      input({ amount: 500, manualLoanId: 'loan-1', personalFinanceCategoryPrimary: 'TRANSFER_OUT' })
    );
    expect(core.status).toBe('final');
    expect(core.status === 'final' && core.result.roleSource).toBe('manual_loan_link');
  });
});

describe('classifyCore — ambiguous transfers (step E)', () => {
  it('outbound ambiguous P2P/transfer-shaped -> expense fallback, tagged transfer_like_unconfirmed', () => {
    const core = classifyCore(
      input({ amount: 100, personalFinanceCategoryPrimary: 'TRANSFER_OUT', personalFinanceCategoryDetailed: 'TRANSFER_OUT_OTHER_TRANSFER_OUT' })
    );
    expect(core.status).toBe('relational_candidate');
    expect(core.status === 'relational_candidate' && core.candidate.fallback).toEqual({
      autoRole: 'expense',
      roleSource: 'transfer_like_unconfirmed',
      roleConfidence: 'low',
      classifierVersion: CURRENT_CLASSIFIER_VERSION,
    });
  });

  it('inbound ambiguous P2P/transfer-shaped -> income fallback, tagged transfer_like_unconfirmed', () => {
    const core = classifyCore(
      input({ amount: -100, personalFinanceCategoryPrimary: 'TRANSFER_IN', personalFinanceCategoryDetailed: 'TRANSFER_IN_OTHER_TRANSFER_IN' })
    );
    expect(core.status).toBe('relational_candidate');
    expect(core.status === 'relational_candidate' && core.candidate.fallback).toEqual({
      autoRole: 'income',
      roleSource: 'transfer_like_unconfirmed',
      roleConfidence: 'low',
      classifierVersion: CURRENT_CLASSIFIER_VERSION,
    });
  });

  it('TRANSFER_IN/OUT primary with no detailed at all is still a relational candidate, never auto-internal_transfer', () => {
    const core = classifyCore(input({ amount: 100, personalFinanceCategoryPrimary: 'TRANSFER_IN' }));
    expect(core.status).toBe('relational_candidate');
  });
});

describe('classifyCore — refund candidates (step F)', () => {
  it('any negative amount not otherwise classified is a refund candidate, never auto-refund from category alone', () => {
    const core = classifyCore(input({ amount: -30, personalFinanceCategoryPrimary: 'GENERAL_MERCHANDISE' }));
    expect(core.status).toBe('relational_candidate');
    expect(core.status === 'relational_candidate' && core.candidate.kind).toBe('refund');
    expect(core.status === 'relational_candidate' && core.candidate.fallback.autoRole).toBe('income');
    expect(core.status === 'relational_candidate' && core.candidate.fallback.roleSource).toBe('refund_candidate_unconfirmed');
  });
});

describe('classifyRowLevel', () => {
  it('returns the fallback role directly for a relational candidate, never leaving a row unclassified', () => {
    const result = classifyRowLevel(input({ amount: -30, personalFinanceCategoryPrimary: 'GENERAL_MERCHANDISE' }));
    expect(result.autoRole).toBe('income');
    expect(result.roleConfidence).toBe('low');
  });

  it('returns the final result directly for a non-candidate row', () => {
    const result = classifyRowLevel(input({ amount: 25 }));
    expect(result.autoRole).toBe('expense');
  });
});
