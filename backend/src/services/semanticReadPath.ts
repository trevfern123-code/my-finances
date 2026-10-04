import { createHash } from 'node:crypto';
import type { BudgetCategoryRow } from '../types';
import { categorySpendRowsOf } from './dataService';
import { readCardPaymentStates, type CardPaymentStateUnavailableReason } from './cardPaymentStateReader';
import {
  readFinancialSnapshot,
  type FinancialSnapshot,
  type FinancialSnapshotRequest,
  type SemanticSplitRow,
  type SemanticTransactionRow,
} from './financialSnapshot';
import {
  aggregateBudgetSpend,
  aggregateCashFlow,
  aggregateCashFlowByMonth,
  aggregateCashFlowDetail,
  aggregateMonthlyBreakdown,
  aggregateSpendByPlaidCategory,
  CASH_FLOW_MEASURES,
  LOAN_INTEREST_CATEGORY,
  pairingContextRange,
  SplitAllocationMismatchError,
  type AggregationAccount,
  type AggregationPeriod,
  type AggregationSplit,
  type AggregationTransaction,
  type BudgetSpend,
  type CardPaymentStates,
  type CashFlowMeasure,
  type CashFlowTotals,
  type EffectRow,
  type MonthlyBreakdownSemantic,
  type MonthlyCashFlow,
} from './semanticAggregation';

/**
 * Financial Semantics Phase B, integration slice I1 — the backend READ PATH of the role-aware
 * aggregates (FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §3, §7.3; CARD_PAYMENT_PAIRING_DESIGN.md §3.7).
 *
 * ONE COHERENT STATE PER RESPONSE. Every read here is ONE call of `get_financial_read_snapshot`
 * (`financialSnapshot.ts`): a single SQL statement, hence a single database snapshot, holding the
 * transactions, and — as the read needs them — their splits, the budget categories and the
 * card-payment matching state. Nothing is paged and nothing is assembled from several requests, so a
 * response can never combine a pending row with the posted row that replaced it, a principal before
 * an edit with another after it, or a transaction with another allocation's splits. This replaces the
 * earlier "read the matching version before and after the pages" bracket, which could not see changes
 * the matching version does not watch (principal, the loan link, categories, splits).
 *
 * It computes nothing itself — the pure module `semanticAggregation.ts` does — and it never writes:
 * no evaluation, no matching, no repair.
 *
 * FROZEN AND ROLE-AWARE FIGURES COME FROM THE SAME ROWS. A level-2 response carries the frozen
 * (sign-based) fields beside the new ones. The aggregate reads return the frozen inputs taken from
 * the SAME snapshot (`frozen`), so both families describe one state and one set of months.
 *
 * CARD-PAYMENT FRESHNESS. The matching state is read inside the snapshot, so fresh states describe
 * exactly the transactions beside them. The existing matching contract still decides freshness
 * (`evaluated_version = input_version`). When the states are stale the read waits briefly — two cheap
 * polls of the versions, 100 ms and 300 ms apart — in case an evaluation is already finishing, takes
 * at most one more snapshot, and otherwise withholds every card-dependent figure.
 *
 * Results:
 *   - `ok`          — figures computed from one snapshot.
 *   - `updating`    — the snapshot was read but the matching state in it is not fresh. Retryable.
 *                     `matching_failed` when the database records a failed evaluation,
 *                     `matching_pending` otherwise. (`inputs_changing` belonged to the version bracket;
 *                     with one snapshot there is no window for it, so this slice never emits it. The
 *                     value stays in the type: it is part of the design's vocabulary.)
 *   - `unavailable` — the snapshot could not be read at all (the function is missing, the request
 *                     failed or timed out, the payload was not the documented shape). It establishes
 *                     nothing about the data and is kept apart from `updating`.
 *   Neither non-`ok` result carries a role-aware total, range or rate, and neither is ever turned into
 *   one by falling back to the sign-based view or to in-module pairing.
 *
 * Integrity failures (`SemanticIntegrityError`, `CardPaymentStateIntegrityError`,
 * `AggregateTooLargeError`) are THROWN, never mapped to a status. The budget's split mismatch is
 * returned as `refused`, with no role-aware figure, because the response still carries the category
 * list.
 *
 * RECOVERY. Nothing is cached, so a later read observes whatever the database holds then: once some
 * existing evaluator has made the matching state fresh, or a bad row has been corrected, the next read
 * returns figures with no Plaid sync. That is OBSERVATION only. This module never evaluates, so it
 * does not by itself make a stale user fresh (autonomous recovery is a separate packet).
 *
 * No wall-clock dependency: every range is an explicit argument, and the wait is injectable.
 */

// ---- Results -----------------------------------------------------------------------------------

export type SemanticUpdatingReason = 'inputs_changing' | 'matching_pending' | 'matching_failed';

export interface SemanticUpdating {
  status: 'updating';
  retryAfterMs: number;
  reason: SemanticUpdatingReason;
}

export interface SemanticUnavailable {
  status: 'unavailable';
  retryAfterMs: number;
  reason: CardPaymentStateUnavailableReason;
}

export type SemanticRead<T> = { status: 'ok'; value: T } | SemanticUpdating | SemanticUnavailable;

/**
 * An aggregate read for a response that also carries frozen fields. `frozen` is present whenever a
 * snapshot was read — it is the frozen fields' input, from the same snapshot as `value`.
 */
export type CoherentRead<F, T> = SemanticUnavailable | (SemanticUpdating & { frozen: F }) | { status: 'ok'; frozen: F; value: T };

/** The waits before each poll of the matching versions while the snapshot's states are stale. */
export const SEMANTIC_READ_BACKOFF_MS: readonly number[] = [100, 300];
/** A read takes at most this many snapshots: the first, and one more if a poll reports fresh states. */
export const SEMANTIC_READ_MAX_SNAPSHOTS = 2;
/** What a client is told to wait before asking again. */
export const SEMANTIC_READ_RETRY_AFTER_MS = 5_000;

/** A reporting range: [start, end) in YYYY-MM-DD; `end` omitted for an open-ended range. */
export interface ReadRange {
  start: string;
  end?: string;
}

export interface SemanticReadOptions {
  /** Tests only: replaces the real wait. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The exclusive upper bound that stands for "no upper bound" in the pure module's period. */
const OPEN_END = '9999-12-31';

function toPeriod(range: ReadRange): AggregationPeriod {
  return { start: range.start, end: range.end ?? OPEN_END };
}

/** The smallest range covering both — the ranges read together are adjacent or nested in practice. */
function unionOf(a: ReadRange, b: ReadRange): ReadRange {
  const start = a.start < b.start ? a.start : b.start;
  if (a.end === undefined || b.end === undefined) return { start };
  return { start, end: a.end > b.end ? a.end : b.end };
}

const inRange = (date: string, range: ReadRange): boolean => date >= range.start && (range.end === undefined || date < range.end);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD: 2026-02-30 and 2026-13-01 are not. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// ---- Rows → the pure module's input ------------------------------------------------------------

interface LoadedRows {
  accounts: AggregationAccount[];
  transactions: AggregationTransaction[];
  byId: Map<string, SemanticTransactionRow>;
}

function toLoadedRows(rows: SemanticTransactionRow[]): LoadedRows {
  const accounts = new Map<string, AggregationAccount>();
  const byId = new Map<string, SemanticTransactionRow>();
  const transactions: AggregationTransaction[] = [];
  for (const row of rows) {
    if (!accounts.has(row.account_id)) {
      accounts.set(row.account_id, {
        id: row.account_id,
        type: row.accounts.type,
        excludeFromCashFlow: row.accounts.exclude_from_cash_flow,
      });
    }
    byId.set(row.id, row);
    transactions.push({
      id: row.id,
      accountId: row.account_id,
      date: row.date,
      amount: row.amount,
      plaidCategory: row.category,
      budgetCategoryId: row.budget_category_id,
      effectiveRole: row.effective_role,
      userRoleOverride: row.user_role_override,
      manualLoanId: row.manual_loan_id,
      principalPortion: row.principal_portion,
    });
  }
  return { accounts: Array.from(accounts.values()), transactions, byId };
}

function toSplits(rows: SemanticSplitRow[]): AggregationSplit[] {
  return rows.map((row) => ({ id: row.id, transactionId: row.transaction_id, budgetCategoryId: row.budget_category_id, amount: row.amount }));
}

/** The rows a transfer-pairing aggregate needs for `range`: the period padded on both sides. */
function contextRangeOf(range: ReadRange): ReadRange {
  const padded = pairingContextRange(toPeriod(range));
  return range.end === undefined ? { start: padded.start } : padded;
}

const unavailable = (reason: CardPaymentStateUnavailableReason): SemanticUnavailable => ({
  status: 'unavailable',
  retryAfterMs: SEMANTIC_READ_RETRY_AFTER_MS,
  reason,
});

// ---- The snapshot with card-payment states -----------------------------------------------------

type CardSnapshot =
  | SemanticUnavailable
  | { status: 'read'; snapshot: FinancialSnapshot; cardPayments: CardPaymentStates | null; updating: SemanticUpdating | null };

/**
 * One snapshot holding the transactions AND the matching state that describes them. When that state
 * is stale the read polls the versions briefly and, only if a poll reports fresh states, takes ONE
 * more snapshot — whose own content then decides. `cardPayments` is null exactly when the final
 * snapshot's states are not fresh; the snapshot's rows are returned either way (the frozen fields
 * never depend on matching).
 */
async function readCardSnapshot(
  userId: string,
  request: FinancialSnapshotRequest & { cardStates: { from: string; to?: string } },
  options: SemanticReadOptions
): Promise<CardSnapshot> {
  const sleep = options.sleep ?? realSleep;
  let read = await readFinancialSnapshot(userId, request);
  if (read.kind === 'unavailable') return unavailable(read.reason);

  if (read.snapshot.cardPayments?.kind !== 'fresh') {
    for (const wait of SEMANTIC_READ_BACKOFF_MS) {
      await sleep(wait);
      // Versions only: an empty date range returns no legs. Nothing is computed from this call.
      const poll = await readCardPaymentStates(userId, { from: request.cardStates.from, to: request.cardStates.from });
      if (poll.kind === 'unavailable') break;
      if (poll.kind === 'fresh') {
        const again = await readFinancialSnapshot(userId, request);
        if (again.kind === 'unavailable') return unavailable(again.reason);
        read = again;
        break;
      }
    }
  }

  const cards = read.snapshot.cardPayments;
  if (cards?.kind === 'fresh') return { status: 'read', snapshot: read.snapshot, cardPayments: cards.states, updating: null };
  return {
    status: 'read',
    snapshot: read.snapshot,
    cardPayments: null,
    updating: {
      status: 'updating',
      retryAfterMs: SEMANTIC_READ_RETRY_AFTER_MS,
      reason: cards?.kind === 'stale' && cards.lastErrorCode !== null ? 'matching_failed' : 'matching_pending',
    },
  };
}

// ---- Cash flow (design §5 C1–C4) ---------------------------------------------------------------

export interface SemanticCashFlowSummary {
  /** One entry per calendar month of `range` that has a row, ascending. */
  monthly: MonthlyCashFlow[];
  currentMonth: CashFlowTotals;
}

/** The frozen `/summary` inputs: what `getTransactionsSince` returns for each of its two ranges. */
export interface FrozenSummaryRows {
  range: { amount: number; date: string }[];
  currentMonth: { amount: number; date: string }[];
}

/**
 * The figures the Overview and Income cards need: per month over `range`, and for `currentMonth` on
 * its own. The role-aware figures and the frozen inputs come from ONE snapshot.
 */
export async function readSummary(
  userId: string,
  args: { range: ReadRange; currentMonth: { start: string; end: string } },
  options: SemanticReadOptions = {}
): Promise<CoherentRead<FrozenSummaryRows, SemanticCashFlowSummary>> {
  const covered = unionOf(args.range, args.currentMonth);
  const read = await readCardSnapshot(userId, { rows: contextRangeOf(covered), cardStates: { from: covered.start, to: covered.end } }, options);
  if (read.status === 'unavailable') return read;

  const rows = read.snapshot.transactions;
  const frozenOf = (range: ReadRange) => rows.filter((row) => inRange(row.date, range)).map((row) => ({ amount: row.amount, date: row.date }));
  const frozen: FrozenSummaryRows = { range: frozenOf(args.range), currentMonth: frozenOf(args.currentMonth) };
  if (read.cardPayments === null) return { ...read.updating!, frozen };

  const { accounts, transactions } = toLoadedRows(rows);
  const cardPayments = read.cardPayments;
  return {
    status: 'ok',
    frozen,
    value: {
      monthly: aggregateCashFlowByMonth({ accounts, transactions, cardPayments, period: toPeriod(args.range) }),
      currentMonth: aggregateCashFlow({ accounts, transactions, cardPayments, period: args.currentMonth }),
    },
  };
}

// ---- Monthly Breakdown (design §5 C5) ----------------------------------------------------------

/** The frozen `/monthly-breakdown` input: what `getCategorizedTransactionsSince` returns. */
export type FrozenBreakdownRows = { amount: number; date: string; category: string | null }[];

/** The `semantic` block of every month of `range` that has a row, ascending, with the frozen input. */
export async function readMonthlyBreakdown(
  userId: string,
  range: ReadRange,
  options: SemanticReadOptions = {}
): Promise<CoherentRead<FrozenBreakdownRows, MonthlyBreakdownSemantic[]>> {
  const read = await readCardSnapshot(userId, { rows: contextRangeOf(range), cardStates: { from: range.start, to: range.end } }, options);
  if (read.status === 'unavailable') return read;

  const rows = read.snapshot.transactions;
  const frozen: FrozenBreakdownRows = rows
    .filter((row) => inRange(row.date, range))
    .map((row) => ({ amount: row.amount, date: row.date, category: row.category }));
  if (read.cardPayments === null) return { ...read.updating!, frozen };

  const { accounts, transactions } = toLoadedRows(rows);
  return {
    status: 'ok',
    frozen,
    value: aggregateMonthlyBreakdown({ accounts, transactions, cardPayments: read.cardPayments, period: toPeriod(range) }),
  };
}

// ---- Budget spend (design §5 C6) ---------------------------------------------------------------

/** The frozen `/api/budget-categories` inputs: the category list and the spend rows of each period. */
export interface FrozenBudgetInputs<K extends string> {
  categories: BudgetCategoryRow[];
  spendRows: Record<K, { budget_category_id: string | null; amount: number }[]>;
}

export type BudgetRead<K extends string> =
  | SemanticUnavailable
  | { status: 'ok'; frozen: FrozenBudgetInputs<K>; value: Record<K, BudgetSpend> }
  /** A spending-eligible transaction's splits do not sum to it (design §13 Q3): the budget aggregate
   *  is refused — never adjusted — and no role-aware figure exists. */
  | { status: 'refused'; frozen: FrozenBudgetInputs<K>; mismatch: SplitAllocationMismatchError };

/**
 * Role-aware spend per budget category for each period, with the frozen inputs, all from ONE snapshot
 * of the transactions, their splits and the category list. Independent of card-payment state (a card
 * payment is never spending), so there is no `updating` here.
 */
export async function readBudget<K extends string>(userId: string, periods: Record<K, { start: string; end: string }>): Promise<BudgetRead<K>> {
  const names = Object.keys(periods) as K[];
  const range = names.map((name) => periods[name] as ReadRange).reduce(unionOf);
  const read = await readFinancialSnapshot(userId, { rows: range, splits: true, budgetCategories: true });
  if (read.kind === 'unavailable') return unavailable(read.reason);

  const { snapshot } = read;
  const splitRows = snapshot.splits ?? [];
  const frozen: FrozenBudgetInputs<K> = { categories: snapshot.budgetCategories ?? [], spendRows: {} as FrozenBudgetInputs<K>['spendRows'] };
  for (const name of names) {
    // What the frozen read returns for this period: its transactions, and the splits of those.
    const inPeriod = snapshot.transactions.filter((row) => inRange(row.date, periods[name]));
    const ids = new Set(inPeriod.map((row) => row.id));
    frozen.spendRows[name] = categorySpendRowsOf(inPeriod, splitRows.filter((split) => ids.has(split.transaction_id)));
  }

  const { accounts, transactions } = toLoadedRows(snapshot.transactions);
  const splits = toSplits(splitRows);
  const value = {} as Record<K, BudgetSpend>;
  try {
    for (const name of names) value[name] = aggregateBudgetSpend({ accounts, transactions, splits, period: periods[name] });
  } catch (err) {
    if (err instanceof SplitAllocationMismatchError) return { status: 'refused', frozen, mismatch: err };
    throw err;
  }
  return { status: 'ok', frozen, value };
}

// ---- Effect rows — the drill-down (design §7.3) ------------------------------------------------

export const EFFECT_MEASURES = CASH_FLOW_MEASURES;
export type EffectMeasure = CashFlowMeasure;

export type EffectBucket =
  /** A budget category; `id: null` is the unassigned bucket. */
  | { kind: 'budget_category'; id: string | null }
  /** A Plaid primary category, or the synthetic `LOAN_INTEREST`. */
  | { kind: 'plaid_category'; category: string };

export interface EffectQuery {
  start: string;
  end: string;
  measure: EffectMeasure;
  /** `spending` only, and optional there: without it the bucket is ALL spending — the summary's own
   *  `spending` total. Not allowed for any other measure. */
  bucket?: EffectBucket;
  cursor?: string | null;
  limit: number;
}

/** One row of the drill-down, in the wire shape of design §7.3. */
export interface EffectRowView {
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
  /** The row's contribution to the bucket total, in the total's own sign convention. */
  effect_amount: number;
  allocation: EffectRow['allocation'];
  split_id?: string;
  split_note?: string | null;
  budget_category_id: string | null;
  plaid_category: string | null;
}

export interface EffectPage {
  rows: EffectRowView[];
  /** The bucket's COMPLETE total and row count — over every page, not only this one. */
  total_amount: number;
  total_count: number;
  next_cursor: string | null;
}

export class InvalidEffectQueryError extends Error {
  constructor(
    readonly code: 'invalid_cursor' | 'invalid_effect_query',
    message: string
  ) {
    super(message);
  }
}

/**
 * A later page was requested with a cursor whose fingerprint no longer matches the result: a row
 * changed, moved, appeared or disappeared since the first page, or the cursor belongs to another
 * range, measure or bucket. The pages already returned no longer add up to anything, so the request
 * is refused with NO rows, total or cursor, and the client must start again from page 1.
 */
export class EffectsRestartRequiredError extends Error {
  readonly code = 'effects_restart_required';
  readonly reason = 'snapshot_changed';
  constructor() {
    super('The result changed since the first page; restart from the first page');
  }
}

/** The cursor format version. Version 1 (`date|id`) could not tell whether two pages described the
 *  same result, and is no longer accepted. */
const CURSOR_VERSION = '2';
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EffectCursor {
  /** The fingerprint of the complete result the first page described. */
  fingerprint: string;
  /** The last transaction returned: the next page starts strictly after it in (date desc, id desc). */
  date: string;
  id: string;
}

/** The opaque cursor: base64url of `version|fingerprint|date|id`. */
export function encodeEffectCursor(cursor: EffectCursor): string {
  return Buffer.from(`${CURSOR_VERSION}|${cursor.fingerprint}|${cursor.date}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeEffectCursor(cursor: string): EffectCursor {
  const invalid = () => new InvalidEffectQueryError('invalid_cursor', 'The cursor is not valid');
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (parts.length !== 4) throw invalid();
  const [version, fingerprint, date, id] = parts;
  if (version !== CURSOR_VERSION || !FINGERPRINT_PATTERN.test(fingerprint) || !isCalendarDate(date) || !UUID_PATTERN.test(id)) throw invalid();
  return { fingerprint, date, id };
}

function assertEffectQuery(query: EffectQuery): void {
  if (query.measure !== 'spending' && query.bucket !== undefined) {
    throw new InvalidEffectQueryError('invalid_effect_query', 'budget_category_id and plaid_category apply to the spending measure only');
  }
  if (!Number.isInteger(query.limit) || query.limit <= 0) {
    throw new InvalidEffectQueryError('invalid_effect_query', 'limit must be a positive integer');
  }
}

const toCents = (dollars: number): number => Math.round(dollars * 100);

/**
 * SHA-256 over a canonical representation of the query identity and the COMPLETE ordered result: the
 * date range, measure and bucket; every row in order, every field it would be returned with; the full
 * total and count. Each line is a JSON array of primitives in a fixed position order, so the
 * representation does not depend on object key order. Equal fingerprints mean the pages describe the
 * same result, byte for byte.
 */
function fingerprintOf(query: EffectQuery, views: EffectRowView[], totalCents: number): string {
  const hash = createHash('sha256');
  const line = (values: (string | number | boolean | null)[]) => hash.update(JSON.stringify(values)).update('\n');
  const bucket = query.bucket;
  line([
    'effects',
    CURSOR_VERSION,
    query.start,
    query.end,
    query.measure,
    bucket === undefined ? null : bucket.kind,
    bucket === undefined ? null : bucket.kind === 'budget_category' ? bucket.id : bucket.category,
  ]);
  for (const view of views) {
    const t = view.transaction;
    line([
      t.id,
      t.date,
      t.name,
      t.merchant_name,
      t.account.id,
      t.account.name,
      t.account.nickname,
      t.pending,
      t.effective_role,
      t.user_role_override,
      t.needs_review,
      view.effect_role,
      toCents(view.effect_amount),
      view.allocation,
      view.split_id ?? null,
      view.split_note ?? null,
      view.budget_category_id,
      view.plaid_category,
    ]);
  }
  line(['total', totalCents, views.length]);
  return hash.digest('base64url');
}

/**
 * Orders the bucket's rows `(date desc, id desc)`, keeps every effect of a transaction together, checks
 * the cursor's fingerprint against the complete result, and cuts a page that never splits a
 * transaction. The totals are computed from ALL rows.
 */
function pageEffectRows(
  rows: EffectRow[],
  query: EffectQuery,
  cursor: EffectCursor | null,
  byId: Map<string, SemanticTransactionRow>,
  splitsById: Map<string, SemanticSplitRow>
): EffectPage {
  const totalCents = rows.reduce((sum, row) => sum + toCents(row.amount), 0);

  // Group by transaction, preserving the module's order of effects within one.
  const groups = new Map<string, EffectRow[]>();
  for (const row of rows) {
    const group = groups.get(row.transactionId);
    if (group) group.push(row);
    else groups.set(row.transactionId, [row]);
  }
  const ordered = Array.from(groups.values()).sort((a, b) => {
    if (a[0].date !== b[0].date) return a[0].date < b[0].date ? 1 : -1;
    return a[0].transactionId < b[0].transactionId ? 1 : a[0].transactionId > b[0].transactionId ? -1 : 0;
  });

  const view = (row: EffectRow): EffectRowView => {
    const txn = byId.get(row.transactionId)!;
    const split = row.splitId !== undefined ? splitsById.get(row.splitId) : undefined;
    const interest = row.allocation === 'interest';
    return {
      transaction: {
        id: txn.id,
        date: txn.date,
        name: txn.name,
        merchant_name: txn.merchant_name,
        account: { id: txn.account_id, name: txn.accounts.name, nickname: txn.accounts.nickname },
        pending: txn.pending,
        effective_role: txn.effective_role,
        user_role_override: txn.user_role_override,
        needs_review: txn.needs_review,
      },
      effect_role: row.effectRole,
      effect_amount: row.amount,
      allocation: row.allocation,
      ...(row.splitId !== undefined ? { split_id: row.splitId, split_note: split?.note ?? null } : {}),
      // Where the effect is allocated: a split's own category; a loan's interest is always unassigned
      // and listed under the synthetic Plaid category (design §4.6, §5 C5).
      budget_category_id: split !== undefined ? split.budget_category_id : interest ? null : txn.budget_category_id,
      plaid_category: interest ? LOAN_INTEREST_CATEGORY : txn.category,
    };
  };
  const viewGroups = ordered.map((group) => group.map(view));

  // The complete result decides whether a continuation is still valid.
  const fingerprint = fingerprintOf(query, viewGroups.flat(), totalCents);
  if (cursor !== null && cursor.fingerprint !== fingerprint) throw new EffectsRestartRequiredError();

  const remaining =
    cursor === null
      ? viewGroups
      : viewGroups.filter((group) => {
          const t = group[0].transaction;
          return t.date < cursor.date || (t.date === cursor.date && t.id < cursor.id);
        });

  const page: EffectRowView[][] = [];
  let count = 0;
  for (const group of remaining) {
    // Whole transactions only: stop before one that would not fit, unless the page is still empty.
    if (page.length > 0 && count + group.length > query.limit) break;
    page.push(group);
    count += group.length;
    if (count >= query.limit) break;
  }
  const last = page.at(-1);
  const hasMore = page.length < remaining.length;

  return {
    rows: page.flat(),
    total_amount: Math.round(totalCents) / 100,
    total_count: rows.length,
    next_cursor:
      hasMore && last !== undefined ? encodeEffectCursor({ fingerprint, date: last[0].transaction.date, id: last[0].transaction.id }) : null,
  };
}

/**
 * The effect rows of ONE bucket for [start, end), produced by the same pure module — and the same
 * complete row set — that produces the totals, so Σ `effect_amount` over all pages = `total_amount`
 * = the figure on the card (design §7.3, invariant I6).
 *
 * CONTINUATION. Every request reads one snapshot and computes the COMPLETE bucket. The first page's
 * cursor carries a fingerprint of that complete result. A later page is served only if the result it
 * recomputes has the same fingerprint; otherwise `EffectsRestartRequiredError` (no rows, no total).
 * A cursor issued for another range, measure or bucket fails the same check.
 *
 * `spending` — bucketed or not — reads no card state. Every other measure is a cash-flow total, read
 * with the matching state in the same snapshot; while that state is stale the answer is `updating`,
 * with no rows and no total.
 */
export async function readEffectRows(userId: string, query: EffectQuery, options: SemanticReadOptions = {}): Promise<SemanticRead<EffectPage>> {
  assertEffectQuery(query);
  // A malformed cursor is refused before anything is read.
  const cursor = query.cursor ? decodeEffectCursor(query.cursor) : null;
  const period = { start: query.start, end: query.end };

  if (query.measure === 'spending') {
    const bucket = query.bucket;
    if (bucket?.kind === 'budget_category') {
      const read = await readFinancialSnapshot(userId, { rows: period, splits: true });
      if (read.kind === 'unavailable') return unavailable(read.reason);
      const loaded = toLoadedRows(read.snapshot.transactions);
      const splitRows = read.snapshot.splits ?? [];
      const budget = aggregateBudgetSpend({ accounts: loaded.accounts, transactions: loaded.transactions, splits: toSplits(splitRows), period });
      const splitsById = new Map(splitRows.map((split) => [split.id, split]));
      return { status: 'ok', value: pageEffectRows(budget.effectRows.get(bucket.id) ?? [], query, cursor, loaded.byId, splitsById) };
    }
    const read = await readFinancialSnapshot(userId, { rows: period });
    if (read.kind === 'unavailable') return unavailable(read.reason);
    const loaded = toLoadedRows(read.snapshot.transactions);
    const spend = aggregateSpendByPlaidCategory({ accounts: loaded.accounts, transactions: loaded.transactions, period });
    // No bucket: every expense and refund effect of the period — the summary's `spending`.
    const rows = bucket === undefined ? Array.from(spend.effectRows.values()).flat() : spend.effectRows.get(bucket.category) ?? [];
    return { status: 'ok', value: pageEffectRows(rows, query, cursor, loaded.byId, new Map()) };
  }

  const read = await readCardSnapshot(userId, { rows: contextRangeOf(period), cardStates: { from: period.start, to: period.end } }, options);
  if (read.status === 'unavailable') return read;
  if (read.cardPayments === null) return read.updating!;
  const loaded = toLoadedRows(read.snapshot.transactions);
  const detail = aggregateCashFlowDetail({ accounts: loaded.accounts, transactions: loaded.transactions, cardPayments: read.cardPayments, period });
  return { status: 'ok', value: pageEffectRows(detail.effectRows.get(query.measure) ?? [], query, cursor, loaded.byId, new Map()) };
}
