import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabaseClient', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import { EFFECT_MEASURES, readCashFlowFigures, readEffectsResponse, type CashFlowFigures, type SemanticNotShown } from './semanticModel';
import {
  cashFlowLineGroups,
  incomeInLabel,
  nonPositiveIncomeNote,
  effectRowLabel,
  effectsFailureText,
  formatAmountRange,
  formatRate,
  formatRateRange,
  formatSigned,
  formatSpending,
  itemCount,
  monthRange,
  unresolvedCardPaymentsNote,
  withheldText,
} from './semanticPresentation';
import { cashFlowWire, effectRowWire, effectsPageWire, unresolvedCashFlowWire } from '../testUtils/semanticFixtures';

function figures(overrides: Record<string, unknown> = {}): CashFlowFigures {
  const read = readCashFlowFigures(cashFlowWire(overrides));
  if (!read) throw new Error('fixture is not valid');
  return read;
}

const allLines = (f: CashFlowFigures) => cashFlowLineGroups(f).flatMap((group) => group.lines);

describe('amounts', () => {
  it('formats a signed amount with a real minus sign', () => {
    expect(formatSigned(40)).toBe('$40.00');
    expect(formatSigned(-60)).toBe('−$60.00');
    expect(formatSigned(0)).toBe('$0.00');
  });

  it('says "refund" in words for negative spending, and never clamps it', () => {
    expect(formatSpending(-60)).toBe('−$60.00 (refund)');
    expect(formatSpending(525)).toBe('$525.00');
    expect(formatSpending(0)).toBe('$0.00');
  });

  it('shows both bounds of a range', () => {
    expect(formatAmountRange({ low: 1727.1, high: 1827.1 })).toBe('$1,727.10 – $1,827.10');
    expect(formatAmountRange({ low: -50, high: 50 })).toBe('−$50.00 – $50.00');
    expect(formatRate(0.7252)).toBe('73%');
    expect(formatRateRange({ low: 0.6919, high: 0.7252 })).toBe('69% – 73%');
  });

  it('counts items and unmatched card payments in words', () => {
    expect(itemCount(1)).toBe('1 item');
    expect(itemCount(120)).toBe('120 items');
    expect(unresolvedCardPaymentsNote(1)).toBe("1 card payment isn't matched yet");
    expect(unresolvedCardPaymentsNote(3)).toBe("3 card payments aren't matched yet");
  });

  it('gives a calendar month as [start, end)', () => {
    expect(monthRange('2026-09')).toEqual({ start: '2026-09-01', end: '2026-10-01' });
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', end: '2027-01-01' });
    expect(monthRange('2024-02')).toEqual({ start: '2024-02-01', end: '2024-03-01' });
  });
});

describe('withheldText — every state with no figure has words, and never a number or a server detail', () => {
  const states: SemanticNotShown[] = [
    { kind: 'loading' },
    { kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000 },
    { kind: 'updating', reason: 'matching_failed', retryAfterMs: 5000 },
    { kind: 'unavailable', reason: 'request_failed 11111111-1111-4111-8111-111111111111', retryAfterMs: 5000 },
    { kind: 'backend_outdated' },
    { kind: 'refused' },
    { kind: 'invalid' },
    { kind: 'failed', code: null },
    { kind: 'failed', code: 'semantic_integrity_error' },
    { kind: 'failed', code: 'card_payment_state_integrity' },
    { kind: 'failed', code: 'aggregate_too_large' },
    { kind: 'failed', code: 'an_unknown_code_12345' },
  ];

  it.each(states.map((state) => [JSON.stringify(state), state] as const))('%s', (_name, state) => {
    const text = withheldText(state);
    expect(text.short.length).toBeGreaterThan(0);
    expect(text.detail.length).toBeGreaterThan(0);
    for (const part of [text.short, text.detail]) {
      expect(part).not.toMatch(/\d/);
      expect(part).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
      expect(part).not.toContain('_');
    }
  });

  it('distinguishes updating from unavailable', () => {
    const updating = withheldText({ kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000 });
    const unavailable = withheldText({ kind: 'unavailable', reason: 'request_failed', retryAfterMs: 5000 });
    expect(updating.short).toBe('Updating…');
    expect(unavailable.short).toBe('Unavailable');
    expect(updating.detail).not.toBe(unavailable.detail);
  });

  it('a backend that does not publish the fields yet reads as "Updating…" (design §6.4)', () => {
    expect(withheldText({ kind: 'backend_outdated' }).short).toBe('Updating…');
  });

  it('failures and refusals are alerts; states that resolve are statuses', () => {
    expect(withheldText({ kind: 'failed', code: null }).tone).toBe('alert');
    expect(withheldText({ kind: 'refused' }).tone).toBe('alert');
    expect(withheldText({ kind: 'invalid' }).tone).toBe('alert');
    expect(withheldText({ kind: 'updating', reason: 'x', retryAfterMs: 1 }).tone).toBe('status');
    expect(withheldText({ kind: 'unavailable', reason: 'x', retryAfterMs: 1 }).tone).toBe('status');
    expect(withheldText({ kind: 'loading' }).tone).toBe('status');
  });
});

describe('effectsFailureText', () => {
  it('has fixed wording for every failure, with no server text', () => {
    expect(effectsFailureText({ kind: 'kept_changing' })).toMatch(/kept changing/);
    expect(effectsFailureText({ kind: 'not_reconciled' })).toMatch(/didn't add up to its total/);
    expect(effectsFailureText({ kind: 'malformed' })).toMatch(/expected form/);
    expect(effectsFailureText({ kind: 'request_failed', code: null, status: 500 })).toBe("This list couldn't be loaded.");
    expect(effectsFailureText({ kind: 'request_failed', code: 'split_allocation_mismatch', status: 409 })).toMatch(/split transaction no longer adds up/);
    expect(effectsFailureText({ kind: 'request_failed', code: 'semantic_integrity_error', status: 500 })).toMatch(/this list is paused/);
  });

  it('a backend without the endpoint (404) reads as an update in progress', () => {
    expect(effectsFailureText({ kind: 'request_failed', code: null, status: 404 })).toMatch(/isn't available yet/);
  });
});

describe('effectRowLabel', () => {
  const row = (overrides: Record<string, unknown>, transaction: Record<string, unknown> = {}) => {
    const page = readEffectsResponse(effectsPageWire([effectRowWire(overrides, transaction)], { total_amount: 10, total_count: 1 }));
    if (page.kind !== 'ok') throw new Error('fixture');
    return page.rows[0];
  };

  it('names the part of a decomposed loan payment (design §9.4)', () => {
    expect(effectRowLabel(row({ allocation: 'interest' }, { name: 'SoFi payment' }))).toBe('SoFi payment — interest');
    expect(effectRowLabel(row({ allocation: 'principal' }, { name: 'SoFi payment' }))).toBe('SoFi payment — principal');
  });

  it('prefers the merchant name and never fails on a nameless row', () => {
    expect(effectRowLabel(row({}, { name: 'VENMO *PAYMENT', merchant_name: 'Venmo' }))).toBe('Venmo');
    expect(effectRowLabel(row({}, { name: null, merchant_name: null }))).toBe('Transaction');
  });
});

describe('cashFlowLineGroups', () => {
  it('always lists Income and Spending, with the server figures', () => {
    const lines = allLines(figures({ income_semantic: 0, spending: 0, debt_payments: 0, known_principal: 0, debt_payments_unknown_principal: 0, refunds: 0, transfers_internal: 0, transfers_external: 0, credit_card_payments_tracked: 0 }));
    expect(lines.map((l) => l.id)).toEqual(['income', 'spending']);
  });

  it('every line is one published amount with a measure the server supports', () => {
    const everything = figures({
      credit_card_payments_untracked: 12,
      credit_card_payments_returned_tracked: 13,
      credit_card_payments_returned_untracked: 14,
      credit_card_payments_externally_funded: 15,
      credit_card_payments_reversed_externally: 16,
      card_payments_unresolved_credit: 17,
      unclassified_count: 2,
      unclassified_amount: 25,
    });
    const lines = allLines(everything);
    for (const line of lines) expect(EFFECT_MEASURES).toContain(line.measure);
    // Nothing is listed twice, and no line reuses another's measure.
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
    expect(new Set(lines.map((l) => l.measure)).size).toBe(lines.length);
    const byId = new Map(lines.map((l) => [l.id, l]));
    expect(byId.get('income')?.amount).toBe(3002.1);
    expect(byId.get('spending')?.amount).toBe(525);
    expect(byId.get('debt_payments')?.amount).toBe(650);
    expect(byId.get('known_principal')?.amount).toBe(350);
    expect(byId.get('debt_payments_unknown_principal')?.amount).toBe(300);
    expect(byId.get('refunds')?.amount).toBe(-60);
    expect(byId.get('transfers_external')?.amount).toBe(-75);
    expect(byId.get('card_payments_unresolved_credit')?.amount).toBe(17);
    expect(byId.get('unclassified')?.amount).toBe(25);
  });

  it('leaves out a line whose amount is zero', () => {
    const ids = allLines(figures()).map((l) => l.id);
    expect(ids).not.toContain('credit_card_payments_untracked');
    expect(ids).not.toContain('card_payments_unresolved_credit');
    expect(ids).not.toContain('unclassified');
  });

  it('calls the neutral credit bucket "Unresolved card credits" and claims nothing about where the money came from', () => {
    const line = allLines(figures({ card_payments_unresolved_credit: 900 })).find((l) => l.id === 'card_payments_unresolved_credit');
    expect(line?.label).toBe('Unresolved card credits');
    expect(line?.measure).toBe('card_payments_unresolved_credit');
    const words = `${line?.label} ${line?.note}`.toLowerCase();
    expect(words).not.toMatch(/external/);
    expect(words).not.toMatch(/funded|funding/);
    expect(words).not.toMatch(/confirmed/);
    expect(words).toMatch(/does not change cash flow/);
    const group = cashFlowLineGroups(figures({ card_payments_unresolved_credit: 900 })).find((g) => g.lines.some((l) => l.id === 'card_payments_unresolved_credit'));
    expect(group?.title).toBe('Not counted in cash flow');
  });

  it('keeps the sign of a reversal-heavy unresolved credit (a signed net)', () => {
    expect(allLines(figures({ card_payments_unresolved_credit: -40 })).find((l) => l.id === 'card_payments_unresolved_credit')?.amount).toBe(-40);
  });

  it('lists unmatched card payments as not settled, never inside a counted line', () => {
    const read = readCashFlowFigures(unresolvedCashFlowWire());
    if (!read) throw new Error('fixture');
    const groups = cashFlowLineGroups(read);
    const open = groups.find((g) => g.title === 'Not settled yet');
    expect(open?.lines.map((l) => [l.id, l.amount])).toEqual([['card_payments_unresolved_payments', 100]]);
    expect(groups.find((g) => g.title === 'Counted in cash flow')?.lines.map((l) => l.id)).not.toContain('card_payments_unresolved_payments');
  });

  it('labels external transfers by direction without changing the figure', () => {
    expect(allLines(figures({ transfers_external: -75 })).find((l) => l.id === 'transfers_external')).toMatchObject({ label: 'Transfers out', amount: -75 });
    expect(allLines(figures({ transfers_external: 40 })).find((l) => l.id === 'transfers_external')).toMatchObject({ label: 'Transfers in', amount: 40 });
  });
});

// I2 correction (review findings F3 and F4).
describe('signed income wording (F4)', () => {
  it('a month header shows income of any sign as a figure', () => {
    expect(incomeInLabel(3002.1)).toBe('$3,002.10 in');
    expect(incomeInLabel(0)).toBe('$0.00 in');
    expect(incomeInLabel(-60)).toBe('−$60.00 in (income reversed)');
    expect(incomeInLabel(-0.01)).toBe('−$0.01 in (income reversed)');
  });

  it('the savings note states the income figure and never says income is missing', () => {
    expect(nonPositiveIncomeNote(0)).toBe('Income this month is $0.00, so the savings rate is shown as 0%.');
    expect(nonPositiveIncomeNote(-60)).toBe('Income this month is −$60.00: reversed income exceeded what came in. The savings rate is shown as 0%.');
    for (const note of [nonPositiveIncomeNote(0), nonPositiveIncomeNote(-60)]) {
      expect(note).not.toMatch(/no income|not available|unavailable|none/i);
    }
  });
});

describe('updating wording (F3)', () => {
  const base = { kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000 } as const;

  it('says what is known — matching is not up to date — and does not claim that matching is running', () => {
    const text = withheldText(base);
    expect(text.detail).toBe("Card-payment matching isn't up to date, so these figures are withheld.");
    expect(text.detail).not.toMatch(/still being matched|being matched|in progress|once that is done/i);
  });

  it('says the client is checking again only while it is', () => {
    expect(withheldText({ ...base, autoRetrying: true }).detail).toBe(
      "Card-payment matching isn't up to date, so these figures are withheld. Checking again automatically."
    );
    expect(withheldText({ ...base, autoRetrying: false }).detail).not.toMatch(/Checking again/);
    expect(withheldText(base).detail).not.toMatch(/Checking again/);
  });

  it('matching_failed is worded as a failure, with the same rule', () => {
    const failed = { ...base, reason: 'matching_failed' };
    expect(withheldText(failed).detail).toBe("Card-payment matching couldn't be brought up to date, so these figures are withheld.");
    expect(withheldText({ ...failed, autoRetrying: true }).detail).toMatch(/Checking again automatically.$/);
  });

  it('no other state ever says it is checking again', () => {
    for (const state of [
      { kind: 'unavailable', reason: 'x', retryAfterMs: 5000 },
      { kind: 'refused' },
      { kind: 'backend_outdated' },
      { kind: 'invalid' },
      { kind: 'failed', code: 'semantic_integrity_error' },
      { kind: 'loading' },
    ] as const) {
      expect(withheldText(state).detail).not.toMatch(/Checking again/);
    }
  });
});
