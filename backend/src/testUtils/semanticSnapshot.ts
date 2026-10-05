/**
 * Test-only (`src/testUtils` is excluded from the build): an in-memory "database state" for the
 * role-aware read path — the §9.1 fixture as the rows `get_financial_read_snapshot` returns, and the
 * card-payment states the database would hold for them (computed by the reference evaluator, see
 * `cardStatesFromOracle.ts`).
 *
 * `serveSnapshot` answers a snapshot request the way the SQL function does: the owner's rows on
 * included accounts in [start, end), ordered (date, id); the splits of those rows; the category
 * list; and the card states for the requested range.
 */
import type {
  FinancialSnapshotRead,
  FinancialSnapshotRequest,
  SemanticSplitRow,
  SemanticTransactionRow,
} from '../services/financialSnapshot';
import type { MatchingDecision } from '../services/cardPaymentMatching';
import type { AggregationAccount, AggregationTransaction } from '../services/semanticAggregation';
import type { BudgetCategoryRow } from '../types';
import { cardStatesFor } from './cardStatesFromOracle';
import { CATEGORY, fixtureAccounts, fixtureSplits, fixtureTransactions } from './phaseBFixture';

/** A canonical uuid for test row `n` (the drill-down cursor carries a real transaction id). */
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const FIXTURE_IDS = ['1', '2', '3', '4a', '4b', '5a', '5b', '6', '7', '8a', '8b', '9', '10', '11', '12', '13'];

/** The uuid of a fixture row given by its short id (`'5a'`); any other id is returned unchanged. */
export const idOf = (shortId: string): string => {
  const index = FIXTURE_IDS.indexOf(shortId);
  return index >= 0 ? uuid(index + 1) : shortId;
};

export const withUuids = (rows: AggregationTransaction[]): AggregationTransaction[] => rows.map((r) => ({ ...r, id: idOf(r.id) }));

/** A row as the snapshot function returns it. */
export function toSemanticRow(t: AggregationTransaction, accounts: AggregationAccount[]): SemanticTransactionRow {
  const account = accounts.find((a) => a.id === t.accountId)!;
  return {
    id: t.id,
    account_id: t.accountId,
    date: t.date,
    amount: t.amount,
    category: t.plaidCategory,
    budget_category_id: t.budgetCategoryId,
    effective_role: t.effectiveRole,
    user_role_override: t.userRoleOverride,
    manual_loan_id: t.manualLoanId,
    principal_portion: t.principalPortion,
    name: `Name of ${t.id}`,
    merchant_name: null,
    pending: false,
    needs_review: false,
    plaid_transaction_id: `plaid-${t.id}`,
    pending_transaction_id: null,
    accounts: { name: `Account ${account.id}`, nickname: null, type: account.type, exclude_from_cash_flow: account.excludeFromCashFlow },
  };
}

/** What the "database" holds at one committed state. */
export interface Snapshot {
  accounts: AggregationAccount[];
  transactions: AggregationTransaction[];
  splits?: SemanticSplitRow[];
  decisions?: MatchingDecision[];
  categories?: BudgetCategoryRow[];
}

/** The fixture's four budget categories, in `sort_order`. */
export const fixtureCategories = (): BudgetCategoryRow[] =>
  Object.entries(CATEGORY).map(([name, id], index) => ({
    id,
    user_id: 'user-1',
    name,
    budget_amount: 100 * (index + 1),
    color: null,
    sort_order: index,
    emoji: null,
    archived_at: null,
  }));

export const fixtureSnapshot = (change: Partial<Snapshot> = {}): Snapshot => ({
  accounts: fixtureAccounts(),
  transactions: withUuids(fixtureTransactions()),
  splits: fixtureSplits().map((s) => ({
    id: s.id,
    transaction_id: idOf(s.transactionId),
    budget_category_id: s.budgetCategoryId,
    amount: s.amount,
    note: `note ${s.id}`,
  })),
  categories: fixtureCategories(),
  ...change,
});

/** The state's transactions on accounts INCLUDED in cash flow with `date` in [start, end), ordered
 *  (date, id) — the filter and order of every aggregate read. */
export function includedTransactions(snapshot: Snapshot, range: { start: string; end?: string }): AggregationTransaction[] {
  return snapshot.transactions
    .filter((t) => !snapshot.accounts.find((a) => a.id === t.accountId)!.excludeFromCashFlow)
    .filter((t) => t.date >= range.start && (range.end === undefined || t.date < range.end))
    .sort((a, b) => (`${a.date}|${a.id}` < `${b.date}|${b.id}` ? -1 : 1));
}

export function rowsOf(snapshot: Snapshot, range: { start: string; end?: string }): SemanticTransactionRow[] {
  return includedTransactions(snapshot, range).map((t) => toSemanticRow(t, snapshot.accounts));
}

/** The card-payment part of a snapshot. */
export type CardState = { fresh: number } | { stale: string | null; inputVersion?: number | null };

/** Fresh card states for the state at `version`. */
export const freshStates = (snapshot: Snapshot, version: number) => ({
  kind: 'fresh' as const,
  inputVersion: version,
  states: cardStatesFor(snapshot.accounts, snapshot.transactions, snapshot.decisions ?? []),
});

/** Stale card states (no states at all), optionally with a recorded evaluation failure. */
export const staleStates = (lastErrorCode: string | null = null, inputVersion: number | null = 9) => ({
  kind: 'stale' as const,
  inputVersion,
  evaluatedVersion: inputVersion === null ? null : inputVersion - 1,
  lastErrorCode,
});

/**
 * Answers one snapshot request from `snapshot`, as `readFinancialSnapshot` would return it. `cards`
 * says what the embedded matching state is at that moment; it is consulted only when the request asks
 * for card states.
 */
export function serveSnapshot(snapshot: Snapshot, request: FinancialSnapshotRequest, cards: CardState = { fresh: 7 }): FinancialSnapshotRead {
  const transactions = rowsOf(snapshot, request.rows);
  const ids = new Set(transactions.map((t) => t.id));
  const splits = request.splits
    ? (snapshot.splits ?? [])
        .filter((s) => ids.has(s.transaction_id))
        .sort((a, b) => (`${a.transaction_id}|${a.id}` < `${b.transaction_id}|${b.id}` ? -1 : 1))
    : null;
  return {
    kind: 'snapshot',
    snapshot: {
      transactions,
      splits,
      budgetCategories: request.budgetCategories ? snapshot.categories ?? [] : null,
      cardPayments:
        request.cardStates === undefined
          ? null
          : 'fresh' in cards
            ? freshStates(snapshot, cards.fresh)
            : staleStates(cards.stale, cards.inputVersion === undefined ? 9 : cards.inputVersion),
    },
  };
}
