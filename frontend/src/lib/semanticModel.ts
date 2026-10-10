/**
 * Financial Semantics Phase B, integration slice I2 — the role-aware ("semantic") read contract as
 * this client understands it (backend/src/controllers/semanticResponse.ts,
 * PHASE_B_I1_BACKEND_READ_PATH.md §3).
 *
 * Every role-aware figure the UI shows comes from the server, through the readers below. A reader
 * takes a response body as `unknown` and returns either the validated figures or a state that
 * carries NO figure. Nothing here computes a financial figure from a transaction's sign, and
 * nothing falls back to the frozen sign-based fields (`spent`, `income`, `total_spent`, …): a
 * response that is not provably the reviewed shape yields a state, never a number.
 *
 * States (the server's own names, plus two this client needs):
 * - `ok`: figures present and validated.
 * - `updating`: the server read the data, but its card-payment matching state is not fresh.
 * - `unavailable`: the server could not read the role-aware state at all.
 * - `refused` (budget only): a split no longer adds up, so the budget aggregate is withheld.
 * - `backend_outdated`: the response carries no `semantic_status`, i.e. the server does not publish
 *   the role-aware fields (yet). Shown as "Updating…" (design §6.4, new bundle before new backend).
 * - `invalid`: the response says `ok` but its figures are missing, malformed or contradict each
 *   other. A client-side integrity failure: no figure is shown.
 */

/** `autoRetrying` is set by the surface that holds the state (never by a reader): whether this
 *  client is still going to ask again by itself (lib/updatingRefetch.ts). Absent means it is not. */
export type SemanticUpdatingState = { kind: 'updating'; reason: string; retryAfterMs: number; autoRetrying?: boolean };
export type SemanticUnavailableState = { kind: 'unavailable'; reason: string; retryAfterMs: number };
export type SemanticRefusedState = { kind: 'refused' };
export type SemanticBackendOutdatedState = { kind: 'backend_outdated' };
export type SemanticInvalidState = { kind: 'invalid' };

/** A state in which no role-aware figure may be shown. */
export type SemanticWithheld =
  | SemanticUpdatingState
  | SemanticUnavailableState
  | SemanticRefusedState
  | SemanticBackendOutdatedState
  | SemanticInvalidState;

export type SemanticResult<T> = ({ kind: 'ok' } & T) | SemanticWithheld;

/** The request itself failed (an integrity error, a network failure, …). `code` is the server's
 *  machine-readable code when it sent one. No figure of an earlier response may stay on screen. */
export type SemanticFailedState = { kind: 'failed'; code: string | null };
/** Nothing has arrived yet for the current request. */
export type SemanticLoadingState = { kind: 'loading' };

/** What a surface holds: the figures, or one of the states in which it shows none. */
export type SemanticView<T> = SemanticResult<T> | SemanticFailedState | SemanticLoadingState;
export type SemanticNotShown = Exclude<SemanticView<unknown>, { kind: 'ok' }>;

/** Marks an `updating` view with whether an automatic refetch is still coming. Any other view is
 *  returned as it is. */
export function withAutoRetry<V extends { kind: string }>(view: V, autoRetrying: boolean): V {
  return view.kind === 'updating' ? { ...view, autoRetrying } : view;
}

/** The `code` of a failed request, for `SemanticFailedState`. */
export function failureOf(err: unknown): SemanticFailedState {
  const code = (err as { code?: unknown } | null)?.code;
  return { kind: 'failed', code: typeof code === 'string' ? code : null };
}

export interface AmountRange {
  low: number;
  high: number;
}

/** Cash-side card payments whose destination is not established (they are in no other card total). */
export interface UnresolvedCardPayments {
  count: number;
  payments_amount: number;
  returns_amount: number;
  by_reason: Record<string, number>;
}

/** The role-aware figures of one period, with the server's field names and definitions. Dollars. */
export interface CashFlowFigures {
  spending: number;
  income_semantic: number;
  debt_payments: number;
  known_principal: number;
  debt_payments_unknown_principal: number;
  transfers_internal: number;
  /** Signed as cash: out negative, in positive. */
  transfers_external: number;
  credit_card_payments_tracked: number;
  credit_card_payments_untracked: number;
  credit_card_payments_returned_tracked: number;
  credit_card_payments_returned_untracked: number;
  credit_card_payments_externally_funded: number;
  credit_card_payments_reversed_externally: number;
  /** "Unresolved card credits": informational, a signed net, zero cash-flow effect. It says nothing
   *  about where the money came from. */
  card_payments_unresolved_credit: number;
  refunds: number;
  /** Null exactly when a cash-side card payment of the period is unresolved; then only the range
   *  is known. */
  cash_flow: number | null;
  cash_flow_range: AmountRange;
  /** A fraction (0.15 = 15%). Null exactly when `cash_flow` is. */
  savings_rate: number | null;
  savings_rate_range: AmountRange;
  card_payments_unresolved: UnresolvedCardPayments;
  unclassified_count: number;
  unclassified_amount: number;
}

export interface MonthCashFlow extends CashFlowFigures {
  /** YYYY-MM */
  month: string;
}

export interface SemanticCategoryAmount {
  category: string;
  /** Signed: a negative amount is net refunds. */
  amount: number;
}

export interface BreakdownExcluded {
  transfers_internal: number;
  transfers_external: number;
  credit_card_payments_tracked: number;
  credit_card_payments_untracked: number;
  credit_card_payments_returned_untracked: number;
  debt_payments: number;
  card_payments_unresolved: UnresolvedCardPayments;
}

export interface SemanticMonthBreakdown {
  /** YYYY-MM */
  month: string;
  spending: number;
  income: number;
  by_category: SemanticCategoryAmount[];
  excluded: BreakdownExcluded;
}

export interface BudgetCategorySpending {
  spending: number;
  recent_avg_spending: number;
}

export type SummarySemantics = SemanticResult<{ months: MonthCashFlow[]; currentMonth: CashFlowFigures }>;
export type MonthlyBreakdownSemantics = SemanticResult<{ months: SemanticMonthBreakdown[] }>;
export type BudgetSemantics = SemanticResult<{ byCategoryId: Map<string, BudgetCategorySpending> }>;

export type SummaryView = SemanticView<{ months: MonthCashFlow[]; currentMonth: CashFlowFigures }>;
export type MonthlyBreakdownView = SemanticView<{ months: SemanticMonthBreakdown[] }>;
export type BudgetView = SemanticView<{ byCategoryId: Map<string, BudgetCategorySpending> }>;

/** Dollars to integer cents. Wire amounts are cent-exact, so this is exact for them. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * The role-aware spending of the given budget categories, added up (design §5 C2: the budget's total
 * spent is Σ role-aware `spending`, signed). Null when any category has no figure: a partial sum is
 * never offered as the total. Summed in integer cents.
 */
export function totalBudgetSpending(byCategoryId: Map<string, BudgetCategorySpending>, categoryIds: string[]): number | null {
  let cents = 0;
  for (const id of categoryIds) {
    const entry = byCategoryId.get(id);
    if (!entry) return null;
    cents += toCents(entry.spending);
  }
  return cents / 100;
}

// ---- Validation primitives ---------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function readRange(value: unknown): AmountRange | null {
  if (!isObject(value) || !isAmount(value.low) || !isAmount(value.high) || value.low > value.high) return null;
  return { low: value.low, high: value.high };
}

function readUnresolved(value: unknown): UnresolvedCardPayments | null {
  if (!isObject(value) || !isCount(value.count) || !isAmount(value.payments_amount) || !isAmount(value.returns_amount)) return null;
  if (value.payments_amount < 0 || value.returns_amount < 0 || !isObject(value.by_reason)) return null;
  const byReason: Record<string, number> = {};
  for (const [reason, count] of Object.entries(value.by_reason)) {
    if (!isCount(count)) return null;
    // A reason this build does not know (packet 2-A): the server applies a rule this build cannot explain, so
    // the summary is not usable — its figures are withheld, never shown as if nothing were open.
    if (!KNOWN_UNRESOLVED_REASONS.has(reason)) return null;
    byReason[reason] = count;
  }
  return { count: value.count, payments_amount: value.payments_amount, returns_amount: value.returns_amount, by_reason: byReason };
}

const CASH_FLOW_AMOUNT_FIELDS = [
  'spending',
  'income_semantic',
  'debt_payments',
  'known_principal',
  'debt_payments_unknown_principal',
  'transfers_internal',
  'transfers_external',
  'credit_card_payments_tracked',
  'credit_card_payments_untracked',
  'credit_card_payments_returned_tracked',
  'credit_card_payments_returned_untracked',
  'credit_card_payments_externally_funded',
  'credit_card_payments_reversed_externally',
  'card_payments_unresolved_credit',
  'refunds',
  'unclassified_amount',
] as const;

/** One period's role-aware figures, or null when any is missing, malformed, or contradicts another. */
export function readCashFlowFigures(value: unknown): CashFlowFigures | null {
  if (!isObject(value)) return null;
  const amounts = {} as Record<(typeof CASH_FLOW_AMOUNT_FIELDS)[number], number>;
  for (const field of CASH_FLOW_AMOUNT_FIELDS) {
    const amount = value[field];
    if (!isAmount(amount)) return null;
    amounts[field] = amount;
  }
  const cashFlowRange = readRange(value.cash_flow_range);
  const savingsRateRange = readRange(value.savings_rate_range);
  const unresolved = readUnresolved(value.card_payments_unresolved);
  if (!cashFlowRange || !savingsRateRange || !unresolved || !isCount(value.unclassified_count)) return null;

  const cashFlow = value.cash_flow;
  const savingsRate = value.savings_rate;
  if (cashFlow === null && savingsRate === null) {
    // Only a range is known, which is the case exactly when something is unresolved.
    if (unresolved.count === 0) return null;
  } else if (isAmount(cashFlow) && isAmount(savingsRate)) {
    // A single figure is published only when nothing is unresolved, and then the range is that figure.
    if (unresolved.count !== 0) return null;
    if (toCents(cashFlowRange.low) !== toCents(cashFlow) || toCents(cashFlowRange.high) !== toCents(cashFlow)) return null;
  } else {
    return null;
  }

  return {
    ...amounts,
    cash_flow: cashFlow,
    cash_flow_range: cashFlowRange,
    savings_rate: savingsRate,
    savings_rate_range: savingsRateRange,
    card_payments_unresolved: unresolved,
    unclassified_count: value.unclassified_count,
  };
}

/**
 * The `semantic_status` of a response: `ok`, a withheld state, or `invalid` when it is present but
 * not one of the reviewed shapes. Absent means the server does not publish role-aware fields.
 */
function readStatus(body: unknown, allowRefused: boolean): { kind: 'ok' } | SemanticWithheld {
  if (!isObject(body)) return { kind: 'invalid' };
  const status = body.semantic_status;
  if (status === undefined) return { kind: 'backend_outdated' };
  if (!isObject(status)) return { kind: 'invalid' };
  switch (status.status) {
    case 'ok':
      return { kind: 'ok' };
    case 'updating':
    case 'unavailable':
      if (typeof status.reason !== 'string' || !isAmount(status.retry_after_ms) || status.retry_after_ms < 0) return { kind: 'invalid' };
      return { kind: status.status, reason: status.reason, retryAfterMs: status.retry_after_ms };
    case 'refused':
      // The body also names the affected transactions; this client shows none of that.
      return allowRefused ? { kind: 'refused' } : { kind: 'invalid' };
    default:
      return { kind: 'invalid' };
  }
}

// ---- Responses ---------------------------------------------------------------------------------

/** The role-aware half of `GET /api/plaid/summary`. */
export function readSummarySemantics(body: unknown): SummarySemantics {
  const status = readStatus(body, false);
  if (status.kind !== 'ok') return status;
  const summary = body as Json;
  if (!Array.isArray(summary.monthly_spending)) return { kind: 'invalid' };

  const months: MonthCashFlow[] = [];
  const seen = new Set<string>();
  for (const entry of summary.monthly_spending as unknown[]) {
    const figures = readCashFlowFigures(entry);
    const month = isObject(entry) ? entry.month : undefined;
    if (!figures || typeof month !== 'string' || !MONTH_PATTERN.test(month) || seen.has(month)) return { kind: 'invalid' };
    seen.add(month);
    months.push({ month, ...figures });
  }
  const currentMonth = readCashFlowFigures(summary.current_month);
  if (!currentMonth) return { kind: 'invalid' };
  return { kind: 'ok', months, currentMonth };
}

function readExcluded(value: unknown): BreakdownExcluded | null {
  if (!isObject(value)) return null;
  const unresolved = readUnresolved(value.card_payments_unresolved);
  if (
    !unresolved ||
    !isAmount(value.transfers_internal) ||
    !isAmount(value.transfers_external) ||
    !isAmount(value.credit_card_payments_tracked) ||
    !isAmount(value.credit_card_payments_untracked) ||
    !isAmount(value.credit_card_payments_returned_untracked) ||
    !isAmount(value.debt_payments)
  ) {
    return null;
  }
  return {
    transfers_internal: value.transfers_internal,
    transfers_external: value.transfers_external,
    credit_card_payments_tracked: value.credit_card_payments_tracked,
    credit_card_payments_untracked: value.credit_card_payments_untracked,
    credit_card_payments_returned_untracked: value.credit_card_payments_returned_untracked,
    debt_payments: value.debt_payments,
    card_payments_unresolved: unresolved,
  };
}

/** The role-aware half of `GET /api/plaid/monthly-breakdown`: the months the server returned, in its
 *  order. A month is never dropped or added here. */
export function readMonthlyBreakdownSemantics(body: unknown): MonthlyBreakdownSemantics {
  const status = readStatus(body, false);
  if (status.kind !== 'ok') return status;
  const response = body as Json;
  if (!Array.isArray(response.months)) return { kind: 'invalid' };

  const months: SemanticMonthBreakdown[] = [];
  const seen = new Set<string>();
  for (const entry of response.months as unknown[]) {
    if (!isObject(entry) || typeof entry.month !== 'string' || !MONTH_PATTERN.test(entry.month) || seen.has(entry.month)) {
      return { kind: 'invalid' };
    }
    const semantic = entry.semantic;
    if (!isObject(semantic) || !isAmount(semantic.spending) || !isAmount(semantic.income) || !Array.isArray(semantic.by_category)) {
      return { kind: 'invalid' };
    }
    const byCategory: SemanticCategoryAmount[] = [];
    const categories = new Set<string>();
    for (const row of semantic.by_category as unknown[]) {
      if (!isObject(row) || typeof row.category !== 'string' || row.category === '' || !isAmount(row.amount) || categories.has(row.category)) {
        return { kind: 'invalid' };
      }
      categories.add(row.category);
      byCategory.push({ category: row.category, amount: row.amount });
    }
    const excluded = readExcluded(semantic.excluded);
    if (!excluded) return { kind: 'invalid' };
    seen.add(entry.month);
    months.push({ month: entry.month, spending: semantic.spending, income: semantic.income, by_category: byCategory, excluded });
  }
  return { kind: 'ok', months };
}

/** The role-aware half of `GET /api/budget-categories`: one entry per category the server listed. */
export function readBudgetSemantics(body: unknown): BudgetSemantics {
  const status = readStatus(body, true);
  if (status.kind !== 'ok') return status;
  const response = body as Json;
  if (!Array.isArray(response.categories)) return { kind: 'invalid' };

  const byCategoryId = new Map<string, BudgetCategorySpending>();
  for (const category of response.categories as unknown[]) {
    if (!isObject(category) || typeof category.id !== 'string' || byCategoryId.has(category.id)) return { kind: 'invalid' };
    if (!isAmount(category.spending) || !isAmount(category.recent_avg_spending)) return { kind: 'invalid' };
    byCategoryId.set(category.id, { spending: category.spending, recent_avg_spending: category.recent_avg_spending });
  }
  return { kind: 'ok', byCategoryId };
}

// ---- The drill-down endpoint -------------------------------------------------------------------

/** One drill-down measure per published amount (backend `CASH_FLOW_MEASURES`). Nothing is added here
 *  that the server does not support. */
export const EFFECT_MEASURES = [
  'spending',
  'income',
  'debt_payments',
  'known_principal',
  'debt_payments_unknown_principal',
  'refunds',
  'transfers_internal',
  'transfers_external',
  'credit_card_payments_tracked',
  'credit_card_payments_untracked',
  'credit_card_payments_returned_tracked',
  'credit_card_payments_returned_untracked',
  'credit_card_payments_externally_funded',
  'credit_card_payments_reversed_externally',
  'card_payments_unresolved_credit',
  'card_payments_unresolved_payments',
  'card_payments_unresolved_returns',
  'unclassified',
] as const;
export type EffectMeasure = (typeof EFFECT_MEASURES)[number];

export type EffectAllocation = 'row' | 'split' | 'interest' | 'principal';
const EFFECT_ALLOCATIONS: readonly string[] = ['row', 'split', 'interest', 'principal'];

export interface EffectRow {
  transaction: {
    id: string;
    date: string;
    name: string | null;
    merchant_name: string | null;
    account: { id: string; name: string | null; nickname: string | null };
    pending: boolean;
    effective_role: string | null;
    user_role_override: string | null;
    needs_review: boolean;
  };
  effect_role: string;
  /** The row's contribution to the total, in the total's own sign convention. Server-provided; never
   *  re-signed or filtered here. */
  effect_amount: number;
  allocation: EffectAllocation;
  split_id: string | null;
  split_note: string | null;
  budget_category_id: string | null;
  plaid_category: string | null;
}

export interface EffectsPage {
  rows: EffectRow[];
  /** The bucket's COMPLETE total and row count, over every page. */
  total_amount: number;
  total_count: number;
  next_cursor: string | null;
}

export type EffectsResponse =
  | ({ kind: 'ok' } & EffectsPage)
  | SemanticUpdatingState
  | SemanticUnavailableState
  | SemanticInvalidState;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function readEffectRow(value: unknown): EffectRow | null {
  if (!isObject(value) || !isObject(value.transaction)) return null;
  const t = value.transaction;
  const account = t.account;
  if (
    typeof t.id !== 'string' ||
    t.id === '' ||
    typeof t.date !== 'string' ||
    !DATE_PATTERN.test(t.date) ||
    !isNullableString(t.name) ||
    !isNullableString(t.merchant_name) ||
    !isObject(account) ||
    typeof account.id !== 'string' ||
    !isNullableString(account.name) ||
    !isNullableString(account.nickname) ||
    typeof t.pending !== 'boolean' ||
    !isNullableString(t.effective_role) ||
    !isNullableString(t.user_role_override) ||
    typeof t.needs_review !== 'boolean'
  ) {
    return null;
  }
  if (typeof value.effect_role !== 'string' || !isAmount(value.effect_amount)) return null;
  if (typeof value.allocation !== 'string' || !EFFECT_ALLOCATIONS.includes(value.allocation)) return null;
  const splitId = value.split_id === undefined ? null : value.split_id;
  const splitNote = value.split_note === undefined ? null : value.split_note;
  if (!isNullableString(splitId) || !isNullableString(splitNote)) return null;
  if (!isNullableString(value.budget_category_id) || !isNullableString(value.plaid_category)) return null;
  return {
    transaction: {
      id: t.id,
      date: t.date,
      name: t.name,
      merchant_name: t.merchant_name,
      account: { id: account.id, name: account.name, nickname: account.nickname },
      pending: t.pending,
      effective_role: t.effective_role,
      user_role_override: t.user_role_override,
      needs_review: t.needs_review,
    },
    effect_role: value.effect_role,
    effect_amount: value.effect_amount,
    allocation: value.allocation as EffectAllocation,
    split_id: splitId,
    split_note: splitNote,
    budget_category_id: value.budget_category_id,
    plaid_category: value.plaid_category,
  };
}

/** A 200 body of `GET /api/plaid/transactions/effects`. */
export function readEffectsResponse(body: unknown): EffectsResponse {
  if (!isObject(body)) return { kind: 'invalid' };
  if (body.status === 'updating' || body.status === 'unavailable') {
    if (typeof body.reason !== 'string' || !isAmount(body.retry_after_ms) || body.retry_after_ms < 0) return { kind: 'invalid' };
    return { kind: body.status, reason: body.reason, retryAfterMs: body.retry_after_ms };
  }
  if (body.status !== 'ok' || !Array.isArray(body.rows) || !isAmount(body.total_amount) || !isCount(body.total_count)) return { kind: 'invalid' };
  if (!(body.next_cursor === null || (typeof body.next_cursor === 'string' && body.next_cursor !== ''))) return { kind: 'invalid' };
  const rows: EffectRow[] = [];
  for (const entry of body.rows as unknown[]) {
    const row = readEffectRow(entry);
    if (!row) return { kind: 'invalid' };
    rows.push(row);
  }
  return { kind: 'ok', rows, total_amount: body.total_amount, total_count: body.total_count, next_cursor: body.next_cursor };
}

// ---- Card-payment recovery review (I3A-R packet 2-A) --------------------------------------------
// What `GET /api/card-payment-recovery/reviews`, `POST …/actions`, `GET …/actions/:id` and
// `POST …/refresh-retries` return, validated field by field. A body that is not exactly the documented
// shape — an unknown state or reason, a figure where none may be, a candidate not marked as a suggestion —
// is `invalid`: the review is then shown as unavailable ("update the app"), never as a figure or as zero.

/** The reasons an unresolved card payment can carry. A reason this build does not know means the server
 *  applies a rule this build cannot explain: the figures that depend on it are withheld. */
export const KNOWN_UNRESOLVED_REASONS: ReadonlySet<string> = new Set([
  'no_candidate',
  'possible_match',
  'amount_differs',
  'ambiguous',
  'matched_leg_not_posted',
  'decision_invalidated',
  'ambiguous_replacement',
  'relink_review_required',
]);

/** Every (state, reason) a leg under review can read. Anything else is not shown. */
const KNOWN_REVIEW_READINGS: ReadonlySet<string> = new Set([
  ...[...KNOWN_UNRESOLVED_REASONS].map((reason) => `unresolved/${reason}`),
  'tracked/auto_pair',
  'tracked/user_pair',
  'untracked/partner_excluded',
  'untracked/no_included_card',
  'untracked/user_confirmed_unlinked',
  'untracked/removed_card',
  'paired/auto_pair',
  'paired/user_pair',
  'funded_from_excluded/auto_pair',
  'funded_from_excluded/user_pair',
  'funded_from_excluded/removed_cash_account',
  'not_counted/excluded_account',
]);

const RECOVERY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECOVERY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isId = (value: unknown): value is string => typeof value === 'string' && RECOVERY_UUID.test(value);
const isIdOrNull = (value: unknown): value is string | null => value === null || isId(value);
const isCentsValue = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isDay = (value: unknown): value is string => typeof value === 'string' && RECOVERY_DATE.test(value);

export interface RecoveryFreshness {
  fresh: boolean;
  input_version: number | null;
  evaluated_version: number | null;
  review_revision: number;
  last_error_code: string | null;
  refresh: { queued: boolean; needs_attention: boolean; attempts: number };
}

export type RecoveryActionType = 'pair_current' | 'confirm_unlinked' | 'dismiss_candidate' | 'undo_decision' | 'reject_suggestion' | 'defer';

export interface RecoveryReceipt {
  operation_id: string;
  action: RecoveryActionType | 'refresh_retry';
  outcome: 'saved' | 'unchanged' | 'undone' | 'queued';
  reason: string | null;
  decision_id: string | null;
  superseded_decision_ids: string[];
  retained_obligation_ids: string[];
  committed_at: string;
}

export interface RecoveryCandidate {
  transaction_id: string;
  account_id: string;
  date: string;
  amount_cents: number;
  pending: boolean;
  account_included: boolean;
  kind: string;
  distance_days: number;
  /** |the payment| − |this candidate|, in cents: what pairing them would leave unexplained. */
  difference_cents: number;
  withheld_by_guard: boolean;
  rejected: boolean;
}

export interface RecoverySource {
  /** graph_source: a removed candidate no decision was written for; its decision_id is null. */
  evidence_kind: 'ambiguity_hold' | 'removed_destination' | 'preserved_confirmation' | 'graph_source';
  decision_id: string | null;
  decision_status: string | null;
  source_relation: string | null;
  source_date: string | null;
  source_cents: number | null;
  source_known: boolean;
}

export interface RecoveryObligation {
  obligation_id: string;
  origin: 'captured' | 'seeded' | 'gap';
  gap_reason: 'unattributed_decision' | 'unrecorded_removal' | null;
  institution_name: string | null;
  removed_on: string | null;
  known_surviving_edge_count: number;
  sources: RecoverySource[];
}

export interface RecoveryReview {
  transaction_id: string;
  account_id: string;
  date: string;
  amount_cents: number;
  pending: boolean;
  side: 'cash' | 'credit';
  direction: 'payment' | 'return';
  account_included: boolean;
  state: string;
  reason: string;
  detail: string | null;
  effect_cents: number | null;
  low_cents: number;
  high_cents: number;
  guard_withheld: boolean;
  withheld_partner_transaction_id: string | null;
  coverage_gap: boolean;
  deferred: boolean;
  controlling_decision: { decision_id: string; kind: string; status: string; user_decision: boolean } | null;
  obligations: RecoveryObligation[];
  candidates: RecoveryCandidate[];
}

export type RecoveryReviewsResponse =
  | {
      kind: 'ok';
      fresh: boolean;
      freshness: RecoveryFreshness;
      actions_enabled: boolean;
      affected_payment_count: number;
      next_cursor: string | null;
      /** Empty unless `fresh`. */
      reviews: RecoveryReview[];
    }
  | { kind: 'invalid' };

export type RecoveryAnswer =
  | { kind: 'ok'; status: 'committed_fresh' | 'committed_pending' | 'replayed' | 'queued'; receipt: RecoveryReceipt; freshness: RecoveryFreshness }
  | { kind: 'invalid' };

export type RecoveryLookup = { kind: 'ok'; found: boolean; receipt: RecoveryReceipt | null; freshness: RecoveryFreshness } | { kind: 'invalid' };

function readFreshness(value: unknown): RecoveryFreshness | null {
  if (!isObject(value) || typeof value.fresh !== 'boolean' || !isCount(value.review_revision)) return null;
  const { input_version: input, evaluated_version: evaluated, last_error_code: code, refresh } = value;
  if (!(input === null || isCount(input)) || !(evaluated === null || isCount(evaluated)) || !isTextOrNull(code)) return null;
  if (!isObject(refresh) || typeof refresh.queued !== 'boolean' || typeof refresh.needs_attention !== 'boolean' || !isCount(refresh.attempts)) return null;
  // "Fresh" is believed only with equal versions.
  if (value.fresh && (input === null || input !== evaluated)) return null;
  return {
    fresh: value.fresh,
    input_version: input,
    evaluated_version: evaluated,
    review_revision: value.review_revision,
    last_error_code: code,
    refresh: { queued: refresh.queued, needs_attention: refresh.needs_attention, attempts: refresh.attempts },
  };
}

const RECEIPT_ACTIONS: ReadonlySet<string> = new Set(['pair_current', 'confirm_unlinked', 'dismiss_candidate', 'undo_decision', 'reject_suggestion', 'defer', 'refresh_retry']);
const RECEIPT_OUTCOMES: ReadonlySet<string> = new Set(['saved', 'unchanged', 'undone', 'queued']);
const idList = (value: unknown): string[] | null => (Array.isArray(value) && value.every(isId) ? (value as string[]) : null);

function readReceipt(value: unknown): RecoveryReceipt | null {
  if (!isObject(value) || !isId(value.operation_id) || typeof value.committed_at !== 'string') return null;
  if (typeof value.action !== 'string' || !RECEIPT_ACTIONS.has(value.action)) return null;
  if (typeof value.outcome !== 'string' || !RECEIPT_OUTCOMES.has(value.outcome)) return null;
  // This build knows no action that retires anything. A receipt saying otherwise is not one it can explain.
  if (value.permanent_retirement !== false) return null;
  const superseded = idList(value.superseded_decision_ids);
  const retained = idList(value.retained_obligation_ids);
  if (superseded === null || retained === null || !isTextOrNull(value.reason) || !isIdOrNull(value.decision_id)) return null;
  return {
    operation_id: value.operation_id,
    action: value.action as RecoveryReceipt['action'],
    outcome: value.outcome as RecoveryReceipt['outcome'],
    reason: value.reason,
    decision_id: value.decision_id,
    superseded_decision_ids: superseded,
    retained_obligation_ids: retained,
    committed_at: value.committed_at,
  };
}

function readList<T>(value: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = read(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

const EVIDENCE_KINDS: ReadonlySet<string> = new Set(['ambiguity_hold', 'removed_destination', 'preserved_confirmation', 'graph_source']);

function readSource(value: unknown): RecoverySource | null {
  if (!isObject(value) || typeof value.evidence_kind !== 'string' || !EVIDENCE_KINDS.has(value.evidence_kind)) return null;
  if (typeof value.source_known !== 'boolean') return null;
  // A graph-observed source names no decision; every other kind must name one.
  if (value.evidence_kind === 'graph_source' ? value.decision_id !== null : !isId(value.decision_id)) return null;
  if (!isTextOrNull(value.decision_status) || !isTextOrNull(value.source_relation)) return null;
  if (!(value.source_date === null || isDay(value.source_date)) || !(value.source_cents === null || isCentsValue(value.source_cents))) return null;
  return {
    evidence_kind: value.evidence_kind as RecoverySource['evidence_kind'],
    decision_id: value.decision_id as string | null,
    decision_status: value.decision_status,
    source_relation: value.source_relation,
    source_date: value.source_date,
    source_cents: value.source_cents,
    source_known: value.source_known,
  };
}

function readObligation(value: unknown): RecoveryObligation | null {
  if (!isObject(value) || !isId(value.obligation_id) || !isCount(value.known_surviving_edge_count)) return null;
  if (value.origin !== 'captured' && value.origin !== 'seeded' && value.origin !== 'gap') return null;
  const gap = value.gap_reason;
  if (!(gap === null || gap === 'unattributed_decision' || gap === 'unrecorded_removal')) return null;
  if ((value.origin === 'gap') !== (gap !== null)) return null;
  if (!isTextOrNull(value.institution_name) || !(value.removed_on === null || isDay(value.removed_on))) return null;
  const sources = readList(value.sources, readSource);
  if (sources === null) return null;
  return {
    obligation_id: value.obligation_id,
    origin: value.origin,
    gap_reason: gap,
    institution_name: value.institution_name,
    removed_on: value.removed_on,
    known_surviving_edge_count: value.known_surviving_edge_count,
    sources,
  };
}

function readCandidate(value: unknown): RecoveryCandidate | null {
  if (!isObject(value) || !isId(value.transaction_id) || !isId(value.account_id) || !isDay(value.date)) return null;
  if (!isCentsValue(value.amount_cents) || !isCount(value.distance_days) || !isCentsValue(value.difference_cents)) return null;
  if (typeof value.pending !== 'boolean' || typeof value.account_included !== 'boolean' || typeof value.kind !== 'string') return null;
  if (typeof value.withheld_by_guard !== 'boolean' || typeof value.rejected !== 'boolean') return null;
  // Never shown as anything but a suggestion.
  if (value.suggestion_only !== true) return null;
  return {
    transaction_id: value.transaction_id,
    account_id: value.account_id,
    date: value.date,
    amount_cents: value.amount_cents,
    pending: value.pending,
    account_included: value.account_included,
    kind: value.kind,
    distance_days: value.distance_days,
    difference_cents: value.difference_cents,
    withheld_by_guard: value.withheld_by_guard,
    rejected: value.rejected,
  };
}

function readReview(value: unknown): RecoveryReview | null {
  if (!isObject(value) || !isId(value.transaction_id) || !isId(value.account_id) || !isDay(value.date)) return null;
  if (!isCentsValue(value.amount_cents) || typeof value.pending !== 'boolean' || typeof value.account_included !== 'boolean') return null;
  if (value.side !== 'cash' && value.side !== 'credit') return null;
  if (value.direction !== 'payment' && value.direction !== 'return') return null;
  if (typeof value.state !== 'string' || typeof value.reason !== 'string' || !isTextOrNull(value.detail)) return null;
  // A reading this build does not know is not shown — not as a range, not as a figure, not as zero.
  if (!KNOWN_REVIEW_READINGS.has(`${value.state}/${value.reason}`)) return null;
  const { effect_cents: effect, low_cents: low, high_cents: high } = value;
  if (!(effect === null || isCentsValue(effect)) || !isCentsValue(low) || !isCentsValue(high) || low > high) return null;
  if (effect !== null && (effect !== low || effect !== high)) return null;
  // Unresolved means: no definite effect on an included cash leg. A definite one there would be a figure.
  if (value.state === 'unresolved' && value.side === 'cash' && value.account_included && effect !== null) return null;
  if (typeof value.guard_withheld !== 'boolean' || typeof value.coverage_gap !== 'boolean' || typeof value.deferred !== 'boolean') return null;
  if (!isIdOrNull(value.withheld_partner_transaction_id) || value.guard_withheld !== (value.withheld_partner_transaction_id !== null)) return null;
  let controlling: RecoveryReview['controlling_decision'] = null;
  if (value.controlling_decision !== null) {
    const d = value.controlling_decision;
    if (!isObject(d) || !isId(d.decision_id) || typeof d.kind !== 'string' || typeof d.status !== 'string' || typeof d.user_decision !== 'boolean') return null;
    controlling = { decision_id: d.decision_id, kind: d.kind, status: d.status, user_decision: d.user_decision };
  }
  const obligations = readList(value.obligations, readObligation);
  const candidates = readList(value.candidates, readCandidate);
  if (obligations === null || candidates === null) return null;
  return {
    transaction_id: value.transaction_id,
    account_id: value.account_id,
    date: value.date,
    amount_cents: value.amount_cents,
    pending: value.pending,
    side: value.side,
    direction: value.direction,
    account_included: value.account_included,
    state: value.state,
    reason: value.reason,
    detail: value.detail,
    effect_cents: effect,
    low_cents: low,
    high_cents: high,
    guard_withheld: value.guard_withheld,
    withheld_partner_transaction_id: value.withheld_partner_transaction_id,
    coverage_gap: value.coverage_gap,
    deferred: value.deferred,
    controlling_decision: controlling,
    obligations,
    candidates,
  };
}

/** A 200 body of `GET /api/card-payment-recovery/reviews`. */
export function readRecoveryReviews(body: unknown): RecoveryReviewsResponse {
  if (!isObject(body) || typeof body.fresh !== 'boolean' || typeof body.actions_enabled !== 'boolean' || !isCount(body.affected_payment_count)) return { kind: 'invalid' };
  const freshness = readFreshness(body.freshness);
  const reviews = readList(body.reviews, readReview);
  if (freshness === null || reviews === null || body.fresh !== freshness.fresh) return { kind: 'invalid' };
  if (!(body.next_cursor === null || (typeof body.next_cursor === 'string' && body.next_cursor !== ''))) return { kind: 'invalid' };
  // A list that is not current carries no review: a review is never shown with figures that are not current.
  if (!body.fresh && (reviews.length > 0 || body.next_cursor !== null)) return { kind: 'invalid' };
  return {
    kind: 'ok',
    fresh: body.fresh,
    freshness,
    actions_enabled: body.actions_enabled,
    affected_payment_count: body.affected_payment_count,
    next_cursor: body.next_cursor,
    reviews,
  };
}

/** A 200 body of `POST …/actions` or `POST …/refresh-retries`. */
export function readRecoveryAnswer(body: unknown): RecoveryAnswer {
  if (!isObject(body)) return { kind: 'invalid' };
  const { status } = body;
  if (status !== 'committed_fresh' && status !== 'committed_pending' && status !== 'replayed' && status !== 'queued') return { kind: 'invalid' };
  const receipt = readReceipt(body.receipt);
  const freshness = readFreshness(body.freshness);
  if (receipt === null || freshness === null) return { kind: 'invalid' };
  if (status === 'committed_fresh' && !freshness.fresh) return { kind: 'invalid' };
  return { kind: 'ok', status, receipt, freshness };
}

/** A 200 body of `GET …/actions/:operationId`. */
export function readRecoveryLookup(body: unknown): RecoveryLookup {
  if (!isObject(body) || typeof body.found !== 'boolean') return { kind: 'invalid' };
  const freshness = readFreshness(body.freshness);
  if (freshness === null) return { kind: 'invalid' };
  if (!body.found) return body.receipt === null ? { kind: 'ok', found: false, receipt: null, freshness } : { kind: 'invalid' };
  const receipt = readReceipt(body.receipt);
  return receipt === null ? { kind: 'invalid' } : { kind: 'ok', found: true, receipt, freshness };
}
