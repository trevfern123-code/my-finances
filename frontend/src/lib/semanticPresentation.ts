import type { EffectsFailure } from './effectsDrilldown';
import { formatCurrency } from './currency';
import type { AmountRange, CashFlowFigures, EffectMeasure, EffectRow, SemanticNotShown } from './semanticModel';

/**
 * Financial Semantics Phase B, integration slice I2 — how role-aware figures and their states are
 * worded. Presentation only: every amount passed in is the server's, and nothing here derives one
 * figure from another.
 */

/** A signed amount with a real minus sign: `−$60.00`, `$40.00`. */
export function formatSigned(amount: number): string {
  return amount < 0 ? `−${formatCurrency(-amount)}` : formatCurrency(amount);
}

/** A spending total. Spending is signed: below zero, refunds exceeded purchases, and the figure says
 *  so in words rather than by colour (design §9.4: `−$60.00 (refund)`). It is never clamped. */
export function formatSpending(amount: number): string {
  return amount < 0 ? `${formatSigned(amount)} (refund)` : formatCurrency(amount);
}

/** The two bounds of a figure that is not yet a single number. */
export function formatAmountRange(range: AmountRange): string {
  return `${formatSigned(range.low)} – ${formatSigned(range.high)}`;
}

/** A rate (a fraction) as a whole percentage. */
export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

export function formatRateRange(range: AmountRange): string {
  return `${formatRate(range.low)} – ${formatRate(range.high)}`;
}

/**
 * A month's income, as its header says it: "$3,002.10 in", "$0.00 in", "−$60.00 in (income
 * reversed)". Income is signed: a reversed deposit reduces it, and it is below zero when reversals
 * exceed what came in (design §4.1). Zero and negative are figures like any other — shown, with the
 * sign, and never treated as "no income".
 */
export function incomeInLabel(amount: number): string {
  return amount < 0 ? `${formatSigned(amount)} in (income reversed)` : `${formatCurrency(amount)} in`;
}

/**
 * Why the savings rate reads 0% when income is not above zero (the server defines the rate as 0
 * then). It states the income figure; it does not say income is missing.
 */
export function nonPositiveIncomeNote(income: number): string {
  return income < 0
    ? `Income this month is ${formatSigned(income)}: reversed income exceeded what came in. The savings rate is shown as 0%.`
    : `Income this month is ${formatSigned(income)}, so the savings rate is shown as 0%.`;
}

/** Why a figure is a range (pairing design §6.2). */
export function unresolvedCardPaymentsNote(count: number): string {
  return count === 1 ? "1 card payment isn't matched yet" : `${count} card payments aren't matched yet`;
}

export function itemCount(count: number): string {
  return count === 1 ? '1 item' : `${count} items`;
}

/** `[start, end)` of a calendar month given as YYYY-MM. */
export function monthRange(month: string): { start: string; end: string } {
  const [year, monthNumber] = month.split('-').map(Number);
  const end = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  return { start: `${month}-01`, end };
}

export interface WithheldText {
  /** What stands where the figure would be, beside an em dash. */
  short: string;
  /** One sentence saying why. */
  detail: string;
  /** `alert` for a failure the user should know about; `status` for a state that resolves itself or
   *  on reload. */
  tone: 'status' | 'alert';
}

const FAILURE_DETAIL: Record<string, string> = {
  semantic_integrity_error: 'One transaction has inconsistent data, so these figures are paused.',
  card_payment_state_integrity: 'A card payment has no usable matching state, so these figures are paused.',
  split_allocation_mismatch: 'A split transaction no longer adds up, so these figures are paused until its splits are corrected.',
  aggregate_too_large: 'This range has too many transactions to total, so nothing is shown.',
  aggregate_snapshot_unavailable: 'This range could not be read as one consistent set, so nothing is shown.',
  semantic_result_inconsistent: 'These figures could not be assembled consistently, so none are shown.',
};

/**
 * The wording for a state in which no role-aware figure is shown. The text is fixed here: nothing
 * the server sent (a message, a transaction id, a reason string) is displayed.
 */
export function withheldText(state: SemanticNotShown): WithheldText {
  switch (state.kind) {
    case 'loading':
      return { short: 'Loading…', detail: 'Loading these figures…', tone: 'status' };
    case 'updating': {
      // What is known is that the matching state is not up to date. Nothing says that it is being
      // brought up to date right now, so the text does not claim that. What this client does about
      // it — ask again by itself a few times, then wait for the user — is said as it is.
      const cause =
        state.reason === 'matching_failed'
          ? "Card-payment matching couldn't be brought up to date, so these figures are withheld."
          : "Card-payment matching isn't up to date, so these figures are withheld.";
      return { short: 'Updating…', detail: state.autoRetrying ? `${cause} Checking again automatically.` : cause, tone: 'status' };
    }
    case 'backend_outdated':
      return { short: 'Updating…', detail: 'The app is being updated. These figures appear once the update is complete.', tone: 'status' };
    case 'unavailable':
      return { short: 'Unavailable', detail: "These figures couldn't be read right now.", tone: 'status' };
    case 'refused':
      return {
        short: 'Paused',
        detail: 'A split transaction no longer adds up, so budget figures are paused until its splits are corrected.',
        tone: 'alert',
      };
    case 'invalid':
      return { short: 'Unavailable', detail: "These figures didn't arrive in the expected form, so they aren't shown.", tone: 'alert' };
    case 'failed':
      return {
        short: 'Unavailable',
        detail: (state.code !== null && FAILURE_DETAIL[state.code]) || "These figures couldn't be loaded.",
        tone: 'alert',
      };
  }
}

/** The wording for a drill-down that could not be shown. */
export function effectsFailureText(failure: EffectsFailure): string {
  switch (failure.kind) {
    case 'kept_changing':
      return 'These transactions kept changing while the list loaded. Try again in a moment.';
    case 'malformed':
      return "This list didn't arrive in the expected form, so it isn't shown.";
    case 'not_reconciled':
      return "This list didn't add up to its total, so it isn't shown.";
    case 'request_failed':
      if (failure.code !== null && FAILURE_DETAIL[failure.code]) return FAILURE_DETAIL[failure.code].replace('these figures are', 'this list is');
      if (failure.status === 404) return "This list isn't available yet. The app is being updated.";
      return "This list couldn't be loaded.";
  }
}

/** How one effect row is named: the transaction, and which part of it this row is. */
export function effectRowLabel(row: EffectRow): string {
  const name = row.transaction.merchant_name ?? row.transaction.name ?? 'Transaction';
  if (row.allocation === 'interest') return `${name} — interest`;
  if (row.allocation === 'principal') return `${name} — principal`;
  return name;
}

export interface CashFlowLine {
  /** A stable id for the line (also the key of its drill-down). */
  id: string;
  label: string;
  /** The server's figure for this line. */
  amount: number;
  /** The drill-down that lists exactly this amount. */
  measure: EffectMeasure;
  note?: string;
}

export interface CashFlowLineGroup {
  title: string;
  lines: CashFlowLine[];
}

/**
 * The lines behind a period's cash flow, grouped by how they relate to it. Every line is one of the
 * server's published amounts with the drill-down measure that explains it; a line whose amount is
 * zero is left out, except Income and Spending.
 */
export function cashFlowLineGroups(f: CashFlowFigures): CashFlowLineGroup[] {
  const present = (lines: CashFlowLine[]) => lines.filter((line) => line.amount !== 0);

  const counted: CashFlowLine[] = [
    { id: 'income', label: 'Income', amount: f.income_semantic, measure: 'income' },
    { id: 'spending', label: 'Spending', amount: f.spending, measure: 'spending', note: 'Refunds are already subtracted.' },
    ...present([
      { id: 'debt_payments', label: 'Debt payments', amount: f.debt_payments, measure: 'debt_payments' },
      {
        id: 'credit_card_payments_untracked',
        label: 'Untracked card payments',
        amount: f.credit_card_payments_untracked,
        measure: 'credit_card_payments_untracked',
        note: 'Paid to a card that is not among your tracked cards.',
      },
      {
        id: 'credit_card_payments_returned_untracked',
        label: 'Returned untracked card payments',
        amount: f.credit_card_payments_returned_untracked,
        measure: 'credit_card_payments_returned_untracked',
      },
      {
        id: 'transfers_external',
        label: f.transfers_external < 0 ? 'Transfers out' : 'Transfers in',
        amount: f.transfers_external,
        measure: 'transfers_external',
        note: 'To or from accounts that are not tracked.',
      },
    ]),
  ];

  const within = present([
    { id: 'refunds', label: 'Refunds', amount: f.refunds, measure: 'refunds', note: 'Already inside Spending.' },
    {
      id: 'known_principal',
      label: 'Loan principal paid down',
      amount: f.known_principal,
      measure: 'known_principal',
      note: 'Already inside Debt payments.',
    },
    {
      id: 'debt_payments_unknown_principal',
      label: 'Loan payments with an unknown principal share',
      amount: f.debt_payments_unknown_principal,
      measure: 'debt_payments_unknown_principal',
      note: 'Already inside Debt payments. Counted in full as money out.',
    },
  ]);

  const notCounted = present([
    { id: 'transfers_internal', label: 'Transfers between your accounts', amount: f.transfers_internal, measure: 'transfers_internal' },
    { id: 'credit_card_payments_tracked', label: 'Card payments to your tracked cards', amount: f.credit_card_payments_tracked, measure: 'credit_card_payments_tracked' },
    {
      id: 'credit_card_payments_returned_tracked',
      label: 'Returned card payments',
      amount: f.credit_card_payments_returned_tracked,
      measure: 'credit_card_payments_returned_tracked',
    },
    {
      id: 'credit_card_payments_externally_funded',
      label: 'Card credits paid from outside your tracked cash',
      amount: f.credit_card_payments_externally_funded,
      measure: 'credit_card_payments_externally_funded',
    },
    {
      id: 'credit_card_payments_reversed_externally',
      label: 'Card payment reversals outside your tracked cash',
      amount: f.credit_card_payments_reversed_externally,
      measure: 'credit_card_payments_reversed_externally',
    },
    {
      id: 'card_payments_unresolved_credit',
      label: 'Unresolved card credits',
      amount: f.card_payments_unresolved_credit,
      measure: 'card_payments_unresolved_credit',
      note: 'For information only. It does not change cash flow and does not show where the money came from.',
    },
  ]);

  const open: CashFlowLine[] = present([
    {
      id: 'card_payments_unresolved_payments',
      label: 'Card payments not matched yet',
      amount: f.card_payments_unresolved.payments_amount,
      measure: 'card_payments_unresolved_payments',
      note: 'Each is either a payment to a tracked card or money that left your accounts. Cash flow is a range until that is known.',
    },
    {
      id: 'card_payments_unresolved_returns',
      label: 'Card payment returns not matched yet',
      amount: f.card_payments_unresolved.returns_amount,
      measure: 'card_payments_unresolved_returns',
    },
  ]);
  if (f.unclassified_count > 0) {
    open.push({
      id: 'unclassified',
      label: f.unclassified_count === 1 ? '1 unclassified transaction' : `${f.unclassified_count} unclassified transactions`,
      amount: f.unclassified_amount,
      measure: 'unclassified',
      note: 'Not yet classified, so each is counted as spending or income by its direction. The amount is the net of money out (+) and money in (−).',
    });
  }

  return [
    { title: 'Counted in cash flow', lines: counted },
    { title: 'Already inside the lines above', lines: within },
    { title: 'Not counted in cash flow', lines: notCounted },
    { title: 'Not settled yet', lines: open },
  ].filter((group) => group.lines.length > 0);
}
