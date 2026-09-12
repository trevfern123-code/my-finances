import { describe, expect, it } from 'vitest';
import { getSemanticEffects, type SemanticEffectsInput } from './semanticEffects';

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

  it('null principalPortion treats the whole amount as interest (defensive default, principal=0)', () => {
    const effects = getSemanticEffects(
      txn({ amount: 200, effectiveRole: 'debt_payment', manualLoanId: 'loan-1', principalPortion: null })
    );
    expect(effects).toEqual([
      { role: 'debt_payment', amount: 0 },
      { role: 'expense', amount: 200 },
    ]);
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
