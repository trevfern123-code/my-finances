import type { EffectsFailure } from './effectsDrilldown';
import { formatCurrency } from './currency';
import type { AmountRange, CashFlowFigures, EffectMeasure, EffectRow, SemanticNotShown } from './semanticModel';
import type { RecoveryActionType, RecoveryCandidate, RecoveryObligation, RecoveryReview, RecoverySource } from './semanticModel';

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

// ---- Payment review (I3A-R packet 2-A) -----------------------------------------------------------
// The words of the review. Everything shown comes from fixed text here plus dates, amounts and the removed
// institution's name; no server message and no identifier is ever displayed.

const formatReviewCents = (cents: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(cents) / 100);
/** A cash-flow effect in cents, signed as the summary shows it: "−$370.00", "+$12.00", "$0.00". */
const formatEffectCents = (cents: number): string => (cents === 0 ? formatReviewCents(0) : `${cents < 0 ? '−' : '+'}${formatReviewCents(cents)}`);

export function formatReviewDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "Card payment of $370.00 on Sep 10, 2026" — what a review is about when the feed has no name for it. */
export function reviewTitle(review: Pick<RecoveryReview, 'side' | 'direction' | 'amount_cents' | 'date'>): string {
  const what =
    review.side === 'cash' ? (review.direction === 'payment' ? 'Card payment' : 'Card payment returned') : review.direction === 'payment' ? 'Payment received on a card' : 'Card payment reversed';
  return `${what} of ${formatReviewCents(review.amount_cents)} on ${formatReviewDate(review.date)}`;
}

/** How many of the unresolved card payments are waiting for a review after a removal. */
export function relinkReviewCount(byReason: Record<string, number>): number {
  return byReason.relink_review_required ?? 0;
}

export function paymentsUnderReviewNote(count: number): string {
  return count === 1 ? '1 payment to review' : `${count} payments to review`;
}

/** What the payment counts as now — one headline and one sentence. Figures only as given: a range stays a range. */
export function reviewReadingText(review: RecoveryReview): { headline: string; detail: string } {
  const range = `between ${formatEffectCents(review.low_cents)} and ${formatEffectCents(review.high_cents)}`;
  const effect = review.effect_cents === null ? null : formatEffectCents(review.effect_cents);
  const reading = `${review.state}/${review.reason}`;
  if (reading === 'unresolved/relink_review_required') {
    return review.side === 'cash'
      ? {
          headline: 'Needs your review',
          detail: `A transaction that arrived after a bank connection was removed looks like the other side of this payment, but nothing confirms it. Until you decide, cash flow counts this payment as a range: ${range}.`,
        }
      : {
          headline: 'Needs your review',
          detail: 'This card payment looks like the other side of a payment that a removed bank connection was involved in. It is not matched to anything until you decide. It does not change cash flow.',
        };
  }
  if (reading === 'untracked/removed_card') {
    return { headline: 'Counted as paid to a removed card', detail: `It counts as money that went to a card whose bank connection was removed: ${effect}.` };
  }
  if (reading === 'untracked/no_included_card') {
    return {
      headline: 'Counted as money that left your accounts',
      detail: `None of your cards is included in cash flow, so this payment counts in full: ${effect}.${review.guard_withheld ? ' A possible match is waiting for your review.' : ''}`,
    };
  }
  if (reading === 'untracked/user_confirmed_unlinked') return { headline: 'Your decision: a card you have not linked', detail: `It counts as money that left your accounts: ${effect}.` };
  if (reading === 'untracked/partner_excluded') return { headline: 'Paid to a card that is excluded from cash flow', detail: `It counts in full: ${effect}.` };
  if (reading === 'tracked/user_pair') return { headline: 'Your decision: matched', detail: `It counts as a transfer between your accounts: ${effect}.` };
  if (reading === 'tracked/auto_pair') return { headline: 'Matched automatically', detail: `It is matched to a card payment that was already there before the connection was removed: ${effect}.` };
  if (review.state === 'paired' || review.state === 'funded_from_excluded') return { headline: 'Matched', detail: 'This card payment is matched. It does not change cash flow.' };
  if (reading === 'not_counted/excluded_account') return { headline: 'Not counted', detail: 'Its account is excluded from cash flow, so this payment is not counted.' };
  if (reading === 'unresolved/decision_invalidated' || reading === 'unresolved/matched_leg_not_posted') {
    return {
      headline: 'Your earlier decision needs another look',
      detail:
        review.side === 'cash'
          ? `The bank's data no longer fits a decision you made about this payment, so it is kept as it is and not matched to anything else. Cash flow counts it as a range: ${range}.`
          : "The bank's data no longer fits a decision you made about this payment, so it is kept as it is and not matched to anything else.",
    };
  }
  return review.side === 'cash'
    ? { headline: 'Not matched yet', detail: `Cash flow counts this payment as a range: ${range}.` }
    : { headline: 'Not matched yet', detail: 'This card payment is not matched to anything. It does not change cash flow.' };
}

export function reviewSourceText(source: RecoverySource): string {
  if (!source.source_known || source.source_date === null || source.source_cents === null) {
    return source.evidence_kind === 'preserved_confirmation'
      ? 'You had confirmed its match with a transaction at the removed bank. That transaction was not recorded.'
      : 'What this depended on at the removed bank was not recorded.';
  }
  const what = `${formatReviewCents(source.source_cents)} on ${formatReviewDate(source.source_date)}`;
  if (source.evidence_kind === 'removed_destination') return `It had been matched automatically to a transaction of ${what} at the removed bank.`;
  if (source.evidence_kind === 'preserved_confirmation') return `You had confirmed its match with a transaction of ${what} at the removed bank.`;
  if (source.evidence_kind === 'graph_source') {
    return source.source_relation === 'automatic_partner'
      ? `Its automatic match, ${what}, was at the removed bank.`
      : `A transaction of ${what} at the removed bank could have been its other side.`;
  }
  return source.source_relation === 'automatic_partner'
    ? `Its automatic match, ${what}, was at the removed bank — and another of your transactions fitted it too.`
    : `A transaction of ${what} at the removed bank could also have been its other side.`;
}

/** One paragraph per obligation: which removal, or which gap. */
export function reviewObligationText(obligation: RecoveryObligation): string {
  const bank = obligation.institution_name ?? 'A bank connection';
  if (obligation.gap_reason === 'unattributed_decision') {
    return 'Part of this payment\'s history was recorded before the app kept track of what a removal depended on. Which removed transaction it was is not known, so nothing new is matched to this payment automatically.';
  }
  if (obligation.gap_reason === 'unrecorded_removal') {
    return `${bank} was removed without a record of what that removal depended on. It may concern this payment, so nothing new is matched to it automatically.`;
  }
  return `${bank} was removed${obligation.removed_on ? ` on ${formatReviewDate(obligation.removed_on)}` : ''}.`;
}

/** "Sep 11, 2026 · $370.00 · 1 day apart", with what the user must know before choosing it. */
export function reviewCandidateText(candidate: RecoveryCandidate): string {
  const parts = [formatReviewDate(candidate.date), formatReviewCents(candidate.amount_cents), candidate.distance_days === 0 ? 'same day' : candidate.distance_days === 1 ? '1 day apart' : `${candidate.distance_days} days apart`];
  if (candidate.difference_cents !== 0) parts.push(`differs by ${formatReviewCents(candidate.difference_cents)}`);
  if (candidate.pending) parts.push('pending');
  if (!candidate.account_included) parts.push('on an account excluded from cash flow');
  return parts.join(' · ');
}

/** What matching would accept when the amounts differ — shown before the user confirms. */
export function acceptedDifferenceText(differenceCents: number): string {
  return differenceCents > 0
    ? `The payment is ${formatReviewCents(differenceCents)} more than this transaction. Matching them accepts that difference: it stays counted as money that left your accounts.`
    : `This transaction is ${formatReviewCents(differenceCents)} more than the payment. Matching them accepts that difference.`;
}

/** What each action does — and what it does not. Shown beside the action. */
export const REVIEW_ACTION_HELP: Record<RecoveryActionType, string> = {
  pair_current: 'Matches this payment with that transaction, so it counts as a transfer between your accounts. This decides this payment only: what is on record about the removed connection stays as it is.',
  confirm_unlinked: 'Counts this payment as money that went to a card you have not linked.',
  dismiss_candidate: 'Says this transaction is not the other side of this payment. This can change the figure: the payment is then read without it.',
  undo_decision: 'Takes that decision back. The payment goes back to what the bank data and the record of the removal say. A decision it had replaced does not come back.',
  reject_suggestion: 'Hides this suggestion. Nothing else changes: the figure stays as it is.',
  defer: 'Leaves it for later. Nothing changes.',
};

const DECISION_KIND_TEXT: Record<string, string> = {
  pair: 'You matched this payment',
  destination_unlinked: 'You said it went to a card you have not linked',
  pair_counterpart_removed: 'You had confirmed a match with a transaction at a bank that was removed',
};
export function reviewDecisionText(decision: NonNullable<RecoveryReview['controlling_decision']>): string {
  const what = DECISION_KIND_TEXT[decision.kind] ?? 'A decision is recorded for this payment';
  return decision.status === 'active' ? `${what}.` : `${what}, and the bank's data no longer fits it.`;
}

const RECOVERY_FAILURE_TEXT: Record<string, string> = {
  stale_version: 'Something changed since this was loaded, so nothing was saved. The review has been reloaded — check it and try again.',
  stale_review: 'This review changed since it was loaded, so nothing was saved. It has been reloaded — check it and try again.',
  operation_conflict: 'That request could not be sent again in a different form. Nothing was saved.',
  not_reviewable: 'This payment is no longer under review. Nothing was saved.',
  not_found: 'That transaction is no longer there. Nothing was saved.',
  invalid_action: 'That cannot be done with these transactions. Nothing was saved.',
  counterpart_reserved: 'That transaction already belongs to another match you confirmed. Undo that one first. Nothing was saved.',
  pair_confirmed: 'These two are a match you saved. Undo the match first. Nothing was saved.',
  decision_replaced: 'That decision was already replaced by a later one. Nothing was saved.',
  retry: 'That could not be completed just now. Nothing was saved — try again.',
  recovery_actions_disabled: 'Changes from this screen are switched off right now. Nothing was saved.',
  recovery_unavailable: "Payment review isn't available right now.",
  session_owner_mismatch: 'You signed in again since this was opened. Nothing was sent — reload the review.',
  session_owner_required: 'You need to be signed in to do that. Nothing was sent.',
  client_update_required: 'This version of the app is out of date. Reload to update, then try again. Nothing was saved.',
};
/** The fixed sentence for a refused or failed recovery request. Never the server's own message. */
export function recoveryFailureText(code: string | null): string {
  return (code !== null && RECOVERY_FAILURE_TEXT[code]) || "That didn't work, and nothing is known to have been saved.";
}
