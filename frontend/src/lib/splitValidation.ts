import { roundToCents } from './money';

export interface SplitDraftRow {
  budget_category_id: string;
  amount: string;
}

export interface SplitBalance {
  parsedTotal: number;
  remaining: number;
  balanced: boolean;
}

/** Sums a split draft's line-item amounts and compares to the transaction's total, cent-rounded
 *  so this can never disagree with the backend's own (exact, post-rounding) validation in
 *  dataService.setTransactionSplits — a draft the UI calls "balanced" always actually saves. */
export function computeSplitBalance(rows: SplitDraftRow[], totalAmount: number): SplitBalance {
  const parsedTotal = roundToCents(rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0));
  const remaining = roundToCents(totalAmount - parsedTotal);
  return { parsedTotal, remaining, balanced: remaining === 0 };
}

/** True if any row is missing a category or a positive amount — the other half of what makes a
 *  split draft valid to save, alongside computeSplitBalance's balance check. */
export function hasIncompleteRow(rows: SplitDraftRow[]): boolean {
  return rows.some((r) => !r.budget_category_id || !r.amount || Number(r.amount) <= 0);
}
