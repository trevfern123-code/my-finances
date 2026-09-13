import { describe, expect, it } from 'vitest';
import {
  getSemanticEffects,
  normalizePrincipalPortion,
  assertLinkedPaymentAmountIsCompatible,
  InvalidPrincipalPortionError,
  LinkedPaymentIntegrityError,
  SemanticIntegrityError,
  type SemanticEffectsInput,
} from './semanticEffects';

function txn(overrides: Partial<SemanticEffectsInput> = {}): SemanticEffectsInput {
  return {
    amount: 100,
    effectiveRole: 'expense',
    manualLoanId: null,
    principalPortion: null,
    userRoleOverride: null,
    ...overrides,
  };
}

describe('getSemanticEffects — ordinary transactions', () => {
  it('returns exactly one effect matching effective_role and the full amount', () => {
    expect(getSemanticEffects(txn({ amount: 42, effectiveRole: 'expense' }))).toEqual([
      { role: 'expense', amount: 42 },
    ]);
  });

  it('works identically for every ordinary role', () => {
    expect(getSemanticEffects(txn({ amount: -2000, effectiveRole: 'income' }))).toEqual([{ role: 'income', amount: -2000 }]);
    expect(getSemanticEffects(txn({ amount: 200, effectiveRole: 'internal_transfer' }))).toEqual([
      { role: 'internal_transfer', amount: 200 },
    ]);
    expect(getSemanticEffects(txn({ amount: 500, effectiveRole: 'credit_card_payment' }))).toEqual([
      { role: 'credit_card_payment', amount: 500 },
    ]);
    expect(getSemanticEffects(txn({ amount: -20, effectiveRole: 'refund' }))).toEqual([{ role: 'refund', amount: -20 }]);
  });
});

describe('getSemanticEffects — manual-loan-linked, no override', () => {
  it('decomposes into debt_payment (principal) + expense (interest)', () => {
    const effects = getSemanticEffects(
      txn({ amount: 500, effectiveRole: 'debt_payment', manualLoanId: 'loan-1', principalPortion: 350 })
    );
    expect(effects).toEqual([
      { role: 'debt_payment', amount: 350 },
      { role: 'expense', amount: 150 },
    ]);
  });

  it('the two effects always sum back to the full transaction amount', () => {
    const effects = getSemanticEffects(
      txn({ amount: 733.21, effectiveRole: 'debt_payment', manualLoanId: 'loan-1', principalPortion: 601.55 })
    );
    const total = effects.reduce((sum, e) => sum + e.amount, 0);
    expect(total).toBeCloseTo(733.21, 10);
  });

  it('100% principal produces only a debt_payment effect, no spurious zero-amount expense line', () => {
    const effects = getSemanticEffects(
      txn({ amount: 500, effectiveRole: 'debt_payment', manualLoanId: 'loan-1', principalPortion: 500 })
    );
    expect(effects).toEqual([{ role: 'debt_payment', amount: 500 }]);
  });

  it('null principalPortion treats the whole amount as interest (defensive default, principal=0) with no spurious zero-amount debt_payment line', () => {
    const effects = getSemanticEffects(
      txn({ amount: 200, effectiveRole: 'debt_payment', manualLoanId: 'loan-1', principalPortion: null })
    );
    expect(effects).toEqual([{ role: 'expense', amount: 200 }]);
  });
});

describe('getSemanticEffects — throws on impossible persisted state instead of clamping (Round 3 remediation §9)', () => {
  it('amount 100 / principal 0 -> expense 100 only', () => {
    expect(getSemanticEffects(txn({ amount: 100, manualLoanId: 'loan-1', principalPortion: 0 }))).toEqual([
      { role: 'expense', amount: 100 },
    ]);
  });

  it('amount 100 / principal 100 -> debt_payment 100 only', () => {
    expect(getSemanticEffects(txn({ amount: 100, manualLoanId: 'loan-1', principalPortion: 100 }))).toEqual([
      { role: 'debt_payment', amount: 100 },
    ]);
  });

  it('amount 100 / principal 60 -> debt_payment 60 + expense 40', () => {
    expect(getSemanticEffects(txn({ amount: 100, manualLoanId: 'loan-1', principalPortion: 60 }))).toEqual([
      { role: 'debt_payment', amount: 60 },
      { role: 'expense', amount: 40 },
    ]);
  });

  it('amount 100 / principal 120 (impossible, exceeds amount) -> throws SemanticIntegrityError', () => {
    expect(() => getSemanticEffects(txn({ amount: 100, manualLoanId: 'loan-1', principalPortion: 120 }))).toThrow(
      SemanticIntegrityError
    );
  });

  it('amount 100 / principal -10 (impossible, negative) -> throws SemanticIntegrityError', () => {
    expect(() => getSemanticEffects(txn({ amount: 100, manualLoanId: 'loan-1', principalPortion: -10 }))).toThrow(
      SemanticIntegrityError
    );
  });

  it('NaN/Infinity principal never propagates -> throws SemanticIntegrityError', () => {
    expect(() => getSemanticEffects(txn({ amount: 100, manualLoanId: 'loan-1', principalPortion: NaN }))).toThrow(
      SemanticIntegrityError
    );
    expect(() =>
      getSemanticEffects(txn({ amount: 100, manualLoanId: 'loan-1', principalPortion: Infinity }))
    ).toThrow(SemanticIntegrityError);
  });

  it('a negative or zero linked amount throws SemanticIntegrityError', () => {
    expect(() => getSemanticEffects(txn({ amount: -100, manualLoanId: 'loan-1', principalPortion: 0 }))).toThrow(
      SemanticIntegrityError
    );
    expect(() => getSemanticEffects(txn({ amount: 0, manualLoanId: 'loan-1', principalPortion: 0 }))).toThrow(
      SemanticIntegrityError
    );
  });

  it('components always sum exactly to the cent-normalized transaction amount, even with float-drift-prone inputs', () => {
    const effects = getSemanticEffects(txn({ amount: 100.1, manualLoanId: 'loan-1', principalPortion: 60.05 }));
    expect(effects).toEqual([
      { role: 'debt_payment', amount: 60.05 },
      { role: 'expense', amount: 40.05 },
    ]);
  });
});

describe('assertLinkedPaymentAmountIsCompatible — Plaid-resync boundary (Round 3 remediation §8)', () => {
  it('accepts a compatible amount/principal pair', () => {
    expect(() => assertLinkedPaymentAmountIsCompatible(100, 60)).not.toThrow();
    expect(() => assertLinkedPaymentAmountIsCompatible(100, 0)).not.toThrow();
    expect(() => assertLinkedPaymentAmountIsCompatible(100, 100)).not.toThrow();
    expect(() => assertLinkedPaymentAmountIsCompatible(100, null)).not.toThrow();
  });

  it('rejects a resynced amount that no longer covers the stored principal', () => {
    expect(() => assertLinkedPaymentAmountIsCompatible(50, 60)).toThrow(LinkedPaymentIntegrityError);
  });

  it('rejects a non-finite, negative, or zero resynced amount', () => {
    expect(() => assertLinkedPaymentAmountIsCompatible(-100, 0)).toThrow(LinkedPaymentIntegrityError);
    expect(() => assertLinkedPaymentAmountIsCompatible(0, 0)).toThrow(LinkedPaymentIntegrityError);
    expect(() => assertLinkedPaymentAmountIsCompatible(NaN, 0)).toThrow(LinkedPaymentIntegrityError);
  });

  it('rejects a non-finite or negative stored principal', () => {
    expect(() => assertLinkedPaymentAmountIsCompatible(100, NaN)).toThrow(LinkedPaymentIntegrityError);
    expect(() => assertLinkedPaymentAmountIsCompatible(100, -10)).toThrow(LinkedPaymentIntegrityError);
  });
});

describe('normalizePrincipalPortion — the WRITE boundary (Round 2 remediation §7)', () => {
  it('accepts and cent-rounds a valid value', () => {
    expect(normalizePrincipalPortion(100, 33.333)).toBe(33.33);
  });

  it('accepts the boundaries 0 and the full amount', () => {
    expect(normalizePrincipalPortion(100, 0)).toBe(0);
    expect(normalizePrincipalPortion(100, 100)).toBe(100);
  });

  it('rejects a value greater than the transaction amount', () => {
    expect(() => normalizePrincipalPortion(100, 120)).toThrow(InvalidPrincipalPortionError);
  });

  it('rejects a negative value', () => {
    expect(() => normalizePrincipalPortion(100, -10)).toThrow(InvalidPrincipalPortionError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => normalizePrincipalPortion(100, NaN)).toThrow(InvalidPrincipalPortionError);
    expect(() => normalizePrincipalPortion(100, Infinity)).toThrow(InvalidPrincipalPortionError);
    expect(() => normalizePrincipalPortion(100, -Infinity)).toThrow(InvalidPrincipalPortionError);
  });
});

describe('getSemanticEffects — manual-loan-linked, WITH user override', () => {
  it('returns exactly one effect for the full amount using the override role, decomposition fully suppressed', () => {
    const effects = getSemanticEffects(
      txn({
        amount: 500,
        effectiveRole: 'expense', // effective_role already reflects the override via the generated column
        manualLoanId: 'loan-1',
        principalPortion: 350,
        userRoleOverride: 'expense',
      })
    );
    expect(effects).toEqual([{ role: 'expense', amount: 500 }]);
  });

  it('loan balance bookkeeping is a separate concern entirely — this function never touches or reports principalPortion when overridden', () => {
    const effects = getSemanticEffects(
      txn({ amount: 500, effectiveRole: 'internal_transfer', manualLoanId: 'loan-1', principalPortion: 350, userRoleOverride: 'internal_transfer' })
    );
    expect(effects).toEqual([{ role: 'internal_transfer', amount: 500 }]);
  });
});

describe('guard rail — why a naive effective_role-only filter is wrong for decomposed loan payments', () => {
  it('demonstrates the undercount/overcount a naive filter would produce on a mixed fixture', () => {
    const fixture: SemanticEffectsInput[] = [
      txn({ amount: 50, effectiveRole: 'expense' }), // ordinary purchase
      txn({ amount: -2000, effectiveRole: 'income' }), // paycheck
      // A $500 manual-loan payment: $350 principal (not spend), $150 interest (real spend).
      txn({ amount: 500, effectiveRole: 'debt_payment', manualLoanId: 'loan-1', principalPortion: 350 }),
    ];

    // The correct total spend, via getSemanticEffects: the ordinary $50 purchase + the $150
    // interest component of the loan payment. The $350 principal is correctly excluded.
    const correctSpend = fixture
      .flatMap((t) => getSemanticEffects(t))
      .filter((e) => e.role === 'expense')
      .reduce((sum, e) => sum + e.amount, 0);
    expect(correctSpend).toBe(200); // 50 + 150

    // A naive `WHERE effective_role = 'expense'` filter sees the loan-payment row's single
    // effective_role ('debt_payment') and excludes the whole $500 — silently losing the real $150
    // of interest spend. This is the exact bug getSemanticEffects exists to prevent.
    const naiveSpend = fixture.filter((t) => t.effectiveRole === 'expense').reduce((sum, t) => sum + t.amount, 0);
    expect(naiveSpend).toBe(50); // wrong — misses the $150 interest component entirely
    expect(naiveSpend).not.toBe(correctSpend);
  });
});
