/**
 * Test-only (`src/testUtils` is excluded from the build): the card-payment states the database would
 * hold for a set of aggregation rows, computed by the reference evaluator `cardPaymentMatching.ts`.
 *
 * In the running application the states come from `get_card_payment_states`, written by the SQL
 * evaluator. The SQL evaluator is required to equal this reference evaluator
 * (`supabase/tests/card_payment_evaluator`), so feeding `semanticAggregation.ts` from the reference
 * evaluator exercises the same contract the read path relies on, without a database.
 *
 * Every account is given to the evaluator, including the ones excluded from cash flow: their legs
 * are matching evidence (decision T5), even though the aggregation never counts them.
 */
import {
  evaluateCardPayments,
  type DecisionLegRef,
  type MatchingDecision,
} from '../services/cardPaymentMatching';
import type {
  AggregationAccount,
  AggregationTransaction,
  CardPaymentStates,
  CashFlowInput,
  AggregationPeriod,
} from '../services/semanticAggregation';

export const ORACLE_USER = 'user-1';
export const ORACLE_AS_OF = '2026-10-15T00:00:00Z';

/** The Plaid id the helper gives row `id` — what a decision's leg reference names. */
export const plaidIdOf = (id: string): string => `plaid-${id}`;

const toCents = (dollars: number): number => Math.round(dollars * 100);

/** A decision leg reference for an aggregation row, at its current amount. */
export function legRef(row: AggregationTransaction): DecisionLegRef {
  return { accountId: row.accountId, plaidTransactionId: plaidIdOf(row.id), cents: toCents(row.amount) };
}

let decisionSeq = 0;

/** The user confirmed `cash` and `credit` as one payment (or one return). */
export function pairDecision(id: string, cash: AggregationTransaction, credit: AggregationTransaction): MatchingDecision {
  const a = legRef(cash);
  const b = legRef(credit);
  return {
    id,
    userId: ORACLE_USER,
    kind: 'pair',
    a,
    b,
    acceptedDifferenceCents: Math.abs(a.cents) - Math.abs(b.cents),
    decidedSeq: ++decisionSeq,
    supersededBy: null,
  };
}

/** The user confirmed that `cash` went to (or came back from) a card that is not linked. */
export function unlinkedDecision(id: string, cash: AggregationTransaction): MatchingDecision {
  return {
    id,
    userId: ORACLE_USER,
    kind: 'destination_unlinked',
    a: legRef(cash),
    b: null,
    acceptedDifferenceCents: null,
    decidedSeq: ++decisionSeq,
    supersededBy: null,
  };
}

export function cardStatesFor(
  accounts: AggregationAccount[],
  transactions: AggregationTransaction[],
  decisions: MatchingDecision[] = []
): CardPaymentStates {
  const evaluation = evaluateCardPayments({
    userId: ORACLE_USER,
    asOf: ORACLE_AS_OF,
    accounts: accounts.map((a) => ({ id: a.id, userId: ORACLE_USER, type: a.type, excludeFromCashFlow: a.excludeFromCashFlow })),
    // Rows the aggregation would refuse (a non-finite amount, an unknown account) are left out here so
    // that the aggregation's own integrity check is what the test observes.
    transactions: transactions
      .filter((t) => Number.isFinite(t.amount) && accounts.some((a) => a.id === t.accountId))
      .map((t) => ({
        id: t.id,
        accountId: t.accountId,
        plaidTransactionId: plaidIdOf(t.id),
        pendingTransactionId: null,
        pending: false,
        date: t.date,
        amountCents: toCents(t.amount),
        effectiveRole: t.effectiveRole,
      })),
    carryovers: [],
    decisions,
  });
  return { legs: evaluation.legs, supersededTransactionIds: evaluation.supersededTransactionIds };
}

/**
 * A complete card-dependent aggregation input. The states are evaluated over `history` — the user's
 * whole history, which is what the database evaluator sees — while `transactions` may be only the
 * rows a caller fetched for the period. Omitted, the fetched rows are the whole history.
 */
export function cashFlowInput(args: {
  accounts: AggregationAccount[];
  transactions: AggregationTransaction[];
  period?: AggregationPeriod;
  decisions?: MatchingDecision[];
  history?: AggregationTransaction[];
}): CashFlowInput {
  return {
    accounts: args.accounts,
    transactions: args.transactions,
    period: args.period,
    cardPayments: cardStatesFor(args.accounts, args.history ?? args.transactions, args.decisions ?? []),
  };
}
