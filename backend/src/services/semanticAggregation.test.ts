import { describe, expect, it } from 'vitest';
import {
  aggregateBudgetSpend,
  aggregateCashFlow,
  aggregateCashFlowByMonth,
  aggregateMonthlyBreakdown,
  LOAN_INTEREST_CATEGORY,
  PAIRING_PAD_DAYS,
  SemanticAggregationIntegrityError,
  type AggregationAccount,
  type AggregationTransaction,
  type BudgetSpend,
  type EffectRow,
} from './semanticAggregation';
import { SemanticIntegrityError } from './semanticEffects';
import { aggregateByMonth } from './monthlyBreakdown';
import {
  ACCOUNT,
  AUGUST,
  CATEGORY,
  LOAN_M,
  SEPTEMBER,
  fixtureAccounts,
  fixtureSplits,
  fixtureTransactions,
  withRow,
} from '../testUtils/phaseBFixture';

// Financial Semantics Phase B, slice 1: the pure aggregation module against the canonical fixture
// of FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §9.1. Every expected number below is the design's own.

const september = (transactions: AggregationTransaction[] = fixtureTransactions(), accounts: AggregationAccount[] = fixtureAccounts()) =>
  aggregateCashFlow({ accounts, transactions, period: SEPTEMBER });

function sumEffectRows(rows: EffectRow[] | undefined): number {
  return Math.round((rows ?? []).reduce((s, r) => s + Math.round(r.amount * 100), 0)) / 100;
}

function assertBudgetReconciles(budget: BudgetSpend): void {
  for (const [key, rows] of budget.effectRows) {
    const bucket = key === null ? budget.unassigned : budget.byCategory.get(key);
    expect(sumEffectRows(rows)).toBe(bucket);
  }
}

describe('control: the fixture reproduces today\'s sign-based figures (design §9.5 / §6.4 frozen fields)', () => {
  it('legacy aggregateByMonth over the included accounts gives income 4 462.10, spent 2 635.00', () => {
    const included = fixtureTransactions().filter((t) => t.accountId !== ACCOUNT.E);
    const months = aggregateByMonth(included.map((t) => ({ amount: t.amount, date: t.date, category: t.plaidCategory })));
    const sept = months.find((m) => m.month === '2026-09')!;
    expect(Math.round(sept.total_income * 100) / 100).toBe(4462.1);
    expect(Math.round(sept.total_spent * 100) / 100).toBe(2635);
    expect(Math.round((sept.total_income - sept.total_spent) * 100) / 100).toBe(1827.1);
  });
});

describe('aggregateCashFlow — base fixture, September (design §9.1 "Expected")', () => {
  const t = september();

  it('income, spending, debt payments and known principal', () => {
    expect(t.income).toBe(3002.1);
    expect(t.spending).toBe(525); // 120+80+50(interest)+60−60+75+200
    expect(t.debtPayments).toBe(650); // 350 known principal + 300 unknown split
    expect(t.knownPrincipal).toBe(350);
    expect(t.debtPaymentsUnknownPrincipal).toBe(300);
  });

  it('transfers and card payments net to zero and are reported, not counted', () => {
    expect(t.transfersInternal).toBe(500);
    expect(t.transfersExternal).toBe(0);
    expect(t.creditCardPaymentsTracked).toBe(900);
    expect(t.creditCardPaymentsUntracked).toBe(0);
    expect(t.creditCardPaymentsExternallyFunded).toBe(0);
    expect(t.refunds).toBe(-60);
  });

  it('cash flow is cash retained after debt service (1 827.10); savings rate adds back known principal (72.5 %)', () => {
    expect(t.cashFlow).toBe(1827.1);
    expect(t.savingsRate).toBeCloseTo((1827.1 + 350) / 3002.1, 10);
    expect(Math.round(t.savingsRate * 1000) / 10).toBe(72.5);
  });

  it('the excluded account E (row 12, $999) contributes nothing', () => {
    const withoutE = september(fixtureTransactions().filter((r) => r.id !== '12'));
    expect(withoutE).toEqual(t);
  });

  it('September has no unclassified rows; August\'s row 13 is counted by its sign AND reported (R0)', () => {
    expect(t.unclassifiedCount).toBe(0);
    const aug = aggregateCashFlow({ accounts: fixtureAccounts(), transactions: fixtureTransactions(), period: AUGUST });
    expect(aug.spending).toBe(45);
    expect(aug.unclassifiedCount).toBe(1);
    expect(aug.unclassifiedAmount).toBe(45);
    expect(aug.cashFlow).toBe(-45);
  });

  it('per-month view: August and September, ascending, each with its own figures', () => {
    const months = aggregateCashFlowByMonth({ accounts: fixtureAccounts(), transactions: fixtureTransactions() });
    expect(months.map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(months[1].cashFlow).toBe(1827.1);
    expect(months[0].unclassifiedCount).toBe(1);
  });
});

describe('aggregateBudgetSpend — base fixture, September (design §9.1 Budget, §4.6 splits)', () => {
  const budget = aggregateBudgetSpend({
    accounts: fixtureAccounts(),
    transactions: fixtureTransactions(),
    splits: fixtureSplits(),
    period: SEPTEMBER,
  });

  it('Groceries 270 (120 + 150 split), Dining 80, Shopping 0 (60 − 60), Household 50, unassigned 125', () => {
    expect(budget.byCategory.get(CATEGORY.groceries)).toBe(270);
    expect(budget.byCategory.get(CATEGORY.dining)).toBe(80);
    expect(budget.byCategory.get(CATEGORY.shopping)).toBe(0);
    expect(budget.byCategory.get(CATEGORY.household)).toBe(50);
    expect(budget.unassigned).toBe(125); // SoFi interest 50 + Venmo 75
    expect(budget.total).toBe(525); // equals role-aware spending
    expect(budget.splitMismatches).toEqual([]);
  });

  it('every bucket\'s effect rows sum exactly to the bucket (drill-down reconciliation, design §7.3)', () => {
    assertBudgetReconciles(budget);
    const shopping = budget.effectRows.get(CATEGORY.shopping)!;
    expect(shopping.map((r) => [r.transactionId, r.amount, r.effectRole])).toEqual([
      ['8a', 60, 'expense'],
      ['8b', -60, 'refund'],
    ]);
    const unassigned = budget.effectRows.get(null)!;
    expect(unassigned.map((r) => [r.transactionId, r.amount, r.allocation])).toEqual([
      ['6', 50, 'interest'],
      ['9', 75, 'row'],
    ]);
    expect(budget.effectRows.get(CATEGORY.household)!.map((r) => [r.transactionId, r.allocation, r.splitId])).toEqual([
      ['10', 'split', 'split-10b'],
    ]);
  });

  it('transfers, card payments and debt principal never reach a budget category', () => {
    const allIds = Array.from(budget.effectRows.values()).flat().map((r) => r.transactionId);
    for (const id of ['1', '4a', '4b', '5a', '5b', '7', '11', '12', '13']) expect(allIds).not.toContain(id);
    expect(allIds.filter((id) => id === '6')).toHaveLength(1); // interest only
  });
});

describe('aggregateMonthlyBreakdown — base fixture (design §5 C5)', () => {
  const [aug, sept] = aggregateMonthlyBreakdown({ accounts: fixtureAccounts(), transactions: fixtureTransactions() });

  it('September by Plaid category, with manual-loan interest under LOAN_INTEREST', () => {
    expect(sept.month).toBe('2026-09');
    expect(Object.fromEntries(sept.byCategory)).toEqual({
      FOOD_AND_DRINK: 400,
      GENERAL_MERCHANDISE: 0,
      TRANSFER_OUT: 75,
      [LOAN_INTEREST_CATEGORY]: 50,
    });
    expect(sept.spending).toBe(525);
    expect(sept.income).toBe(3002.1);
  });

  it('the "not counted as spending" footer: transfers 500, card payments 900, debt payments 650', () => {
    expect(sept.excluded).toEqual({
      transfersInternal: 500,
      transfersExternal: 0,
      creditCardPaymentsTracked: 900,
      creditCardPaymentsUntracked: 0,
      debtPayments: 650,
    });
  });

  it('splits are never used here: Costco stays whole under FOOD_AND_DRINK', () => {
    expect(sept.effectRows.get('FOOD_AND_DRINK')!.map((r) => [r.transactionId, r.amount])).toEqual([
      ['2', 120],
      ['3', 80],
      ['10', 200],
    ]);
  });

  it('every category\'s effect rows sum exactly to it, in both months', () => {
    for (const month of [aug, sept]) {
      for (const [key, rows] of month.effectRows) expect(sumEffectRows(rows)).toBe(month.byCategory.get(key));
    }
    expect(Object.fromEntries(aug.byCategory)).toEqual({ FOOD_AND_DRINK: 45 });
  });
});

describe('user role corrections (design §9.1 override variants)', () => {
  it('#9 Venmo overridden to internal_transfer (no partner): spending 450, external −75, cash flow unchanged', () => {
    const rows = withRow(fixtureTransactions(), '9', { effectiveRole: 'internal_transfer', userRoleOverride: 'internal_transfer' });
    const t = september(rows);
    expect(t.spending).toBe(450);
    expect(t.transfersExternal).toBe(-75);
    expect(t.cashFlow).toBe(1827.1);
    expect(Math.round(t.savingsRate * 1000) / 10).toBe(72.5);

    const budget = aggregateBudgetSpend({ accounts: fixtureAccounts(), transactions: rows, splits: fixtureSplits(), period: SEPTEMBER });
    expect(budget.unassigned).toBe(50);
    const sept = aggregateMonthlyBreakdown({ accounts: fixtureAccounts(), transactions: rows, period: SEPTEMBER })[0];
    expect(sept.byCategory.has('TRANSFER_OUT')).toBe(false);
  });

  it('#6 (SoFi, linked) overridden to expense: whole 400 is spending, known principal 0, rate 60.9 %', () => {
    const rows = withRow(fixtureTransactions(), '6', { effectiveRole: 'expense', userRoleOverride: 'expense' });
    const t = september(rows);
    expect(t.spending).toBe(875);
    expect(t.debtPayments).toBe(300);
    expect(t.knownPrincipal).toBe(0);
    expect(t.cashFlow).toBe(1827.1);
    expect(Math.round(t.savingsRate * 1000) / 10).toBe(60.9);
  });

  it('#6 with an explicit debt_payment override: whole 400 is a debt payment, spending 475', () => {
    const rows = withRow(fixtureTransactions(), '6', { effectiveRole: 'debt_payment', userRoleOverride: 'debt_payment' });
    const t = september(rows);
    expect(t.debtPayments).toBe(700);
    expect(t.knownPrincipal).toBe(0);
    expect(t.spending).toBe(475);
    expect(t.cashFlow).toBe(1827.1);
  });

  it('a positive row overridden to refund is a refund reversal: spending +60 in Shopping, cash flow −60', () => {
    const rows = [
      ...fixtureTransactions(),
      {
        id: '8r',
        accountId: ACCOUNT.X,
        date: '2026-09-27',
        amount: 60,
        plaidCategory: 'GENERAL_MERCHANDISE',
        budgetCategoryId: CATEGORY.shopping,
        effectiveRole: 'refund',
        userRoleOverride: 'refund',
        manualLoanId: null,
        principalPortion: null,
      },
    ];
    const t = september(rows);
    expect(t.spending).toBe(585);
    expect(t.refunds).toBe(0); // −60 and +60
    expect(t.cashFlow).toBe(1767.1);
    const budget = aggregateBudgetSpend({ accounts: fixtureAccounts(), transactions: rows, splits: fixtureSplits(), period: SEPTEMBER });
    expect(budget.byCategory.get(CATEGORY.shopping)).toBe(60);
    assertBudgetReconciles(budget);
  });

  it('a negative row overridden to expense reduces spending; a positive row overridden to income reduces income', () => {
    const rows = [
      ...fixtureTransactions(),
      { ...fixtureTransactions()[1], id: 'neg-exp', amount: -20, effectiveRole: 'expense', userRoleOverride: 'expense' },
      { ...fixtureTransactions()[0], id: 'pos-inc', amount: 100, effectiveRole: 'income', userRoleOverride: 'income' },
    ];
    const t = september(rows);
    expect(t.spending).toBe(505);
    expect(t.income).toBe(2902.1);
  });
});

describe('account exclusions and the tracked-set principle (design §4.1–§4.3, §9.1 variants)', () => {
  it('savings account excluded: 4a becomes an external transfer −500; cash flow 1 325.00, rate 55.8 %', () => {
    const t = september(fixtureTransactions(), fixtureAccounts({ S: { excludeFromCashFlow: true } }));
    expect(t.income).toBe(3000);
    expect(t.spending).toBe(525);
    expect(t.transfersInternal).toBe(0);
    expect(t.transfersExternal).toBe(-500);
    expect(t.cashFlow).toBe(1325);
    expect(Math.round(t.savingsRate * 1000) / 10).toBe(55.8);
  });

  it('card account excluded: 5a is an untracked card outflow of 900; spending 125; cash flow 1 327.10', () => {
    const t = september(fixtureTransactions(), fixtureAccounts({ X: { excludeFromCashFlow: true } }));
    expect(t.spending).toBe(125);
    expect(t.creditCardPaymentsTracked).toBe(0);
    expect(t.creditCardPaymentsUntracked).toBe(900);
    expect(t.cashFlow).toBe(1327.1);
  });

  it('card not linked at all: the same outcome — the $900 never vanishes; rate 55.9 %', () => {
    const rows = fixtureTransactions().filter((r) => r.accountId !== ACCOUNT.X);
    const accounts = fixtureAccounts().filter((a) => a.id !== ACCOUNT.X);
    const t = september(rows, accounts);
    expect(t.spending).toBe(125);
    expect(t.creditCardPaymentsUntracked).toBe(900);
    expect(t.cashFlow).toBe(1327.1);
    expect(Math.round(t.savingsRate * 1000) / 10).toBe(55.9);
  });

  it('checking not linked (externally funded card payment): 5b contributes 0; 4b reclassified as income → cash flow 102.10', () => {
    // Per §9.1, with C gone reconciliation no longer pairs 4b: it falls back to income.
    const rows = withRow(
      fixtureTransactions().filter((r) => r.accountId !== ACCOUNT.C),
      '4b',
      { effectiveRole: 'income' }
    );
    const accounts = fixtureAccounts().filter((a) => a.id !== ACCOUNT.C);
    const t = september(rows, accounts);
    expect(t.income).toBe(502.1);
    expect(t.spending).toBe(400);
    expect(t.debtPayments).toBe(0);
    expect(t.creditCardPaymentsExternallyFunded).toBe(900);
    expect(t.cashFlow).toBe(102.1);
  });

  // Design conflict, recorded in FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §13 Q1: §9.1 says marking 4b
  // as a transfer in this variant "gives Income 2.10 and Cash flow −397.90", but §4.1/§4.2 (the later
  // tracked-set principle) count an unpaired transfer leg in cash flow with its sign, which gives
  // 102.10. Deliberately not asserted until the design is reconciled.
  it.todo('checking not linked, 4b marked as a transfer — awaiting design §13 Q1 (−397.90 vs 102.10)');
});

describe('card-payment pairing edge cases (design §4.3, §9.1 "Pairing edge cases")', () => {
  const extra = (id: string, date: string, accountId: string, amount: number): AggregationTransaction => ({
    id,
    accountId,
    date,
    amount,
    plaidCategory: 'LOAN_PAYMENTS',
    budgetCategoryId: null,
    effectiveRole: 'credit_card_payment',
    userRoleOverride: null,
    manualLoanId: null,
    principalPortion: null,
  });
  const X2 = 'acct-X2';
  const accountsWithX2 = [...fixtureAccounts(), { id: X2, type: 'credit', excludeFromCashFlow: false }];

  it('two identical payments on consecutive days with two card legs each pair to the nearest: both tracked', () => {
    const rows = [...fixtureTransactions(), extra('5c', '2026-09-11', ACCOUNT.C, 900), extra('5d', '2026-09-11', ACCOUNT.X, -900)];
    const t = september(rows);
    expect(t.creditCardPaymentsTracked).toBe(1800);
    expect(t.creditCardPaymentsUntracked).toBe(0);
    expect(t.cashFlow).toBe(1827.1);
  });

  it('one payer leg with two card legs at equal distance is ambiguous: untracked, never guessed', () => {
    const rows = [
      ...fixtureTransactions().filter((r) => r.id !== '5b'),
      extra('card-early', '2026-09-09', ACCOUNT.X, -900),
      extra('card-late', '2026-09-11', X2, -900),
    ];
    const t = september(rows, accountsWithX2);
    expect(t.creditCardPaymentsTracked).toBe(0);
    expect(t.creditCardPaymentsUntracked).toBe(900);
    expect(t.creditCardPaymentsExternallyFunded).toBe(1800);
    expect(t.cashFlow).toBe(927.1);
  });

  it('a payment on 09-29 whose card leg posts 10-02 is tracked in September only when the fetch is padded', () => {
    const late = [extra('5late', '2026-09-29', ACCOUNT.C, 250), extra('5late-card', '2026-10-02', ACCOUNT.X, -250)];
    const padded = september([...fixtureTransactions(), ...late]);
    expect(padded.creditCardPaymentsTracked).toBe(1150);
    expect(padded.creditCardPaymentsUntracked).toBe(0);
    // Without the padding row the same payment would wrongly look untracked.
    const unpadded = september([...fixtureTransactions(), late[0]]);
    expect(unpadded.creditCardPaymentsUntracked).toBe(250);
    expect(PAIRING_PAD_DAYS).toBeGreaterThanOrEqual(5);
  });

  it('a card leg must be on a credit account: an opposite leg on a depository account never tracks the payment', () => {
    const rows = withRow(fixtureTransactions(), '5b', { accountId: ACCOUNT.S });
    const t = september(rows);
    expect(t.creditCardPaymentsTracked).toBe(0);
    expect(t.creditCardPaymentsUntracked).toBe(900);
    // Pinned current behaviour for a negative card-payment leg on a non-credit account, per §4.3's
    // sign rule; flagged for confirmation in design §13 Q4.
    expect(t.creditCardPaymentsExternallyFunded).toBe(900);
  });
});

describe('transfer pairing (design §4.2)', () => {
  it('a pair that crosses the period boundary nets to zero in both months (fetch padded)', () => {
    const rows = [
      ...withRow(withRow(fixtureTransactions(), '4a', { date: '2026-09-30' }), '4b', { date: '2026-10-01' }),
    ];
    const t = september(rows);
    expect(t.transfersInternal).toBe(500);
    expect(t.transfersExternal).toBe(0);
    expect(t.cashFlow).toBe(1827.1);
  });

  it('an ambiguous transfer (two equally close partners) is left unpaired; the period\'s cash-flow total is unaffected', () => {
    const S2 = 'acct-S2';
    const rows = [
      ...fixtureTransactions(),
      { ...fixtureTransactions()[4], id: '4c', accountId: S2 }, // a second −500 into another savings account, same day
    ];
    const accounts = [...fixtureAccounts(), { id: S2, type: 'depository', excludeFromCashFlow: false }];
    const t = september(rows, accounts);
    expect(t.transfersInternal).toBe(0);
    expect(t.transfersExternal).toBe(500); // −500 + 500 + 500: exactly the net cash that entered the tracked set
    expect(t.cashFlow).toBe(2327.1);
  });

  it('a transfer leg whose opposite leg is classified as income does not pair (both legs must be transfers)', () => {
    const rows = withRow(fixtureTransactions(), '4b', { effectiveRole: 'income' });
    const t = september(rows);
    expect(t.transfersInternal).toBe(0);
    expect(t.transfersExternal).toBe(-500);
    expect(t.income).toBe(3502.1);
    expect(t.cashFlow).toBe(1827.1);
  });
});

describe('refunds and splits (design §4.5, §4.6)', () => {
  const budgetFor = (rows: AggregationTransaction[], splits = fixtureSplits(), period = SEPTEMBER) =>
    aggregateBudgetSpend({ accounts: fixtureAccounts(), transactions: rows, splits, period });

  it('a refund counts in its own month: with the purchase in August, August Shopping +60, September −60', () => {
    const rows = withRow(fixtureTransactions(), '8a', { date: '2026-08-18' });
    expect(budgetFor(rows).byCategory.get(CATEGORY.shopping)).toBe(-60); // never clamped
    expect(budgetFor(rows, fixtureSplits(), AUGUST).byCategory.get(CATEGORY.shopping)).toBe(60);
  });

  it('a refund with no budget category reduces unassigned spending only', () => {
    const rows = withRow(fixtureTransactions(), '8b', { budgetCategoryId: null });
    const budget = budgetFor(rows);
    expect(budget.byCategory.get(CATEGORY.shopping)).toBe(60);
    expect(budget.unassigned).toBe(65);
    assertBudgetReconciles(budget);
  });

  it('splits on a transfer parent contribute nothing', () => {
    const rows = withRow(fixtureTransactions(), '10', { effectiveRole: 'internal_transfer', userRoleOverride: 'internal_transfer' });
    const budget = budgetFor(rows);
    expect(budget.byCategory.get(CATEGORY.household)).toBeUndefined();
    expect(budget.byCategory.get(CATEGORY.groceries)).toBe(120);
  });

  it('splits on a loan-linked parent without an override are ignored: only its interest counts, unassigned', () => {
    const splits = [
      ...fixtureSplits(),
      { id: 'split-6a', transactionId: '6', budgetCategoryId: CATEGORY.household, amount: 400 },
    ];
    const budget = budgetFor(fixtureTransactions(), splits);
    expect(budget.byCategory.get(CATEGORY.household)).toBe(50);
    expect(budget.unassigned).toBe(125);
    assertBudgetReconciles(budget);
  });

  it('with an expense override the loan-linked row is one effect, so its splits apply', () => {
    const rows = withRow(fixtureTransactions(), '6', { effectiveRole: 'expense', userRoleOverride: 'expense' });
    const splits = [...fixtureSplits(), { id: 'split-6a', transactionId: '6', budgetCategoryId: CATEGORY.household, amount: 400 }];
    const budget = budgetFor(rows, splits);
    expect(budget.byCategory.get(CATEGORY.household)).toBe(450);
    expect(budget.unassigned).toBe(75);
  });

  it('splits that do not sum to their parent are allocated as stored and reported (design §13 Q3)', () => {
    const splits = [
      { id: 'split-10a', transactionId: '10', budgetCategoryId: CATEGORY.groceries, amount: 150 },
      { id: 'split-10b', transactionId: '10', budgetCategoryId: CATEGORY.household, amount: 49.99 },
    ];
    const budget = budgetFor(fixtureTransactions(), splits);
    expect(budget.splitMismatches).toEqual([{ transactionId: '10', parentAmount: 200, splitTotal: 199.99 }]);
    expect(budget.byCategory.get(CATEGORY.household)).toBe(49.99);
  });
});

describe('integrity failures are never masked (R9, invariant I4)', () => {
  it('an impossible loan-linked principal fails the whole aggregate and names the row', () => {
    const rows = withRow(fixtureTransactions(), '6', { principalPortion: 450 });
    const run = () => september(rows);
    expect(run).toThrow(SemanticAggregationIntegrityError);
    expect(run).toThrow(SemanticIntegrityError); // still caught by existing handling
    try {
      run();
    } catch (err) {
      expect((err as SemanticAggregationIntegrityError).transactionId).toBe('6');
      expect((err as Error).message).toMatch(/^semantic_integrity_error: transaction 6:/);
    }
    expect(() => aggregateBudgetSpend({ accounts: fixtureAccounts(), transactions: rows, splits: [], period: SEPTEMBER })).toThrow(
      SemanticAggregationIntegrityError
    );
    expect(() => aggregateMonthlyBreakdown({ accounts: fixtureAccounts(), transactions: rows })).toThrow(SemanticAggregationIntegrityError);
  });

  it('a role outside the six Phase A roles, a non-finite amount, or an unknown account is an integrity failure', () => {
    expect(() => september(withRow(fixtureTransactions(), '2', { effectiveRole: 'spending' }))).toThrow(/effective_role 'spending'/);
    expect(() => september(withRow(fixtureTransactions(), '2', { amount: Number.NaN }))).toThrow(/finite/);
    expect(() => september(withRow(fixtureTransactions(), '2', { accountId: 'acct-missing' }))).toThrow(/was not supplied/);
  });

  it('a NULL role is not an integrity failure: it degrades to the sign fallback (R0)', () => {
    const rows = withRow(fixtureTransactions(), '2', { effectiveRole: null });
    const t = september(rows);
    expect(t.spending).toBe(525);
    expect(t.unclassifiedCount).toBe(1);
    expect(t.unclassifiedAmount).toBe(120);
  });

  it('the manual-loan decomposition is exactly the Phase A contract: 350 principal + 50 interest', () => {
    const only6 = fixtureTransactions().filter((r) => r.id === '6');
    const t = september(only6);
    expect(t.knownPrincipal).toBe(350);
    expect(t.spending).toBe(50);
    expect(only6[0].manualLoanId).toBe(LOAN_M);
  });
});
