import { describe, expect, it } from 'vitest';
import {
  aggregateBudgetSpend,
  aggregateCashFlow,
  aggregateCashFlowByMonth,
  aggregateMonthlyBreakdown,
  LOAN_INTEREST_CATEGORY,
  PAIRING_PAD_DAYS,
  pairingContextRange,
  SemanticAggregationIntegrityError,
  SplitAllocationMismatchError,
  type AggregationPeriod,
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
    expect(t.creditCardPaymentsReturnedTracked).toBe(0);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(0);
    expect(t.creditCardPaymentsReversedExternally).toBe(0);
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
      creditCardPaymentsReturnedUntracked: 0,
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

  it('checking not linked, 4b marked as a transfer: an external transfer +500 → income 2.10, cash flow 102.10 (§13 Q1 resolved)', () => {
    // The approved tracked-set principle (§4.1/§4.2) counts an unpaired transfer leg in cash flow with
    // its sign; the stale "−397.90" in §9.1 was corrected to this.
    const rows = fixtureTransactions().filter((r) => r.accountId !== ACCOUNT.C);
    const accounts = fixtureAccounts().filter((a) => a.id !== ACCOUNT.C);
    const t = september(rows, accounts);
    expect(t.income).toBe(2.1);
    expect(t.transfersExternal).toBe(500);
    expect(t.cashFlow).toBe(102.1);
  });
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

  it('a card leg must be on a credit account: two cash-side legs never pair, and the money is counted once each way', () => {
    // 5b moved to savings: checking +900 out, savings −900 in, both labelled card payments.
    const rows = withRow(fixtureTransactions(), '5b', { accountId: ACCOUNT.S });
    const t = september(rows);
    expect(t.creditCardPaymentsTracked).toBe(0);
    expect(t.creditCardPaymentsUntracked).toBe(900);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(900);
    expect(t.creditCardPaymentsExternallyFunded).toBe(0);
    expect(t.cashFlow).toBe(1827.1); // cash stayed within the tracked set
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

});

describe('split allocation mismatches refuse the budget aggregate (Trevor\'s decision on design §13 Q3)', () => {
  const budgetFor = (rows: AggregationTransaction[], splits: typeof fixtureSplits extends () => infer R ? R : never) =>
    aggregateBudgetSpend({ accounts: fixtureAccounts(), transactions: rows, splits, period: SEPTEMBER });
  const expectRefused = (run: () => unknown, transactionId: string) => {
    expect(run).toThrow(SplitAllocationMismatchError);
    try {
      run();
    } catch (err) {
      expect(err).not.toBeInstanceOf(SemanticIntegrityError); // never shown as loan data
      expect((err as SplitAllocationMismatchError).code).toBe('split_allocation_mismatch');
      expect((err as SplitAllocationMismatchError).transactionId).toBe(transactionId);
      return err as SplitAllocationMismatchError;
    }
    throw new Error('expected a refusal');
  };

  it('an expense whose splits are one cent short is refused, naming the transaction; nothing is adjusted', () => {
    const splits = [
      { id: 'split-10a', transactionId: '10', budgetCategoryId: CATEGORY.groceries, amount: 150 },
      { id: 'split-10b', transactionId: '10', budgetCategoryId: CATEGORY.household, amount: 49.99 },
    ];
    const err = expectRefused(() => budgetFor(fixtureTransactions(), splits), '10');
    expect(err.mismatches).toEqual([{ transactionId: '10', parentAmount: 200, splitTotal: 199.99 }]);
    expect(splits[1].amount).toBe(49.99); // the stored split is untouched
  });

  it('a refund whose splits do not sum to its negative amount is refused', () => {
    const splits = [...fixtureSplits(), { id: 'split-8b', transactionId: '8b', budgetCategoryId: CATEGORY.shopping, amount: -50 }];
    const err = expectRefused(() => budgetFor(fixtureTransactions(), splits), '8b');
    expect(err.mismatches).toEqual([{ transactionId: '8b', parentAmount: -60, splitTotal: -50 }]);
  });

  it('every mismatched parent is reported, and a non-finite split amount is a mismatch too', () => {
    const splits = [
      { id: 'split-10a', transactionId: '10', budgetCategoryId: CATEGORY.groceries, amount: 150 },
      { id: 'split-10b', transactionId: '10', budgetCategoryId: CATEGORY.household, amount: 40 },
      { id: 'split-2', transactionId: '2', budgetCategoryId: CATEGORY.groceries, amount: Number.NaN },
    ];
    const err = expectRefused(() => budgetFor(fixtureTransactions(), splits), '2');
    expect(err.mismatches.map((m) => m.transactionId)).toEqual(['2', '10']);
    expect(err.message).toMatch(/and 1 more/);
  });

  it('valid splits — including a refund split summing to its negative amount — are accepted', () => {
    const splits = [...fixtureSplits(), { id: 'split-8b', transactionId: '8b', budgetCategoryId: CATEGORY.household, amount: -60 }];
    const budget = budgetFor(fixtureTransactions(), splits);
    expect(budget.byCategory.get(CATEGORY.shopping)).toBe(60);
    expect(budget.byCategory.get(CATEGORY.household)).toBe(-10);
    assertBudgetReconciles(budget);
  });

  it('mismatched splits the role rules already exclude (transfer, card payment, loan-decomposed) never block the budget', () => {
    const splits = [
      ...fixtureSplits(),
      { id: 'split-4a', transactionId: '4a', budgetCategoryId: CATEGORY.household, amount: 1 },
      { id: 'split-5a', transactionId: '5a', budgetCategoryId: CATEGORY.household, amount: 1 },
      { id: 'split-6', transactionId: '6', budgetCategoryId: CATEGORY.household, amount: 1 },
    ];
    const budget = budgetFor(fixtureTransactions(), splits);
    expect(budget.total).toBe(525);
    expect(budget.byCategory.get(CATEGORY.household)).toBe(50);
  });

  it('cash flow and the Monthly Breakdown stay available while the budget is refused (neither reads splits)', () => {
    const splits = [{ id: 'split-10a', transactionId: '10', budgetCategoryId: CATEGORY.groceries, amount: 1 }];
    expect(() => budgetFor(fixtureTransactions(), splits)).toThrow(SplitAllocationMismatchError);
    expect(september().cashFlow).toBe(1827.1);
    expect(aggregateMonthlyBreakdown({ accounts: fixtureAccounts(), transactions: fixtureTransactions(), period: SEPTEMBER })[0].spending).toBe(525);
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

  it('unclassifiedAmount is the signed net of unclassified rows, reported with their count (§13 Q6)', () => {
    const rows = [
      ...fixtureTransactions(),
      { ...fixtureTransactions()[15], id: '13b', amount: -20, plaidCategory: 'INCOME', budgetCategoryId: null },
    ];
    const aug = aggregateCashFlow({ accounts: fixtureAccounts(), transactions: rows, period: AUGUST });
    expect(aug.unclassifiedCount).toBe(2);
    expect(aug.unclassifiedAmount).toBe(25); // +45 purchase, −20 deposit
    expect(aug.spending).toBe(45);
    expect(aug.income).toBe(20);
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

// ---- Fetched-context contract (Codex review finding 1) ---------------------------------------------

/** Rows a caller would fetch for `period` with `padDays` on each side ([start − pad, end + pad)). */
function fetchedWithPad(rows: AggregationTransaction[], period: AggregationPeriod, padDays: number): AggregationTransaction[] {
  const shift = (d: string, n: number) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const start = shift(period.start, -padDays);
  const end = shift(period.end, padDays);
  return rows.filter((r) => r.date >= start && r.date < end);
}

const leg = (id: string, date: string, accountId: string, amount: number, role: string): AggregationTransaction => ({
  id,
  accountId,
  date,
  amount,
  plaidCategory: role === 'internal_transfer' ? (amount > 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN') : 'LOAN_PAYMENTS',
  budgetCategoryId: null,
  effectiveRole: role,
  userRoleOverride: null,
  manualLoanId: null,
  principalPortion: null,
});

describe('fetched-context contract: reciprocal matching needs two windows of surrounding evidence', () => {
  it('the documented pad is two of the widest window, and pairingContextRange applies it to both ends', () => {
    expect(PAIRING_PAD_DAYS).toBe(10);
    expect(pairingContextRange(SEPTEMBER)).toEqual({ start: '2026-08-22', end: '2026-10-11' });
  });

  it('card: Sep 1 checking +100, Aug 28 card −100, Aug 24 checking +100 — the card leg is contested, so September stays −100', () => {
    const rows = [
      leg('p1', '2026-09-01', ACCOUNT.C, 100, 'credit_card_payment'),
      leg('k', '2026-08-28', ACCOUNT.X, -100, 'credit_card_payment'),
      leg('p0', '2026-08-24', ACCOUNT.C, 100, 'credit_card_payment'),
    ];
    const accounts = fixtureAccounts();
    const run = (r: AggregationTransaction[]) => aggregateCashFlow({ accounts, transactions: r, period: SEPTEMBER });

    expect(run(rows).cashFlow).toBe(-100); // complete evidence: k's best match is a tie → no pair
    expect(run(fetchedWithPad(rows, SEPTEMBER, PAIRING_PAD_DAYS)).cashFlow).toBe(-100);
    expect(run(fetchedWithPad(rows, SEPTEMBER, 5)).cashFlow).toBe(0); // the old one-window pad hides p0
  });

  it('transfer: Sep 30 checking +100, Oct 3 savings −100, Oct 6 checking +100 — ambiguous reciprocal match, September stays −100', () => {
    const rows = [
      leg('t1', '2026-09-30', ACCOUNT.C, 100, 'internal_transfer'),
      leg('t2', '2026-10-03', ACCOUNT.S, -100, 'internal_transfer'),
      leg('t3', '2026-10-06', ACCOUNT.C, 100, 'internal_transfer'),
    ];
    const accounts = fixtureAccounts();
    const run = (r: AggregationTransaction[]) => aggregateCashFlow({ accounts, transactions: r, period: SEPTEMBER });

    expect(run(rows).cashFlow).toBe(-100);
    expect(run(rows).transfersExternal).toBe(-100);
    expect(run(fetchedWithPad(rows, SEPTEMBER, PAIRING_PAD_DAYS)).cashFlow).toBe(-100);
    expect(run(fetchedWithPad(rows, SEPTEMBER, 5)).cashFlow).toBe(0);
  });

  it('for many generated histories, the in-period result with the documented pad equals the result with complete evidence', () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const accounts = [...fixtureAccounts(), { id: 'acct-S2', type: 'depository', excludeFromCashFlow: false }, { id: 'acct-X2', type: 'credit', excludeFromCashFlow: false }];
    const cash = [ACCOUNT.C, ACCOUNT.S, 'acct-S2'];
    const credit = [ACCOUNT.X, 'acct-X2'];
    const pick = <T,>(xs: T[]) => xs[Math.floor(random() * xs.length)];
    // Legs cluster within ±12 days of the two period boundaries, where two-hop evidence matters.
    const day = () => {
      const d = new Date(random() < 0.5 ? '2026-09-01T00:00:00Z' : '2026-10-01T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + Math.floor(random() * 25) - 12);
      return d.toISOString().slice(0, 10);
    };

    let oneWindowDiffers = 0;
    for (let history = 0; history < 200; history++) {
      const rows: AggregationTransaction[] = [];
      for (let i = 0; i < 25; i++) {
        const transfer = random() < 0.5;
        const amount = 100 * (random() < 0.5 ? 1 : -1);
        const account = transfer ? pick(cash) : amount > 0 === random() < 0.8 ? pick(cash) : pick(credit);
        rows.push(leg(`h${history}-${i}`, day(), account, amount, transfer ? 'internal_transfer' : 'credit_card_payment'));
      }
      const full = aggregateCashFlow({ accounts, transactions: rows, period: SEPTEMBER });
      const documented = aggregateCashFlow({ accounts, transactions: fetchedWithPad(rows, SEPTEMBER, PAIRING_PAD_DAYS), period: SEPTEMBER });
      expect(documented).toEqual(full);
      const oneWindow = aggregateCashFlow({ accounts, transactions: fetchedWithPad(rows, SEPTEMBER, 5), period: SEPTEMBER });
      if (JSON.stringify(oneWindow) !== JSON.stringify(full)) oneWindowDiffers++;
    }
    expect(oneWindowDiffers).toBeGreaterThan(0); // the generator does reach the two-hop cases
  });
});

// ---- Returned card payments (Codex review finding 2) ----------------------------------------------

describe('returned card payments: cash arriving in checking vs a payment into a card', () => {
  const ccp = (id: string, date: string, accountId: string, amount: number) => leg(id, date, accountId, amount, 'credit_card_payment');

  it('a matched return (checking −900 with card +900) nets to zero and is reported once, next to the matched payment', () => {
    const rows = [...fixtureTransactions(), ccp('ret-c', '2026-09-15', ACCOUNT.C, -900), ccp('ret-x', '2026-09-15', ACCOUNT.X, 900)];
    const t = september(rows);
    expect(t.creditCardPaymentsTracked).toBe(900);
    expect(t.creditCardPaymentsReturnedTracked).toBe(900);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(0);
    expect(t.creditCardPaymentsReversedExternally).toBe(0);
    expect(t.income).toBe(3002.1); // a return is never income
    expect(t.cashFlow).toBe(1827.1);
  });

  it('card not linked: the payment out (−900) and its return into checking (+900) cancel — no cash vanishes or appears', () => {
    const rows = [...fixtureTransactions().filter((r) => r.accountId !== ACCOUNT.X), ccp('ret-c', '2026-09-15', ACCOUNT.C, -900)];
    const accounts = fixtureAccounts().filter((a) => a.id !== ACCOUNT.X);
    const t = september(rows, accounts);
    expect(t.creditCardPaymentsUntracked).toBe(900);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(900);
    expect(t.cashFlow).toBe(2227.1); // = the unlinked-card variant (1 327.10) with the $900 back
  });

  it('card excluded from cash flow: the same — its +900 reversal is not loaded, the checking return still counts', () => {
    const rows = [...fixtureTransactions(), ccp('ret-c', '2026-09-15', ACCOUNT.C, -900), ccp('ret-x', '2026-09-15', ACCOUNT.X, 900)];
    const t = september(rows, fixtureAccounts({ X: { excludeFromCashFlow: true } }));
    expect(t.creditCardPaymentsUntracked).toBe(900);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(900);
    expect(t.creditCardPaymentsReturnedTracked).toBe(0);
    expect(t.cashFlow).toBe(2227.1);
  });

  it('a return on its own (no payment in range) is cash in: +100 to cash flow, not income', () => {
    const t = september([...fixtureTransactions(), ccp('ret-only', '2026-09-20', ACCOUNT.C, -100)]);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(100);
    expect(t.income).toBe(3002.1);
    expect(t.cashFlow).toBe(1927.1);
  });

  it('a reversal on the card whose cash side is outside the tracked set moves no tracked cash', () => {
    const t = september([...fixtureTransactions(), ccp('rev-x', '2026-09-16', ACCOUNT.X, 900)]);
    expect(t.creditCardPaymentsReversedExternally).toBe(900);
    expect(t.cashFlow).toBe(1827.1);
  });

  it('checking not linked: an externally funded payment into the card is still 0 (unchanged)', () => {
    const rows = fixtureTransactions().filter((r) => r.accountId !== ACCOUNT.C);
    const t = september(rows, fixtureAccounts().filter((a) => a.id !== ACCOUNT.C));
    expect(t.creditCardPaymentsExternallyFunded).toBe(900);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(0);
  });

  it('a payment and a return between the same two accounts pair with their own opposites, never each other', () => {
    // Payment 09-10 (fixture 5a/5b) and a return two days later: each cash leg pairs with the card leg
    // of the opposite sign; no leg is counted twice.
    const rows = [...fixtureTransactions(), ccp('ret-c', '2026-09-12', ACCOUNT.C, -900), ccp('ret-x', '2026-09-12', ACCOUNT.X, 900)];
    const t = september(rows);
    expect(t.creditCardPaymentsTracked).toBe(900);
    expect(t.creditCardPaymentsReturnedTracked).toBe(900);
    expect(t.creditCardPaymentsUntracked + t.creditCardPaymentsReturnedUntracked + t.creditCardPaymentsExternallyFunded + t.creditCardPaymentsReversedExternally).toBe(0);
    expect(t.cashFlow).toBe(1827.1);
  });
});

// ---- Design §13 R3: both legs tracked but outside the matching window (Codex review of 4e31fb3) ----
//
// Both legs of a payment (or of a return) are in the tracked set but farther apart than the ±5-day
// card window, so they do not pair. That is NOT only a labelling difference: the unpaired cash-side
// leg is counted as cash crossing the tracked-set boundary while its unpaired credit-side leg is
// non-cash, so cash flow is off by the full amount, permanently. The characterization tests pin
// today's numbers; the `it.fails` tests state the correct figure and are EXPECTED to fail until the
// resolution proposed in design §13 R3 is decided and built (vitest passes them while they fail and
// flags them the moment they start passing). This is a known limitation, not an accepted one.

describe('§13 R3 — tracked legs outside the ±5-day card window change cash flow, not just labels', () => {
  const accounts: AggregationAccount[] = [
    { id: ACCOUNT.C, type: 'depository', excludeFromCashFlow: false },
    { id: ACCOUNT.X, type: 'credit', excludeFromCashFlow: false },
  ];
  const ccp = (id: string, date: string, accountId: string, amount: number) => leg(id, date, accountId, amount, 'credit_card_payment');
  const run = (rows: AggregationTransaction[]) => aggregateCashFlow({ accounts, transactions: rows, period: SEPTEMBER });
  // Codex's reproduction: checking +100 Sep 1 and card −100 Sep 2 (a pair); card reversal +100 Sep 10;
  // checking return −100 on `returnDate`.
  const paymentAndReturn = (returnDate: string) => [
    ccp('pay', '2026-09-01', ACCOUNT.C, 100),
    ccp('card', '2026-09-02', ACCOUNT.X, -100),
    ccp('rev', '2026-09-10', ACCOUNT.X, 100),
    ccp('ret', returnDate, ACCOUNT.C, -100),
  ];

  it('characterization: the checking return 5 days after the card reversal pairs with it → cash flow 0', () => {
    const t = run(paymentAndReturn('2026-09-15'));
    expect(t.creditCardPaymentsTracked).toBe(100);
    expect(t.creditCardPaymentsReturnedTracked).toBe(100);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(0);
    expect(t.creditCardPaymentsReversedExternally).toBe(0);
    expect(t.cashFlow).toBe(0);
  });

  it("characterization: one day later (6 days) the return legs do not pair → cash flow +100 (today's behaviour)", () => {
    const t = run(paymentAndReturn('2026-09-16'));
    expect(t.creditCardPaymentsTracked).toBe(100); // the payment still pairs: 0 cash
    expect(t.creditCardPaymentsReturnedUntracked).toBe(100); // the checking return is counted as cash in: +100
    expect(t.creditCardPaymentsReversedExternally).toBe(100); // the card reversal is counted as non-cash: 0
    expect(t.cashFlow).toBe(100);
  });

  it.fails('correct figure: a payment and its return between two TRACKED accounts net to 0 however far apart the legs are', () => {
    // Checking −100 then +100, card −100 then +100: no cash crossed the tracked-set boundary.
    expect(run(paymentAndReturn('2026-09-16')).cashFlow).toBe(0);
  });

  it("characterization: §4.3's late-card-leg residual is the same mechanism — payment Sep 1, card leg Sep 7 → −100, Sep 6 → 0", () => {
    const late = run([ccp('pay', '2026-09-01', ACCOUNT.C, 100), ccp('card', '2026-09-07', ACCOUNT.X, -100)]);
    expect(late.creditCardPaymentsUntracked).toBe(100);
    expect(late.creditCardPaymentsExternallyFunded).toBe(100);
    expect(late.cashFlow).toBe(-100);
    const onTime = run([ccp('pay', '2026-09-01', ACCOUNT.C, 100), ccp('card', '2026-09-06', ACCOUNT.X, -100)]);
    expect(onTime.creditCardPaymentsTracked).toBe(100);
    expect(onTime.cashFlow).toBe(0);
  });

  it.fails('correct figure: a payment whose card leg posts 6 days later is still internal to the tracked set', () => {
    // The late leg having "arrived" does not self-correct anything: both legs are present, unpaired.
    expect(run([ccp('pay', '2026-09-01', ACCOUNT.C, 100), ccp('card', '2026-09-07', ACCOUNT.X, -100)]).cashFlow).toBe(0);
  });

  it('not a fetched-context artefact: every leg is inside the period, and the documented pad gives the same result', () => {
    const rows = paymentAndReturn('2026-09-16');
    const padded = aggregateCashFlow({ accounts, transactions: fetchedWithPad(rows, SEPTEMBER, PAIRING_PAD_DAYS), period: SEPTEMBER });
    expect(padded).toEqual(run(rows));
    expect(padded.cashFlow).toBe(100);
  });

  it('the untracked-card cases the rule exists for are unaffected: payment −100, and payment + return net 0', () => {
    expect(run([ccp('pay', '2026-09-01', ACCOUNT.C, 100)]).cashFlow).toBe(-100);
    expect(run([ccp('pay', '2026-09-01', ACCOUNT.C, 100), ccp('ret', '2026-09-16', ACCOUNT.C, -100)]).cashFlow).toBe(0);
  });
});

// ---- R7: an excluded card leg closer than the included one (CARD_PAYMENT_PAIRING_DESIGN.md §4.6) --
//
// Trevor approved T5 (2026-09-29): legs on excluded accounts are matching evidence. Slice 1 never sees
// them, so it pairs checking with the included card. Under the approved rule the excluded card's leg is
// the closer reciprocal match, so the payment went outside the tracked set: a CONFIRMED difference of
// −100 with zero unresolved exposure, not a range. The characterization test pins slice 1; the
// `it.fails` test states the approved figure and flips when the stored-pairing slice lands.

describe('R7 — an excluded card closer than the included card: a confirmed difference from slice 1', () => {
  const accounts: AggregationAccount[] = [
    { id: ACCOUNT.C, type: 'depository', excludeFromCashFlow: false },
    { id: ACCOUNT.X, type: 'credit', excludeFromCashFlow: false },
    { id: ACCOUNT.E, type: 'credit', excludeFromCashFlow: true },
  ];
  const rows = [
    leg('pay', '2026-09-01', ACCOUNT.C, 100, 'credit_card_payment'),
    leg('included-card', '2026-09-03', ACCOUNT.X, -100, 'credit_card_payment'),
    leg('excluded-card', '2026-09-02', ACCOUNT.E, -100, 'credit_card_payment'),
  ];
  const run = () => aggregateCashFlow({ accounts, transactions: rows, period: SEPTEMBER });

  it('characterization: slice 1 ignores the excluded card and pairs checking with the included card → 0', () => {
    const t = run();
    expect(t.creditCardPaymentsTracked).toBe(100);
    expect(t.creditCardPaymentsUntracked).toBe(0);
    expect(t.cashFlow).toBe(0);
  });

  it.fails('approved rule (T5): the closer excluded-card leg is the partner → −100, confirmed (no range)', () => {
    expect(run().cashFlow).toBe(-100);
  });
});
