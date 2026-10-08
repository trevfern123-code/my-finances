import { supabaseAdmin } from '../config/supabase';
import type { BudgetCategoryRow } from '../types';
import {
  classifyReadError,
  classifyThrownRead,
  parseCardPaymentStates,
  warnUnreadable,
  type CardPaymentStateRead,
  type CardPaymentStateUnavailableReason,
} from './cardPaymentStateReader';
import { AggregateTooLargeError } from './fetchAllPages';

/**
 * The coherent financial read (Financial Semantics Phase B, integration slice I1; migration
 * 20261004120000).
 *
 * A published aggregate must be computed from ONE coherent financial state and must never be silently
 * truncated. Several PostgREST requests are several committed snapshots, and a read assembled from
 * them can combine states that never existed together — a pending row with the posted row that
 * replaced it, a principal before an edit with another after it, a transaction with another
 * allocation's splits. So everything one read needs comes from ONE call of
 * `get_financial_read_snapshot`: a single statement, hence a single MVCC snapshot, returning a single
 * `jsonb` value that is not subject to the response row cap.
 *
 * What the snapshot holds — and what it guarantees:
 * - `transactions`: the user's rows on accounts INCLUDED in cash flow with `date` in [start, end),
 *   ordered (date, id), with every column the aggregation consumes.
 * - `splits`, `budgetCategories`, `cardPayments`: only when requested; each observed in that same
 *   statement. `cardPayments` is the existing reader's result, so its freshness rule is unchanged
 *   (states only when `evaluated_version = input_version`) — and because it shares the snapshot, fresh
 *   states describe exactly the transactions returned beside them.
 *
 * Limits: the function refuses more than 10 000 transactions or 25 000 splits (development-stage
 * safety limits, enforced in SQL and not adjustable by a caller). It then returns counts and no rows,
 * and this module throws `AggregateTooLargeError`: nothing is ever computed from a partial set.
 *
 * `unavailable` means THIS read obtained no usable answer (the function is missing, the request
 * failed or timed out, or the payload was not in the documented shape). It establishes nothing about
 * the data. The read never throws for those cases, never retries and never writes.
 */

/** Mirrors of the constants enforced inside the SQL function — for messages and tests only. */
export const SNAPSHOT_MAX_TRANSACTIONS = 10_000;
export const SNAPSHOT_MAX_SPLITS = 25_000;

/** How long the client waits for one snapshot before abandoning the request. */
export const FINANCIAL_SNAPSHOT_TIMEOUT_MS = 20_000;

/** One transaction as the aggregation reads it. Its account is always one INCLUDED in cash flow. */
export interface SemanticTransactionRow {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  category: string | null;
  budget_category_id: string | null;
  effective_role: string | null;
  user_role_override: string | null;
  manual_loan_id: string | null;
  principal_portion: number | null;
  name: string | null;
  merchant_name: string | null;
  pending: boolean;
  needs_review: boolean;
  /** Lineage (pending → posted continuity): not consumed by the aggregation, returned for completeness. */
  plaid_transaction_id: string | null;
  pending_transaction_id: string | null;
  accounts: { name: string | null; nickname: string | null; type: string | null; exclude_from_cash_flow: boolean };
}

export interface SemanticSplitRow {
  id: string;
  transaction_id: string;
  budget_category_id: string;
  amount: number;
  note: string | null;
}

export interface FinancialSnapshotRequest {
  /** The transactions to return: `date` in [start, end); `end` omitted for an open-ended range. */
  rows: { start: string; end?: string };
  splits?: boolean;
  budgetCategories?: boolean;
  /** When given, the card-payment states of the legs dated in [from, to) are read in the same snapshot. */
  cardStates?: { from: string; to?: string };
}

export interface FinancialSnapshot {
  transactions: SemanticTransactionRow[];
  /** Null unless requested. */
  splits: SemanticSplitRow[] | null;
  budgetCategories: BudgetCategoryRow[] | null;
  /** Null unless requested; otherwise fresh states, or the stale versions with no states. */
  cardPayments: Exclude<CardPaymentStateRead, { kind: 'unavailable' }> | null;
}

export type FinancialSnapshotRead =
  | { kind: 'snapshot'; snapshot: FinancialSnapshot }
  | { kind: 'unavailable'; reason: CardPaymentStateUnavailableReason };

const READ = 'financial snapshot';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseTransaction(value: unknown): SemanticTransactionRow | null {
  if (!isRecord(value)) return null;
  const account = value.accounts;
  if (!isRecord(account)) return null;
  if (typeof value.id !== 'string' || typeof value.account_id !== 'string') return null;
  if (typeof value.date !== 'string' || !DATE_ONLY.test(value.date)) return null;
  if (!isFiniteNumber(value.amount)) return null;
  if (value.principal_portion !== null && !isFiniteNumber(value.principal_portion)) return null;
  if (typeof value.pending !== 'boolean' || typeof value.needs_review !== 'boolean') return null;
  if (typeof account.exclude_from_cash_flow !== 'boolean') return null;
  for (const key of ['category', 'budget_category_id', 'effective_role', 'user_role_override', 'manual_loan_id', 'name', 'merchant_name', 'plaid_transaction_id', 'pending_transaction_id']) {
    if (!isStringOrNull(value[key])) return null;
  }
  for (const key of ['name', 'nickname', 'type']) {
    if (!isStringOrNull(account[key])) return null;
  }
  return {
    id: value.id,
    account_id: value.account_id,
    date: value.date,
    amount: value.amount,
    category: value.category as string | null,
    budget_category_id: value.budget_category_id as string | null,
    effective_role: value.effective_role as string | null,
    user_role_override: value.user_role_override as string | null,
    manual_loan_id: value.manual_loan_id as string | null,
    principal_portion: value.principal_portion as number | null,
    name: value.name as string | null,
    merchant_name: value.merchant_name as string | null,
    pending: value.pending,
    needs_review: value.needs_review,
    plaid_transaction_id: value.plaid_transaction_id as string | null,
    pending_transaction_id: value.pending_transaction_id as string | null,
    accounts: {
      name: account.name as string | null,
      nickname: account.nickname as string | null,
      type: account.type as string | null,
      exclude_from_cash_flow: account.exclude_from_cash_flow,
    },
  };
}

function parseSplit(value: unknown): SemanticSplitRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.transaction_id !== 'string' || typeof value.budget_category_id !== 'string') return null;
  if (typeof value.amount !== 'number' || !isStringOrNull(value.note)) return null;
  // A non-finite split amount cannot arrive as JSON; a finite one is validated by the aggregation.
  return { id: value.id, transaction_id: value.transaction_id, budget_category_id: value.budget_category_id, amount: value.amount, note: value.note };
}

function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** The keys of the rows must strictly increase: the function orders them, and a payload that is not in
 *  that order (or repeats a row) is not the documented shape. */
function strictlyOrdered<T>(rows: T[], keyOf: (row: T) => string): boolean {
  for (let i = 1; i < rows.length; i++) if (!(keyOf(rows[i - 1]) < keyOf(rows[i]))) return false;
  return true;
}

export type ParsedFinancialSnapshot =
  | { kind: 'snapshot'; snapshot: FinancialSnapshot }
  | { kind: 'too_large'; transactionCount: number; splitCount: number };

/**
 * The function's `jsonb`, validated field by field against the request. Anything outside the
 * documented shape is null (`unexpected_response`): it is never coerced into rows.
 */
export function parseFinancialSnapshot(payload: unknown, request: FinancialSnapshotRequest): ParsedFinancialSnapshot | null {
  if (!isRecord(payload)) return null;
  const { tooLarge, transactionCount, splitCount } = payload;
  if (typeof tooLarge !== 'boolean' || !isCount(transactionCount) || !isCount(splitCount)) return null;
  if (tooLarge) return { kind: 'too_large', transactionCount, splitCount };

  const transactions = parseList(payload.transactions, parseTransaction);
  if (transactions === null || transactions.length !== transactionCount) return null;
  if (!strictlyOrdered(transactions, (row) => `${row.date}|${row.id}`)) return null;
  // The function returns included accounts only; a row saying otherwise is not its documented output.
  if (transactions.some((row) => row.accounts.exclude_from_cash_flow)) return null;

  let splits: SemanticSplitRow[] | null = null;
  if (request.splits) {
    splits = parseList(payload.splits, parseSplit);
    if (splits === null || splits.length !== splitCount) return null;
    if (!strictlyOrdered(splits, (row) => `${row.transaction_id}|${row.id}`)) return null;
  } else if (payload.splits !== null && payload.splits !== undefined) {
    return null;
  }

  let budgetCategories: BudgetCategoryRow[] | null = null;
  if (request.budgetCategories) {
    if (!Array.isArray(payload.budgetCategories)) return null;
    for (const category of payload.budgetCategories) {
      if (!isRecord(category) || typeof category.id !== 'string') return null;
    }
    budgetCategories = payload.budgetCategories as BudgetCategoryRow[];
  }

  let cardPayments: FinancialSnapshot['cardPayments'] = null;
  if (request.cardStates) {
    cardPayments = parseCardPaymentStates(payload.cardPayments);
    if (cardPayments === null) return null;
  }

  return { kind: 'snapshot', snapshot: { transactions, splits, budgetCategories, cardPayments } };
}

export interface FinancialSnapshotOptions {
  timeoutMs?: number;
}

/**
 * One coherent read of the user's financial inputs. Returns `unavailable` when no usable answer was
 * obtained; throws `AggregateTooLargeError` when the range exceeds the function's limits.
 */
export async function readFinancialSnapshot(
  userId: string,
  request: FinancialSnapshotRequest,
  options: FinancialSnapshotOptions = {}
): Promise<FinancialSnapshotRead> {
  const timeoutMs = options.timeoutMs ?? FINANCIAL_SNAPSHOT_TIMEOUT_MS;
  let signal: AbortSignal | undefined;
  let parsed: ParsedFinancialSnapshot | null;
  try {
    signal = AbortSignal.timeout(timeoutMs);
    const { data, error, status } = await supabaseAdmin
      .rpc('get_financial_read_snapshot', {
        p_user_id: userId,
        p_from: request.rows.start,
        p_to: request.rows.end ?? null,
        p_include_splits: request.splits === true,
        p_include_budget_categories: request.budgetCategories === true,
        p_include_card_states: request.cardStates !== undefined,
        p_card_states_from: request.cardStates?.from ?? null,
        p_card_states_to: request.cardStates?.to ?? null,
      })
      .abortSignal(signal);
    if (error) return { kind: 'unavailable', reason: classifyReadError(READ, error, status, signal) };
    parsed = parseFinancialSnapshot(data, request);
    if (parsed === null) {
      warnUnreadable(READ, 'unexpected_response', { responseType: data === null ? 'null' : typeof data });
      return { kind: 'unavailable', reason: 'unexpected_response' };
    }
  } catch (err) {
    return { kind: 'unavailable', reason: classifyThrownRead(READ, err, signal) };
  }
  if (parsed.kind === 'too_large') {
    throw new AggregateTooLargeError(
      'the financial snapshot',
      `holds ${parsed.transactionCount} transactions and ${parsed.splitCount} splits, over the limit of ` +
        `${SNAPSHOT_MAX_TRANSACTIONS} transactions or ${SNAPSHOT_MAX_SPLITS} splits`
    );
  }
  return parsed;
}
