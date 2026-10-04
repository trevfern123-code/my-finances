import { describe, expect, it } from 'vitest';
import {
  aggregateBudgetSpend,
  aggregateCashFlow,
  aggregateCashFlowByMonth,
  aggregateMonthlyBreakdown,
  LOAN_INTEREST_CATEGORY,
  aggregateCashFlowDetail,
  aggregateSpendByPlaidCategory,
  CardPaymentStateIntegrityError,
  CASH_FLOW_MEASURES,
  PAIRING_PAD_DAYS,
  pairingContextRange,
  SemanticAggregationIntegrityError,
  TRANSFER_PAIR_WINDOW_DAYS,
  SplitAllocationMismatchError,
  type AggregationPeriod,
  type AggregationAccount,
  type AggregationTransaction,
  type BudgetSpend,
  type CardLegStateInput,
  type CashFlowTotals,
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
import { cardStatesFor, cashFlowInput, pairDecision, unlinkedDecision } from '../testUtils/cardStatesFromOracle';
import type { MatchingDecision } from './cardPaymentMatching';

// Financial Semantics Phase B: the pure aggregation module against the canonical fixture of
// FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §9.1. Every expected number below is the design's own.
//
// Card-payment legs are no longer paired inside the module (CARD_PAYMENT_PAIRING_DESIGN.md §5): they
// arrive with their stored matching state. Here the states are computed by the reference evaluator
// (`cashFlowInput` → `cardPaymentMatching.ts`), which the SQL evaluator is required to equal, so every
// card figure below is the approved matching rule's, not slice 1's ±5-day in-module pairing.

const september = (
  transactions: AggregationTransaction[] = fixtureTransactions(),
  accounts: AggregationAccount[] = fixtureAccounts(),
  decisions: MatchingDecision[] = []
) => aggregateCashFlow(cashFlowInput({ accounts, transactions, period: SEPTEMBER, decisions }));

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
    expect(Math.round(t.savingsRate! * 1000) / 10).toBe(72.5);
  });

  it('the excluded account E (row 12, $999) contributes nothing', () => {
    const withoutE = september(fixtureTransactions().filter((r) => r.id !== '12'));
    expect(withoutE).toEqual(t);
  });

  it('September has no unclassified rows; August\'s row 13 is counted by its sign AND reported (R0)', () => {
    expect(t.unclassifiedCount).toBe(0);
    const aug = aggregateCashFlow(cashFlowInput({ accounts: fixtureAccounts(), transactions: fixtureTransactions(), period: AUGUST }));
    expect(aug.spending).toBe(45);
    expect(aug.unclassifiedCount).toBe(1);
    expect(aug.unclassifiedAmount).toBe(45);
    expect(aug.cashFlow).toBe(-45);
  });

  it('per-month view: August and September, ascending, each with its own figures', () => {
    const months = aggregateCashFlowByMonth(cashFlowInput({ accounts: fixtureAccounts(), transactions: fixtureTransactions() }));
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
  const [aug, sept] = aggregateMonthlyBreakdown(cashFlowInput({ accounts: fixtureAccounts(), transactions: fixtureTransactions() }));

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
      cardPaymentsUnresolved: { count: 0, paymentsAmount: 0, returnsAmount: 0, byReason: {} },
    });
  });

  it('an unresolved card payment is reported in the month\'s footer, in neither card line', () => {
    const rows = [
      ...fixtureTransactions().filter((r) => r.id !== '5b'),
      { ...fixtureTransactions().find((r) => r.id === '5b')!, date: '2026-09-17' }, // the card leg, 7 days late
    ];
    const month = aggregateMonthlyBreakdown(cashFlowInput({ accounts: fixtureAccounts(), transactions: rows })).find((m) => m.month === '2026-09')!;
    expect(month.excluded.creditCardPaymentsTracked).toBe(0);
    expect(month.excluded.creditCardPaymentsUntracked).toBe(0);
    expect(month.excluded.cardPaymentsUnresolved).toEqual({ count: 1, paymentsAmount: 900, returnsAmount: 0, byReason: { possible_match: 1 } });
    // Spending and its categories do not depend on the card payment at all.
    expect(month.spending).toBe(525);
  });

  it('aggregateSpendByPlaidCategory gives the same buckets and rows for the period, reading no card state', () => {
    const period = aggregateSpendByPlaidCategory({ accounts: fixtureAccounts(), transactions: fixtureTransactions(), period: SEPTEMBER });
    expect(Object.fromEntries(period.byCategory)).toEqual(Object.fromEntries(sept.byCategory));
    expect(period.total).toBe(sept.spending);
    for (const [category, rows] of period.effectRows) {
      expect(rows).toEqual(sept.effectRows.get(category));
      expect(sumEffectRows(rows)).toBe(period.byCategory.get(category));
    }
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
    expect(Math.round(t.savingsRate! * 1000) / 10).toBe(72.5);

    const budget = aggregateBudgetSpend({ accounts: fixtureAccounts(), transactions: rows, splits: fixtureSplits(), period: SEPTEMBER });
    expect(budget.unassigned).toBe(50);
    const sept = aggregateMonthlyBreakdown(cashFlowInput({ accounts: fixtureAccounts(), transactions: rows, period: SEPTEMBER }))[0];
    expect(sept.byCategory.has('TRANSFER_OUT')).toBe(false);
  });

  it('#6 (SoFi, linked) overridden to expense: whole 400 is spending, known principal 0, rate 60.9 %', () => {
    const rows = withRow(fixtureTransactions(), '6', { effectiveRole: 'expense', userRoleOverride: 'expense' });
    const t = september(rows);
    expect(t.spending).toBe(875);
    expect(t.debtPayments).toBe(300);
    expect(t.knownPrincipal).toBe(0);
    expect(t.cashFlow).toBe(1827.1);
    expect(Math.round(t.savingsRate! * 1000) / 10).toBe(60.9);
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
    expect(Math.round(t.savingsRate! * 1000) / 10).toBe(55.8);
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
    expect(Math.round(t.savingsRate! * 1000) / 10).toBe(55.9);
  });

  it('checking not linked: the card leg 5b is an unresolved card credit (no source of funds asserted) and contributes 0; 4b reclassified as income → cash flow 102.10', () => {
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
    // Nothing establishes where the $900 came from, so it is NOT called externally funded (decided for
    // I1; this replaces §9.1's earlier "externally funded inflow 900"). Its cash-flow effect stays 0.
    expect(t.creditCardPaymentsExternallyFunded).toBe(0);
    expect(t.cardPaymentsUnresolvedCredit).toBe(900);
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

  it('one payer leg with two card legs at equal distance is ambiguous: unresolved — a range, never guessed', () => {
    const rows = [
      ...fixtureTransactions().filter((r) => r.id !== '5b'),
      extra('card-early', '2026-09-09', ACCOUNT.X, -900),
      extra('card-late', '2026-09-11', X2, -900),
    ];
    const t = september(rows, accountsWithX2);
    // Neither tracked nor untracked: the destination is not established (pairing design §4.4).
    expect(t.creditCardPaymentsTracked).toBe(0);
    expect(t.creditCardPaymentsUntracked).toBe(0);
    expect(t.cardPaymentsUnresolved).toEqual({ count: 1, paymentsAmount: 900, returnsAmount: 0, byReason: { ambiguous: 1 } });
    expect(t.creditCardPaymentsExternallyFunded).toBe(0);
    expect(t.cardPaymentsUnresolvedCredit).toBe(1800); // the two card legs, equally unresolved
    expect(t.cashFlow).toBeNull();
    expect(t.savingsRate).toBeNull();
    expect(t.cashFlowRange).toEqual({ low: 927.1, high: 1827.1 }); // if untracked … if tracked
  });

  it('a payment on 09-29 whose card leg posts 10-02 is tracked in September from its stored state, whatever was fetched', () => {
    const late = [extra('5late', '2026-09-29', ACCOUNT.C, 250), extra('5late-card', '2026-10-02', ACCOUNT.X, -250)];
    const history = [...fixtureTransactions(), ...late];
    const everything = september(history);
    expect(everything.creditCardPaymentsTracked).toBe(1150);
    expect(everything.creditCardPaymentsUntracked).toBe(0);
    // The states are computed over the whole history in the database, so the card leg does not have
    // to be among the fetched rows: slice 1 wrongly called this payment untracked without it.
    const withoutCardLeg = aggregateCashFlow(
      cashFlowInput({ accounts: fixtureAccounts(), transactions: [...fixtureTransactions(), late[0]], history, period: SEPTEMBER })
    );
    expect(withoutCardLeg).toEqual(everything);
  });

  it('a card leg must be on a credit account: two cash-side legs never pair — each is unresolved on its own, then counted once each way', () => {
    // 5b moved to savings: checking +900 out, savings −900 in, both labelled card payments.
    const rows = withRow(fixtureTransactions(), '5b', { accountId: ACCOUNT.S });
    const pay = rows.find((r) => r.id === '5a')!;
    const ret = rows.find((r) => r.id === '5b')!;
    const unconfirmed = september(rows);
    expect(unconfirmed.creditCardPaymentsTracked).toBe(0);
    expect(unconfirmed.creditCardPaymentsUntracked).toBe(0);
    expect(unconfirmed.cardPaymentsUnresolved).toMatchObject({ count: 2, paymentsAmount: 900, returnsAmount: 900 });
    expect(unconfirmed.cashFlow).toBeNull();
    expect(unconfirmed.cashFlowRange).toEqual({ low: 927.1, high: 2727.1 });

    // Confirmed one transaction at a time (no automatic "unlinked", T4): the money is counted once
    // each way, so cash stayed within the tracked set.
    const t = september(rows, fixtureAccounts(), [unlinkedDecision('d-pay', pay), unlinkedDecision('d-ret', ret)]);
    expect(t.creditCardPaymentsTracked).toBe(0);
    expect(t.creditCardPaymentsUntracked).toBe(900);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(900);
    expect(t.creditCardPaymentsExternallyFunded).toBe(0);
    expect(t.cashFlow).toBe(1827.1);
    expect(t.cashFlowRange).toEqual({ low: 1827.1, high: 1827.1 });
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
    expect(aggregateMonthlyBreakdown(cashFlowInput({ accounts: fixtureAccounts(), transactions: fixtureTransactions(), period: SEPTEMBER }))[0].spending).toBe(525);
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
    expect(() => aggregateMonthlyBreakdown(cashFlowInput({ accounts: fixtureAccounts(), transactions: rows }))).toThrow(SemanticAggregationIntegrityError);
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
    const aug = aggregateCashFlow(cashFlowInput({ accounts: fixtureAccounts(), transactions: rows, period: AUGUST }));
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
  it('the documented pad is two transfer windows, and pairingContextRange applies it to both ends', () => {
    // Card payments left the pad (pairing design §5): their matching runs over the whole history.
    expect(PAIRING_PAD_DAYS).toBe(2 * TRANSFER_PAIR_WINDOW_DAYS);
    expect(PAIRING_PAD_DAYS).toBe(6);
    expect(pairingContextRange(SEPTEMBER)).toEqual({ start: '2026-08-26', end: '2026-10-07' });
  });

  it('card: Sep 1 checking +100, Aug 28 card −100, Aug 24 checking +100 — the card leg is contested, so September is a range, whatever was fetched', () => {
    const rows = [
      leg('p1', '2026-09-01', ACCOUNT.C, 100, 'credit_card_payment'),
      leg('k', '2026-08-28', ACCOUNT.X, -100, 'credit_card_payment'),
      leg('p0', '2026-08-24', ACCOUNT.C, 100, 'credit_card_payment'),
    ];
    const accounts = fixtureAccounts();
    const run = (fetched: AggregationTransaction[]) =>
      aggregateCashFlow(cashFlowInput({ accounts, transactions: fetched, history: rows, period: SEPTEMBER }));

    // Complete evidence: k's best match is a tie → ambiguous. Slice 1 turned that into −100 (and, with
    // one window of padding, into 0); the stored state keeps both possibilities.
    for (const fetched of [rows, fetchedWithPad(rows, SEPTEMBER, PAIRING_PAD_DAYS), fetchedWithPad(rows, SEPTEMBER, 0)]) {
      const t = run(fetched);
      expect(t.cashFlow).toBeNull();
      expect(t.cashFlowRange).toEqual({ low: -100, high: 0 });
      expect(t.cardPaymentsUnresolved).toEqual({ count: 1, paymentsAmount: 100, returnsAmount: 0, byReason: { ambiguous: 1 } });
    }
  });

  it('transfer: Sep 30 checking +100, Oct 3 savings −100, Oct 6 checking +100 — ambiguous reciprocal match, September stays −100', () => {
    const rows = [
      leg('t1', '2026-09-30', ACCOUNT.C, 100, 'internal_transfer'),
      leg('t2', '2026-10-03', ACCOUNT.S, -100, 'internal_transfer'),
      leg('t3', '2026-10-06', ACCOUNT.C, 100, 'internal_transfer'),
    ];
    const accounts = fixtureAccounts();
    const run = (r: AggregationTransaction[]) => aggregateCashFlow(cashFlowInput({ accounts, transactions: r, period: SEPTEMBER }));

    expect(run(rows).cashFlow).toBe(-100);
    expect(run(rows).transfersExternal).toBe(-100);
    expect(run(fetchedWithPad(rows, SEPTEMBER, PAIRING_PAD_DAYS)).cashFlow).toBe(-100);
    expect(run(fetchedWithPad(rows, SEPTEMBER, TRANSFER_PAIR_WINDOW_DAYS)).cashFlow).toBe(0); // one window hides t3
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
      // The card states always come from the whole history (`history: rows`), as in the database; only
      // the rows fetched for the transfer pairing vary.
      const full = aggregateCashFlow(cashFlowInput({ accounts, transactions: rows, history: rows, period: SEPTEMBER }));
      const documented = aggregateCashFlow(
        cashFlowInput({ accounts, transactions: fetchedWithPad(rows, SEPTEMBER, PAIRING_PAD_DAYS), history: rows, period: SEPTEMBER })
      );
      expect(documented).toEqual(full);
      const oneWindow = aggregateCashFlow(
        cashFlowInput({ accounts, transactions: fetchedWithPad(rows, SEPTEMBER, TRANSFER_PAIR_WINDOW_DAYS), history: rows, period: SEPTEMBER })
      );
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

  it('a return on its own is unresolved while an included card exists; once confirmed it is cash in: +100, never income', () => {
    const ret = ccp('ret-only', '2026-09-20', ACCOUNT.C, -100);
    const rows = [...fixtureTransactions(), ret];
    // The user has an included card, so "it came back from a card I haven't linked" is not assumed (T4).
    const unconfirmed = september(rows);
    expect(unconfirmed.creditCardPaymentsReturnedUntracked).toBe(0);
    expect(unconfirmed.cardPaymentsUnresolved).toMatchObject({ count: 1, paymentsAmount: 0, returnsAmount: 100 });
    expect(unconfirmed.cashFlow).toBeNull();
    expect(unconfirmed.cashFlowRange).toEqual({ low: 1827.1, high: 1927.1 });

    const t = september(rows, fixtureAccounts(), [unlinkedDecision('d-ret', ret)]);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(100);
    expect(t.income).toBe(3002.1);
    expect(t.cashFlow).toBe(1927.1);
  });

  it('an unmatched reversal on the card moves no tracked cash and is an unresolved card credit (negative), not "reversed externally"', () => {
    const t = september([...fixtureTransactions(), ccp('rev-x', '2026-09-16', ACCOUNT.X, 900)]);
    expect(t.creditCardPaymentsReversedExternally).toBe(0);
    expect(t.cardPaymentsUnresolvedCredit).toBe(-900); // a reversal is a negative credit to the card
    expect(t.cashFlow).toBe(1827.1);
  });

  it('checking not linked: the unmatched payment into the card is still 0 in cash flow (unchanged)', () => {
    const rows = fixtureTransactions().filter((r) => r.accountId !== ACCOUNT.C);
    const t = september(rows, fixtureAccounts().filter((a) => a.id !== ACCOUNT.C));
    expect(t.creditCardPaymentsExternallyFunded).toBe(0);
    expect(t.cardPaymentsUnresolvedCredit).toBe(900);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(0);
  });

  it('a card leg ESTABLISHED as paid from outside the tracked set is externally funded; an unresolved one never is', () => {
    // F is a cash account excluded from cash flow: its leg pairs with the card's (evidence, T5), which
    // establishes that the card was paid from outside the tracked set.
    const accounts = [...fixtureAccounts(), { id: 'acct-F', type: 'depository', excludeFromCashFlow: true }];
    const rows = [ccp('f-pay', '2026-09-04', 'acct-F', 300), ccp('x-card', '2026-09-04', ACCOUNT.X, -300), ccp('x-lone', '2026-09-20', ACCOUNT.X, -70)];
    const t = aggregateCashFlow(cashFlowInput({ accounts, transactions: rows, period: SEPTEMBER }));
    expect(t.creditCardPaymentsExternallyFunded).toBe(300);
    expect(t.cardPaymentsUnresolvedCredit).toBe(70);
    expect(t.cashFlow).toBe(0);
    expect(t.cashFlowRange).toEqual({ low: 0, high: 0 }); // credit-side legs never move cash flow
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

// ---- Design §13 R3: both legs tracked but outside the automatic ±5-day window ----------------------
//
// Slice 1 paired card legs inside this module and turned "no partner within ±5 days" into "untracked",
// which moved cash flow by the full amount (the R3 defect: +100 for a late return, −100 for a late
// card leg). The module now reads each leg's STORED state (CARD_PAYMENT_PAIRING_DESIGN.md §5): such a
// leg is `unresolved`, the period shows a range instead of a guessed figure, and the correct figure
// appears once the user confirms the match. The two former `it.fails` tests are plain `it` tests now —
// they pass through a stored user decision, exactly as the pairing design §5 says they must.

describe('§13 R3 — tracked legs outside the automatic window are a range until confirmed, never a guessed figure', () => {
  const accounts: AggregationAccount[] = [
    { id: ACCOUNT.C, type: 'depository', excludeFromCashFlow: false },
    { id: ACCOUNT.X, type: 'credit', excludeFromCashFlow: false },
  ];
  const ccp = (id: string, date: string, accountId: string, amount: number) => leg(id, date, accountId, amount, 'credit_card_payment');
  const run = (rows: AggregationTransaction[], decisions: MatchingDecision[] = []) =>
    aggregateCashFlow(cashFlowInput({ accounts, transactions: rows, period: SEPTEMBER, decisions }));
  // Codex's reproduction: checking +100 Sep 1 and card −100 Sep 2 (a pair); card reversal +100 Sep 10;
  // checking return −100 on `returnDate`.
  const paymentAndReturn = (returnDate: string) => [
    ccp('pay', '2026-09-01', ACCOUNT.C, 100),
    ccp('card', '2026-09-02', ACCOUNT.X, -100),
    ccp('rev', '2026-09-10', ACCOUNT.X, 100),
    ccp('ret', returnDate, ACCOUNT.C, -100),
  ];
  const byId = (rows: AggregationTransaction[], id: string) => rows.find((r) => r.id === id)!;

  it('the checking return 5 days after the card reversal pairs automatically → cash flow 0', () => {
    const t = run(paymentAndReturn('2026-09-15'));
    expect(t.creditCardPaymentsTracked).toBe(100);
    expect(t.creditCardPaymentsReturnedTracked).toBe(100);
    expect(t.creditCardPaymentsReturnedUntracked).toBe(0);
    expect(t.creditCardPaymentsReversedExternally).toBe(0);
    expect(t.cashFlow).toBe(0);
  });

  it('one day later (6 days) the return is unresolved: a range [0, +100], never +100 (slice 1 said +100)', () => {
    const t = run(paymentAndReturn('2026-09-16'));
    expect(t.creditCardPaymentsTracked).toBe(100); // the payment still pairs: 0 cash
    expect(t.creditCardPaymentsReturnedUntracked).toBe(0); // NOT counted as cash in
    expect(t.cardPaymentsUnresolved).toMatchObject({ count: 1, paymentsAmount: 0, returnsAmount: 100 });
    expect(t.cashFlow).toBeNull();
    expect(t.cashFlowRange).toEqual({ low: 0, high: 100 });
  });

  it('correct figure: a payment and its return between two TRACKED accounts net to 0 however far apart the legs are', () => {
    // Checking −100 then +100, card −100 then +100: no cash crossed the tracked-set boundary. The user
    // confirms the return against the card's reversal (a stored pair decision).
    const rows = paymentAndReturn('2026-09-16');
    const t = run(rows, [pairDecision('d-return', byId(rows, 'ret'), byId(rows, 'rev'))]);
    expect(t.cashFlow).toBe(0);
    expect(t.cashFlowRange).toEqual({ low: 0, high: 0 });
    expect(t.creditCardPaymentsReturnedTracked).toBe(100);
    expect(t.cardPaymentsUnresolved.count).toBe(0);
  });

  it('a card leg 6 days late is a range [−100, 0], never −100; 5 days late it pairs automatically → 0', () => {
    const late = run([ccp('pay', '2026-09-01', ACCOUNT.C, 100), ccp('card', '2026-09-07', ACCOUNT.X, -100)]);
    expect(late.creditCardPaymentsUntracked).toBe(0); // slice 1 counted 100 here
    expect(late.cardPaymentsUnresolved).toEqual({ count: 1, paymentsAmount: 100, returnsAmount: 0, byReason: { possible_match: 1 } });
    expect(late.cashFlow).toBeNull();
    expect(late.cashFlowRange).toEqual({ low: -100, high: 0 });
    const onTime = run([ccp('pay', '2026-09-01', ACCOUNT.C, 100), ccp('card', '2026-09-06', ACCOUNT.X, -100)]);
    expect(onTime.creditCardPaymentsTracked).toBe(100);
    expect(onTime.cashFlow).toBe(0);
  });

  it('correct figure: a payment whose card leg posts 6 days later is still internal to the tracked set', () => {
    const rows = [ccp('pay', '2026-09-01', ACCOUNT.C, 100), ccp('card', '2026-09-07', ACCOUNT.X, -100)];
    const t = run(rows, [pairDecision('d-late', rows[0], rows[1])]);
    expect(t.cashFlow).toBe(0);
    expect(t.creditCardPaymentsTracked).toBe(100);
    expect(t.creditCardPaymentsExternallyFunded).toBe(0);
  });

  it('the result never depends on which card legs were fetched: the states come from the whole history', () => {
    const rows = paymentAndReturn('2026-09-16');
    const whole = run(rows);
    const onlyTheReturn = aggregateCashFlow(
      cashFlowInput({ accounts, transactions: rows.filter((r) => r.id === 'ret'), history: rows, period: { start: '2026-09-16', end: '2026-09-17' } })
    );
    expect(whole.cashFlowRange).toEqual({ low: 0, high: 100 });
    expect(onlyTheReturn.cashFlowRange).toEqual({ low: 0, high: 100 });
  });

  it('a payment to a card that is not linked: unresolved while an included card exists (T4), −100 once established', () => {
    const pay = ccp('pay', '2026-09-01', ACCOUNT.C, 100);
    const ret = ccp('ret', '2026-09-16', ACCOUNT.C, -100);
    // An included card exists: no automatic "unlinked", however old the payment is.
    expect(run([pay]).cashFlow).toBeNull();
    expect(run([pay]).cashFlowRange).toEqual({ low: -100, high: 0 });
    // The user's confirmation, per transaction.
    expect(run([pay], [unlinkedDecision('d1', pay)]).cashFlow).toBe(-100);
    expect(run([pay, ret], [unlinkedDecision('d1', pay), unlinkedDecision('d2', ret)]).cashFlow).toBe(0);
    // No included card at all is proof on its own: −100 immediately, and payment + return net 0.
    const cashOnly = accounts.filter((a) => a.type !== 'credit');
    const noCard = (rows: AggregationTransaction[]) => aggregateCashFlow(cashFlowInput({ accounts: cashOnly, transactions: rows, period: SEPTEMBER }));
    expect(noCard([pay]).cashFlow).toBe(-100);
    expect(noCard([pay]).creditCardPaymentsUntracked).toBe(100);
    expect(noCard([pay, ret]).cashFlow).toBe(0);
  });
});

// ---- R7: an excluded card leg closer than the included one (CARD_PAYMENT_PAIRING_DESIGN.md §4.6) --
//
// Trevor approved T5 (2026-09-29): legs on excluded accounts are matching evidence. The excluded card's
// leg is the closer reciprocal match, so the payment went outside the tracked set: a CONFIRMED −100
// with zero unresolved exposure, not a range. Slice 1 never saw the excluded card and paired checking
// with the included card (0); that characterization is gone with the in-module pairing it described.

describe('R7 — an excluded card closer than the included card', () => {
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
  const run = () => aggregateCashFlow(cashFlowInput({ accounts, transactions: rows, period: SEPTEMBER }));

  it('approved rule (T5): the closer excluded-card leg is the partner → −100, confirmed (no range)', () => {
    const t = run();
    expect(t.cashFlow).toBe(-100);
    expect(t.cashFlowRange).toEqual({ low: -100, high: -100 });
    expect(t.creditCardPaymentsTracked).toBe(0);
    expect(t.creditCardPaymentsUntracked).toBe(100);
    expect(t.cardPaymentsUnresolved.count).toBe(0);
    // The included card's own leg is unresolved: an unresolved card credit, never cash flow, and no
    // claim about who paid it.
    expect(t.creditCardPaymentsExternallyFunded).toBe(0);
    expect(t.cardPaymentsUnresolvedCredit).toBe(100);
  });

  it('the excluded account\'s rows are evidence only: whether or not they were fetched, nothing of theirs is counted', () => {
    const fetchedWithoutExcluded = aggregateCashFlow(
      cashFlowInput({ accounts, transactions: rows.filter((r) => r.accountId !== ACCOUNT.E), history: rows, period: SEPTEMBER })
    );
    expect(fetchedWithoutExcluded).toEqual(run());
  });
});

// ---- Stored card-payment states (CARD_PAYMENT_PAIRING_DESIGN.md §5, acceptance tests §11 1–9a) ----

describe('card payments from stored states (pairing design §11, pure module)', () => {
  const accounts: AggregationAccount[] = [
    { id: ACCOUNT.C, type: 'depository', excludeFromCashFlow: false },
    { id: ACCOUNT.X, type: 'credit', excludeFromCashFlow: false },
    { id: ACCOUNT.E, type: 'credit', excludeFromCashFlow: true },
    { id: 'acct-F', type: 'depository', excludeFromCashFlow: true },
  ];
  const ccp = (id: string, date: string, accountId: string, amount: number) => leg(id, date, accountId, amount, 'credit_card_payment');
  const run = (rows: AggregationTransaction[], decisions: MatchingDecision[] = [], accts = accounts, period = SEPTEMBER) =>
    aggregateCashFlow(cashFlowInput({ accounts: accts, transactions: rows, period, decisions }));
  const notThisPair = (id: string, a: AggregationTransaction, b: AggregationTransaction): MatchingDecision => ({
    ...pairDecision(id, a, b),
    kind: 'not_this_pair',
    acceptedDifferenceCents: null,
  });

  it('1. late leg: range, then 0 when paired, STILL a range after "not this one", −100 after "a card I haven\'t linked"', () => {
    const pay = ccp('pay', '2026-09-01', ACCOUNT.C, 100);
    const card = ccp('card', '2026-09-07', ACCOUNT.X, -100);
    expect(run([pay, card])).toMatchObject({ cashFlow: null, cashFlowRange: { low: -100, high: 0 } });
    expect(run([pay, card], [pairDecision('d', pay, card)]).cashFlow).toBe(0);
    // Rejecting the candidate is never proof of an unlinked card (pairing design §3.4).
    const rejected = run([pay, card], [notThisPair('d', pay, card)]);
    expect(rejected).toMatchObject({ cashFlow: null, cashFlowRange: { low: -100, high: 0 }, creditCardPaymentsUntracked: 0 });
    expect(run([pay, card], [unlinkedDecision('d', pay)]).cashFlow).toBe(-100);
  });

  it('3. a payment and its return with an unconfirmed destination: bounds [−100, +100] in one month; each month its own across months', () => {
    const pay = ccp('pay', '2026-09-01', ACCOUNT.C, 100);
    const sameMonth = ccp('ret', '2026-09-12', ACCOUNT.C, -100);
    expect(run([pay, sameMonth]).cashFlowRange).toEqual({ low: -100, high: 100 });
    expect(run([pay, sameMonth], [unlinkedDecision('a', pay), unlinkedDecision('b', sameMonth)]).cashFlow).toBe(0);

    const nextMonth = ccp('ret', '2026-10-12', ACCOUNT.C, -100);
    const OCTOBER = { start: '2026-10-01', end: '2026-11-01' };
    const decisions = [unlinkedDecision('a', pay), unlinkedDecision('b', nextMonth)];
    expect(run([pay, nextMonth]).cashFlowRange).toEqual({ low: -100, high: 0 });
    expect(run([pay, nextMonth], [], accounts, OCTOBER).cashFlowRange).toEqual({ low: 0, high: 100 });
    // No cross-month cancellation: −100 in September, +100 in October.
    expect(run([pay, nextMonth], decisions).cashFlow).toBe(-100);
    expect(run([pay, nextMonth], decisions, accounts, OCTOBER).cashFlow).toBe(100);
  });

  it('4. fee matrix (§4.3): the cash excess counts like an unpaired cash leg, the card excess never does', () => {
    const pairOf = (cashAmount: number, cardAccount: string, cardAmount: number, cashAccount: string = ACCOUNT.C) => {
      const cash = ccp('cash', '2026-09-01', cashAccount, cashAmount);
      const card = ccp('card', '2026-09-02', cardAccount, cardAmount);
      return run([cash, card], [pairDecision('d', cash, card)]);
    };
    // Payment, cash larger: −2.00 left checking and did not reach an included card.
    expect(pairOf(100, ACCOUNT.X, -98)).toMatchObject({ cashFlow: -2, creditCardPaymentsTracked: 98, creditCardPaymentsUntracked: 2, creditCardPaymentsExternallyFunded: 0 });
    // Payment, card larger: 0 — the card's extra 2 came from outside (externally funded).
    expect(pairOf(98, ACCOUNT.X, -100)).toMatchObject({ cashFlow: 0, creditCardPaymentsTracked: 98, creditCardPaymentsUntracked: 0, creditCardPaymentsExternallyFunded: 2 });
    // Return, cash larger: +2.00 arrived in checking from outside.
    expect(pairOf(-100, ACCOUNT.X, 98)).toMatchObject({ cashFlow: 2, creditCardPaymentsReturnedTracked: 98, creditCardPaymentsReturnedUntracked: 2, creditCardPaymentsReversedExternally: 0 });
    // Return, card larger: 0 — the card's extra 2 went outside (reversed externally).
    expect(pairOf(-98, ACCOUNT.X, 100)).toMatchObject({ cashFlow: 0, creditCardPaymentsReturnedTracked: 98, creditCardPaymentsReturnedUntracked: 0, creditCardPaymentsReversedExternally: 2 });
    // Excluded card: the whole cash leg, any difference.
    expect(pairOf(100, ACCOUNT.E, -98)).toMatchObject({ cashFlow: -100, creditCardPaymentsTracked: 0, creditCardPaymentsUntracked: 100 });
    // Excluded cash account funding an included card: 0; the card leg is funded from outside the tracked set.
    expect(pairOf(100, ACCOUNT.X, -98, 'acct-F')).toMatchObject({ cashFlow: 0, creditCardPaymentsTracked: 0, creditCardPaymentsUntracked: 0, creditCardPaymentsExternallyFunded: 98 });
  });

  it('4b. including the excluded card later switches −100 to −2.00 (the pair stores both amounts)', () => {
    const cash = ccp('cash', '2026-09-01', ACCOUNT.C, 100);
    const card = ccp('card', '2026-09-02', ACCOUNT.E, -98);
    const included = accounts.map((a) => (a.id === ACCOUNT.E ? { ...a, excludeFromCashFlow: false } : a));
    expect(run([cash, card], [pairDecision('d', cash, card)]).cashFlow).toBe(-100);
    expect(run([cash, card], [pairDecision('d', cash, card)], included).cashFlow).toBe(-2);
  });

  it('5. ties: two payments and one card credit give [−800, 0]; after picking one, the other stays unresolved (not untracked)', () => {
    const first = ccp('p1', '2026-09-01', ACCOUNT.C, 400);
    const second = ccp('p2', '2026-09-03', ACCOUNT.C, 400);
    const card = ccp('k', '2026-09-02', ACCOUNT.X, -400);
    expect(run([first, second, card])).toMatchObject({ cashFlow: null, cashFlowRange: { low: -800, high: 0 } });
    const picked = run([first, second, card], [pairDecision('d', first, card)]);
    expect(picked).toMatchObject({ cashFlow: null, cashFlowRange: { low: -400, high: 0 }, creditCardPaymentsTracked: 400, creditCardPaymentsUntracked: 0 });
    expect(picked.cardPaymentsUnresolved).toMatchObject({ count: 1, paymentsAmount: 400 });
  });

  it('6. an excluded-card pair is −500 with no range; no included card is −250 with no range', () => {
    const toExcluded = run([ccp('c', '2026-09-01', ACCOUNT.C, 500), ccp('e', '2026-09-01', ACCOUNT.E, -500)]);
    expect(toExcluded).toMatchObject({ cashFlow: -500, cashFlowRange: { low: -500, high: -500 }, creditCardPaymentsUntracked: 500 });
    const noIncludedCard = run([ccp('c', '2026-09-01', ACCOUNT.C, 250)], [], accounts.filter((a) => a.id !== ACCOUNT.X));
    expect(noIncludedCard).toMatchObject({ cashFlow: -250, cashFlowRange: { low: -250, high: -250 }, creditCardPaymentsUntracked: 250 });
  });

  it('7. generated histories: low ≤ high; high − low = Σ |unresolved cash-side|; resolved ⇒ one figure; credit-side legs never move a bound', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pool = [...accounts, { id: 'acct-X2', type: 'credit', excludeFromCashFlow: false }, { id: ACCOUNT.S, type: 'depository', excludeFromCashFlow: false }];
    const pick = <T,>(xs: T[]) => xs[Math.floor(random() * xs.length)];
    let sawUnresolved = 0;
    let sawResolved = 0;
    for (let history = 0; history < 300; history++) {
      const rows: AggregationTransaction[] = [];
      const count = 1 + Math.floor(random() * 8);
      for (let i = 0; i < count; i++) {
        const day = String(1 + Math.floor(random() * 28)).padStart(2, '0');
        const amount = pick([100, -100, 98, -98]);
        rows.push(ccp(`g${history}-${i}`, `2026-09-${day}`, pick(pool).id, amount));
      }
      const input = cashFlowInput({ accounts: pool, transactions: rows, period: SEPTEMBER });
      const t = aggregateCashFlow(input);
      const unresolvedCash = input.cardPayments.legs.filter((l) => l.side === 'cash' && l.accountIncluded && l.state === 'unresolved');
      const exposure = unresolvedCash.reduce((sum, l) => sum + Math.abs(l.amountCents), 0) / 100;

      expect(t.cashFlowRange.low).toBeLessThanOrEqual(t.cashFlowRange.high);
      expect(Math.round((t.cashFlowRange.high - t.cashFlowRange.low) * 100) / 100).toBe(exposure);
      expect(t.cardPaymentsUnresolved.count).toBe(unresolvedCash.length);
      expect(Math.round((t.cardPaymentsUnresolved.paymentsAmount + t.cardPaymentsUnresolved.returnsAmount) * 100) / 100).toBe(exposure);
      // Only card rows exist here, so the bounds are exactly the established cash-side effects plus the
      // unresolved ones — a credit-side leg, paired or not, contributes to neither.
      const established = Math.round((t.creditCardPaymentsReturnedUntracked - t.creditCardPaymentsUntracked) * 100) / 100;
      expect(t.cashFlowRange.low).toBe(Math.round((established - t.cardPaymentsUnresolved.paymentsAmount) * 100) / 100);
      expect(t.cashFlowRange.high).toBe(Math.round((established + t.cardPaymentsUnresolved.returnsAmount) * 100) / 100);
      if (unresolvedCash.length === 0) {
        expect(t.cashFlow).toBe(t.cashFlowRange.low);
        expect(t.cashFlowRange.high).toBe(t.cashFlowRange.low);
        sawResolved++;
      } else {
        expect(t.cashFlow).toBeNull();
        expect(t.savingsRate).toBeNull();
        // `no_candidate` is never read as untracked.
        expect(unresolvedCash.every((l) => l.effectCents === null)).toBe(true);
        sawUnresolved++;
      }
    }
    expect(sawUnresolved).toBeGreaterThan(20);
    expect(sawResolved).toBeGreaterThan(20);
  });

  it('the savings-rate range follows the cash-flow range; income ≤ 0 gives 0', () => {
    const rows = [
      leg('pay', '2026-09-01', ACCOUNT.C, 100, 'credit_card_payment'),
      leg('card', '2026-09-07', ACCOUNT.X, -100, 'credit_card_payment'),
      { ...leg('salary', '2026-09-01', ACCOUNT.C, -1000, 'income'), plaidCategory: 'INCOME' },
    ];
    const t = run(rows);
    expect(t.cashFlowRange).toEqual({ low: 900, high: 1000 });
    expect(t.savingsRate).toBeNull();
    expect(t.savingsRateRange).toEqual({ low: 0.9, high: 1 });
    expect(run(rows.slice(0, 2)).savingsRateRange).toEqual({ low: 0, high: 0 });
  });

  describe('8. a card leg without a usable stored state is an integrity failure — never untracked, never a fallback to pairing', () => {
    const pay = ccp('pay', '2026-09-01', ACCOUNT.C, 100);
    const card = ccp('card', '2026-09-02', ACCOUNT.X, -100);
    const rows = [pay, card];
    const states = () => cardStatesFor(accounts, rows);
    const withState = (id: string, change: Partial<CardLegStateInput>) => ({
      legs: states().legs.map((l) => (l.transactionId === id ? { ...l, ...change } : l)),
      supersededTransactionIds: [],
    });
    const aggregate = (cardPayments: { legs: CardLegStateInput[]; supersededTransactionIds: string[] }) =>
      aggregateCashFlow({ accounts, transactions: rows, period: SEPTEMBER, cardPayments });
    const expectIntegrity = (cardPayments: Parameters<typeof aggregate>[0], id: string, message: RegExp) => {
      let thrown: unknown;
      try {
        aggregate(cardPayments);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CardPaymentStateIntegrityError);
      expect((thrown as CardPaymentStateIntegrityError).transactionId).toBe(id);
      expect((thrown as CardPaymentStateIntegrityError).code).toBe('card_payment_state_integrity');
      expect((thrown as Error).message).toMatch(message);
      // Not a loan-data problem: it must never be presented as a SemanticIntegrityError.
      expect(thrown).not.toBeInstanceOf(SemanticIntegrityError);
    };

    it('control: with the stored pair the figure is 0', () => {
      expect(aggregate(states()).cashFlow).toBe(0);
    });

    it('a missing state — with no states at all, or with only the other leg\'s — names the row', () => {
      expectIntegrity({ legs: [], supersededTransactionIds: [] }, 'pay', /no stored matching state/);
      expectIntegrity({ legs: states().legs.filter((l) => l.transactionId !== 'card'), supersededTransactionIds: [] }, 'card', /no stored matching state/);
    });

    it('a state for another amount, account or side means rows and states are not one version', () => {
      expectIntegrity(withState('pay', { amountCents: 9800 }), 'pay', /different amount/);
      expectIntegrity(withState('pay', { accountId: ACCOUNT.S }), 'pay', /different account/);
      expectIntegrity(withState('pay', { side: 'credit' }), 'pay', /'credit' side/);
      expectIntegrity(withState('pay', { accountIncluded: false }), 'pay', /excluded from cash flow/);
    });

    it('an effect the leg cannot have, an unknown state, or a duplicate state is refused', () => {
      expectIntegrity(withState('pay', { effectCents: 100 }), 'pay', /outside the range/); // a payment cannot add cash
      expectIntegrity(withState('pay', { effectCents: -20000 }), 'pay', /outside the range/);
      expectIntegrity(withState('pay', { effectCents: null }), 'pay', /integer effect/);
      expectIntegrity(withState('pay', { state: 'untracked', effectCents: -5000 }), 'pay', /count in full/);
      expectIntegrity(withState('pay', { effectCents: -200 }), 'pay', /exactly its cash excess/); // tracked, but no fee pair
      expectIntegrity(withState('pay', { state: 'unresolved' }), 'pay', /no effect and the bounds/);
      expectIntegrity(withState('pay', { state: 'not_counted' }), 'pay', /not a cash-side state/);
      expectIntegrity(withState('card', { effectCents: -10000 }), 'card', /zero effect/);
      expectIntegrity(withState('card', { state: 'tracked' }), 'card', /not a credit-side state/);
      expectIntegrity(withState('card', { cardExcessCents: 20000 }), 'card', /card excess/);
      expectIntegrity({ legs: [...states().legs, states().legs[0]], supersededTransactionIds: [] }, states().legs[0].transactionId, /more than one/);
    });

    it('the Monthly Breakdown, which reports card lines, fails the same way; the budget, which reads no card state, does not', () => {
      expect(() => aggregateMonthlyBreakdown({ accounts, transactions: rows, cardPayments: { legs: [], supersededTransactionIds: [] } })).toThrow(
        CardPaymentStateIntegrityError
      );
      expect(aggregateBudgetSpend({ accounts, transactions: rows, splits: [], period: SEPTEMBER }).total).toBe(0);
    });

    it('a superseded pending row and a zero-amount row have no state and count for nothing', () => {
      const pending = ccp('pending-pay', '2026-09-01', ACCOUNT.C, 100);
      const zero = ccp('zero', '2026-09-03', ACCOUNT.C, 0);
      const t = aggregateCashFlow({
        accounts,
        transactions: [...rows, pending, zero],
        period: SEPTEMBER,
        cardPayments: { legs: states().legs, supersededTransactionIds: ['pending-pay'] },
      });
      expect(t.cashFlow).toBe(0);
      expect(t.creditCardPaymentsTracked).toBe(100);
      expect(t.cardPaymentsUnresolved.count).toBe(0);
    });

    it('a loan-decomposed row reports principal and interest whatever its role says, so it reads no card state', () => {
      const linked: AggregationTransaction = { ...ccp('linked', '2026-09-05', ACCOUNT.C, 400), manualLoanId: LOAN_M, principalPortion: 350 };
      const t = aggregateCashFlow({ accounts, transactions: [...rows, linked], period: SEPTEMBER, cardPayments: states() });
      expect(t).toMatchObject({ debtPayments: 350, knownPrincipal: 350, spending: 50, creditCardPaymentsTracked: 100, cashFlow: -400 });
    });

    it('a card leg outside the period needs no state (it is never aggregated)', () => {
      const october = ccp('oct', '2026-10-02', ACCOUNT.C, 50);
      const t = aggregateCashFlow({ accounts, transactions: [...rows, october], period: SEPTEMBER, cardPayments: states() });
      expect(t.cashFlow).toBe(0);
    });
  });

  it('9. transfers are unchanged by the stored states: the §9.1 fixture still nets 4a/4b to zero', () => {
    const t = aggregateCashFlow(cashFlowInput({ accounts: fixtureAccounts(), transactions: fixtureTransactions(), period: SEPTEMBER }));
    expect(t.transfersInternal).toBe(500);
    expect(t.transfersExternal).toBe(0);
  });
});

// ---- Effect rows behind every published cash-flow total (design §7.3, invariant I6) ---------------

describe('aggregateCashFlowDetail — every total reconciles to its effect rows', () => {
  const totalOf: Record<(typeof CASH_FLOW_MEASURES)[number], (t: CashFlowTotals) => number> = {
    spending: (t) => t.spending,
    income: (t) => t.income,
    debt_payments: (t) => t.debtPayments,
    known_principal: (t) => t.knownPrincipal,
    debt_payments_unknown_principal: (t) => t.debtPaymentsUnknownPrincipal,
    refunds: (t) => t.refunds,
    transfers_internal: (t) => t.transfersInternal,
    transfers_external: (t) => t.transfersExternal,
    credit_card_payments_tracked: (t) => t.creditCardPaymentsTracked,
    credit_card_payments_untracked: (t) => t.creditCardPaymentsUntracked,
    credit_card_payments_returned_tracked: (t) => t.creditCardPaymentsReturnedTracked,
    credit_card_payments_returned_untracked: (t) => t.creditCardPaymentsReturnedUntracked,
    credit_card_payments_externally_funded: (t) => t.creditCardPaymentsExternallyFunded,
    credit_card_payments_reversed_externally: (t) => t.creditCardPaymentsReversedExternally,
    card_payments_unresolved_credit: (t) => t.cardPaymentsUnresolvedCredit,
    card_payments_unresolved_payments: (t) => t.cardPaymentsUnresolved.paymentsAmount,
    card_payments_unresolved_returns: (t) => t.cardPaymentsUnresolved.returnsAmount,
    unclassified: (t) => t.unclassifiedAmount,
  };
  const assertReconciles = (input: Parameters<typeof aggregateCashFlowDetail>[0]) => {
    const detail = aggregateCashFlowDetail(input);
    expect(detail.totals).toEqual(aggregateCashFlow(input)); // one code path for totals and rows
    for (const measure of CASH_FLOW_MEASURES) {
      expect(sumEffectRows(detail.effectRows.get(measure)), measure).toBe(totalOf[measure](detail.totals));
    }
    expect(detail.effectRows.get('unclassified')!.length).toBe(detail.totals.unclassifiedCount);
    return detail;
  };

  it('base fixture, September and August', () => {
    const sept = assertReconciles(cashFlowInput({ accounts: fixtureAccounts(), transactions: fixtureTransactions(), period: SEPTEMBER }));
    // The loan-linked payment #6 explains two totals with two different effects of the same row.
    expect(sept.effectRows.get('spending')!.find((r) => r.transactionId === '6')).toMatchObject({ amount: 50, allocation: 'interest', effectRole: 'expense' });
    expect(sept.effectRows.get('debt_payments')!.find((r) => r.transactionId === '6')).toMatchObject({ amount: 350, allocation: 'principal' });
    expect(sept.effectRows.get('debt_payments')!.find((r) => r.transactionId === '7')).toMatchObject({ amount: 300, allocation: 'row' });
    expect(sept.effectRows.get('known_principal')!.map((r) => r.transactionId)).toEqual(['6']);
    // The unknown-principal total is exactly the debt-payment effects with no manual-loan split: #7.
    expect(sept.effectRows.get('debt_payments_unknown_principal')!.map((r) => [r.transactionId, r.amount, r.allocation])).toEqual([['7', 300, 'row']]);
    expect(sept.totals.debtPaymentsUnknownPrincipal).toBe(300);
    // Income rows are listed by their contribution (positive), a refund by its own sign (negative).
    expect(sept.effectRows.get('income')!.find((r) => r.transactionId === '1')!.amount).toBe(3000);
    expect(sept.effectRows.get('refunds')!.map((r) => [r.transactionId, r.amount])).toEqual([['8b', -60]]);
    // A paired transfer is listed once, by its outgoing leg; a tracked card payment by its cash leg.
    expect(sept.effectRows.get('transfers_internal')!.map((r) => r.transactionId)).toEqual(['4a']);
    expect(sept.effectRows.get('credit_card_payments_tracked')!.map((r) => r.transactionId)).toEqual(['5a']);

    const aug = assertReconciles(cashFlowInput({ accounts: fixtureAccounts(), transactions: fixtureTransactions(), period: AUGUST }));
    expect(aug.effectRows.get('unclassified')!.map((r) => [r.transactionId, r.amount])).toEqual([['13', 45]]);
  });

  it('every §9.1 variant and the card-payment cases', () => {
    const withoutX = { accounts: fixtureAccounts().filter((a) => a.id !== ACCOUNT.X), rows: fixtureTransactions().filter((r) => r.accountId !== ACCOUNT.X) };
    const withoutC = { accounts: fixtureAccounts().filter((a) => a.id !== ACCOUNT.C), rows: fixtureTransactions().filter((r) => r.accountId !== ACCOUNT.C) };
    const cases: Parameters<typeof cashFlowInput>[0][] = [
      { accounts: fixtureAccounts({ S: { excludeFromCashFlow: true } }), transactions: fixtureTransactions() },
      { accounts: fixtureAccounts({ X: { excludeFromCashFlow: true } }), transactions: fixtureTransactions() },
      { accounts: withoutX.accounts, transactions: withoutX.rows },
      { accounts: withoutC.accounts, transactions: withoutC.rows },
      { accounts: fixtureAccounts(), transactions: withRow(fixtureTransactions(), '9', { effectiveRole: 'internal_transfer', userRoleOverride: 'internal_transfer' }) },
      { accounts: fixtureAccounts(), transactions: withRow(fixtureTransactions(), '6', { effectiveRole: 'expense', userRoleOverride: 'expense' }) },
      { accounts: fixtureAccounts(), transactions: withRow(fixtureTransactions(), '2', { effectiveRole: null }) },
      // A fee pair and a return, so every card measure has rows.
      {
        accounts: fixtureAccounts(),
        transactions: [
          ...fixtureTransactions(),
          leg('fee-cash', '2026-09-14', ACCOUNT.C, 100, 'credit_card_payment'),
          leg('fee-card', '2026-09-14', ACCOUNT.X, -98, 'credit_card_payment'),
          leg('ret-c', '2026-09-20', ACCOUNT.C, -900, 'credit_card_payment'),
          leg('ret-x', '2026-09-20', ACCOUNT.X, 900, 'credit_card_payment'),
          leg('rev-x', '2026-09-26', ACCOUNT.X, 40, 'credit_card_payment'),
        ],
        decisions: [
          pairDecision('fee', leg('fee-cash', '2026-09-14', ACCOUNT.C, 100, 'credit_card_payment'), leg('fee-card', '2026-09-14', ACCOUNT.X, -98, 'credit_card_payment')),
        ],
      },
    ];
    for (const c of cases) assertReconciles(cashFlowInput({ ...c, period: SEPTEMBER }));
  });

  it('unresolved legs are listed only under the unresolved measures: the cash leg by its amount, the card leg as an unresolved card credit', () => {
    const rows = [
      leg('pay', '2026-09-01', ACCOUNT.C, 100, 'credit_card_payment'),
      leg('card', '2026-09-07', ACCOUNT.X, -100, 'credit_card_payment'),
      leg('ret', '2026-09-20', ACCOUNT.C, -40, 'credit_card_payment'),
      leg('rev', '2026-09-28', ACCOUNT.X, 15, 'credit_card_payment'),
    ];
    const detail = assertReconciles(cashFlowInput({ accounts: fixtureAccounts(), transactions: rows, period: SEPTEMBER }));
    expect(detail.totals.cardPaymentsUnresolved).toMatchObject({ count: 2, paymentsAmount: 100, returnsAmount: 40 });
    expect(detail.totals.cardPaymentsUnresolvedCredit).toBe(85); // +100 payment into the card, −15 reversal
    expect(detail.effectRows.get('card_payments_unresolved_payments')!.map((r) => [r.transactionId, r.amount])).toEqual([['pay', 100]]);
    expect(detail.effectRows.get('card_payments_unresolved_returns')!.map((r) => [r.transactionId, r.amount])).toEqual([['ret', 40]]);
    expect(detail.effectRows.get('card_payments_unresolved_credit')!.map((r) => [r.transactionId, r.amount])).toEqual([
      ['card', 100],
      ['rev', -15],
    ]);
    const unresolvedMeasures = ['card_payments_unresolved_payments', 'card_payments_unresolved_returns', 'card_payments_unresolved_credit'];
    for (const measure of CASH_FLOW_MEASURES) {
      if (unresolvedMeasures.includes(measure)) continue;
      expect(detail.effectRows.get(measure)!.some((r) => r.transactionId === 'pay'), measure).toBe(false);
    }
  });
});
